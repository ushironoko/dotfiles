import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import type { HarnessConfig } from "../../../pi/extensions/pi-harness/config";
import setupHookBridge from "../../../pi/extensions/pi-harness/features/hook-bridge/index";
import type { BridgeHookSpec } from "../../../pi/extensions/pi-harness/features/hook-bridge/registry";
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

  test("round-trips npm_script_preference through a mapped Bash call", async () => {
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

    const blocked = await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t1",
      input: { command: "npx prettier --write ." },
    });
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("format");

    const allowed = await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "t2",
      input: { command: "bun run format" },
    });
    expect(allowed).toBeUndefined();
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
    expect(injection?.message.customType).toBe("pi-harness-hook-bridge");
    expect(injection?.message.content.length).toBeGreaterThan(0);
    expect(injection?.message.display).toBe(false);

    const ignored = await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "please review this normally",
    });
    expect(ignored).toBeUndefined();
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
