import type { On } from "claude-code";
import {
  colorOf,
  type Detail,
  detailView,
  type Entry,
  glyphOf,
  harnessFrameOf,
  type Kit,
  promptTextOf,
  type Summary,
  tidyOf,
} from "./detail";
import {
  SUMMARY_ARGV,
  SUMMARY_TIMEOUT_MS,
  summaryInputOf,
  summaryTextOf,
} from "./summary";
import {
  agentMetaOf,
  recentRunsOf,
  runNamesOf,
  runScansOf,
  sessionPathsOf,
  transcriptOf,
  transcriptPathOf,
  type Disk,
  type RunAgent,
  type SessionPaths,
} from "./disk";

const PANE_ID = "agents-view";
const PANE_TITLE = "Agents";
const COMMAND = "subagents";
const TICK_MS = 500;
const SYNC_MS = 3000;
const PATHS_RETRY_MS = 30_000;
const NAMES_RETRY_MS = 15_000;
const MAX_LOOKUPS = 5;
const MAX_BACKFILLS = 3;
const PLAIN_TYPES = new Set(["agent", "workflow-subagent"]);
const MAX_AGENTS = 300;
const MAX_ENTRIES = 300;
const MAX_TEXT_CHARS = 2000;
const MAX_PROMPT_CHARS = 8000;
const MAX_LINE_CHARS = 200;
const MAX_DEPTH = 6;
const SUMMARY_FIELDS = [
  "file_path",
  "notebook_path",
  "command",
  "pattern",
  "url",
  "query",
  "description",
  "prompt",
] as const;

interface Tokens {
  input: number;
  output: number;
}

interface Tracked {
  id: string;
  label: string;
  type: string;
  status: string;
  isListed: boolean;
  isBackground: boolean;
  seq: number;
  entries: readonly Entry[];
  parentId?: string;
  workflowRun?: string;
  workflowIndex?: number;
  phase?: string;
  isResolved: boolean;
  isBackfilled: boolean;
  lookups: number;
  model?: string;
  effort?: string;
  startedAt: number;
  endedAt?: number;
  steps: number;
  toolCalls: number;
  tokens: Tokens;
}

type Runs = ReadonlyMap<string, string>;

interface Placed {
  agent: Tracked;
  depth: number;
}

interface Group {
  key: string;
  title: string;
  note: string;
  members: readonly Placed[];
}

interface Listed {
  id: string;
  description: string;
  type: string;
  status: string;
  parentId?: string;
}

interface Host {
  list: () => Promise<readonly Listed[]>;
  now: () => Promise<number>;
  disk: Disk;
  summarize: (input: string) => Promise<string>;
  open: () => Promise<unknown>;
  redraw: () => void;
}

interface Row {
  type: string;
  role?: string;
  isMeta?: true;
  content: readonly { type: string; [field: string]: unknown }[];
}

const isDrawable = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;

  return code === 9 || code === 10 || (code >= 32 && code !== 127);
};

const drawableOf = (text: string, limit: number): string => {
  const cleaned = [...text.slice(0, limit * 2).replaceAll("\r\n", "\n")]
    .filter(isDrawable)
    .join("");

  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned;
};

const lineOf = (text: string): string =>
  drawableOf(text.replaceAll(/\s+/g, " ").trim(), MAX_LINE_CHARS);

const summaryOf = (input: unknown): string => {
  if (typeof input !== "object" || input === null) {
    return "";
  }

  const record = input as Record<string, unknown>;
  const found = SUMMARY_FIELDS.map((field) => record[field]).find(
    (value): value is string => typeof value === "string" && value !== "",
  );

  return found === undefined ? "" : lineOf(tidyOf(found));
};

const resultTextOf = (content: unknown): string => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part: unknown) =>
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).type === "text"
        ? String((part as Record<string, unknown>).text ?? "")
        : "",
    )
    .join("\n");
};

const resultEntryOf = (content: unknown, isError: boolean): Entry => {
  const text = tidyOf(resultTextOf(content));
  const lines = text === "" ? 0 : text.split("\n").length;
  const head = lineOf(
    text.split("\n").find((line) => line.trim() !== "") ?? "",
  );

  return {
    kind: "result",
    isError,
    text: lines > 1 ? `${head} (+${lines - 1} lines)` : head,
  };
};

const entriesOf = (row: Row, hasPrompt: boolean): Entry[] =>
  row.content.flatMap((block): Entry[] => {
    if (block.type === "text" && typeof block.text === "string") {
      const frame =
        row.role === "user" ? harnessFrameOf(block.text) : undefined;

      if (frame === "user request") {
        return [];
      }

      const isPrompt =
        row.role === "user" &&
        (frame === "computed task" || (!hasPrompt && frame === undefined));
      const text = isPrompt
        ? drawableOf(tidyOf(promptTextOf(block.text)), MAX_PROMPT_CHARS)
        : drawableOf(tidyOf(block.text.trim()), MAX_TEXT_CHARS);

      if (text.trim() === "") {
        return [];
      }

      return [isPrompt ? { kind: "prompt", text } : { kind: "text", text }];
    }

    if (block.type === "tool_use") {
      return [
        {
          kind: "tool",
          name: typeof block.name === "string" ? block.name : "tool",
          summary: summaryOf(block.input),
        },
      ];
    }

    if (block.type === "tool_result") {
      return [resultEntryOf(block.content, block.is_error === true)];
    }

    return [];
  });

const statusOfReason = (reason: string): string => {
  switch (reason) {
    case "answer": {
      return "completed";
    }
    case "aborted": {
      return "killed";
    }
    default: {
      return "failed";
    }
  }
};

const isLive = (status: string): boolean =>
  status === "running" || status === "idle";

const seededStatusOf = (one: Tracked, member: RunAgent): string => {
  if (!member.isDone || one.isListed || !isLive(one.status)) {
    return one.status;
  }

  return member.isRetried ? "retried" : "completed";
};

const modelOf = (model: string): string =>
  model
    .replace(/^.*?claude-/, "")
    .replace(/-\d{8}(?=$|\[|-v)/, "")
    .replace(/-(\d+)-(\d+)(?=$|\[)/, "-$1.$2");

const effortOf = (effort: string | number | undefined): string | undefined => {
  if (effort === undefined) {
    return undefined;
  }

  return typeof effort === "number" ? `budget ${effort}` : effort;
};

const countOf = (value: number): string => {
  if (value < 1000) {
    return String(value);
  }

  if (value < 1_000_000) {
    return `${(value / 1000).toFixed(1)}k`;
  }

  return `${(value / 1_000_000).toFixed(1)}M`;
};

const durationOf = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);

  if (minutes < 60) {
    return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  }

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
};

const elapsedOf = (agent: Tracked, now: number): string =>
  durationOf((agent.endedAt ?? now) - agent.startedAt);

const runnerOf = (agent: Tracked): string =>
  [agent.model === undefined ? undefined : modelOf(agent.model), agent.effort]
    .filter((part) => part !== undefined)
    .join(" · ");

const chipOf = (agent: Tracked): string =>
  [PLAIN_TYPES.has(agent.type) ? undefined : `[${agent.type}]`, agent.phase]
    .filter((part) => part !== undefined)
    .join(" ");

const countedOf = (value: number, noun: string): string =>
  `${value} ${noun}${value === 1 ? "" : "s"}`;

const definedOf = (parts: readonly (string | undefined)[]): string[] =>
  parts.filter((part): part is string => part !== undefined && part !== "");

const detailOf = (
  agent: Tracked,
  runs: Runs,
  now: number,
  summary?: Summary,
): Detail => {
  const workflow =
    agent.workflowRun === undefined
      ? undefined
      : definedOf([
          runs.get(agent.workflowRun) ?? "workflow",
          agent.workflowIndex === undefined
            ? undefined
            : `#${agent.workflowIndex}`,
        ]).join(" ");

  return {
    id: agent.id,
    summary,
    label: agent.label,
    status: agent.status,
    elapsed: elapsedOf(agent, now),
    context: definedOf([
      agent.type,
      agent.phase,
      workflow,
      agent.isBackground ? "background" : undefined,
    ]),
    model: agent.model === undefined ? undefined : modelOf(agent.model),
    effort: agent.effort,
    stats: definedOf([
      countedOf(agent.steps, "step"),
      countedOf(agent.toolCalls, "tool"),
      `in ${countOf(agent.tokens.input)}`,
      `out ${countOf(agent.tokens.output)}`,
    ]).join(" · "),
    origin: definedOf([
      agent.id,
      agent.parentId === undefined ? undefined : `parent ${agent.parentId}`,
      agent.workflowRun,
    ]).join(" · "),
    entries: agent.entries,
  };
};

const freshOf = (id: string, seq: number, now: number): Tracked => ({
  id,
  label: id,
  type: "agent",
  status: "running",
  isListed: false,
  isBackground: false,
  isResolved: false,
  isBackfilled: false,
  lookups: 0,
  seq,
  entries: [],
  startedAt: now,
  steps: 0,
  toolCalls: 0,
  tokens: { input: 0, output: 0 },
});

const orderOf = (agents: ReadonlyMap<string, Tracked>): Tracked[] =>
  [...agents.values()].toSorted((a, b) => {
    const running = Number(isLive(b.status)) - Number(isLive(a.status));

    return running === 0 ? b.seq - a.seq : running;
  });

const placedOf = (agents: ReadonlyMap<string, Tracked>): Placed[] => {
  const ordered = orderOf(agents);
  const rootOf = (agent: Tracked): string | undefined =>
    agent.parentId !== undefined && agents.has(agent.parentId)
      ? agent.parentId
      : undefined;
  const walk = (parentId: string | undefined, depth: number): Placed[] =>
    ordered
      .filter((one) => rootOf(one) === parentId)
      .flatMap((one) => [
        { agent: one, depth },
        ...(depth < MAX_DEPTH ? walk(one.id, depth + 1) : []),
      ]);

  return walk(undefined, 0);
};

const noteOf = (members: readonly Placed[], suffix?: string): string =>
  [
    `${members.filter(({ agent }) => isLive(agent.status)).length} running / ${members.length}`,
    suffix,
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

const rankOf = (group: Group): readonly [number, number] => [
  Number(group.members.some(({ agent }) => isLive(agent.status))),
  Math.max(...group.members.map(({ agent }) => agent.seq)),
];

const groupsOf = (
  agents: ReadonlyMap<string, Tracked>,
  runs: Runs,
): Group[] => {
  const ordered = orderOf(agents);
  const runIds = [
    ...new Set(
      ordered.flatMap((one) =>
        one.workflowRun === undefined ? [] : [one.workflowRun],
      ),
    ),
  ];
  const loose = placedOf(
    new Map([...agents].filter(([, one]) => one.workflowRun === undefined)),
  );
  const workflows = runIds.map((run): Group => {
    const members = ordered
      .filter((one) => one.workflowRun === run)
      .map((agent) => ({ agent, depth: 0 }));
    const name = runs.get(run);

    return {
      key: run,
      title: name ?? run,
      note: noteOf(members, name === undefined ? undefined : run),
      members,
    };
  });
  const groups =
    loose.length === 0
      ? workflows
      : [
          ...workflows,
          {
            key: "subagents",
            title: "subagents",
            note: noteOf(loose),
            members: loose,
          },
        ];

  return groups.toSorted((a, b) => {
    const [liveA, seqA] = rankOf(a);
    const [liveB, seqB] = rankOf(b);

    return liveA === liveB ? seqB - seqA : liveB - liveA;
  });
};

const prunedOf = (
  agents: ReadonlyMap<string, Tracked>,
): ReadonlyMap<string, Tracked> =>
  agents.size <= MAX_AGENTS
    ? agents
    : new Map(
        orderOf(agents)
          .slice(0, MAX_AGENTS)
          .map((one) => [one.id, one]),
      );

const trackedSignatureOf = (one: Tracked, now: number): string =>
  [
    one.id,
    one.status,
    one.entries.length,
    one.label,
    one.type,
    one.phase,
    one.workflowRun,
    one.model,
    one.effort,
    one.steps,
    one.tokens.output,
    one.endedAt === undefined ? Math.floor(now / 1000) : one.endedAt,
  ].join(":");

const signatureOf = (
  agents: ReadonlyMap<string, Tracked>,
  runs: Runs,
  now: number,
): string =>
  [
    ...runs.values(),
    ...[...agents.values()].map((one) => trackedSignatureOf(one, now)),
  ].join("|");

export const register = (on: On) => {
  let agents: ReadonlyMap<string, Tracked> = new Map();
  let runs: Runs = new Map();
  let selectedId: string | null = null;
  let expandedIds: ReadonlySet<string> = new Set();
  let summaries: ReadonlyMap<string, Summary & { seq: number }> = new Map();
  let summarySeq = 0;
  let host: Host | null = null;
  let isOpen = false;
  let hasAutoOpened = false;
  let drawnSignature = "";
  let seq = 0;
  let paths: SessionPaths | undefined;
  let pathsCheckedAt = Number.NEGATIVE_INFINITY;
  let syncedAt = Number.NEGATIVE_INFINITY;
  let namedAt = Number.NEGATIVE_INFINITY;
  let soughtRuns: ReadonlySet<string> = new Set();
  let endedRuns: ReadonlySet<string> = new Set();
  let syncNote: string | undefined;

  const upsert = (
    id: string,
    now: number,
    change: (current: Tracked) => Tracked,
  ) => {
    const current = agents.get(id) ?? freshOf(id, (seq += 1), now);
    agents = prunedOf(new Map([...agents, [id, change(current)]]));
  };

  const openPane = async (current: Host) => {
    isOpen = true;
    await current.open();
    current.redraw();
  };

  const resolvePaths = async (disk: Disk, now: number) => {
    if (paths === undefined && now - pathsCheckedAt >= PATHS_RETRY_MS) {
      pathsCheckedAt = now;
      paths = await sessionPathsOf(disk).catch(() => undefined);
    }

    return paths;
  };

  const seedRuns = async (
    disk: Disk,
    found: SessionPaths,
    recent: readonly string[],
    now: number,
  ) => {
    const scan = await runScansOf(
      disk,
      found,
      recent.filter((run) => !endedRuns.has(run)),
    );
    endedRuns = new Set([...endedRuns, ...scan.ended]);

    scan.active.forEach(({ run, agents: members }) =>
      members.forEach((member) =>
        upsert(member.id, member.startedAt ?? now, (one) => ({
          ...one,
          label:
            one.label === one.id && member.label !== undefined
              ? lineOf(member.label)
              : one.label,
          type: one.type === "agent" ? "workflow-subagent" : one.type,
          phase: one.phase ?? member.phase,
          workflowRun: one.workflowRun ?? run,
          isResolved: one.isResolved || member.label !== undefined,
          status: seededStatusOf(one, member),
          endedAt:
            member.isDone && one.endedAt === undefined
              ? (member.endedAt ?? now)
              : one.endedAt,
        })),
      ),
    );
  };

  const resolveAgents = async (
    disk: Disk,
    found: SessionPaths,
    recent: readonly string[],
    now: number,
  ) => {
    const pending = [...agents.values()].filter(
      (one) => !one.isResolved && one.lookups < MAX_LOOKUPS,
    );

    if (pending.length === 0) {
      return;
    }

    const metas = await Promise.all(
      pending.map(
        async (one) =>
          [
            one.id,
            await agentMetaOf(
              disk,
              found,
              one.workflowRun === undefined ? recent : [one.workflowRun],
              one.id,
            ).catch(() => undefined),
          ] as const,
      ),
    );

    metas.forEach(([id, meta]) =>
      upsert(id, now, (one) =>
        meta === undefined
          ? { ...one, lookups: one.lookups + 1 }
          : {
              ...one,
              label:
                !one.isListed && meta.label !== undefined
                  ? lineOf(meta.label)
                  : one.label,
              type: one.isListed ? one.type : (meta.type ?? one.type),
              phase: meta.phase ?? one.phase,
              model: one.model ?? meta.model,
              workflowRun: one.workflowRun ?? meta.run,
              isResolved: true,
              lookups: one.lookups + 1,
            },
      ),
    );
  };

  const backfillAgents = async (
    disk: Disk,
    found: SessionPaths,
    now: number,
  ) => {
    const pending = [...agents.values()]
      .filter(
        (one) =>
          !one.isBackfilled &&
          one.entries.length === 0 &&
          one.steps === 0 &&
          (one.workflowRun !== undefined || one.isResolved) &&
          (isLive(one.status) || one.id === selectedId),
      )
      .slice(0, MAX_BACKFILLS);
    const loaded = await Promise.all(
      pending.map(
        async (one) =>
          [
            one.id,
            await transcriptOf(
              disk,
              transcriptPathOf(found, one.id, one.workflowRun),
            ).catch(() => undefined),
          ] as const,
      ),
    );

    loaded.forEach(([id, transcript]) =>
      upsert(id, now, (one) => {
        if (transcript === undefined || one.entries.length > 0) {
          return { ...one, isBackfilled: true };
        }

        return {
          ...one,
          isBackfilled: true,
          entries: transcript.rows
            .reduce<Entry[]>(
              (collected, row) => [
                ...collected,
                ...entriesOf(
                  row,
                  collected.some((entry) => entry.kind === "prompt"),
                ),
              ],
              [],
            )
            .slice(-MAX_ENTRIES),
          model: one.model ?? transcript.model,
          effort: one.effort ?? transcript.effort,
          steps: one.steps + transcript.steps,
          toolCalls: one.toolCalls + transcript.toolCalls,
          tokens: {
            input: one.tokens.input + transcript.input,
            output: one.tokens.output + transcript.output,
          },
        };
      }),
    );
  };

  const requestSummary = async (current: Host, id: string) => {
    const seq = (summarySeq += 1);
    const settle = (summary: Summary) => {
      if (summaries.get(id)?.seq === seq) {
        summaries = new Map([...summaries, [id, { ...summary, seq }]]);
        current.redraw();
      }
    };

    summaries = new Map([
      ...summaries,
      [id, { state: "loading", text: "", seq }],
    ]);
    current.redraw();

    const now = await current.now();

    if (paths !== undefined) {
      await backfillAgents(current.disk, paths, now).catch(() => undefined);
    }

    const agent = agents.get(id);

    if (agent === undefined) {
      settle({ state: "error", text: "agent is no longer tracked" });

      return;
    }

    await current.summarize(summaryInputOf(detailOf(agent, runs, now))).then(
      (text) => settle({ state: "done", text }),
      (error: unknown) =>
        settle({ state: "error", text: lineOf(String(error)) }),
    );
  };

  const resolveNames = async (disk: Disk, found: SessionPaths, now: number) => {
    const unnamed = [...agents.values()].flatMap((one) =>
      one.workflowRun === undefined ||
      runs.has(one.workflowRun) ||
      soughtRuns.has(one.workflowRun)
        ? []
        : [one.workflowRun],
    );

    if (unnamed.length === 0 || now - namedAt < NAMES_RETRY_MS) {
      return;
    }

    namedAt = now;
    soughtRuns = new Set([...soughtRuns, ...unnamed]);
    const named = await runNamesOf(disk, found).catch(() => new Map());
    runs = new Map([...named, ...runs]);
  };

  const sync = async (disk: Disk, now: number) => {
    if (now - syncedAt < SYNC_MS) {
      return;
    }

    syncedAt = now;
    const found = await resolvePaths(disk, now);

    if (found === undefined) {
      syncNote =
        "session records not found; workflow agents appear as they run";

      return;
    }

    const recent = await recentRunsOf(disk, found, now);
    const open = recent.filter((one) => !one.isEnded).map((one) => one.run);

    await seedRuns(disk, found, open, now);
    await resolveAgents(
      disk,
      found,
      recent.map((one) => one.run),
      now,
    );
    await backfillAgents(disk, found, now);
    await resolveNames(disk, found, now);
    syncNote = undefined;
  };

  const tick = async (current: Host) => {
    const listed = await current.list().catch(() => []);
    const now = await current.now();

    await sync(current.disk, now).catch((error: unknown) => {
      syncNote = `reading session records failed: ${lineOf(String(error))}`;
    });

    listed.forEach((info) =>
      upsert(info.id, now, (one) => ({
        ...one,
        label: lineOf(info.description) || one.label,
        type: info.type,
        status: info.status,
        parentId: info.parentId ?? one.parentId,
        isListed: true,
        endedAt: isLive(info.status) ? undefined : (one.endedAt ?? now),
      })),
    );

    if (!hasAutoOpened && agents.size > 0) {
      hasAutoOpened = true;

      if (!isOpen) {
        await openPane(current);
      }
    }

    const signature = [
      syncNote ?? "",
      [...summaries].map(([id, one]) => `${id}:${one.seq}:${one.state}`),
      signatureOf(agents, runs, now),
    ].join("|");

    if (signature !== drawnSignature) {
      drawnSignature = signature;
      current.redraw();
    }
  };

  on("session.start", async ($, e, next) => {
    if ((await $.env.get("AGENTS_VIEW_CHILD")) === "1") {
      return next(e);
    }

    const current: Host = {
      list: () => $.agent.list(),
      now: () => $.clock.now(),
      disk: {
        read: (path) => $.fs.read(path),
        list: (path) => $.fs.list(path),
        exists: (path) => $.fs.exists(path),
        stat: (path) => $.fs.stat(path),
        run: (argv) => $.process.run(argv),
        configured: () => $.env.get("CLAUDE_CONFIG_DIR"),
        home: () => $.env.get("HOME"),
        sessionId: () => $.session.id(),
        roots: async () => [await $.session.root(), await $.session.cwd()],
      },
      summarize: async (input) => {
        const { exitCode, stdout, stderr } = await $.process.run(SUMMARY_ARGV, {
          stdin: input,
          env: { AGENTS_VIEW_CHILD: "1" },
          timeoutMs: SUMMARY_TIMEOUT_MS,
        });

        if (exitCode !== 0) {
          throw new Error(
            lineOf(stderr) || lineOf(stdout) || `claude exited ${exitCode}`,
          );
        }

        return summaryTextOf(stdout);
      },
      open: () => $.ui.open({ id: PANE_ID, title: PANE_TITLE }),
      redraw: () => $.ui.invalidate("ui.render"),
    };
    host = current;

    await $.command.register({
      name: COMMAND,
      description: "Toggle the pane listing this session's subagents",
    });
    const loop = () =>
      $.clock.after(
        TICK_MS,
        () =>
          void tick(current)
            .catch(() => undefined)
            .finally(loop),
      );
    loop();

    return next(e);
  });

  on("command.run", { command: COMMAND }, async ($) => {
    if (host === null) {
      return { text: "agents-view is not ready yet." };
    }

    if (isOpen) {
      isOpen = false;
      await $.ui.close({ id: PANE_ID });

      return { text: "Agents pane hidden." };
    }

    hasAutoOpened = true;
    await openPane(host);

    return { text: "Agents pane shown." };
  });

  on("agent.spawn", async ($, e, next) => {
    const result = await next(e);
    const { agentId } = result;

    if (agentId !== undefined) {
      const now = await $.clock.now();
      const description = lineOf(e.description);

      upsert(agentId, now, (one) => ({
        ...one,
        label: !one.isListed && description !== "" ? description : one.label,
        type: one.isListed ? one.type : e.subagentType,
        model: one.model ?? result.model,
        parentId: one.parentId ?? e.parentAgentId,
        workflowRun: e.workflow?.runId || one.workflowRun,
        workflowIndex: e.workflow?.agentIndex ?? one.workflowIndex,
        isBackground: e.background,
        status: one.isListed ? one.status : "running",
        endedAt: undefined,
      }));
    }

    return result;
  });

  on("turn.start", async ($, e, next) => {
    const { agentId } = e;

    if (agentId !== undefined) {
      const now = await $.clock.now();
      const prompt = lineOf(e.text);

      upsert(agentId, now, (one) => ({
        ...one,
        label: one.label === one.id && prompt !== "" ? prompt : one.label,
        status: one.isListed ? one.status : "running",
        endedAt: undefined,
      }));
    }

    return next(e);
  });

  on("tool.call", { tool: "Workflow" }, async (_, e, next) => {
    const ran = await next(e);

    if (ran.deny === undefined && ran.isError !== true) {
      const { runId, workflowName } = ran.result;
      const name = workflowName ?? e.name;

      if (runId !== undefined && name !== undefined && name !== "") {
        runs = new Map([...runs, [runId, lineOf(name)]]);
      }
    }

    return ran;
  });

  on("turn.step", async function* observeStep($, e, next) {
    const { agentId } = e;

    if (agentId === undefined) {
      return yield* next(e);
    }

    upsert(agentId, await $.clock.now(), (one) => ({
      ...one,
      model: e.model,
      effort: effortOf(e.effort),
    }));

    const result = yield* next(e);
    const { usage } = result;

    upsert(agentId, await $.clock.now(), (one) => ({
      ...one,
      model: usage?.model ?? one.model,
      steps: one.steps + 1,
      toolCalls: one.toolCalls + result.toolUses.length,
      tokens:
        usage === null
          ? one.tokens
          : {
              input:
                one.tokens.input +
                usage.input_tokens +
                usage.cache_read_input_tokens +
                usage.cache_creation_input_tokens,
              output: one.tokens.output + usage.output_tokens,
            },
    }));

    return result;
  });

  on("session.append", async ($, e, next) => {
    const { agentId, message } = e;

    if (
      agentId !== undefined &&
      (message.type === "user" || message.type === "assistant") &&
      message.isMeta !== true
    ) {
      upsert(agentId, await $.clock.now(), (one) => {
        const added = entriesOf(
          message,
          one.entries.some((entry) => entry.kind === "prompt"),
        );
        const opening = added.find((entry) => entry.kind === "prompt");

        return {
          ...one,
          label:
            !one.isListed && one.label === one.id && opening !== undefined
              ? lineOf(opening.text)
              : one.label,
          entries: [...one.entries, ...added].slice(-MAX_ENTRIES),
        };
      });
    }

    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const { agentId } = e;

    if (agentId !== undefined && agents.has(agentId)) {
      const now = await $.clock.now();

      upsert(agentId, now, (one) => ({
        ...one,
        status: one.isListed ? one.status : statusOfReason(e.reason),
        endedAt: now,
      }));
    }

    return next(e);
  });

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID || e.surface !== "terminal") {
      return next(e);
    }

    const { Box, Text, Button } = $.ui.resolve(e);
    const kit: Kit = { Box, Text, Button };
    const now = await $.clock.now();
    const groups = groupsOf(agents, runs);
    const ordered = groups.flatMap(({ members }) =>
      members.map(({ agent }) => agent),
    );
    const selected =
      agents.get(selectedId ?? "") ??
      ordered.find((one) => isLive(one.status)) ??
      ordered[0];
    const running = ordered.filter((one) => isLive(one.status)).length;

    return (
      <Box flexDirection="column" paddingRight={1}>
        <Text bold>
          Agents <Text color="yellow">{running} running</Text>
          <Text dimColor> / {ordered.length} total</Text>
        </Text>
        {syncNote === undefined ? undefined : (
          <Text color="yellow" wrap="truncate-end">
            {syncNote}
          </Text>
        )}
        {ordered.length === 0 ? (
          <Text dimColor>No subagents in this session yet.</Text>
        ) : (
          <Box flexDirection="column">
            {groups.map((group) => (
              <Box key={`group:${group.key}`} flexDirection="column">
                <Text wrap="truncate-end">
                  <Text bold color="cyan">
                    {group.title}
                  </Text>
                  <Text dimColor> {group.note}</Text>
                </Text>
                {group.members.map(({ agent: one, depth }) => {
                  const isSelected = one.id === selected?.id;
                  const meta = [chipOf(one), runnerOf(one), elapsedOf(one, now)]
                    .filter((part) => part !== "")
                    .join(" · ");

                  return (
                    <Button
                      key={`agent:${one.id}`}
                      plain
                      dimColor={!isSelected}
                      onPress={() => {
                        selectedId = one.id;
                        syncedAt = Number.NEGATIVE_INFINITY;

                        if (host !== null) {
                          void requestSummary(host, one.id);
                        }
                        host?.redraw();
                      }}
                    >
                      {isSelected ? "❯ " : "  "}
                      {"  ".repeat(depth)}
                      {depth > 0 ? "└ " : ""}
                      <Text color={colorOf(one.status)}>
                        {glyphOf(one.status)}
                      </Text>{" "}
                      {one.label}
                      <Text dimColor> {meta}</Text>
                    </Button>
                  );
                })}
              </Box>
            ))}
          </Box>
        )}
        <Text dimColor>{"─".repeat(Math.max(1, e.props.bodyColumns - 1))}</Text>
        {detailView(
          kit,
          selected === undefined
            ? undefined
            : detailOf(selected, runs, now, summaries.get(selected.id)),
          {
            isExpanded: selected !== undefined && expandedIds.has(selected.id),
            onToggle: () => {
              if (selected === undefined) {
                return;
              }

              expandedIds = expandedIds.has(selected.id)
                ? new Set([...expandedIds].filter((id) => id !== selected.id))
                : new Set([...expandedIds, selected.id]);
              host?.redraw();
            },
          },
        )}
      </Box>
    );
  });

  on("ui.close", { id: PANE_ID }, (_, e, next) => {
    isOpen = false;

    return next(e);
  });
};
