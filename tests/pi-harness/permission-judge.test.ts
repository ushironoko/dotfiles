import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  type PermissionJudgeConfig,
} from "../../pi/extensions/pi-harness/config";
import {
  BoundedCommandError,
  type BoundedCommandOptions,
  type BoundedCommandResult,
  type RunBoundedCommand,
} from "../../pi/extensions/pi-harness/lib/bounded-process";
import {
  createAbortController,
  isAbortSignal,
} from "../../pi/extensions/pi-harness/lib/abort";
import {
  createPermissionJudge,
  PERMISSION_JUDGE_POLICY_VERSION,
  PERMISSION_JUDGE_REASONING_EFFORT,
} from "../../pi/extensions/pi-harness/features/permission-policy/judge";
import type {
  BoundedTaskContext,
  PermissionProjectContext,
  PermissionRunEvidence,
} from "../../pi/extensions/pi-harness/features/permission-policy/context";

interface Invocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: BoundedCommandOptions;
}

const encoded = (value: string): Uint8Array => new TextEncoder().encode(value);

const commandResult = (
  stdout: string | Uint8Array,
  exitCode = 0,
): BoundedCommandResult => ({
  exitCode,
  stdout: typeof stdout === "string" ? encoded(stdout) : stdout,
  stderr: new Uint8Array(),
  stdoutTruncated: false,
});

const verdict = (safety: string, relevance = safety): string =>
  JSON.stringify({ safety, relevance });

const runner = (
  outputs: readonly (BoundedCommandResult | Error)[],
): { run: RunBoundedCommand; calls: Invocation[] } => {
  const calls: Invocation[] = [];
  let index = 0;
  const run: RunBoundedCommand = async (command, args, options) => {
    calls.push({ command, args, options });
    const output = outputs[Math.min(index, outputs.length - 1)];
    index += 1;
    if (output === undefined) throw new Error("missing test output");
    if (output instanceof Error) throw output;
    return output;
  };
  return { run, calls };
};

const config = (
  overrides: Partial<PermissionJudgeConfig> = {},
): PermissionJudgeConfig => ({
  ...DEFAULT_PERMISSION_JUDGE_CONFIG,
  ...overrides,
});

const task = (
  text: string,
  fingerprint = `task:${text}`,
): BoundedTaskContext => ({
  text,
  source: "interactive",
  fingerprint,
});

const runEvidence = (fingerprint = "run:a"): PermissionRunEvidence => ({
  assistantText: "Inspect the policy after the failed test.",
  askUserQuestionResultText:
    'Your questions have been answered: "Run the check?"="Allow".',
  priorToolResults: [
    { toolName: "bash", status: "error" },
    { toolName: "read", status: "ok" },
  ],
  fingerprint,
});

const project = (fingerprint = "project:a"): PermissionProjectContext => ({
  kind: "git",
  name: "project",
  cwd: "/private/project-worktree/packages/app",
  activeWorktree: "/private/project-worktree",
  navigableRoots: ["/private/project-worktree", "/private/project"],
  worktrees: ["/private/project-worktree", "/private/project"],
  fingerprint,
});

const stdinText = (call: Invocation): string => {
  const { stdin } = call.options;
  if (stdin === undefined) throw new Error("expected stdin");
  return typeof stdin === "string" ? stdin : new TextDecoder().decode(stdin);
};

describe("Codex CLI permission judge", () => {
  test("invokes the pinned model through a bounded non-interactive Codex command", async () => {
    const probe = runner([commandResult(verdict("ALLOW"))]);
    let instructions = "";
    let sourceSchemaFile = "";
    let cleanupCalls = 0;
    const judge = createPermissionJudge(config(), {
      runCommand: probe.run,
      createWorkspace(value, schemaFile) {
        instructions = value;
        sourceSchemaFile = schemaFile;
        return {
          cwd: "/isolated/codex-judge",
          instructionsFile: "/isolated/codex-judge/instructions.md",
          schemaFile: "/isolated/codex-judge/output-schema.json",
          cleanup() {
            cleanupCalls += 1;
          },
        };
      },
      env: {
        HOME: "/home/test",
        PATH: `/usr/bin:${import.meta.dir}`,
        BASH_ENV: "/tmp/injected",
        PWD: "/private/project-worktree",
        OLDPWD: "/private/old-project-worktree",
        INIT_CWD: "/private/project-worktree",
        npm_config_local_prefix: "/private/project-worktree",
        npm_package_json: "/private/project-worktree/package.json",
      },
      schemaFile: "/trusted/judge-schema.json",
    });

    expect(
      await judge.judge("git status --short", {
        cwd: import.meta.dir,
        task: task("Inspect the current repository state"),
        runEvidence: runEvidence(),
        project: project(),
        leadingNavigation: {
          scope: "listed-worktree",
          sameRepository: true,
        },
        gitCwd: { scope: "listed-worktree", sameRepository: true },
        executionBoundary: {
          mode: "sandboxed",
          network: "denied",
          profileFingerprint: "b".repeat(64),
        },
      }),
    ).toMatchObject({ kind: "allow", cached: false });

    expect(probe.calls).toHaveLength(1);
    const [call] = probe.calls;
    if (call === undefined) throw new Error("missing invocation");
    expect(call.command).toBe("codex");
    expect(call.args.slice(0, 18)).toEqual([
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--model",
      "gpt-5.6-luna",
      "-c",
      'model_instructions_file="/isolated/codex-judge/instructions.md"',
      "-c",
      'model_reasoning_effort="low"',
    ]);
    expect(
      call.args.filter((_value, index) => call.args[index - 1] === "--disable"),
    ).toEqual([
      "apps",
      "auth_elicitation",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "code_mode_host",
      "computer_use",
      "guardian_approval",
      "hooks",
      "image_generation",
      "multi_agent",
      "multi_agent_v2",
      "plugins",
      "shell_snapshot",
      "shell_tool",
      "skill_mcp_dependency_install",
      "skill_search",
      "standalone_web_search",
      "tool_call_mcp_elicitation",
      "tool_suggest",
      "unified_exec",
      "workspace_dependencies",
    ]);
    expect(call.args.slice(-3)).toEqual([
      "--output-schema",
      "/isolated/codex-judge/output-schema.json",
      "-",
    ]);
    expect(call.options.cwd).toBe("/isolated/codex-judge");
    expect(call.options.timeoutMs).toBe(30_000);
    expect(call.options.stdinMaxBytes).toBe(20 * 1024);
    expect(call.options.stdoutMaxBytes).toBe(64 * 1024);
    expect(call.options.stderrMaxBytes).toBe(64 * 1024);
    expect(call.options.env.HOME).toBe("/home/test");
    expect(call.options.env.PATH).toBe("/usr/bin");
    expect(call.options.env.PWD).toBe("/isolated/codex-judge");
    expect(call.options.env.BASH_ENV).toBeUndefined();
    expect(call.options.env.OLDPWD).toBeUndefined();
    expect(call.options.env.INIT_CWD).toBeUndefined();
    expect(call.options.env.npm_config_local_prefix).toBeUndefined();
    expect(call.options.env.npm_package_json).toBeUndefined();

    expect(sourceSchemaFile).toBe("/trusted/judge-schema.json");
    expect(instructions).toContain(
      "Never execute, browse, use tools, or investigate.",
    );
    expect(cleanupCalls).toBe(1);
    const prompt = stdinText(call);
    expect(prompt).not.toContain(
      "Never execute, browse, use tools, or investigate.",
    );
    expect(prompt).toContain('"command":"git status --short"');
    expect(prompt).toContain(
      '"currentTask":{"text":"Inspect the current repository state","source":"interactive"}',
    );
    expect(prompt).toContain('"askUserQuestionResultText"');
    expect(prompt).toContain('"kind":"git"');
    expect(prompt).toContain('"executionBoundary":{"mode":"sandboxed"');
    expect(prompt).toContain('"leadingNavigation":{"scope":"listed-worktree"}');
    expect(prompt).toContain('"gitCwd":{"scope":"listed-worktree"}');
  });

  test("propagates a configured model to Codex argv and audit metadata", async () => {
    const model = "gpt-5.6-luna-test-override";
    const probe = runner([commandResult(verdict("ALLOW"))]);
    const outcome = await createPermissionJudge(config({ model }), {
      runCommand: probe.run,
    }).judge("git status");

    const [call] = probe.calls;
    if (call === undefined) throw new Error("missing invocation");
    const modelFlagIndex = call.args.indexOf("--model");
    expect(call.args[modelFlagIndex + 1]).toBe(model);
    expect(outcome.audit?.model).toBe(model);
  });

  test("requires both independent gates to allow", async () => {
    for (const [safety, relevance, expectedKind] of [
      ["ALLOW", "ALLOW", "allow"],
      ["ASK", "ALLOW", "ask"],
      ["ALLOW", "ASK", "ask"],
      ["ASK", "ASK", "ask"],
    ] as const) {
      const probe = runner([commandResult(verdict(safety, relevance))]);
      const judge = createPermissionJudge(config(), {
        runCommand: probe.run,
      });
      const outcome = await judge.judge("git status", {
        task: task("Inspect repository status"),
      });
      expect(outcome.kind).toBe(expectedKind);
      expect(outcome.audit).toEqual({
        source: "live",
        backend: "codex-cli",
        gates: { safety, relevance },
        model: "gpt-5.6-luna",
        reasoningEffort: PERMISSION_JUDGE_REASONING_EFFORT,
        policyVersion: PERMISSION_JUDGE_POLICY_VERSION,
      });
    }
  });

  test("rejects malformed, extra, and invalid structured outputs", async () => {
    for (const output of [
      "not-json",
      "",
      "null",
      "[]",
      JSON.stringify({ safety: "ALLOW" }),
      JSON.stringify({ safety: "ALLOW", relevance: "ALLOW", reason: "ok" }),
      JSON.stringify({ safety: "YES", relevance: "ALLOW" }),
      JSON.stringify({ safety: "ALLOW", relevance: "YES" }),
    ]) {
      const probe = runner([commandResult(output)]);
      const outcome = await createPermissionJudge(config(), {
        runCommand: probe.run,
      }).judge("git status");
      expect(outcome.kind).toBe("invalid-response");
    }
  });

  test("rejects invalid UTF-8", async () => {
    const probe = runner([commandResult(new Uint8Array([255, 254]))]);
    expect(
      await createPermissionJudge(config(), {
        runCommand: probe.run,
      }).judge("git status"),
    ).toEqual({
      kind: "invalid-response",
      reason: "Codex judge response was not valid UTF-8",
    });
  });

  test("treats nonzero exits as unavailable without exposing stderr", async () => {
    const calls: Invocation[] = [];
    const run: RunBoundedCommand = async (command, args, options) => {
      calls.push({ command, args, options });
      return {
        exitCode: 17,
        stdout: new Uint8Array(),
        stderr: encoded("secret diagnostic containing command text"),
        stdoutTruncated: false,
      };
    };
    const outcome = await createPermissionJudge(config(), {
      runCommand: run,
    }).judge("cat ~/.ssh/id_ed25519");
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "Codex CLI exited with code 17",
    });
    expect(calls).toHaveLength(1);
  });

  test("maps bounded process failures without failing open", async () => {
    for (const [error, expected] of [
      [
        new BoundedCommandError("timeout", "codex", "deadline"),
        { kind: "timeout", reason: "Codex judge timed out" },
      ],
      [
        new BoundedCommandError("missing", "codex", "missing"),
        {
          kind: "unavailable",
          reason: "Codex CLI could not be executed",
        },
      ],
      [
        new BoundedCommandError("spawn", "codex", "spawn"),
        {
          kind: "unavailable",
          reason: "Codex CLI could not be executed",
        },
      ],
      [
        new BoundedCommandError("oversize", "codex", "large"),
        {
          kind: "invalid-response",
          reason: "Codex judge output exceeded the size limit",
        },
      ],
    ] as const) {
      const probe = runner([error]);
      expect(
        await createPermissionJudge(config(), {
          runCommand: probe.run,
        }).judge("git status"),
      ).toEqual(expected);
    }
  });

  test("does not invoke Codex after parent cancellation", async () => {
    const controller = createAbortController();
    controller.abort();
    const probe = runner([commandResult(verdict("ALLOW"))]);
    expect(
      await createPermissionJudge(config(), {
        runCommand: probe.run,
      }).judge("git status", { signal: controller.signal }),
    ).toEqual({
      kind: "parent-aborted",
      reason: "the active pi operation was cancelled",
    });
    expect(probe.calls).toHaveLength(0);
  });

  test("propagates parent cancellation to an active Codex process", async () => {
    const controller = createAbortController();
    const run: RunBoundedCommand = async (command, _args, options) =>
      new Promise((_resolve, reject) => {
        const rejectAbort = () =>
          reject(new BoundedCommandError("aborted", command, "aborted"));
        if (!isAbortSignal(options.signal)) {
          reject(new Error("expected active abort signal"));
          return;
        }
        options.signal.addEventListener("abort", rejectAbort, { once: true });
      });
    const pending = createPermissionJudge(config(), {
      runCommand: run,
    }).judge("git status", { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({
      kind: "parent-aborted",
      reason: "the active pi operation was cancelled",
    });
  });

  test("rejects commands and prompts beyond their byte budgets before execution", async () => {
    const probe = runner([commandResult(verdict("ALLOW"))]);
    const judge = createPermissionJudge(config(), { runCommand: probe.run });
    expect(await judge.judge("x".repeat(2 * 1024 + 1))).toEqual({
      kind: "too-long",
      reason: "command is too long for complete Codex classification",
    });
    expect(
      await judge.judge("git status", {
        task: task("x".repeat(20 * 1024)),
      }),
    ).toEqual({
      kind: "too-long",
      reason: "command is too long for complete Codex classification",
    });
    expect(probe.calls).toHaveLength(0);
  });

  test("fails closed on configuration errors and invalid runtime values", async () => {
    for (const judgeConfig of [
      config({ configurationError: "invalid permissionJudge fields: url" }),
      config({ model: "" }),
      config({ model: "bad:model" }),
      config({ timeoutMs: 999 }),
      config({ timeoutMs: 120_001 }),
    ]) {
      const probe = runner([commandResult(verdict("ALLOW"))]);
      const outcome = await createPermissionJudge(judgeConfig, {
        runCommand: probe.run,
      }).judge("git status");
      expect(outcome.kind).toBe("unavailable");
      expect(probe.calls).toHaveLength(0);
    }
  });

  test("caches only complete allows and keys task evidence and execution context", async () => {
    let now = 1_000;
    const probe = runner([
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
    ]);
    const judge = createPermissionJudge(config(), {
      runCommand: probe.run,
      now: () => now,
      cacheTtlMs: 100,
    });
    const base = {
      cwd: "/repo",
      task: task("Inspect status", "task:a"),
      runEvidence: runEvidence("run:a"),
      project: project("project:a"),
      executionBoundary: {
        mode: "sandboxed" as const,
        network: "denied" as const,
        profileFingerprint: "a".repeat(64),
      },
    };

    expect(await judge.judge("git status", base)).toMatchObject({
      kind: "allow",
      cached: false,
    });
    expect(await judge.judge("git status", base)).toMatchObject({
      kind: "allow",
      cached: true,
      audit: { source: "cache", backend: "codex-cli" },
    });
    await judge.judge("git status --short", base);
    await judge.judge("git status", { ...base, cwd: "/other" });
    await judge.judge("git status", {
      ...base,
      task: task("Inspect status", "task:b"),
    });
    await judge.judge("git status", {
      ...base,
      runEvidence: runEvidence("run:b"),
    });
    await judge.judge("git status", {
      ...base,
      project: project("project:b"),
    });
    expect(probe.calls).toHaveLength(6);

    now += 101;
    expect(await judge.judge("git status", base)).toMatchObject({
      kind: "allow",
      cached: false,
    });
    expect(probe.calls).toHaveLength(7);
  });

  test("does not cache asks, uncorrelated calls, or explicitly uncached calls", async () => {
    const probe = runner([
      commandResult(verdict("ASK")),
      commandResult(verdict("ASK")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
    ]);
    const judge = createPermissionJudge(config(), { runCommand: probe.run });

    await judge.judge("git status");
    await judge.judge("git status");
    await judge.judge("git diff", { taskCorrelation: "uncorrelated" });
    await judge.judge("git diff", { taskCorrelation: "uncorrelated" });
    await judge.judge("git log", { cacheAllowed: false });
    await judge.judge("git log", { cacheAllowed: false });
    expect(probe.calls).toHaveLength(6);
  });

  test("enforces LRU capacity and clear resets cache and circuit state", async () => {
    let now = 0;
    const probe = runner([
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
    ]);
    const judge = createPermissionJudge(config(), {
      runCommand: probe.run,
      now: () => now,
      cacheCapacity: 2,
      circuitMs: 5_000,
    });
    await judge.judge("one");
    await judge.judge("two");
    expect(await judge.judge("one")).toMatchObject({ cached: true });
    await judge.judge("three");
    expect(await judge.judge("two")).toMatchObject({ cached: false });
    judge.clear();
    expect(await judge.judge("one")).toMatchObject({ cached: false });

    const failureProbe = runner([
      new BoundedCommandError("missing", "codex", "missing"),
      commandResult(verdict("ALLOW")),
    ]);
    const circuitJudge = createPermissionJudge(config(), {
      runCommand: failureProbe.run,
      now: () => now,
      circuitMs: 5_000,
    });
    const failed = await circuitJudge.judge("git status");
    expect(failed.kind).toBe("unavailable");
    expect(await circuitJudge.judge("git diff")).toEqual({
      kind: "unavailable",
      reason: "Codex judge is temporarily unavailable",
    });
    circuitJudge.clear();
    const recovered = await circuitJudge.judge("git diff");
    expect(recovered.kind).toBe("allow");
  });

  test("copies trusted classifier files into a cleaned private workspace", async () => {
    const probe = runner([commandResult(verdict("ALLOW"))]);
    let cwdMode = 0;
    let instructionsMode = 0;
    let schemaMode = 0;
    let schemaText = "";
    const inspectRun: RunBoundedCommand = async (command, args, options) => {
      const schemaIndex = args.indexOf("--output-schema");
      const schemaFile = args[schemaIndex + 1];
      if (schemaFile === undefined) throw new Error("missing schema file");
      const instructionsSetting = args.find((value) =>
        value.startsWith("model_instructions_file="),
      );
      if (instructionsSetting === undefined) {
        throw new Error("missing instructions file");
      }
      const instructionsFile: unknown = JSON.parse(
        instructionsSetting.slice("model_instructions_file=".length),
      );
      if (typeof instructionsFile !== "string") {
        throw new Error("invalid instructions file");
      }
      cwdMode = statSync(options.cwd).mode & 0o777;
      instructionsMode = statSync(instructionsFile).mode & 0o777;
      schemaMode = statSync(schemaFile).mode & 0o777;
      schemaText = readFileSync(schemaFile, "utf8");
      return probe.run(command, args, options);
    };
    await createPermissionJudge(config(), { runCommand: inspectRun }).judge(
      "git status",
    );
    const [call] = probe.calls;
    if (call === undefined) throw new Error("missing invocation");
    expect(call.options.cwd).toStartWith(`${tmpdir()}/pi-codex-judge-`);
    expect(call.options.cwd).not.toBe(process.cwd());
    expect(existsSync(call.options.cwd)).toBe(false);
    expect(call.args).toContain(
      `model_instructions_file=${JSON.stringify(`${call.options.cwd}/instructions.md`)}`,
    );
    const schemaIndex = call.args.indexOf("--output-schema");
    expect(schemaIndex).toBeGreaterThan(-1);
    expect(call.args[schemaIndex + 1]).toBe(
      `${call.options.cwd}/output-schema.json`,
    );
    expect(cwdMode).toBe(0o700);
    expect(instructionsMode).toBe(0o600);
    expect(schemaMode).toBe(0o600);
    expect(JSON.parse(schemaText)).toMatchObject({
      additionalProperties: false,
      required: ["safety", "relevance"],
    });
  });

  test("fails closed when isolated workspace cleanup fails", async () => {
    const probe = runner([commandResult(verdict("ALLOW"))]);
    const outcome = await createPermissionJudge(config(), {
      runCommand: probe.run,
      createWorkspace: () => ({
        cwd: "/isolated/codex-judge",
        instructionsFile: "/isolated/codex-judge/instructions.md",
        schemaFile: "/isolated/codex-judge/output-schema.json",
        cleanup() {
          throw new Error("cleanup failed");
        },
      }),
    }).judge("git status");
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "Codex CLI could not be executed",
    });
  });
});
