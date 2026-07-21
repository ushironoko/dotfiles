import { afterEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_PERMISSION_JUDGE_CONFIG,
  type HarnessConfig,
  type PermissionJudgeConfig,
} from "../../pi/extensions/pi-harness/config";
import setupPermissionPolicy from "../../pi/extensions/pi-harness/features/permission-policy";
import {
  CHILD_PERMISSION_SIGNAL_ENV,
  formatChildPermissionSignal,
} from "../../pi/extensions/pi-harness/features/permission-policy/block";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import type { ToolCallEvent } from "../../pi/extensions/pi-harness/lib/pi-like";
import { startMockUpstream, type MockUpstream } from "../test-helpers";
import { createFakePi } from "./fake-pi";

const upstreams: MockUpstream[] = [];

const start = async (
  chatHandler: Parameters<typeof startMockUpstream>[0],
): Promise<MockUpstream> => {
  const upstream = await startMockUpstream((request, received) => {
    if (received.path === "/api/status") {
      return Response.json({ cloud: { disabled: true, source: "test" } });
    }
    if (received.path === "/api/tags") {
      return Response.json({
        models: [
          {
            name: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
            model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
            digest: DEFAULT_PERMISSION_JUDGE_CONFIG.expectedDigest,
          },
        ],
      });
    }
    return chatHandler(request, received);
  });
  upstreams.push(upstream);
  return upstream;
};

const chatRequests = (upstream: MockUpstream) =>
  upstream.received.filter((request) => request.path === "/api/chat");

afterEach(async () => {
  await Promise.all(upstreams.splice(0).map((upstream) => upstream.close()));
});

const ollamaResponse = (content: string): Response =>
  Response.json({
    model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
    message: { role: "assistant", content },
    done: true,
    done_reason: "stop",
  });

const makeConfig = (
  permissionJudge?: PermissionJudgeConfig,
  isChild = false,
): HarnessConfig => ({
  isChild,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
    "ask-user-question": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths("/tmp/pi-permission-judge-policy"),
  ...(permissionJudge === undefined ? {} : { permissionJudge }),
});

const judgeConfig = (upstream: MockUpstream): PermissionJudgeConfig => ({
  ...DEFAULT_PERMISSION_JUDGE_CONFIG,
  url: `${upstream.url}/api/chat`,
});

const bashCall = (command: string, id = "judge-1"): ToolCallEvent => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: id,
  input: { command },
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

describe("permission policy local judge routing", () => {
  test("auto-approves an unruled command only on exact ALLOW", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi({ cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(
      await pi.emitToolCall(bashCall("git status --short")),
    ).toBeUndefined();
    expect(upstream.received.map((request) => request.path)).toEqual([
      "/api/status",
      "/api/tags",
      "/api/chat",
    ]);
  });

  test("a hidden substitution does not inherit the outer explicit allow", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const pi = createFakePi({ hasUI: false });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(await pi.emitToolCall(bashCall(`bun "$'$(printf PWN)'"`))).toEqual({
      block: true,
      reason: "local judge requested user confirmation",
    });
    expect(chatRequests(upstream)).toHaveLength(1);
  });

  test("hidden substitutions and unsupported `<<` never reach the judge", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi();
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));
    let deeplyNested = "bit issue claim";
    for (let depth = 0; depth < 66; depth += 1) {
      deeplyNested = `$(${deeplyNested})`;
    }
    const cases = [
      {
        command: `bun "$'$(bit relay sync)'"`,
        reason: "bit relay は禁止です",
      },
      {
        command: `bun "\${v:-$'$(bit issue claim)'}"`,
        reason: "コマンドを解析できませんでした",
      },
      {
        command: `bun "\${v:-'$(bit issue claim)'}"`,
        reason: "コマンドを解析できませんでした",
      },
      {
        command: `bun "\${v:-"$'$(bit issue claim)'"}"`,
        reason: "bit issue claim は禁止です",
      },
      {
        command: `bun "\${v:-$(printf %s 'x}'; bit issue claim)}"`,
        reason: "bit issue claim は禁止です",
      },
      {
        command: `v=x; echo "\${v#'{'}"; bit issue claim; echo "}"`,
        reason: "コマンドを解析できませんでした",
      },
      {
        command: `bun "\${v:-"${deeplyNested}"}"`,
        reason: "コマンドを解析できませんでした",
      },
      {
        command: 'bun "$\\\n(bit relay sync)"',
        reason: "コマンドを解析できませんでした",
      },
      {
        command: "cat <<EOF\n'$(bit relay sync)'\nEOF",
        reason: "コマンドを解析できませんでした",
      },
      {
        command: "cat <<EOF\n$(\nbit relay sync\n)\nEOF",
        reason: "コマンドを解析できませんでした",
      },
      {
        command: "cat <<EOF; echo $(bit relay sync)\nplain\nEOF",
        reason: "コマンドを解析できませんでした",
      },
      {
        command: "cat <<A <<B\nplain\nA\n'$(bit relay sync)'\nB",
        reason: "コマンドを解析できませんでした",
      },
      {
        command: "cat <<EOF\n EOF\n'$(bit relay sync)'\nEOF",
        reason: "コマンドを解析できませんでした",
      },
      {
        command: "cat <<$'\\q'\nbody\n\\q\nbit relay sync",
        reason: "コマンドを解析できませんでした",
      },
      {
        command: "cat <\\\n<EOF\n'$(bit relay sync)'\nEOF",
        reason: "コマンドを解析できませんでした",
      },
      {
        command: "! ((1 << 2))\nbit relay sync",
        reason: "コマンドを解析できませんでした",
      },
    ];

    for (const [index, sample] of cases.entries()) {
      const result = await pi.emitToolCall(
        bashCall(sample.command, `bypass-${index}`),
      );
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining(sample.reason),
      });
    }
    expect(upstream.received).toHaveLength(0);
  });

  test("deny, explicit allow, and built-in ask never call the judge", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi();
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(await pi.emitToolCall(bashCall("bit relay sync", "deny"))).toEqual({
      block: true,
      reason: "bit relay は禁止です",
    });
    expect(
      await pi.emitToolCall(bashCall("bun test", "allow")),
    ).toBeUndefined();
    pi.queueConfirm(true);
    expect(
      await pi.emitToolCall(bashCall("rm -rf /tmp/project", "ask")),
    ).toBeUndefined();
    expect(upstream.received).toHaveLength(0);
  });

  test("falls back to human confirmation for ASK or invalid output", async () => {
    let content = "ASK";
    const upstream = await start(() => ollamaResponse(content));
    const accepted = createFakePi();
    accepted.queueConfirm(true);
    setupPermissionPolicy(accepted, makeConfig(judgeConfig(upstream)));
    expect(
      await accepted.emitToolCall(bashCall("git status", "accepted")),
    ).toBeUndefined();

    content = "not a verdict";
    const rejected = createFakePi();
    rejected.queueConfirm(false);
    setupPermissionPolicy(rejected, makeConfig(judgeConfig(upstream)));
    expect(
      await rejected.emitToolCall(bashCall("git status", "rejected")),
    ).toEqual({
      block: true,
      reason: "local judge did not return an exact ALLOW verdict",
    });
  });

  test("bounds confirmation with the active signal and configured timeout", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const pi = createFakePi();
    const controller = createTestAbortController();
    Object.assign(pi.ctx, { signal: controller.signal });
    pi.queueConfirm(false);
    setupPermissionPolicy(
      pi,
      makeConfig({
        ...judgeConfig(upstream),
        confirmTimeoutMs: 1_234,
      }),
    );

    expect(await pi.emitToolCall(bashCall("git status"))).toEqual({
      block: true,
      reason: "local judge requested user confirmation",
    });
    expect(pi.confirmDialogs).toHaveLength(1);
    expect(pi.confirmDialogs[0]?.dialogOptions).toEqual({
      signal: controller.signal,
      timeout: 1_234,
    });
  });

  test("blocks non-interactively when the judge does not allow", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const pi = createFakePi({ hasUI: false });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(await pi.emitToolCall(bashCall("git status"))).toEqual({
      block: true,
      reason: "local judge requested user confirmation",
    });
  });

  test("signals child-only permission blocks without changing the tool reason", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const pi = createFakePi({ hasUI: false });
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const signals: string[] = [];
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream), true), {
      permissionSignalToken: token,
      writePermissionSignal: (text) => signals.push(text),
    });

    expect(await pi.emitToolCall(bashCall("git status"))).toEqual({
      block: true,
      reason: "local judge requested user confirmation",
    });
    expect(signals).toEqual([`${formatChildPermissionSignal(token)}\n`]);
  });

  test("consumes the inherited child signal token before tools can inherit it", () => {
    const previous = process.env[CHILD_PERMISSION_SIGNAL_ENV];
    process.env[CHILD_PERMISSION_SIGNAL_ENV] =
      "123e4567-e89b-42d3-a456-426614174000";
    try {
      const pi = createFakePi({ hasUI: false });
      setupPermissionPolicy(pi, makeConfig(undefined, true));
      expect(process.env[CHILD_PERMISSION_SIGNAL_ENV]).toBeUndefined();
    } finally {
      if (previous === undefined)
        delete process.env[CHILD_PERMISSION_SIGNAL_ENV];
      else process.env[CHILD_PERMISSION_SIGNAL_ENV] = previous;
    }
  });

  test("warns once and confirms when Ollama is unavailable", async () => {
    const upstream = await start(() => new Response("down", { status: 503 }));
    const pi = createFakePi();
    pi.queueConfirm(true);
    pi.queueConfirm(true);
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(
      await pi.emitToolCall(bashCall("git status", "first")),
    ).toBeUndefined();
    expect(
      await pi.emitToolCall(bashCall("git log -1", "second")),
    ).toBeUndefined();
    expect(chatRequests(upstream)).toHaveLength(1);
    expect(pi.notifications).toEqual([
      {
        level: "warning",
        message: expect.stringContaining("ローカルコマンド判定器"),
      },
    ]);
  });

  test("a cached approval does not restart the same unavailable warning period", async () => {
    let calls = 0;
    const upstream = await start(() => {
      calls += 1;
      return calls === 1
        ? ollamaResponse("ALLOW")
        : new Response("down", { status: 503 });
    });
    const pi = createFakePi();
    pi.queueConfirm(true);
    pi.queueConfirm(true);
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    await pi.emitToolCall(bashCall("git status", "cache-seed"));
    await pi.emitToolCall(bashCall("git log -1", "outage"));
    await pi.emitToolCall(bashCall("git status", "cache-hit"));
    await pi.emitToolCall(bashCall("git diff --stat", "same-outage"));

    expect(chatRequests(upstream)).toHaveLength(2);
    expect(pi.notifications).toHaveLength(1);
  });

  test("a parent abort blocks without requesting or prompting", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi();
    const controller = createTestAbortController();
    controller.abort();
    Object.assign(pi.ctx, { signal: controller.signal });
    pi.queueConfirm(true);
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(await pi.emitToolCall(bashCall("git status"))).toEqual({
      block: true,
      reason: "the active pi operation was cancelled",
    });
    expect(upstream.received).toHaveLength(0);
  });

  test("omitted or disabled judge config preserves rule-only behavior", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));

    const omitted = createFakePi();
    setupPermissionPolicy(omitted, makeConfig());
    expect(await omitted.emitToolCall(bashCall("git status"))).toBeUndefined();

    const disabled = createFakePi();
    setupPermissionPolicy(
      disabled,
      makeConfig({
        ...judgeConfig(upstream),
        enabled: false,
      }),
    );
    expect(await disabled.emitToolCall(bashCall("git status"))).toBeUndefined();
    expect(upstream.received).toHaveLength(0);
  });

  test("session shutdown clears cached ALLOW decisions", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi({ cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    await pi.emitToolCall(bashCall("git status", "one"));
    await pi.emitToolCall(bashCall("git status", "two"));
    expect(chatRequests(upstream)).toHaveLength(1);

    await pi.emitSessionShutdown();
    await pi.emitToolCall(bashCall("git status", "three"));
    expect(chatRequests(upstream)).toHaveLength(2);
  });
});
