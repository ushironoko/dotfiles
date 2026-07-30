import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  boundTaskContext,
  createPermissionTaskTracker,
  DEFAULT_GIT_TIMEOUT_MS,
  derivePermissionRunEvidence,
  discoverProjectContext,
  runGitWorktreeList,
  type GitWorktreeListResult,
} from "../../pi/extensions/pi-harness/features/permission-policy/context";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const worktreeOutput = (...records: string[][]): Uint8Array =>
  Buffer.from(
    records.map((fields) => `${fields.join("\0")}\0\0`).join(""),
    "utf8",
  );

const ok = (stdout: Uint8Array): GitWorktreeListResult => ({
  kind: "ok",
  stdout,
});

const createTestAbortController = (): {
  signal: AbortSignal;
  abort: () => void;
} => {
  const value: unknown = new AbortController();
  if (
    typeof value !== "object" ||
    value === null ||
    !("abort" in value) ||
    typeof value.abort !== "function" ||
    !("signal" in value)
  ) {
    throw new Error("AbortController is unavailable");
  }
  const { abort, signal } = value;
  return {
    signal: signal as AbortSignal,
    abort: () => Reflect.apply(abort, value, []),
  };
};

const currentTask = (
  tracker: ReturnType<typeof createPermissionTaskTracker>,
) => {
  const state = tracker.current();
  return state.correlation === "task" ? state.task : undefined;
};

describe("current permission task context", () => {
  test("bounds model-visible text but fingerprints the complete raw input", () => {
    const prefix = "x".repeat(1_024);
    const first = boundTaskContext(`${prefix}A\u0000`, "interactive");
    const second = boundTaskContext(`${prefix}B\u0000`, "interactive");

    expect(first).toBeDefined();
    expect(Buffer.byteLength(first?.text ?? "")).toBeLessThanOrEqual(1_024);
    expect(first?.text).not.toContain("\u0000");
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  test("promotes matching raw input only when its agent run starts", () => {
    const tracker = createPermissionTaskTracker();
    tracker.capture({
      text: "Run the focused tests",
      source: "interactive",
    });

    expect(tracker.current()).toEqual({ correlation: "none" });
    tracker.activate("Run the focused tests");
    expect(tracker.current()).toMatchObject({
      correlation: "task",
      task: { text: "Run the focused tests", source: "interactive" },
    });

    tracker.activate("automatic retry after compaction");
    expect(currentTask(tracker)?.text).toBe("Run the focused tests");

    tracker.capture({
      text: "Then lint",
      source: "interactive",
      streamingBehavior: "followUp",
    });
    expect(currentTask(tracker)?.text).toBe("Run the focused tests");
    tracker.settle();
    expect(tracker.current()).toEqual({ correlation: "none" });

    tracker.activate("Then lint");
    expect(tracker.current()).toEqual({ correlation: "none" });
    tracker.capture({ text: "Fresh task", source: "interactive" });
    tracker.activate("Fresh task");
    expect(currentTask(tracker)?.text).toBe("Fresh task");
  });

  test("promotes queued steering input only on a positive append-only delta", () => {
    const tracker = createPermissionTaskTracker();
    tracker.capture({ text: "Initial task", source: "interactive" });
    tracker.activate("Initial task");
    const previousMessages = [{ role: "user", content: "Initial task" }];
    tracker.activateFromMessages(previousMessages);
    tracker.capture({
      text: "Now run lint",
      source: "interactive",
      streamingBehavior: "steer",
    });

    tracker.activateFromMessages(previousMessages);
    expect(currentTask(tracker)?.text).toBe("Initial task");

    tracker.activateFromMessages([
      ...previousMessages,
      { role: "assistant", content: [] },
      {
        role: "user",
        content: [{ type: "text", text: "Now run lint" }],
      },
    ]);
    expect(currentTask(tracker)?.text).toBe("Now run lint");
  });

  test("uses steering-before-followUp delivery order for a multi-message delta", () => {
    const tracker = createPermissionTaskTracker();
    const previousMessages = [{ role: "user", content: "Initial task" }];
    tracker.activateFromMessages(previousMessages);
    tracker.capture({
      text: "Follow-up task",
      source: "interactive",
      streamingBehavior: "followUp",
    });
    tracker.capture({
      text: "Steering task",
      source: "interactive",
      streamingBehavior: "steer",
    });

    tracker.activateFromMessages([
      ...previousMessages,
      { role: "user", content: "Steering task" },
      { role: "user", content: "Follow-up task" },
    ]);
    expect(currentTask(tracker)?.text).toBe("Follow-up task");
  });

  test("fails closed when a queued expandable input cannot be matched exactly", () => {
    const tracker = createPermissionTaskTracker();
    tracker.capture({ text: "Initial task", source: "interactive" });
    tracker.activate("Initial task");
    const previousMessages = [{ role: "user", content: "Initial task" }];
    tracker.activateFromMessages(previousMessages);
    tracker.capture({
      text: "/skill:start-work implement the change",
      source: "interactive",
      streamingBehavior: "followUp",
    });

    tracker.activateFromMessages(previousMessages);
    expect(currentTask(tracker)?.text).toBe("Initial task");

    tracker.activateFromMessages([
      ...previousMessages,
      { role: "assistant", content: [] },
      { role: "user", content: "<expanded SKILL.md contents from disk>" },
    ]);
    expect(tracker.current()).toEqual({ correlation: "uncorrelated" });
  });

  test("keeps raw expandable invocations instead of expanded contents", () => {
    const tracker = createPermissionTaskTracker();
    tracker.capture({
      text: "/skill:start-work implement the change",
      source: "rpc",
    });
    tracker.activate("<expanded SKILL.md contents from disk>");
    expect(tracker.current()).toMatchObject({
      correlation: "task",
      task: {
        text: "/skill:start-work implement the change",
        source: "rpc",
      },
    });

    tracker.settle();
    tracker.capture({
      text: "/review parser changes",
      source: "interactive",
    });
    tracker.activate("<expanded prompt template Markdown>");
    expect(currentTask(tracker)?.text).toBe("/review parser changes");
  });

  test("marks stale, ambiguous, overflowed, and unbaselined queues uncorrelated", () => {
    const stale = createPermissionTaskTracker();
    stale.capture({ text: "handled elsewhere", source: "extension" });
    stale.capture({ text: "actual task", source: "interactive" });
    stale.activate("actual task");
    expect(stale.current()).toEqual({ correlation: "uncorrelated" });

    const ambiguous = createPermissionTaskTracker();
    const baseline = [{ role: "user", content: "Initial" }];
    ambiguous.activateFromMessages(baseline);
    ambiguous.capture({
      text: "same",
      source: "interactive",
      streamingBehavior: "steer",
    });
    ambiguous.capture({
      text: "same",
      source: "rpc",
      streamingBehavior: "steer",
    });
    ambiguous.activateFromMessages([
      ...baseline,
      { role: "user", content: "same" },
    ]);
    expect(ambiguous.current()).toEqual({ correlation: "uncorrelated" });

    const unbaselined = createPermissionTaskTracker();
    unbaselined.capture({
      text: "queued",
      source: "interactive",
      streamingBehavior: "steer",
    });
    unbaselined.activateFromMessages([{ role: "user", content: "queued" }]);
    expect(unbaselined.current()).toEqual({ correlation: "uncorrelated" });

    const overflowed = createPermissionTaskTracker();
    overflowed.activateFromMessages(baseline);
    for (let index = 0; index < 9; index += 1) {
      overflowed.capture({
        text: `queued-${index}`,
        source: "interactive",
        streamingBehavior: "steer",
      });
    }
    overflowed.activateFromMessages([
      ...baseline,
      { role: "user", content: "queued-0" },
    ]);
    expect(overflowed.current()).toEqual({ correlation: "uncorrelated" });
  });

  test("invalidates a pending queue when user history shrinks", () => {
    const tracker = createPermissionTaskTracker();
    const baseline = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ];
    tracker.activateFromMessages(baseline);
    tracker.capture({
      text: "queued",
      source: "interactive",
      streamingBehavior: "followUp",
    });
    tracker.activateFromMessages([{ role: "user", content: "second" }]);
    expect(tracker.current()).toEqual({ correlation: "uncorrelated" });
  });
});

describe("current permission run evidence", () => {
  test("binds assistant text, AskUserQuestion results, and prior metadata to the exact tool call", () => {
    const evidence = derivePermissionRunEvidence(
      [
        {
          type: "message",
          message: {
            role: "user",
            content: "Old task",
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "OLD ASSISTANT CONTEXT" }],
          },
        },
        {
          type: "message",
          message: {
            role: "user",
            content: "Diagnose permission prompts",
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Inspect the policy implementation." },
              {
                type: "toolCall",
                id: "prior-call",
                name: "read",
                arguments: { path: "PRIVATE ARGUMENT" },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "prior-call",
            toolName: "read",
            content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }],
            details: { secret: "PRIVATE DETAILS" },
            isError: false,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "question-call",
                name: "AskUserQuestion",
                arguments: { questions: "PRIVATE QUESTION ARGUMENTS" },
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "question-call",
            toolName: "AskUserQuestion",
            content: [
              {
                type: "text",
                text: 'Your questions have been answered: "Run tests?"="Allow".',
              },
            ],
            details: { secret: "PRIVATE ASK DETAILS" },
            isError: false,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "PRIVATE THINKING" },
              { type: "text", text: "Now inspect the local judge logs." },
              {
                type: "toolCall",
                id: "current-call",
                name: "bash",
                arguments: { command: "PRIVATE CURRENT ARGUMENT" },
              },
            ],
          },
        },
      ],
      "current-call",
      {
        matchesAskUserQuestionResult: (id, text) =>
          id === "question-call" &&
          text === 'Your questions have been answered: "Run tests?"="Allow".',
      },
    );

    expect(evidence).toMatchObject({
      assistantText:
        "Inspect the policy implementation.\nNow inspect the local judge logs.",
      askUserQuestionResultText:
        'Your questions have been answered: "Run tests?"="Allow".',
      priorToolResults: [
        { toolName: "read", status: "ok" },
        { toolName: "AskUserQuestion", status: "ok" },
      ],
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("OLD ASSISTANT CONTEXT");
    expect(serialized).not.toContain("PRIVATE ARGUMENT");
    expect(serialized).not.toContain("PRIVATE QUESTION ARGUMENTS");
    expect(serialized).not.toContain("PRIVATE TOOL OUTPUT");
    expect(serialized).not.toContain("PRIVATE DETAILS");
    expect(serialized).not.toContain("PRIVATE ASK DETAILS");
    expect(serialized).not.toContain("PRIVATE THINKING");
  });

  test("excludes failed, reordered, lookalike, orphaned, and duplicate AskUserQuestion results", () => {
    const evidence = derivePermissionRunEvidence(
      [
        { type: "message", message: { role: "user", content: "task" } },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "reordered-question",
            toolName: "AskUserQuestion",
            content: [{ type: "text", text: "REORDERED PRIVATE RESULT" }],
            isError: false,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "reordered-question",
                name: "AskUserQuestion",
              },
              {
                type: "toolCall",
                id: "failed-question",
                name: "AskUserQuestion",
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "failed-question",
            toolName: "AskUserQuestion",
            content: [{ type: "text", text: "FAILED PRIVATE RESULT" }],
            isError: true,
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "lookalike-question",
            toolName: "askUserQuestion",
            content: [{ type: "text", text: "LOOKALIKE PRIVATE RESULT" }],
            isError: false,
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "orphan-question",
            toolName: "AskUserQuestion",
            content: [{ type: "text", text: "ORPHAN PRIVATE RESULT" }],
            isError: false,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "duplicate-question",
                name: "AskUserQuestion",
              },
            ],
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "duplicate-question",
            toolName: "AskUserQuestion",
            content: [{ type: "text", text: "DUPLICATE PRIVATE RESULT 1" }],
            isError: false,
          },
        },
        {
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "duplicate-question",
            toolName: "AskUserQuestion",
            content: [{ type: "text", text: "DUPLICATE PRIVATE RESULT 2" }],
            isError: false,
          },
        },
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "current", name: "bash" }],
          },
        },
      ],
      "current",
      { matchesAskUserQuestionResult: () => true },
    );

    expect(evidence?.askUserQuestionResultText).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toContain("PRIVATE RESULT");
  });

  test("retains only the latest authenticated AskUserQuestion result", () => {
    const questionTurn = (id: string, result: string): unknown[] => [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id, name: "AskUserQuestion" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: id,
          toolName: "AskUserQuestion",
          content: [{ type: "text", text: result }],
          isError: false,
        },
      },
    ];
    const evidence = derivePermissionRunEvidence(
      [
        { type: "message", message: { role: "user", content: "task" } },
        ...questionTurn("first-question", "STALE RESULT"),
        ...questionTurn("latest-question", "LATEST RESULT"),
        {
          type: "message",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: "current", name: "bash" }],
          },
        },
      ],
      "current",
      {
        matchesAskUserQuestionResult: (id, text) =>
          (id === "first-question" && text === "STALE RESULT") ||
          (id === "latest-question" && text === "LATEST RESULT"),
      },
    );

    expect(evidence?.askUserQuestionResultText).toBe("LATEST RESULT");
  });

  test.each(["missing", "modified"] as const)(
    "does not fall back to older approval when a later result is %s",
    (laterResult) => {
      const laterQuestion: unknown[] = [
        {
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "later-question",
                name: "AskUserQuestion",
              },
            ],
          },
        },
        ...(laterResult === "missing"
          ? []
          : [
              {
                type: "message",
                message: {
                  role: "toolResult",
                  toolCallId: "later-question",
                  toolName: "AskUserQuestion",
                  content: [{ type: "text", text: "MODIFIED RESULT" }],
                  isError: false,
                },
              },
            ]),
      ];
      const evidence = derivePermissionRunEvidence(
        [
          { type: "message", message: { role: "user", content: "task" } },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "approved-question",
                  name: "AskUserQuestion",
                },
              ],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "approved-question",
              toolName: "AskUserQuestion",
              content: [{ type: "text", text: "APPROVED RESULT" }],
              isError: false,
            },
          },
          ...laterQuestion,
          {
            type: "message",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "current", name: "bash" }],
            },
          },
        ],
        "current",
        {
          matchesAskUserQuestionResult: (id, text) =>
            id === "approved-question" && text === "APPROVED RESULT",
        },
      );

      expect(evidence?.askUserQuestionResultText).toBeUndefined();
    },
  );

  test("fails closed on a missing or duplicate current tool identity", () => {
    const assistant = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Inspect" },
          { type: "toolCall", id: "same", name: "bash", arguments: {} },
        ],
      },
    };
    expect(derivePermissionRunEvidence([assistant], "missing")).toBeUndefined();
    expect(
      derivePermissionRunEvidence([assistant, assistant], "same"),
    ).toBeUndefined();
  });

  test("omits serialized-overlimit question text while fingerprinting complete evidence", () => {
    const boundedQuestionResult = `QUESTION="APPROVED" ${'"\\\n'.repeat(2_000)}`;
    const matchesBoundedQuestionResult = (expected: string) => ({
      matchesAskUserQuestionResult: (id: string, text: string): boolean =>
        id === "bounded-question" && text === expected,
    });
    const entries: unknown[] = [
      { type: "message", message: { role: "user", content: "task" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `${"a".repeat(3_000)}TAIL` }],
        },
      },
    ];
    for (let index = 0; index < 20; index += 1) {
      entries.push({
        type: "message",
        message: {
          role: "toolResult",
          toolName: `tool-${index}`,
          isError: index % 2 === 0,
        },
      });
    }
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "bounded-question", name: "AskUserQuestion" },
        ],
      },
    });
    const questionResultIndex = entries.length;
    entries.push({
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "bounded-question",
        toolName: "AskUserQuestion",
        content: [{ type: "text", text: boundedQuestionResult }],
        isError: false,
      },
    });
    entries.push({
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "current", name: "bash" }],
      },
    });

    const first = derivePermissionRunEvidence(
      entries,
      "current",
      matchesBoundedQuestionResult(boundedQuestionResult),
    );
    expect(Buffer.byteLength(first?.assistantText ?? "")).toBeLessThanOrEqual(
      2 * 1_024,
    );
    expect(first?.assistantText).toEndWith("TAIL");
    expect(
      Buffer.byteLength(JSON.stringify(boundedQuestionResult)),
    ).toBeGreaterThan(2 * 1_024);
    expect(first?.askUserQuestionResultText).toBeUndefined();
    expect(first?.priorToolResults).toHaveLength(16);
    expect(first?.priorToolResults[0]?.toolName).toBe("tool-5");

    const changed = structuredClone(entries) as Record<string, unknown>[];
    const assistantEntry = changed[1] as {
      message: { content: { text: string }[] };
    };
    const [assistantBlock] = assistantEntry.message.content;
    if (!assistantBlock) throw new Error("missing assistant content block");
    assistantBlock.text = `${"b".repeat(3_000)}TAIL`;
    expect(
      derivePermissionRunEvidence(
        changed,
        "current",
        matchesBoundedQuestionResult(boundedQuestionResult),
      )?.fingerprint,
    ).not.toBe(first?.fingerprint);

    const changedQuestion = structuredClone(entries) as Record<
      string,
      unknown
    >[];
    const questionEntry = changedQuestion[questionResultIndex] as {
      message: { content: { text: string }[] };
    };
    const [questionBlock] = questionEntry.message.content;
    if (!questionBlock) throw new Error("missing question result block");
    const changedQuestionResult = `QUESTION="APPROVED" ${'"\\\n'.repeat(1_999)}r`;
    questionBlock.text = changedQuestionResult;
    expect(
      derivePermissionRunEvidence(
        changedQuestion,
        "current",
        matchesBoundedQuestionResult(changedQuestionResult),
      )?.fingerprint,
    ).not.toBe(first?.fingerprint);
  });
});

describe("permission judge project context", () => {
  test("uses a one-second default Git probe timeout", () => {
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(1_000);
  });

  test("discovers the real active linked worktree", async () => {
    const repoRoot = await realpath(resolve(import.meta.dir, "../.."));
    const context = await discoverProjectContext(repoRoot);

    expect(context.kind).toBe("git");
    if (context.kind !== "git")
      throw new Error(`expected git: ${context.kind}`);
    expect(context.activeWorktree).toBe(repoRoot);
    expect(context.navigableRoots).toContain(repoRoot);
    expect(context.worktrees).toContain(repoRoot);
  });

  test("discovers, canonicalizes, deduplicates, and identifies linked worktrees", async () => {
    const parent = await tempRoot("judge-project-");
    const main = join(parent, "project");
    const linked = join(parent, "project-feature");
    const sub = join(linked, "packages", "app");
    const alias = join(parent, "project-alias");
    await mkdir(main);
    await mkdir(sub, { recursive: true });
    await symlink(main, alias);

    const context = await discoverProjectContext(sub, {
      runGit: async () =>
        ok(
          worktreeOutput(
            [`worktree ${main}`, "HEAD a", "branch refs/heads/main"],
            [`worktree ${linked}`, "HEAD b", "branch refs/heads/feature"],
            [`worktree ${alias}`, "HEAD a", "branch refs/heads/main"],
          ),
        ),
      runGitCommonDir: async () => "/common/.git",
    });

    expect(context).toMatchObject({
      kind: "git",
      name: "project",
      cwd: sub,
      activeWorktree: linked,
      navigableRoots: [main, linked].sort(),
      worktrees: [linked, main],
    });
    if (context.kind !== "git") throw new Error("expected git context");
    expect(context.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  test("uses a bare repository for identity but never as navigable worktree scope", async () => {
    const parent = await tempRoot("judge-bare-");
    const bare = join(parent, "project.git");
    const linked = join(parent, "project-feature");
    const sub = join(linked, "packages", "app");
    await mkdir(bare);
    await mkdir(sub, { recursive: true });

    const context = await discoverProjectContext(sub, {
      runGit: async () =>
        ok(
          worktreeOutput(
            [`worktree ${bare}`, "bare"],
            [`worktree ${linked}`, "HEAD b", "branch refs/heads/feature"],
          ),
        ),
      runGitCommonDir: async () => "/common/.git",
    });

    expect(context).toMatchObject({
      kind: "git",
      name: "project.git",
      cwd: sub,
      activeWorktree: linked,
      worktrees: [linked],
    });
    if (context.kind !== "git") throw new Error("expected git context");
    expect(context.worktrees).not.toContain(bare);
  });

  test("distinguishes verified non-git state from unavailable discovery", async () => {
    const cwd = await tempRoot("judge-non-git-");
    const nonGit = await discoverProjectContext(cwd, {
      runGit: async () => ({ kind: "non-git" }),
    });
    const unavailable = await discoverProjectContext(cwd, {
      runGit: async () => ({ kind: "unavailable", reason: "timed out" }),
    });

    expect(nonGit).toMatchObject({ kind: "non-git", cwd });
    expect(unavailable).toMatchObject({
      kind: "unavailable",
      cwd,
      reason: "timed out",
    });
  });

  test.each([
    ["missing final NUL", Buffer.from("worktree /tmp/repo")],
    ["missing empty-record separator", Buffer.from("worktree /tmp/repo\0")],
    [
      "invalid UTF-8",
      Buffer.from([119, 111, 114, 107, 116, 114, 101, 101, 32, 255, 0]),
    ],
    [
      "control character in path",
      worktreeOutput(["worktree /tmp/bad\npath", "HEAD a"]),
    ],
    ["relative worktree path", worktreeOutput(["worktree relative", "HEAD a"])],
    [
      "duplicate worktree path",
      worktreeOutput(
        ["worktree /tmp/repo", "HEAD a"],
        ["worktree /tmp/repo", "HEAD b", "detached"],
      ),
    ],
    [
      "unknown record field",
      worktreeOutput(["worktree /tmp/repo", "HEAD a", "future-field x"]),
    ],
    [
      "conflicting branch state",
      worktreeOutput([
        "worktree /tmp/repo",
        "HEAD a",
        "branch refs/heads/main",
        "detached",
      ]),
    ],
    ["oversized output", Buffer.alloc(64 * 1_024 + 1, 0x61)],
  ])("marks malformed Git output unavailable: %s", async (_label, stdout) => {
    const cwd = await tempRoot("judge-malformed-");
    const context = await discoverProjectContext(cwd, {
      runGit: async () => ok(stdout),
    });
    expect(context).toMatchObject({
      kind: "unavailable",
      reason: "git returned malformed worktree data",
    });
  });

  test("skips a missing worktree only when Git marks it prunable", async () => {
    const parent = await tempRoot("judge-prunable-");
    const main = join(parent, "project");
    const missing = join(parent, "missing");
    const recreated = join(parent, "recreated-prunable");
    await mkdir(main);
    await mkdir(recreated);

    const context = await discoverProjectContext(main, {
      runGit: async () =>
        ok(
          worktreeOutput(
            [`worktree ${main}`, "HEAD a", "branch refs/heads/main"],
            [
              `worktree ${missing}`,
              "HEAD b",
              "prunable gitdir file points to non-existent location",
            ],
            [
              `worktree ${recreated}`,
              "HEAD c",
              "prunable stale administrative record",
            ],
          ),
        ),
      runGitCommonDir: async () => "/common/.git",
    });
    expect(context).toMatchObject({
      kind: "git",
      activeWorktree: main,
      navigableRoots: [main],
      worktrees: [main],
    });
  });

  test("rejects a non-prunable worktree path owned by another repository", async () => {
    const parent = await tempRoot("judge-stale-worktree-");
    const main = join(parent, "project");
    const stale = join(parent, "stale-linked-worktree");
    await Promise.all([mkdir(main), mkdir(stale)]);

    const context = await discoverProjectContext(main, {
      runGit: async () =>
        ok(
          worktreeOutput(
            [`worktree ${main}`, "HEAD a", "branch refs/heads/main"],
            [`worktree ${stale}`, "HEAD b", "branch refs/heads/stale"],
          ),
        ),
      runGitCommonDir: async (cwd) =>
        cwd === stale ? "/unrelated/.git" : "/common/.git",
    });

    expect(context).toMatchObject({
      kind: "unavailable",
      reason: "git returned a worktree from a different repository",
    });
  });

  test("rejects a real stale worktree path replaced by another repository", async () => {
    const parent = await tempRoot("judge-real-stale-worktree-");
    const main = join(parent, "project");
    const stale = join(parent, "stale-linked-worktree");
    await mkdir(main);
    await execFileAsync("git", ["init", "-q"], { cwd: main });
    await writeFile(join(main, "tracked.txt"), "tracked\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: main });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Pi Test",
        "-c",
        "user.email=pi@example.invalid",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd: main },
    );
    await execFileAsync(
      "git",
      ["worktree", "add", "-qb", "stale-review", stale],
      { cwd: main },
    );
    await rm(stale, { recursive: true, force: true });
    await mkdir(stale);
    await execFileAsync("git", ["init", "-q"], { cwd: stale });

    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      { cwd: main },
    );
    expect(stdout).toContain(`worktree ${stale}`);
    const context = await discoverProjectContext(main, { timeoutMs: 1_000 });
    expect(context).toMatchObject({
      kind: "unavailable",
      reason: "git returned a worktree from a different repository",
    });
  });

  test("precomputes registered-worktree, nested-repo, and symlink-escape navigation", async () => {
    const parent = await tempRoot("judge-navigation-");
    const main = join(parent, "project");
    const nested = join(main, "vendor", "nested");
    const outside = join(parent, "outside");
    const escape = join(main, "escape");
    await mkdir(nested, { recursive: true });
    await mkdir(outside);
    await symlink(outside, escape);
    const runGit = async () =>
      ok(
        worktreeOutput([
          `worktree ${main}`,
          "HEAD a",
          "branch refs/heads/main",
        ]),
      );
    const runGitCommonDir = async (cwd: string) =>
      cwd === nested ? "/different/.git" : "/common/.git";

    const listed = await discoverProjectContext(main, {
      runGit,
      runGitCommonDir,
      leadingCdTarget: main,
    });
    const nestedRepo = await discoverProjectContext(main, {
      runGit,
      runGitCommonDir,
      leadingCdTarget: nested,
    });
    const symlinkEscape = await discoverProjectContext(main, {
      runGit,
      runGitCommonDir,
      leadingCdTarget: escape,
    });

    expect(listed.leadingNavigation).toEqual({
      scope: "listed-worktree",
      sameRepository: true,
    });
    expect(nestedRepo.leadingNavigation).toEqual({
      scope: "unverified",
      sameRepository: false,
    });
    expect(symlinkEscape.leadingNavigation).toEqual({
      scope: "outside-listed-worktrees",
      sameRepository: false,
    });
  });

  test("uses complete navigable roots beyond the display limit", async () => {
    const parent = await tempRoot("judge-many-worktrees-");
    const roots = Array.from({ length: 18 }, (_, index) =>
      join(parent, `project-${String(index).padStart(2, "0")}`),
    );
    await Promise.all(roots.map((root) => mkdir(root)));
    const [active] = roots;
    const target = roots.at(17);
    if (active === undefined || target === undefined) {
      throw new Error("missing test roots");
    }
    const context = await discoverProjectContext(active, {
      runGit: async () =>
        ok(
          worktreeOutput(
            ...roots.map((root, index) => [
              `worktree ${root}`,
              `HEAD ${index}`,
              `branch refs/heads/worktree-${index}`,
            ]),
          ),
        ),
      runGitCommonDir: async () => "/common/.git",
      leadingCdTarget: target,
    });

    expect(context.kind).toBe("git");
    if (context.kind !== "git") throw new Error("expected git context");
    expect(context.worktrees).toHaveLength(16);
    expect(context.worktrees).not.toContain(target);
    expect(context.navigableRoots).toContain(target);
    expect(context.leadingNavigation).toEqual({
      scope: "listed-worktree",
      sameRepository: true,
    });
  });

  test("bounds all discovery phases by one cumulative deadline", async () => {
    const cwd = await tempRoot("judge-cumulative-deadline-");
    const startedAt = performance.now();
    const context = await discoverProjectContext(cwd, {
      timeoutMs: 50,
      canonicalizeDirectory: async (path) => {
        await Bun.sleep(20);
        return path;
      },
      runGit: async () => {
        await Bun.sleep(20);
        return ok(
          worktreeOutput([
            `worktree ${cwd}`,
            "HEAD a",
            "branch refs/heads/main",
          ]),
        );
      },
    });

    expect(context).toMatchObject({
      kind: "unavailable",
      reason: "project discovery timed out",
    });
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  test("bounds canonicalization inside the whole discovery deadline", async () => {
    const cwd = await tempRoot("judge-deadline-");
    let canonicalizeCalls = 0;
    const startedAt = performance.now();
    const context = await discoverProjectContext(cwd, {
      timeoutMs: 20,
      runGit: async () =>
        ok(
          worktreeOutput([
            `worktree ${cwd}`,
            "HEAD a",
            "branch refs/heads/main",
          ]),
        ),
      canonicalizeDirectory: async (path) => {
        canonicalizeCalls += 1;
        if (canonicalizeCalls === 1) return path;
        return new Promise<string | undefined>(() => {});
      },
    });

    expect(context).toMatchObject({
      kind: "unavailable",
      reason: "project discovery timed out",
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("parent abort releases discovery during canonicalization", async () => {
    const cwd = await tempRoot("judge-canonical-abort-");
    const controller = createTestAbortController();
    let canonicalizeCalls = 0;
    let enteredSlowCanonicalization: (() => void) | undefined;
    const entered = new Promise<void>((resolveEntered) => {
      enteredSlowCanonicalization = resolveEntered;
    });
    const pending = discoverProjectContext(
      cwd,
      {
        timeoutMs: 1_000,
        runGit: async () =>
          ok(
            worktreeOutput([
              `worktree ${cwd}`,
              "HEAD a",
              "branch refs/heads/main",
            ]),
          ),
        canonicalizeDirectory: async (path) => {
          canonicalizeCalls += 1;
          if (canonicalizeCalls === 1) return path;
          enteredSlowCanonicalization?.();
          return new Promise<string | undefined>(() => {});
        },
      },
      controller.signal,
    );
    await entered;
    controller.abort();

    expect(await pending).toMatchObject({
      kind: "unavailable",
      reason: "project discovery was cancelled",
    });
  });

  test("the Git runner includes async environment building in its timeout", async () => {
    const cwd = await tempRoot("judge-env-timeout-");
    const marker = join(cwd, "spawned");
    const fakeGit = join(cwd, "fake-git");
    await writeFile(fakeGit, `#!/bin/sh\ntouch ${marker}\n`, "utf8");
    await chmod(fakeGit, 0o755);

    const result = await runGitWorktreeList(cwd, undefined, {
      gitExecutable: fakeGit,
      timeoutMs: 20,
      buildEnv: async () => new Promise<Record<string, string>>(() => {}),
    });
    expect(result).toEqual({
      kind: "unavailable",
      reason: "git worktree discovery timed out",
    });
    expect(await Bun.file(marker).exists()).toBe(false);
  });

  test("the real Git runner distinguishes timeout and parent abort", async () => {
    const cwd = await tempRoot("judge-runner-");
    const fakeGit = join(cwd, "fake-git");
    await writeFile(fakeGit, "#!/bin/sh\ntrap '' TERM\nsleep 2\n", "utf8");
    await chmod(fakeGit, 0o755);

    const startedAt = performance.now();
    const timedOut = await runGitWorktreeList(cwd, undefined, {
      gitExecutable: fakeGit,
      timeoutMs: 20,
    });
    expect(timedOut).toEqual({
      kind: "unavailable",
      reason: "git worktree discovery timed out",
    });
    expect(performance.now() - startedAt).toBeLessThan(500);

    const controller = createTestAbortController();
    const pending = runGitWorktreeList(cwd, controller.signal, {
      gitExecutable: fakeGit,
      timeoutMs: 1_000,
    });
    controller.abort();
    expect(await pending).toEqual({
      kind: "unavailable",
      reason: "project discovery was cancelled",
    });
  });
});
