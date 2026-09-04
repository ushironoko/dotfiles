import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  createPermissionJudge as createRawPermissionJudge,
  PERMISSION_JUDGE_CODEX_VERSION,
  PERMISSION_JUDGE_POLICY_VERSION,
  PERMISSION_JUDGE_REASONING_EFFORT,
  type PermissionJudgeOptions,
} from "../../pi/extensions/pi-harness/features/permission-policy/judge";
import {
  createPermissionJudgeRuntime,
  type PermissionJudgeRuntime,
  type PermissionJudgeWorkspace,
} from "../../pi/extensions/pi-harness/features/permission-policy/judge-runtime";
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

const capability = (
  toolNames: readonly string[] = [
    "functions.update_plan",
    "functions.view_image",
  ],
  instructionSentinelVisible = false,
  outsideWorkspaceImageReadable = false,
): string =>
  JSON.stringify({
    toolNames,
    instructionSentinelVisible,
    outsideWorkspaceImageReadable,
  });

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
  enabled: true,
  executablePath: "/trusted/codex",
  expectedExecutableSha256: "a".repeat(64),
  ...overrides,
});

const workspace = (
  overrides: Partial<PermissionJudgeWorkspace> = {},
): PermissionJudgeWorkspace => ({
  cwd: "/isolated/codex-judge",
  home: "/isolated/codex-judge/home",
  codexHome: "/isolated/codex-judge/codex-home",
  instructionsFile: "/isolated/codex-judge/instructions.md",
  schemaFile: "/isolated/codex-judge/output-schema.json",
  modelCatalogFile: "/isolated/codex-judge/model-catalog.json",
  deniedImageFile: "/isolated/denied-image.png",
  environment: {
    HOME: "/isolated/codex-judge/home",
    CODEX_HOME: "/isolated/codex-judge/codex-home",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    PWD: "/isolated/codex-judge",
    TMPDIR: "/isolated/codex-judge/tmp",
  },
  cleanup: () => {},
  ...overrides,
});

const runtime = (
  overrides: Partial<PermissionJudgeRuntime> = {},
): PermissionJudgeRuntime => ({
  identity: {
    executablePath: "/trusted/codex",
    executableSha256: "a".repeat(64),
    ancestorFingerprint: "b".repeat(64),
    fingerprint: "c".repeat(64),
    dev: 1,
    ino: 2,
    uid: 501,
    mode: 0o100500,
    size: 1024,
  },
  runtimeRoot: "/isolated",
  codexVersion: PERMISSION_JUDGE_CODEX_VERSION,
  isolationVerified: true,
  verify() {
    return this.identity;
  },
  assertOutsideWorktrees: () => {},
  createWorkspace: () => workspace(),
  ...overrides,
});

const EXECUTABLE_IDENTITY = runtime().identity;

const createPermissionJudge = (
  judgeConfig: PermissionJudgeConfig,
  options: PermissionJudgeOptions = {},
) =>
  createRawPermissionJudge(judgeConfig, {
    runtime: runtime(),
    ...options,
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
    let schema = "";
    let modelCatalog = "";
    let cleanupCalls = 0;
    const judge = createPermissionJudge(config(), {
      runCommand: probe.run,
      runtime: runtime({
        createWorkspace(value, schemaText, modelCatalogText) {
          instructions = value;
          schema = schemaText;
          modelCatalog = modelCatalogText;
          return workspace({
            cleanup() {
              cleanupCalls += 1;
            },
          });
        },
      }),
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
    expect(call.command).toBe("/trusted/codex");
    expect(call.args.slice(0, 16)).toEqual([
      "-a",
      "never",
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
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
      "artifact",
      "auth_elicitation",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "code_mode",
      "code_mode_buffered_exec",
      "code_mode_host",
      "code_mode_only",
      "computer_use",
      "current_time_reminder",
      "default_mode_request_user_input",
      "deferred_executor",
      "enable_mcp_apps",
      "exec_permission_approvals",
      "executor_capability_discovery",
      "external_agent_memory_import",
      "goals",
      "guardian_approval",
      "hooks",
      "image_generation",
      "in_app_browser",
      "memories",
      "mentions_v2",
      "multi_agent",
      "multi_agent_v2",
      "network_proxy",
      "non_prefixed_mcp_tool_names",
      "plugin_sharing",
      "plugins",
      "remote_plugin",
      "request_permissions_tool",
      "respect_system_proxy",
      "secret_auth_storage",
      "shell_snapshot",
      "shell_tool",
      "skill_env_var_dependency_prompt",
      "skill_mcp_dependency_install",
      "skill_search",
      "standalone_web_search",
      "tool_call_mcp_elicitation",
      "tool_suggest",
      "unified_exec",
      "use_agent_identity",
      "workspace_dependencies",
    ]);
    expect(call.args).toContain(
      'model_catalog_json="/isolated/codex-judge/model-catalog.json"',
    );
    expect(call.args).toContain(
      "tools.experimental_request_user_input={enabled=false}",
    );
    expect(call.args).toContain('default_permissions="pi_permission_judge"');
    expect(call.args).toContain(
      'permissions.pi_permission_judge.filesystem={":root"="deny","/isolated/codex-judge"="read"}',
    );
    expect(call.args).toContain(
      "permissions.pi_permission_judge.network.enabled=false",
    );
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
    expect(call.options.env.HOME).toBe("/isolated/codex-judge/home");
    expect(call.options.env.CODEX_HOME).toBe(
      "/isolated/codex-judge/codex-home",
    );
    expect(call.options.env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(call.options.env.PWD).toBe("/isolated/codex-judge");
    expect(call.options.env.BASH_ENV).toBeUndefined();
    expect(call.options.env.OLDPWD).toBeUndefined();
    expect(call.options.env.INIT_CWD).toBeUndefined();
    expect(call.options.env.npm_config_local_prefix).toBeUndefined();
    expect(call.options.env.npm_package_json).toBeUndefined();

    expect(JSON.parse(schema)).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        safety: { type: "string", enum: ["ALLOW", "ASK"] },
        relevance: { type: "string", enum: ["ALLOW", "ASK"] },
      },
      required: ["safety", "relevance"],
      additionalProperties: false,
    });
    expect(instructions).toContain(
      "Never execute, browse, use tools, or investigate.",
    );
    expect(JSON.parse(modelCatalog)).toMatchObject({
      models: [
        {
          slug: "gpt-5.6-luna",
          shell_type: "disabled",
          apply_patch_tool_type: null,
          input_modalities: ["text"],
          supports_search_tool: false,
          tool_mode: "direct",
          multi_agent_version: null,
        },
      ],
    });
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

  test("requires one successful model-visible isolation attestation", async () => {
    const probe = runner([
      commandResult(capability()),
      commandResult(verdict("ALLOW")),
      commandResult(verdict("ALLOW")),
    ]);
    const instructions: string[] = [];
    const schemas: string[] = [];
    const sentinels: (string | undefined)[] = [];
    const judgeRuntime = runtime({
      isolationVerified: false,
      createWorkspace(
        instructionText,
        schemaText,
        _modelCatalogText,
        sentinel,
      ) {
        instructions.push(instructionText);
        schemas.push(schemaText);
        sentinels.push(sentinel);
        return workspace();
      },
    });
    const judge = createRawPermissionJudge(config(), {
      runCommand: probe.run,
      runtime: judgeRuntime,
    });

    expect(await judge.judge("git status")).toMatchObject({ kind: "allow" });
    expect(await judge.judge("git diff")).toMatchObject({ kind: "allow" });
    expect(probe.calls).toHaveLength(3);
    expect(stdinText(probe.calls[0] as Invocation)).toContain(
      "codex-permission-judge-tool-and-instruction-isolation",
    );
    expect(stdinText(probe.calls[0] as Invocation)).toContain(
      '"deniedImagePath":"/isolated/denied-image.png"',
    );
    expect(instructions[0]).toContain("actually visible in this request");
    expect(JSON.parse(schemas[0] ?? "")).toMatchObject({
      properties: {
        toolNames: {
          type: "array",
          items: { type: "string" },
        },
        instructionSentinelVisible: { type: "boolean" },
        outsideWorkspaceImageReadable: { type: "boolean" },
      },
      additionalProperties: false,
    });
    expect(instructions[1]).toContain(
      "Never execute, browse, use tools, or investigate.",
    );
    expect(sentinels[0]).toContain(
      "PI_PERMISSION_JUDGE_HOSTILE_AGENTS_SENTINEL",
    );
    expect(sentinels.slice(1)).toEqual([undefined, undefined]);
    expect(instructions).toHaveLength(3);
  });

  test("fails closed when the isolation attestation does not allow", async () => {
    for (const response of [
      capability([
        "functions.update_plan",
        "functions.view_image",
        "functions.exec",
      ]),
      capability(undefined, true),
      capability(undefined, false, true),
      capability(["functions.update_plan"]),
      capability(["functions.update_plan", "functions.update_plan"]),
      JSON.stringify({
        toolNames: ["functions.update_plan", "functions.view_image"],
        instructionSentinelVisible: false,
        outsideWorkspaceImageReadable: false,
        extra: false,
      }),
      JSON.stringify({
        toolNames: ["functions.update_plan", 1],
        instructionSentinelVisible: false,
        outsideWorkspaceImageReadable: false,
      }),
      "not-json",
    ]) {
      const probe = runner([commandResult(response)]);
      const outcome = await createRawPermissionJudge(config(), {
        runCommand: probe.run,
        runtime: runtime({ isolationVerified: false }),
      }).judge("git status");
      expect(outcome).toEqual({
        kind: "unavailable",
        reason: "Codex CLI could not be executed",
      });
      expect(probe.calls).toHaveLength(1);
    }
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

  test("validates runtime identity before serving a cached allow", async () => {
    const probe = runner([commandResult(verdict("ALLOW"))]);
    let valid = true;
    const judgeRuntime = runtime({
      verify() {
        if (!valid) throw new Error("identity changed");
        return EXECUTABLE_IDENTITY;
      },
    });
    const judge = createPermissionJudge(config(), {
      runCommand: probe.run,
      runtime: judgeRuntime,
    });

    expect(await judge.judge("git status")).toMatchObject({
      kind: "allow",
      cached: false,
    });
    valid = false;
    expect(await judge.judge("git status")).toEqual({
      kind: "unavailable",
      reason: "Codex judge runtime identity changed",
    });
    expect(probe.calls).toHaveLength(1);
  });

  test("discards an allow when runtime identity changes during execution", async () => {
    let changed = false;
    const probe = runner([commandResult(verdict("ALLOW"))]);
    const run: RunBoundedCommand = async (command, args, options) => {
      const result = await probe.run(command, args, options);
      changed = true;
      return result;
    };
    const judgeRuntime = runtime({
      verify() {
        if (changed) throw new Error("identity changed");
        return EXECUTABLE_IDENTITY;
      },
    });
    const judge = createPermissionJudge(config(), {
      runCommand: run,
      runtime: judgeRuntime,
    });

    expect(await judge.judge("git status")).toEqual({
      kind: "unavailable",
      reason: "Codex CLI could not be executed",
    });
    expect(probe.calls).toHaveLength(1);
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
    const testRoot = realpathSync(
      mkdtempSync(join(tmpdir(), "pi-codex-runtime-test-")),
    );
    const executableFile = join(testRoot, "codex");
    const executableBytes = "fixture-codex";
    writeFileSync(executableFile, executableBytes, { mode: 0o500 });
    chmodSync(executableFile, 0o500);
    const executablePath = realpathSync(executableFile);
    const judgeConfig = config({
      executablePath,
      expectedExecutableSha256: createHash("sha256")
        .update(executableBytes)
        .digest("hex"),
    });
    const judgeRuntime = createPermissionJudgeRuntime(judgeConfig, {
      runtimeRoot: join(testRoot, "runtime"),
    });
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
    try {
      await createRawPermissionJudge(judgeConfig, {
        runCommand: inspectRun,
        runtime: {
          ...judgeRuntime,
          codexVersion: PERMISSION_JUDGE_CODEX_VERSION,
          isolationVerified: true,
        },
      }).judge("git status");
      const [call] = probe.calls;
      if (call === undefined) throw new Error("missing invocation");
      expect(call.command).toBe(executablePath);
      expect(call.options.cwd).toStartWith(`${judgeRuntime.runtimeRoot}/run-`);
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
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test("fails closed when isolated workspace cleanup fails", async () => {
    const probe = runner([commandResult(verdict("ALLOW"))]);
    const outcome = await createPermissionJudge(config(), {
      runCommand: probe.run,
      runtime: runtime({
        createWorkspace: () =>
          workspace({
            cleanup() {
              throw new Error("cleanup failed");
            },
          }),
      }),
    }).judge("git status");
    expect(outcome).toEqual({
      kind: "unavailable",
      reason: "Codex CLI could not be executed",
    });
  });
});
