import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  type HarnessConfig,
} from "../../../pi/extensions/pi-harness/config";
import {
  PERMISSION_PREFLIGHT_PATH,
  setupHarness,
} from "../../../pi/extensions/pi-harness/index";
import setupHookBridge from "../../../pi/extensions/pi-harness/features/hook-bridge/index";
import { parsePermissionAuditJsonl } from "../../../pi/extensions/pi-harness/features/permission-audit/analysis";
import {
  setupPermissionAudit,
  type PermissionAuditIntegration,
} from "../../../pi/extensions/pi-harness/features/permission-audit/index";
import type { PermissionAuditStage } from "../../../pi/extensions/pi-harness/features/permission-audit/model";
import { createPermissionTaskTracker } from "../../../pi/extensions/pi-harness/features/permission-policy/context";
import setupPermissionPolicy from "../../../pi/extensions/pi-harness/features/permission-policy/index";
import type { BridgeHookSpec } from "../../../pi/extensions/pi-harness/features/hook-bridge/registry";
import {
  CHILD_PERMISSION_SIGNAL_ENV,
  formatChildPermissionSignal,
} from "../../../pi/extensions/pi-harness/features/permission-policy/block";
import { resolvePaths } from "../../../pi/extensions/pi-harness/lib/paths";
import { createFakePi } from "../../pi-harness/fake-pi";
import { cleanupTestDirectory, setupTestDirectory } from "../../test-helpers";

const ROOT = resolve(import.meta.dir, "../../..");
const HOOKS = join(ROOT, "claude/.claude/hooks");

const tempDirectories: string[] = [];

const makeConfig = (
  home: string,
  trustedRoots: string[] = [],
  isChild = false,
): HarnessConfig => ({
  isChild,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": true,
    "asuku-notify": true,
    "ask-user-question": true,
  },
  trust: { trustedRoots },
  paths: resolvePaths(home),
});

const makeTempDirectory = async (
  prefix: string,
  subdirs?: string[],
): Promise<string> => {
  const directory = await setupTestDirectory(prefix, subdirs);
  tempDirectories.push(directory);
  return directory;
};

const makeSpec = (
  id: string,
  stage: BridgeHookSpec["stage"],
  script: string,
  options: Pick<BridgeHookSpec, "matcher" | "requiresTrust"> = {},
): BridgeHookSpec => ({
  id,
  stage,
  script,
  timeoutMs: 10_000,
  maxOutputBytes: 65_536,
  ...options,
});

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

describe("pi-harness hook bridge", () => {
  test("handles ask outcomes interactively and fails closed without UI", async () => {
    const directory = await makeTempDirectory("pi-hook-ask");
    const script = join(directory, "ask.sh");
    await fs.writeFile(
      script,
      [
        "#!/usr/bin/env bash",
        "cat > /dev/null",
        `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"confirm hook action"}}'`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const registry = [
      makeSpec("ask", "tool_call", script, { matcher: /^Bash$/ }),
    ];
    const event = {
      type: "tool_call" as const,
      toolName: "bash",
      toolCallId: "ask-1",
      input: { command: "pwd" },
    };

    const acceptedPi = createFakePi({ cwd: directory });
    acceptedPi.queueConfirm(true);
    setupHookBridge(acceptedPi, makeConfig(directory), {
      cwd: directory,
      registry,
    });
    expect(await acceptedPi.emitToolCall(event)).toBeUndefined();

    const rejectedPi = createFakePi({ cwd: directory });
    rejectedPi.queueConfirm(false);
    setupHookBridge(rejectedPi, makeConfig(directory), {
      cwd: directory,
      registry,
    });
    const rejected = await rejectedPi.emitToolCall(event);
    expect(rejected?.reason).toBe("confirm hook action");

    const nonInteractivePi = createFakePi({ cwd: directory, hasUI: false });
    setupHookBridge(nonInteractivePi, makeConfig(directory), {
      cwd: directory,
      registry,
    });
    const nonInteractive = await nonInteractivePi.emitToolCall(event);
    expect(nonInteractive?.reason).toBe("confirm hook action");
  });

  test("a later policy denial outranks an accepted hook ASK", async () => {
    const directory = await makeTempDirectory("pi-hook-ask-then-deny");
    const script = join(directory, "ask.sh");
    await fs.writeFile(
      script,
      [
        "#!/bin/bash",
        "cat >/dev/null",
        `printf '%s' '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"confirm first"}}'`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const config = makeConfig(directory);
    const pi = createFakePi({ cwd: directory });
    const taskTracker = createPermissionTaskTracker();
    const audit = setupPermissionAudit(pi, config, { taskTracker });
    const blocker = (reason: string) => ({ block: true as const, reason });
    setupHookBridge(pi, config, {
      registry: [
        makeSpec("ask-first", "tool_call", script, { matcher: /^Bash$/ }),
      ],
      permissionAudit: audit,
      auditPhase: "preflight",
      blockToolCall: blocker,
    });
    setupPermissionPolicy(pi, config, {
      taskTracker,
      permissionAudit: audit,
      blockToolCall: blocker,
    });
    audit.registerTail(pi, blocker);
    pi.queueConfirm(true);

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "ask-then-deny",
        input: { command: "bit relay serve" },
      }),
    ).toMatchObject({ block: true });
    await pi.emitSessionShutdown();

    const [file] = await fs.readdir(config.paths.logDir);
    const parsed = parsePermissionAuditJsonl(
      await fs.readFile(join(config.paths.logDir, file ?? ""), "utf8"),
    );
    expect(parsed.records[0]).toMatchObject({
      effectiveDecision: "deny",
      boundaryDisposition: "block",
      stages: [
        { type: "hook", verdict: "ask" },
        { type: "confirmation", status: "accepted" },
        { type: "deterministic", verdict: "deny" },
      ],
    });
  });

  test("records degraded hook continues with stable reason codes", async () => {
    const directory = await makeTempDirectory("pi-hook-degraded");
    const timeoutScript = join(directory, "timeout.sh");
    const nonzeroScript = join(directory, "nonzero.sh");
    const malformedScript = join(directory, "malformed.sh");
    await fs.writeFile(
      timeoutScript,
      "#!/bin/bash\ncat >/dev/null\nsleep 1\n",
      { mode: 0o755 },
    );
    await fs.writeFile(nonzeroScript, "#!/bin/bash\ncat >/dev/null\nexit 1\n", {
      mode: 0o755,
    });
    await fs.writeFile(
      malformedScript,
      "#!/bin/bash\ncat >/dev/null\nprintf not-json\n",
      { mode: 0o755 },
    );
    const stages: PermissionAuditStage[] = [];
    const permissionAudit: PermissionAuditIntegration = {
      lineageId: "123e4567-e89b-42d3-a456-426614174000",
      addStage: (_toolCallId, stage) => stages.push(stage),
      updateContext() {},
      finalizeBlock: async () => true,
      registerTail() {},
      childEnvironment: () => ({}),
    };
    const timeoutSpec = makeSpec("timeout", "tool_call", timeoutScript, {
      matcher: /^Bash$/,
    });
    const pi = createFakePi({ cwd: directory });
    setupHookBridge(pi, makeConfig(directory), {
      permissionAudit,
      registry: [
        { ...timeoutSpec, timeoutMs: 10 },
        makeSpec("nonzero", "tool_call", nonzeroScript, {
          matcher: /^Bash$/,
        }),
        makeSpec("malformed", "tool_call", malformedScript, {
          matcher: /^Bash$/,
        }),
      ],
    });

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "degraded-hooks",
        input: { command: "pwd" },
      }),
    ).toBeUndefined();
    expect(
      stages.map((stage) =>
        stage.type === "hook" ? stage.reasonCode : stage.type,
      ),
    ).toEqual(["hook-timeout", "hook-nonzero-exit", "hook-malformed-output"]);
  });

  test("npm_script_preference blocks before later permission handlers", async () => {
    const directory = await makeTempDirectory("pi-hook-npm-preference");
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { format: "prettier --write ." } }),
    );

    const pi = createFakePi({ cwd: directory });
    setupHookBridge(pi, makeConfig(directory), {
      cwd: directory,
      registry: [
        makeSpec(
          "npm-script-preference",
          "tool_call",
          join(HOOKS, "pre_tool_use/npm_script_preference.sh"),
          { matcher: /^Bash$/ },
        ),
      ],
    });
    let laterPermissionCalls = 0;
    pi.on("tool_call", () => {
      laterPermissionCalls += 1;
      return undefined;
    });

    const blocked = await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t1",
      input: { command: "npx prettier --write ." },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("format");
    expect(laterPermissionCalls).toBe(0);

    const allowed = await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t2",
      input: { command: "bun run format" },
    });
    expect(allowed).toBeUndefined();
    expect(laterPermissionCalls).toBe(1);
  });

  test("umbrella orders npm preflight before policy and signals child blocks", async () => {
    const directory = await makeTempDirectory("pi-hook-npm-preflight");
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { format: "prettier --write ." } }),
    );
    const pi = createFakePi({ cwd: directory, hasUI: false });
    const config: HarnessConfig = {
      ...makeConfig(directory, [], true),
      features: {
        "hook-bridge": true,
        subagent: false,
        workflow: false,
        "bit-task": false,
        statusline: false,
        "provider-log": false,
        "asuku-notify": false,
        "ask-user-question": false,
      },
      paths: {
        ...resolvePaths(directory),
        claudeHooksDir: HOOKS,
      },
      permissionJudge: {
        ...DEFAULT_PERMISSION_JUDGE_CONFIG,
        configurationError: "permission judge should not run",
      },
    };
    const permissionSignalToken = "123e4567-e89b-42d3-a456-426614174000";
    const permissionSignals: string[] = [];
    const previousSignalToken = process.env[CHILD_PERMISSION_SIGNAL_ENV];
    process.env[CHILD_PERMISSION_SIGNAL_ENV] = permissionSignalToken;
    try {
      setupHarness(pi, config, {
        writePermissionSignal: (text) => permissionSignals.push(text),
      });
      expect(process.env[CHILD_PERMISSION_SIGNAL_ENV]).toBeUndefined();
    } finally {
      if (previousSignalToken === undefined) {
        delete process.env[CHILD_PERMISSION_SIGNAL_ENV];
      } else {
        process.env[CHILD_PERMISSION_SIGNAL_ENV] = previousSignalToken;
      }
    }

    const blocked = await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "preflight-1",
      input: { command: "npx prettier --write ." },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("run format");
    expect(blocked?.reason).not.toContain("permission judge should not run");
    expect(permissionSignals).toEqual([
      `${formatChildPermissionSignal(permissionSignalToken)}\n`,
    ]);

    const passedToPolicy = await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "preflight-2",
      input: { command: "bun x totally-unknown-package" },
    });
    expect(passedToPolicy?.block).toBe(true);
    expect(passedToPolicy?.reason).toContain("パッケージランナー");
    expect(passedToPolicy?.reason).not.toContain(
      "permission judge should not run",
    );
    expect(permissionSignals).toEqual([
      `${formatChildPermissionSignal(permissionSignalToken)}\n`,
      `${formatChildPermissionSignal(permissionSignalToken)}\n`,
    ]);

    await pi.emitSessionShutdown();
    const auditFiles = (await fs.readdir(config.paths.logDir)).filter((name) =>
      name.startsWith("permission-"),
    );
    expect(auditFiles).toHaveLength(1);
    const audit = parsePermissionAuditJsonl(
      await fs.readFile(join(config.paths.logDir, auditFiles[0] ?? ""), "utf8"),
    );
    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]?.stages).toEqual([
      expect.objectContaining({
        type: "hook",
        phase: "preflight",
        hookId: "npm-script-preference",
        verdict: "deny",
      }),
    ]);
    expect(audit.records[1]?.stages).toEqual([
      expect.objectContaining({
        type: "hook",
        phase: "preflight",
        verdict: "continue",
      }),
      expect.objectContaining({
        type: "deterministic",
        verdict: "ask",
      }),
      expect.objectContaining({
        type: "confirmation",
        status: "not-shown",
      }),
    ]);
  });

  test("pins the pre-permission hook to a repository-independent PATH", async () => {
    const directory = await makeTempDirectory("pi-hook-fixed-path", [
      "nested",
      "pre_tool_use",
    ]);
    await fs.writeFile(
      join(directory, "pre_tool_use/npm_script_preference.sh"),
      [
        "#!/bin/bash",
        "cat > /dev/null",
        `jq -n --arg path "$PATH" '{hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:$path}}'`,
      ].join("\n"),
      { mode: 0o755 },
    );
    const pi = createFakePi({ cwd: join(directory, "nested"), hasUI: false });
    const config: HarnessConfig = {
      ...makeConfig(directory, [], true),
      features: {
        "hook-bridge": true,
        subagent: false,
        workflow: false,
        "bit-task": false,
        statusline: false,
        "provider-log": false,
        "asuku-notify": false,
        "ask-user-question": false,
      },
      paths: {
        ...resolvePaths(directory),
        claudeHooksDir: directory,
      },
      permissionJudge: {
        ...DEFAULT_PERMISSION_JUDGE_CONFIG,
        configurationError: "permission judge should not run",
      },
    };
    setupHarness(pi, config);

    const blocked = await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "fixed-path-1",
      input: { command: "npx prettier --write ." },
    });
    expect(blocked?.reason).toBe(PERMISSION_PREFLIGHT_PATH);
    expect(blocked?.reason).not.toContain(directory);
  });

  test("injects ultracode context only for matching prompts", async () => {
    const directory = await makeTempDirectory("pi-hook-ultracode", [
      "bin",
      "tmp",
    ]);
    const stubBin = join(directory, "bin");
    await fs.writeFile(
      join(stubBin, "codex"),
      "#!/usr/bin/env bash\nexit 0\n",
      {
        mode: 0o755,
      },
    );

    const pi = createFakePi({ cwd: directory });
    setupHookBridge(pi, makeConfig(directory), {
      cwd: directory,
      env: {
        HOME: directory,
        PATH: `${stubBin}:${process.env.PATH ?? ""}`,
        TMPDIR: join(directory, "tmp"),
      },
      registry: [
        makeSpec(
          "ultracode-codex-context",
          "before_agent_start",
          join(HOOKS, "user_prompt_submit/ultracode_codex_context.sh"),
        ),
      ],
    });

    const injection = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "please run ultracode on this",
    });
    expect(injection?.message?.customType).toBe("pi-harness-hook-bridge");
    expect(injection?.message?.content.length).toBeGreaterThan(0);
    expect(injection?.message?.display).toBe(false);

    const ignored = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "please review this normally",
    });
    expect(ignored).toBeUndefined();
  });

  test("resolves the hook cwd from the event ctx, not the setup-time cwd", async () => {
    const initDir = await makeTempDirectory("pi-hook-cwd-init");
    const eventDir = await makeTempDirectory("pi-hook-cwd-event");
    const outFile = join(eventDir, "received.json");
    const script = join(initDir, "capture.sh");
    await fs.writeFile(
      script,
      [
        "#!/usr/bin/env bash",
        `cat > ${JSON.stringify(outFile)}`,
        "printf '%s' '{}'",
      ].join("\n"),
      { mode: 0o755 },
    );

    const pi = createFakePi({ cwd: initDir });
    setupHookBridge(pi, makeConfig(initDir), {
      cwd: initDir,
      registry: [makeSpec("capture", "before_agent_start", script)],
    });

    // A resumed session fires the event from a different repository than the
    // one process.cwd() pointed at during setup.
    pi.ctx.cwd = eventDir;
    await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "hello",
    });

    const payload = JSON.parse(await fs.readFile(outFile, "utf8")) as {
      cwd: string;
    };
    expect(payload.cwd).toBe(eventDir);
  });

  test("evaluates requiresTrust against the event ctx.cwd", async () => {
    const untrustedDir = await makeTempDirectory("pi-hook-trust-untrusted");
    const trustedDir = await makeTempDirectory("pi-hook-trust-trusted");
    const marker = join(trustedDir, "ran.txt");
    const script = join(untrustedDir, "trust.sh");
    await fs.writeFile(
      script,
      [
        "#!/usr/bin/env bash",
        "cat > /dev/null",
        `touch ${JSON.stringify(marker)}`,
        "printf '%s' '{}'",
      ].join("\n"),
      { mode: 0o755 },
    );
    const event = {
      type: "tool_result" as const,
      toolName: "bash",
      toolCallId: "trust-1",
      input: { command: "echo hi" },
      content: [{ type: "text" as const, text: "hi" }],
      isError: false,
    };
    const registry = [
      makeSpec("trust", "tool_result", script, { requiresTrust: true }),
    ];

    // ctx.cwd is the TRUSTED dir → the requiresTrust hook runs, even though the
    // setup-time cwd was the untrusted dir.
    const trustedPi = createFakePi({ cwd: trustedDir });
    setupHookBridge(trustedPi, makeConfig(untrustedDir, [trustedDir]), {
      cwd: untrustedDir,
      registry,
    });
    await trustedPi.emitToolResult(event);
    expect(existsSync(marker)).toBe(true);

    await fs.rm(marker, { force: true });

    // ctx.cwd is the UNTRUSTED dir → the hook is skipped, even though the
    // setup-time cwd was the trusted dir (proves ctx.cwd wins over options.cwd).
    const untrustedPi = createFakePi({ cwd: untrustedDir });
    setupHookBridge(untrustedPi, makeConfig(untrustedDir, [trustedDir]), {
      cwd: trustedDir,
      registry,
    });
    await untrustedPi.emitToolResult(event);
    expect(existsSync(marker)).toBe(false);
  });

  test("trust-gates coding_cycle and runs it safely in a trusted project", async () => {
    const directory = await makeTempDirectory("pi-hook-coding-cycle");
    await fs.writeFile(join(directory, "package.json"), JSON.stringify({}));
    const init = Bun.spawn(["git", "init", "-q", directory], {
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await init.exited).toBe(0);

    const registry = [
      makeSpec(
        "coding-cycle",
        "tool_result",
        join(HOOKS, "post_tool_use/coding_cycle.sh"),
        { matcher: /^(Write|Edit|MultiEdit)$/, requiresTrust: true },
      ),
    ];
    const event = {
      type: "tool_result" as const,
      toolName: "write",
      toolCallId: "t1",
      input: { path: join(directory, "file.ts"), content: "const x = 1" },
      content: [{ type: "text", text: "written" }],
      isError: false,
    };

    const untrustedPi = createFakePi({ cwd: directory });
    setupHookBridge(untrustedPi, makeConfig(directory), {
      cwd: directory,
      registry,
    });
    expect(await untrustedPi.emitToolResult(event)).toBeUndefined();

    const trustedPi = createFakePi({ cwd: directory });
    setupHookBridge(trustedPi, makeConfig(directory, [directory]), {
      cwd: directory,
      registry,
    });
    expect(await trustedPi.emitToolResult(event)).toBeUndefined();
  });

  test("appends type_safety_check feedback to the original result", async () => {
    const directory = await makeTempDirectory("pi-hook-type-safety");
    const filePath = join(directory, "file.ts");
    await fs.writeFile(filePath, "const x = 1\n");
    const originalContent = [
      { type: "text", text: "written" },
      { type: "image", source: "preserved" },
    ];

    const pi = createFakePi({ cwd: directory });
    setupHookBridge(pi, makeConfig(directory, [directory]), {
      cwd: directory,
      registry: [
        makeSpec(
          "type-safety-check",
          "tool_result",
          join(HOOKS, "post_tool_use/type_safety_check.sh"),
          { matcher: /^(Write|Edit|MultiEdit)$/, requiresTrust: true },
        ),
      ],
    });

    const patch = await pi.emitToolResult({
      type: "tool_result",
      toolName: "write",
      toolCallId: "t1",
      input: {
        path: filePath,
        content: ["const x:", "any = 1"].join(" "),
      },
      content: originalContent,
      isError: false,
    });

    expect(patch?.content?.slice(0, originalContent.length)).toEqual(
      originalContent,
    );
    expect(
      patch?.content?.some(
        (block) =>
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.includes("型安全性"),
      ),
    ).toBe(true);
    expect(
      pi.notifications.some(({ message }) => message.includes("型安全性")),
    ).toBe(true);
  });

  test("skips trusted-only hooks when the TARGET FILE lives outside trusted roots", async () => {
    // Critical review finding: trust must hold for the edited file's own
    // location, not just the session cwd — otherwise a write into an
    // untrusted directory executes that directory's repo-defined scripts.
    const trustedCwd = await makeTempDirectory("pi-hook-trusted-cwd");
    const untrustedTarget = await makeTempDirectory("pi-hook-untrusted-target");
    const filePath = join(untrustedTarget, "file.ts");
    await fs.writeFile(filePath, "const x = 1\n");

    const pi = createFakePi({ cwd: trustedCwd });
    setupHookBridge(pi, makeConfig(trustedCwd, [trustedCwd]), {
      cwd: trustedCwd,
      registry: [
        makeSpec(
          "type-safety-check",
          "tool_result",
          join(HOOKS, "post_tool_use/type_safety_check.sh"),
          { matcher: /^(Write|Edit|MultiEdit)$/, requiresTrust: true },
        ),
      ],
    });

    const patch = await pi.emitToolResult({
      type: "tool_result",
      toolName: "write",
      toolCallId: "t1",
      input: { path: filePath, content: ["const x:", "any = 1"].join(" ") },
      content: [{ type: "text", text: "written" }],
      isError: false,
    });

    // The same input produces a patch when the target is trusted (previous
    // test); with an untrusted target the hook must not run at all.
    expect(patch).toBeUndefined();
  });

  test("child profile keeps tool_call hooks but drops tool_result hooks", async () => {
    const directory = await makeTempDirectory("pi-hook-child");
    const filePath = join(directory, "file.ts");
    await fs.writeFile(filePath, "const x = 1\n");
    await fs.writeFile(
      join(directory, "package.json"),
      JSON.stringify({ scripts: { format: "prettier --write ." } }),
    );

    const pi = createFakePi({ cwd: directory, hasUI: false });
    setupHookBridge(pi, makeConfig(directory, [directory], true), {
      cwd: directory,
      registry: [
        makeSpec(
          "npm-script-preference",
          "tool_call",
          join(HOOKS, "pre_tool_use/npm_script_preference.sh"),
          { matcher: /^Bash$/ },
        ),
        makeSpec(
          "type-safety-check",
          "tool_result",
          join(HOOKS, "post_tool_use/type_safety_check.sh"),
          { matcher: /^(Write|Edit|MultiEdit)$/, requiresTrust: true },
        ),
      ],
    });

    // Deny-side hook still fires in a child: npx with an equivalent script
    // gets blocked by npm_script_preference.
    const blocked = await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t1",
      input: { command: "npx prettier --write ." },
    });
    expect(blocked?.block).toBe(true);

    // Post-tool hook must NOT run in a child even though everything is
    // trusted — same input that patches in the parent profile.
    const patch = await pi.emitToolResult({
      type: "tool_result",
      toolName: "write",
      toolCallId: "t2",
      input: { path: filePath, content: ["const x:", "any = 1"].join(" ") },
      content: [{ type: "text", text: "written" }],
      isError: false,
    });
    expect(patch).toBeUndefined();
  });
});
