const RECENT_RUN_MS = 24 * 60 * 60 * 1000;
const READ_LIMIT = 3_500_000;
const HEAD_BYTES = 262_144;
const TAIL_BYTES = 3_000_000;
const MAX_RECENT_RUNS = 40;
const RUN_NAME =
  /"workflowName":"((?:[^"\\]|\\.){1,200})","runId":"(wf_[0-9a-f-]+)"/g;

export interface DiskEntry {
  name: string;
  kind: string;
  mtimeMs: number;
}

export interface Disk {
  read: (path: string) => Promise<string>;
  list: (path: string) => Promise<readonly DiskEntry[]>;
  exists: (path: string) => Promise<boolean>;
  stat: (path: string) => Promise<{ mtimeMs: number; size: number }>;
  run: (
    argv: readonly string[],
  ) => Promise<{ exitCode: number; stdout: string }>;
  configured: () => Promise<string | undefined>;
  home: () => Promise<string | undefined>;
  sessionId: () => Promise<string>;
  roots: () => Promise<readonly string[]>;
}

export interface SessionPaths {
  transcript: string;
  dir: string;
}

export interface RecentRun {
  run: string;
  isEnded: boolean;
}

export interface RunAgent {
  id: string;
  label?: string;
  phase?: string;
  isDone: boolean;
  isRetried: boolean;
  startedAt?: number;
  endedAt?: number;
}

export interface RunScan {
  active: readonly { run: string; agents: readonly RunAgent[] }[];
  ended: readonly string[];
}

export interface TranscriptRow {
  type: string;
  role: string;
  content: readonly { type: string; [field: string]: unknown }[];
}

export interface Transcript {
  rows: readonly TranscriptRow[];
  model?: string;
  effort?: string;
  steps: number;
  toolCalls: number;
  input: number;
  output: number;
}

export interface AgentMeta {
  label?: string;
  type?: string;
  phase?: string;
  model?: string;
  run?: string;
}

const findFirst = async <T>(
  items: readonly T[],
  predicate: (item: T) => Promise<boolean>,
): Promise<T | undefined> => {
  const [head, ...rest] = items;

  if (head === undefined) {
    return undefined;
  }

  return (await predicate(head).catch(() => false))
    ? head
    : findFirst(rest, predicate);
};

const projectDirOf = (root: string): string =>
  root.replaceAll(/[^a-zA-Z0-9]/g, "-");

const configDirOf = async (disk: Disk): Promise<string | undefined> => {
  const configured = await disk.configured();

  if (configured !== undefined && configured !== "") {
    return configured;
  }

  const home = await disk.home();

  return home === undefined || home === "" ? undefined : `${home}/.claude`;
};

export const sessionPathsOf = async (
  disk: Disk,
): Promise<SessionPaths | undefined> => {
  const configDir = await configDirOf(disk);

  if (configDir === undefined) {
    return undefined;
  }

  const projects = `${configDir}/projects`;
  const id = await disk.sessionId();
  const roots = await disk.roots();
  const entries = await disk.list(projects).catch(() => []);
  const named = roots.map((root) => `${projects}/${projectDirOf(root)}`);
  const listed = entries
    .filter((entry) => entry.kind === "dir")
    .map((entry) => `${projects}/${entry.name}`);
  const found = await findFirst([...new Set([...named, ...listed])], (base) =>
    disk.exists(`${base}/${id}.jsonl`),
  );

  return found === undefined
    ? undefined
    : { transcript: `${found}/${id}.jsonl`, dir: `${found}/${id}` };
};

export const recentRunsOf = async (
  disk: Disk,
  paths: SessionPaths,
  now: number,
): Promise<readonly RecentRun[]> => {
  const [folders, records] = await Promise.all([
    disk.list(`${paths.dir}/subagents/workflows`).catch(() => []),
    disk.list(`${paths.dir}/workflows`).catch(() => []),
  ]);
  const ended = new Map(
    records
      .filter(
        (entry) =>
          entry.kind === "file" &&
          entry.name.startsWith("wf_") &&
          entry.name.endsWith(".json"),
      )
      .map((entry) => [entry.name.slice(0, -".json".length), entry.mtimeMs]),
  );
  const open = await Promise.all(
    folders
      .filter(
        (entry) =>
          entry.kind === "dir" &&
          entry.name.startsWith("wf_") &&
          !ended.has(entry.name),
      )
      .map(async (entry) => {
        const journal = await disk
          .stat(`${paths.dir}/subagents/workflows/${entry.name}/journal.jsonl`)
          .catch(() => undefined);

        return {
          run: entry.name,
          isEnded: false,
          mtimeMs: journal?.mtimeMs ?? 0,
        };
      }),
  );
  const closed = [...ended].map(([run, mtimeMs]) => ({
    run,
    isEnded: true,
    mtimeMs,
  }));

  return [...open, ...closed]
    .filter((one) => now - one.mtimeMs < RECENT_RUN_MS)
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_RECENT_RUNS)
    .map(({ run, isEnded }) => ({ run, isEnded }));
};

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const recordOf = (line: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);

    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const runAgentsOf = (
  journal: string,
  mtimes: ReadonlyMap<string, number>,
): RunAgent[] => {
  const events = journal.split("\n").flatMap((line) => {
    const event = recordOf(line);
    const agentId = stringOf(event?.agentId);

    return event === undefined || agentId === undefined
      ? []
      : [
          {
            type: stringOf(event.type),
            agentId,
            label: stringOf(event.label),
            phase: stringOf(event.phase),
          },
        ];
  });
  const done = new Set(
    events
      .filter((event) => event.type === "result")
      .map((event) => event.agentId),
  );
  const started = new Map(
    events
      .filter((event) => event.type === "started")
      .map((event) => [event.agentId, event] as const),
  );

  const latest = new Map(
    [...started.values()].map((event) => [event.label, event.agentId] as const),
  );

  return [...started.values()].map((event) => {
    const isRetried =
      !done.has(event.agentId) &&
      event.label !== undefined &&
      latest.get(event.label) !== event.agentId;
    const isDone = done.has(event.agentId) || isRetried;

    return {
      id: event.agentId,
      label: event.label,
      phase: event.phase,
      isDone,
      isRetried,
      startedAt: mtimes.get(`agent-${event.agentId}.meta.json`),
      endedAt: isDone ? mtimes.get(`agent-${event.agentId}.jsonl`) : undefined,
    };
  });
};

const runScanOf = async (
  disk: Disk,
  paths: SessionPaths,
  run: string,
): Promise<RunScan> => {
  if (await disk.exists(`${paths.dir}/workflows/${run}.json`)) {
    return { active: [], ended: [run] };
  }

  const base = `${paths.dir}/subagents/workflows/${run}`;
  const [entries, journal] = await Promise.all([
    disk.list(base),
    disk.read(`${base}/journal.jsonl`),
  ]);
  const mtimes = new Map(
    entries
      .filter((entry) => entry.mtimeMs > 0)
      .map((entry) => [entry.name, entry.mtimeMs]),
  );

  return {
    active: [{ run, agents: runAgentsOf(journal, mtimes) }],
    ended: [],
  };
};

export const runScansOf = async (
  disk: Disk,
  paths: SessionPaths,
  runs: readonly string[],
): Promise<RunScan> => {
  const scans = await Promise.all(
    runs.map((run) =>
      runScanOf(disk, paths, run).catch(
        (): RunScan => ({ active: [], ended: [] }),
      ),
    ),
  );

  return {
    active: scans.flatMap((scan) => scan.active),
    ended: scans.flatMap((scan) => scan.ended),
  };
};

export const transcriptPathOf = (
  paths: SessionPaths,
  agentId: string,
  run?: string,
): string =>
  run === undefined
    ? `${paths.dir}/subagents/agent-${agentId}.jsonl`
    : `${paths.dir}/subagents/workflows/${run}/agent-${agentId}.jsonl`;

const numberOf = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const blocksOf = (content: unknown): TranscriptRow["content"] => {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  return Array.isArray(content)
    ? content.filter(
        (block): block is { type: string } =>
          typeof block === "object" &&
          block !== null &&
          typeof (block as Record<string, unknown>).type === "string",
      )
    : [];
};

const rowOf = (record: Record<string, unknown>): TranscriptRow | undefined => {
  const message = record.message as Record<string, unknown> | undefined;
  const role = stringOf(message?.role);

  if (
    (record.type !== "user" && record.type !== "assistant") ||
    record.isMeta === true ||
    role === undefined
  ) {
    return undefined;
  }

  return { type: role, role, content: blocksOf(message?.content) };
};

const transcriptFrom = (
  records: readonly Record<string, unknown>[],
  opening: readonly TranscriptRow[],
): Transcript => {
  const requests = records.filter((record) => record.type === "api-request");
  const params = requests.at(-1)?.params as Record<string, unknown> | undefined;
  const config = params?.output_config as Record<string, unknown> | undefined;
  const replies = records
    .filter((record) => record.type === "assistant")
    .map((record) => record.message as Record<string, unknown> | undefined);
  const usages = new Map(
    replies.flatMap((message) => {
      const id = stringOf(message?.id);

      return id === undefined
        ? []
        : [[id, message?.usage as Record<string, unknown> | undefined]];
    }),
  );
  const rows = records.flatMap((record) => rowOf(record) ?? []);

  return {
    rows: [...opening, ...rows],
    model: stringOf(params?.model) ?? stringOf(replies.at(-1)?.model),
    effort: stringOf(config?.effort),
    steps: usages.size,
    toolCalls: replies.reduce(
      (count, message) =>
        count +
        blocksOf(message?.content).filter((block) => block.type === "tool_use")
          .length,
      0,
    ),
    input: [...usages.values()].reduce(
      (total, usage) =>
        total +
        numberOf(usage?.input_tokens) +
        numberOf(usage?.cache_read_input_tokens) +
        numberOf(usage?.cache_creation_input_tokens),
      0,
    ),
    output: [...usages.values()].reduce(
      (total, usage) => total + numberOf(usage?.output_tokens),
      0,
    ),
  };
};

const recordsOf = (text: string, isCut: boolean): Record<string, unknown>[] =>
  (isCut ? text.split("\n").slice(1) : text.split("\n")).flatMap((line) => {
    const record = recordOf(line);

    return record === undefined ? [] : [record];
  });

export const transcriptOf = async (
  disk: Disk,
  path: string,
): Promise<Transcript> => {
  const { size } = await disk.stat(path);

  if (size <= READ_LIMIT) {
    return transcriptFrom(recordsOf(await disk.read(path), false), []);
  }

  const [head, tail] = await Promise.all([
    disk.run(["head", "-c", String(HEAD_BYTES), path]),
    disk.run(["tail", "-c", String(TAIL_BYTES), path]),
  ]);
  const opening = recordsOf(head.stdout, false)
    .flatMap((record) => rowOf(record) ?? [])
    .filter((row) => row.role === "user")
    .slice(0, 1);

  return transcriptFrom(recordsOf(tail.stdout, true), opening);
};

const parsedMetaOf = (text: string, run?: string): AgentMeta | undefined => {
  const parsed: unknown = JSON.parse(text);

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  return {
    label: stringOf(record.description),
    type: stringOf(record.agentType),
    phase: stringOf(record.workflowPhase),
    model: stringOf(record.model),
    run,
  };
};

export const agentMetaOf = async (
  disk: Disk,
  paths: SessionPaths,
  runs: readonly string[],
  agentId: string,
): Promise<AgentMeta | undefined> => {
  const candidates: readonly { path: string; run?: string }[] = [
    { path: `${paths.dir}/subagents/agent-${agentId}.meta.json` },
    ...runs.map((run) => ({
      path: `${paths.dir}/subagents/workflows/${run}/agent-${agentId}.meta.json`,
      run,
    })),
  ];
  const found = await findFirst(candidates, (candidate) =>
    disk.exists(candidate.path),
  );

  if (found === undefined) {
    return undefined;
  }

  return parsedMetaOf(await disk.read(found.path), found.run);
};

const unescapedOf = (text: string): string => {
  try {
    const parsed: unknown = JSON.parse(`"${text}"`);

    return typeof parsed === "string" ? parsed : text;
  } catch {
    return text;
  }
};

export const runNamesOf = async (
  disk: Disk,
  paths: SessionPaths,
): Promise<ReadonlyMap<string, string>> => {
  const scanned = await disk
    .run([
      "perl",
      "-ne",
      String.raw`next unless index($_, q("workflowName":")) >= 0; print "$&\n" while /"workflowName":"[^"]{1,200}","runId":"wf_[0-9a-f-]+"/g`,
      paths.transcript,
    ])
    .catch(() => ({ exitCode: 2, stdout: "" }));
  const { exitCode, stdout } =
    scanned.exitCode === 0
      ? scanned
      : await disk.run([
          "grep",
          "-o",
          '"workflowName":"[^"]*","runId":"wf_[0-9a-f-]*"',
          paths.transcript,
        ]);

  if (exitCode > 1) {
    return new Map();
  }

  return new Map(
    [...stdout.matchAll(RUN_NAME)].map(
      ([, name = "", runId = ""]) => [runId, unescapedOf(name)] as const,
    ),
  );
};
