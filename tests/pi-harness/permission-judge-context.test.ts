import { afterEach, describe, expect, test } from "bun:test";
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
import {
  boundTaskContext,
  createPermissionTaskTracker,
  discoverProjectContext,
  runGitWorktreeList,
  type GitWorktreeListResult,
} from "../../pi/extensions/pi-harness/features/permission-policy/context";

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

  test("waits to promote a queued expanded skill until its user message is delivered", () => {
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
    expect(currentTask(tracker)?.text).toBe(
      "/skill:start-work implement the change",
    );
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

describe("permission judge project context", () => {
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
      Buffer.from([
        0x77, 0x6f, 0x72, 0x6b, 0x74, 0x72, 0x65, 0x65, 0x20, 0xff, 0,
      ]),
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
    });
    expect(context).toMatchObject({
      kind: "git",
      activeWorktree: main,
      navigableRoots: [main],
      worktrees: [main],
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
    const active = roots[0];
    const target = roots[17];
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
