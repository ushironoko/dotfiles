import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
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
import type { PermissionProjectContext } from "../../pi/extensions/pi-harness/features/permission-policy/context";
import { loadRules } from "../../pi/extensions/pi-harness/features/permission-policy/rules";
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

const ollamaResponse = (verdict: string): Response =>
  Response.json({
    model: DEFAULT_PERMISSION_JUDGE_CONFIG.model,
    message: {
      role: "assistant",
      content: JSON.stringify({ verdict }),
    },
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

const verifiedProject = (cwd: string): PermissionProjectContext => ({
  kind: "git",
  name: "dotfiles",
  cwd,
  activeWorktree: cwd,
  navigableRoots: [cwd],
  worktrees: [cwd],
  fingerprint: `project:${cwd}`,
});

const verifiedGitCwdProject = (cwd: string): PermissionProjectContext => ({
  ...verifiedProject(cwd),
  leadingNavigation: {
    scope: "listed-worktree",
    sameRepository: true,
  },
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
  test("auto-approves an unruled command only on structured ALLOW", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi({ cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(
      await pi.emitToolCall(bashCall("git rev-parse HEAD")),
    ).toBeUndefined();
    expect(upstream.received.map((request) => request.path)).toEqual([
      "/api/status",
      "/api/tags",
      "/api/chat",
    ]);
  });

  test("auto-approves verified no-config project searches before Ollama", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => verifiedProject(cwd),
    });

    for (const command of [
      'rg --no-config -n "permission.*log|local judge requested" src tests',
      "rg --no-config -n pattern src | head -200",
    ]) {
      expect(await pi.emitToolCall(bashCall(command))).toBeUndefined();
    }
    expect(upstream.received).toHaveLength(0);
  });

  test("keeps helper-capable Git reads on the model route", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => verifiedProject(cwd),
    });

    expect(await pi.emitToolCall(bashCall("git status --short"))).toEqual({
      block: true,
      reason: "local judge requested user confirmation",
    });
    expect(chatRequests(upstream)).toHaveLength(1);
  });

  test("routes a verified same-repository git -C read to the local judge", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = resolve(import.meta.dir, "../..");
    const linked = resolve(cwd, "../linked-worktree");
    const pi = createFakePi({ cwd, hasUI: false });
    let discoveredTarget: string | undefined;
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async (_cwd, _signal, target) => {
        discoveredTarget = target;
        return verifiedGitCwdProject(cwd);
      },
    });

    expect(
      await pi.emitToolCall(
        bashCall(`git -C ${linked} status --short`, "verified-git-cwd"),
      ),
    ).toBeUndefined();
    expect(discoveredTarget).toBe(linked);
    expect(chatRequests(upstream)).toHaveLength(1);
    expect(chatRequests(upstream)[0]?.body).toContain(
      '\\"gitCwd\\":{\\"scope\\":\\"listed-worktree\\"}',
    );
  });

  test("keeps an unverified git -C read before the local judge", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd, hasUI: false });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => ({
        ...verifiedProject(cwd),
        leadingNavigation: {
          scope: "outside-listed-worktrees",
          sameRepository: false,
        },
      }),
    });

    expect(
      await pi.emitToolCall(
        bashCall("git -C /tmp/unrelated status --short", "unverified-git-cwd"),
      ),
    ).toEqual({
      block: true,
      reason:
        "git -C の対象を登録済みの同一リポジトリworktree内と確認できませんでした",
    });
    expect(upstream.received).toHaveLength(0);
  });

  test("never verifies shell-sensitive git -C path spellings", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd, hasUI: false });
    let discoveries = 0;
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => {
        discoveries += 1;
        return verifiedGitCwdProject(cwd);
      },
    });

    for (const command of [
      "git -C ~/other status --short",
      "git -C /repo/link/.. status --short",
      "git -C ../linked-worktree status --short",
    ]) {
      expect(await pi.emitToolCall(bashCall(command))).toEqual({
        block: true,
        reason:
          "Git の作業場所・設定・不明なグローバルオプション変更には確認が必要です",
      });
    }
    expect(discoveries).toBe(0);
    expect(upstream.received).toHaveLength(0);
  });

  test("uses bounded raw current-turn input instead of the expanded prompt", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => verifiedProject(cwd),
    });

    await pi.emitInput({
      type: "input",
      text: "/skill:start-work implement contextual judging",
      source: "interactive",
    });
    await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "PRIVATE EXPANDED SKILL FILE CONTENTS",
    });
    expect(
      await pi.emitToolCall(bashCall("git rev-parse HEAD")),
    ).toBeUndefined();

    const firstBody = chatRequests(upstream)[0]?.body ?? "";
    expect(firstBody).toContain(
      "/skill:start-work implement contextual judging",
    );
    expect(firstBody).not.toContain("PRIVATE EXPANDED SKILL FILE CONTENTS");
    expect(firstBody).toContain(cwd);

    await pi.emitAgentSettled();
    expect(
      await pi.emitToolCall(bashCall("git rev-parse HEAD", "after-settled")),
    ).toBeUndefined();
    const secondBody = chatRequests(upstream)[1]?.body ?? "";
    expect(secondBody).not.toContain("/skill:start-work");
    expect(chatRequests(upstream)).toHaveLength(2);
  });

  test("adds only authenticated current-run assistant text and tool-result metadata", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => verifiedProject(cwd),
    });
    pi.setSessionBranch([
      {
        type: "message",
        message: { role: "user", content: "Investigate permission prompts" },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Inspect the judge after the failed test." },
            {
              type: "toolCall",
              id: "prior-read",
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
          toolCallId: "prior-read",
          toolName: "read",
          content: [{ type: "text", text: "PRIVATE OUTPUT" }],
          details: { secret: "PRIVATE DETAILS" },
          isError: false,
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "PRIVATE THINKING" },
            { type: "text", text: "Now inspect policy references." },
            {
              type: "toolCall",
              id: "current-rg",
              name: "bash",
              arguments: { command: "PRIVATE CURRENT ARGUMENT" },
            },
          ],
        },
      },
    ]);

    expect(
      await pi.emitToolCall(
        bashCall("grep permission-policy pi", "current-rg"),
      ),
    ).toBeUndefined();
    const body = chatRequests(upstream)[0]?.body ?? "";
    expect(body).toContain("Inspect the judge after the failed test.");
    expect(body).toContain("Now inspect policy references.");
    expect(body).toContain(String.raw`\"toolName\":\"read\",\"status\":\"ok\"`);
    expect(body).not.toContain("PRIVATE ARGUMENT");
    expect(body).not.toContain("PRIVATE CURRENT ARGUMENT");
    expect(body).not.toContain("PRIVATE OUTPUT");
    expect(body).not.toContain("PRIVATE DETAILS");
    expect(body).not.toContain("PRIVATE THINKING");
  });

  test("fails closed when queued expanded input lacks an exact delivery match", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => verifiedProject(cwd),
    });

    await pi.emitInput({
      type: "input",
      text: "Initial review task",
      source: "interactive",
    });
    await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: "Initial review task",
    });
    const previousMessages = [{ role: "user", content: "Initial review task" }];
    await pi.emitContext(previousMessages);
    await pi.emitInput({
      type: "input",
      text: "/skill:start-work implement follow-up",
      source: "interactive",
      streamingBehavior: "followUp",
    });
    await pi.emitContext(previousMessages);

    await pi.emitToolCall(bashCall("git rev-parse HEAD", "before-delivery"));
    const beforeDelivery = chatRequests(upstream)[0]?.body ?? "";
    expect(beforeDelivery).toContain("Initial review task");
    expect(beforeDelivery).not.toContain("/skill:start-work");

    await pi.emitContext([
      ...previousMessages,
      { role: "assistant", content: [] },
      { role: "user", content: "PRIVATE EXPANDED SKILL CONTENT" },
    ]);
    await pi.emitToolCall(
      bashCall("git rev-parse --show-toplevel", "after-delivery"),
    );
    const afterDelivery = chatRequests(upstream)[1]?.body ?? "";
    expect(afterDelivery).not.toContain("/skill:start-work");
    expect(afterDelivery).not.toContain("PRIVATE EXPANDED SKILL CONTENT");
  });

  test("does not reuse an expandable task cache entry after its queued input is dequeued", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => verifiedProject(cwd),
    });

    const taskA = "/skill:start-work allow task A";
    const expandedA = "PRIVATE EXPANDED TASK A";
    await pi.emitInput({
      type: "input",
      text: taskA,
      source: "interactive",
    });
    await pi.emitBeforeAgentStart({
      type: "before_agent_start",
      prompt: expandedA,
    });
    const baseline = [{ role: "user", content: expandedA }];
    await pi.emitContext(baseline);
    await pi.emitToolCall(bashCall("git rev-parse HEAD", "cache-seed"));
    expect(chatRequests(upstream)).toHaveLength(1);
    await pi.emitAgentSettled();

    await pi.emitInput({
      type: "input",
      text: taskA,
      source: "interactive",
      streamingBehavior: "steer",
    });
    await pi.emitInput({
      type: "input",
      text: "Task B: inspect only and do not mutate",
      source: "interactive",
      streamingBehavior: "steer",
    });
    await pi.emitContext([
      ...baseline,
      { role: "user", content: "Task B: inspect only and do not mutate" },
    ]);

    await pi.emitToolCall(bashCall("git rev-parse HEAD", "after-dequeue"));
    expect(chatRequests(upstream)).toHaveLength(2);
    const afterDequeue = chatRequests(upstream)[1]?.body ?? "";
    expect(afterDequeue).not.toContain(taskA);
    expect(afterDequeue).not.toContain("Task B: inspect only");
  });

  test("does not reuse ALLOW cache after queued-task correlation fails", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = resolve(import.meta.dir, "../..");
    const pi = createFakePi({ cwd });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => verifiedProject(cwd),
    });

    const baseline = [{ role: "user", content: "Initial task" }];
    await pi.emitContext(baseline);
    await pi.emitInput({
      type: "input",
      text: "same queued task",
      source: "interactive",
      streamingBehavior: "steer",
    });
    await pi.emitInput({
      type: "input",
      text: "same queued task",
      source: "rpc",
      streamingBehavior: "steer",
    });
    await pi.emitContext([
      ...baseline,
      { role: "user", content: "same queued task" },
    ]);

    expect(
      await pi.emitToolCall(bashCall("git rev-parse HEAD", "uncorrelated-1")),
    ).toBeUndefined();
    expect(
      await pi.emitToolCall(bashCall("git rev-parse HEAD", "uncorrelated-2")),
    ).toBeUndefined();
    expect(chatRequests(upstream)).toHaveLength(2);
    expect(
      chatRequests(upstream)
        .map((request) => request.body)
        .join("\n"),
    ).not.toContain("same queued task");
  });

  test("keeps unavailable project mutations above a catch-all configured allow", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const cwd = "/tmp/project";
    const pi = createFakePi({ cwd, hasUI: false });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      rules: loadRules(
        JSON.stringify({
          deny: [],
          allow: [{ pattern: "^" }],
          ask: [],
        }),
      ),
      discoverProject: async () => ({
        kind: "unavailable",
        cwd,
        reason: "PRIVATE DISCOVERY DETAILS",
        fingerprint: "project:unavailable",
      }),
    });

    for (const [index, command] of [
      "git add src/parser.ts",
      "git apply fix.patch",
      "git pull --ff-only",
      'echo "$(git apply fix.patch)"',
      'echo "$(git pull --ff-only)"',
    ].entries()) {
      expect(
        await pi.emitToolCall(
          bashCall(command, `unavailable-mutation-${index}`),
        ),
      ).toEqual({
        block: true,
        reason:
          "プロジェクト境界を検証できないため変更コマンドには確認が必要です",
      });
    }
    expect(upstream.received).toHaveLength(0);
  });

  test("preserves configured allows only after required navigation and project verification", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const cwd = "/tmp/verified-project";
    const pi = createFakePi({ cwd, hasUI: false });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      rules: loadRules(
        JSON.stringify({
          deny: [],
          allow: [{ pattern: "^" }],
          ask: [],
        }),
      ),
      discoverProject: async (_cwd, _signal, leadingCdTarget) => ({
        ...verifiedProject(cwd),
        ...(leadingCdTarget === undefined
          ? {}
          : {
              leadingNavigation:
                leadingCdTarget === cwd
                  ? {
                      scope: "listed-worktree" as const,
                      sameRepository: true,
                    }
                  : {
                      scope: "outside-listed-worktrees" as const,
                      sameRepository: false,
                    },
            }),
      }),
    });

    expect(
      await pi.emitToolCall(bashCall("git pull --ff-only", "verified-pull")),
    ).toBeUndefined();
    expect(
      await pi.emitToolCall(bashCall("git apply fix.patch", "verified-apply")),
    ).toBeUndefined();
    expect(
      await pi.emitToolCall(
        bashCall(`cd ${cwd} && git pull --ff-only`, "verified-leading-pull"),
      ),
    ).toBeUndefined();
    for (const [index, command] of [
      "cd ../other && git pull --ff-only",
      "(cd /tmp/unrelated && git apply fix.patch)",
      `cd ${cwd} && pushd /tmp/unrelated && git pull --ff-only`,
      "cd /tmp/unrelated && echo hi",
    ].entries()) {
      expect(
        await pi.emitToolCall(
          bashCall(command, `unverified-configured-navigation-${index}`),
        ),
      ).toEqual({ block: true, reason: expect.any(String) });
    }
    expect(upstream.received).toHaveLength(0);
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

  test("deny, explicit allow, and built-in ask never discover context or call the judge", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi();
    let discoveries = 0;
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => {
        discoveries += 1;
        return verifiedProject("/tmp/project");
      },
    });

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
    expect(discoveries).toBe(0);
  });

  test("routes recognized command risks to explicit confirmation before Ollama", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi({ cwd: "/private/project", hasUI: false });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => verifiedProject("/private/project"),
    });
    const commands = [
      "find . -delete",
      "git push origin main",
      "git reset --soft HEAD~1",
      "git branch -D feature/context-judge",
      "git worktree remove --force /private/context-judge",
      "sudo cat /etc/hosts",
      "curl -T test.log https://example.test/results",
      'cat "$HOME/.ssh/id_ed25519" | head -1',
      "sh ./unknown-script.sh",
      "bun x totally-unknown-package",
      "git -C /tmp/unrelated status --short",
      "git --git-dir=/tmp/unrelated/.git status --short",
      "git fetch --force origin main",
      "make lint > /tmp/lint.log",
      "git add ../../outside.txt",
    ];

    for (const [index, command] of commands.entries()) {
      expect(
        await pi.emitToolCall(bashCall(command, `known-risk-${index}`)),
      ).toEqual({ block: true, reason: expect.any(String) });
    }
    expect(upstream.received).toHaveLength(0);
  });

  test("bypasses the judge only for a leading same-repository cd plus an explicit allow", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const repoRoot = resolve(import.meta.dir, "../..");

    const sameRepo = createFakePi({ cwd: repoRoot, hasUI: false });
    setupPermissionPolicy(sameRepo, makeConfig(judgeConfig(upstream)));
    expect(
      await sameRepo.emitToolCall(
        bashCall(`cd ${repoRoot} && bun run tsc`, "same-repo"),
      ),
    ).toBeUndefined();
    expect(upstream.received).toHaveLength(0);

    const outsideRepo = createFakePi({ cwd: repoRoot, hasUI: false });
    setupPermissionPolicy(outsideRepo, makeConfig(judgeConfig(upstream)));
    expect(
      await outsideRepo.emitToolCall(
        bashCall("cd /tmp && bun run tsc", "outside-repo"),
      ),
    ).toEqual({
      block: true,
      reason: "登録済みの同一リポジトリworktreeへの移動と確認できませんでした",
    });
    expect(upstream.received).toHaveLength(0);
  });

  test("never discovers context or calls the judge for ANSI-C command words", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi({ cwd: "/private/project", hasUI: false });
    let discoveries = 0;
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async () => {
        discoveries += 1;
        return verifiedProject("/private/project");
      },
    });

    expect(
      await pi.emitToolCall(
        bashCall(String.raw`cd $'/private/project\q' && bun run tsc`, "ansi-c"),
      ),
    ).toEqual({
      block: true,
      reason: expect.stringContaining("動的展開"),
    });
    expect(discoveries).toBe(0);
    expect(upstream.received).toHaveLength(0);
  });

  test("does not trust a leading cd outside registered worktree roots", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const cwd = "/private/project";
    const target = "/private/forged-worktree";
    const pi = createFakePi({ cwd, hasUI: false });
    let discoveredTarget: string | undefined;
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)), {
      discoverProject: async (_cwd, _signal, leadingCdTarget) => {
        discoveredTarget = leadingCdTarget;
        return {
          ...verifiedProject(cwd),
          leadingNavigation: {
            scope: "outside-listed-worktrees",
            sameRepository: false,
          },
        };
      },
    });

    expect(
      await pi.emitToolCall(
        bashCall(`cd ${target} && bun run tsc`, "forged-worktree"),
      ),
    ).toEqual({
      block: true,
      reason: "登録済みの同一リポジトリworktreeへの移動と確認できませんでした",
    });
    expect(discoveredTarget).toBe(target);
    expect(upstream.received).toHaveLength(0);
  });

  test("falls back to human confirmation for ASK or invalid output", async () => {
    let content = "ASK";
    const upstream = await start(() => ollamaResponse(content));
    const accepted = createFakePi();
    accepted.queueConfirm(true);
    setupPermissionPolicy(accepted, makeConfig(judgeConfig(upstream)));
    expect(
      await accepted.emitToolCall(bashCall("git rev-parse HEAD", "accepted")),
    ).toBeUndefined();

    content = "not a verdict";
    const rejected = createFakePi();
    rejected.queueConfirm(false);
    setupPermissionPolicy(rejected, makeConfig(judgeConfig(upstream)));
    expect(
      await rejected.emitToolCall(bashCall("git rev-parse HEAD", "rejected")),
    ).toEqual({
      block: true,
      reason: "local judge did not return a valid structured verdict",
    });
  });

  test("keeps confirmation abortable without a timeout", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const pi = createFakePi();
    const controller = createTestAbortController();
    Object.assign(pi.ctx, { signal: controller.signal });
    pi.queueConfirm(false);
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(await pi.emitToolCall(bashCall("git rev-parse HEAD"))).toEqual({
      block: true,
      reason: "local judge requested user confirmation",
    });
    expect(pi.confirmDialogs).toHaveLength(1);
    expect(pi.confirmDialogs[0]?.dialogOptions).toEqual({
      signal: controller.signal,
    });
    expect(pi.confirmDialogs[0]?.dialogOptions).not.toHaveProperty("timeout");
  });

  test("blocks non-interactively when the judge does not allow", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));
    const pi = createFakePi({ hasUI: false });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    expect(await pi.emitToolCall(bashCall("git rev-parse HEAD"))).toEqual({
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

    expect(await pi.emitToolCall(bashCall("git rev-parse HEAD"))).toEqual({
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
      await pi.emitToolCall(bashCall("git rev-parse HEAD", "first")),
    ).toBeUndefined();
    expect(
      await pi.emitToolCall(
        bashCall("git rev-parse --show-toplevel", "second"),
      ),
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

    await pi.emitToolCall(bashCall("git rev-parse HEAD", "cache-seed"));
    await pi.emitToolCall(bashCall("git rev-parse --show-toplevel", "outage"));
    await pi.emitToolCall(bashCall("git rev-parse HEAD", "cache-hit"));
    await pi.emitToolCall(bashCall("git rev-parse --git-dir", "same-outage"));

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

    expect(await pi.emitToolCall(bashCall("git rev-parse HEAD"))).toEqual({
      block: true,
      reason: "the active pi operation was cancelled",
    });
    expect(upstream.received).toHaveLength(0);
  });

  test("omitted or disabled judge config preserves rule-only behavior", async () => {
    const upstream = await start(() => ollamaResponse("ASK"));

    const omitted = createFakePi();
    setupPermissionPolicy(omitted, makeConfig());
    expect(
      await omitted.emitToolCall(bashCall("git rev-parse HEAD")),
    ).toBeUndefined();

    const disabled = createFakePi();
    setupPermissionPolicy(
      disabled,
      makeConfig({
        ...judgeConfig(upstream),
        enabled: false,
      }),
    );
    expect(
      await disabled.emitToolCall(bashCall("git rev-parse HEAD")),
    ).toBeUndefined();
    expect(upstream.received).toHaveLength(0);
  });

  test("session shutdown clears cached ALLOW decisions", async () => {
    const upstream = await start(() => ollamaResponse("ALLOW"));
    const pi = createFakePi({ cwd: "/tmp/project" });
    setupPermissionPolicy(pi, makeConfig(judgeConfig(upstream)));

    await pi.emitToolCall(bashCall("git rev-parse HEAD", "one"));
    await pi.emitToolCall(bashCall("git rev-parse HEAD", "two"));
    expect(chatRequests(upstream)).toHaveLength(1);

    await pi.emitSessionShutdown();
    await pi.emitToolCall(bashCall("git rev-parse HEAD", "three"));
    expect(chatRequests(upstream)).toHaveLength(2);
  });
});
