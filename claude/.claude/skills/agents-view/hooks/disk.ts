const RECENT_RUN_MS = 24 * 60 * 60 * 1000;
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
  stat: (path: string) => Promise<{ mtimeMs: number }>;
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
