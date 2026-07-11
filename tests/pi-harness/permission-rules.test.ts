import { describe, expect, test } from "bun:test";
import setupPermissionPolicy from "../../pi/extensions/pi-harness/features/permission-policy";
import {
  evaluateCommand,
  loadRules,
} from "../../pi/extensions/pi-harness/features/permission-policy/rules";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import type { ToolCallEvent } from "../../pi/extensions/pi-harness/lib/pi-like";
import { createFakePi } from "./fake-pi";

const config: HarnessConfig = {
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths("/tmp/pi-harness-permission-policy-test"),
};

const denyCases = [
  ["bit issue claim 123", "bit issue claim は禁止です"],
  ["bit issue unclaim 123", "bit issue unclaim は禁止です"],
  ["bit issue claims", "bit issue claims は禁止です"],
  ["bit issue watch 5", "bit issue watch は禁止です"],
  ["bit issue import x", "bit issue import は禁止です"],
  ["bit pr import 7", "bit pr import は禁止です"],
  ["bit relay serve", "bit relay は禁止です"],
  ["bit clone relay+ssh://x", "bit clone relay+ は禁止です"],
] as const;

const benignCommands: string[] = [
  "bit issue list --open",
  "echo hello",
  "git status",
  "rm -f /tmp/x",
  "rm -rf relative/path",
  "git push origin main",
  "git reset --soft HEAD~1",
  "git clean -f",
  "chmod 777 /tmp/x",
];

const destructiveCommands: string[] = [
  "git reset --hard HEAD~1",
  "rm -rf /tmp/x",
  "rm -fr ~",
  "rm -r -f /",
  "git push origin main --force",
  "git push -f origin main",
  "git clean -fd",
  "git clean -df",
  "git clean -f -d",
  "chmod -R 777 /tmp/x",
];

const createPermissionPi = (hasUI = true) => {
  const pi = createFakePi({ hasUI });
  setupPermissionPolicy(pi, config);
  return pi;
};

const bashCall = (command: string): ToolCallEvent => ({
  type: "tool_call",
  toolName: "bash",
  toolCallId: "t1",
  input: { command },
});

describe("permission-policy", () => {
  test.each(denyCases)("blocks %s", async (command, reason) => {
    const pi = createPermissionPi();

    expect(await pi.emitToolCall(bashCall(command))).toEqual({
      block: true,
      reason,
    });
  });

  test.each(benignCommands)("continues %s", async (command) => {
    const pi = createPermissionPi();

    expect(await pi.emitToolCall(bashCall(command))).toBeUndefined();
  });

  test.each(destructiveCommands)("continues confirmed %s", async (command) => {
    const pi = createPermissionPi();
    pi.queueConfirm(true);

    expect(await pi.emitToolCall(bashCall(command))).toBeUndefined();
  });

  test.each(destructiveCommands)("blocks rejected %s", async (command) => {
    const pi = createPermissionPi();
    pi.queueConfirm(false);

    expect(await pi.emitToolCall(bashCall(command))).toEqual({
      block: true,
      reason: expect.any(String),
    });
  });

  test("blocks destructive commands without consulting confirm when non-interactive", async () => {
    const pi = createPermissionPi(false);
    pi.queueConfirm(true);

    expect(await pi.emitToolCall(bashCall("git reset --hard HEAD~1"))).toEqual({
      block: true,
      reason: expect.any(String),
    });

    pi.ctx.hasUI = true;
    expect(
      await pi.emitToolCall(bashCall("git reset --hard HEAD~1")),
    ).toBeUndefined();
  });

  test("passes through non-bash tools", async () => {
    const pi = createPermissionPi();

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "read",
        toolCallId: "t1",
        input: { command: "bit issue claim x" },
      }),
    ).toBeUndefined();
  });

  // Malformed bash input must BLOCK, not pass through — the safety floor is
  // fail-closed for anything it cannot evaluate (review finding).
  test.each([
    { label: "non-string command", input: { command: 42 } },
    { label: "missing command", input: {} },
    { label: "null command", input: { command: null } },
    { label: "array command", input: { command: ["bit", "issue", "claim"] } },
  ])("blocks malformed bash input: $label", async ({ input }) => {
    const pi = createPermissionPi();

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "t1",
        input: input as Record<string, unknown>,
      }),
    ).toEqual({ block: true, reason: expect.stringContaining("ブロック") });
  });

  test("empty-but-valid rules file keeps the built-in deny floor", async () => {
    // A config of {"deny":[],"ask":[]} must not drop the mandatory denials.
    const { loadRules, evaluateCommand } = await import(
      "../../pi/extensions/pi-harness/features/permission-policy/rules"
    );
    const rules = loadRules('{"deny":[],"ask":[]}');
    expect(evaluateCommand("bit issue claim 123", rules).verdict).toBe("deny");
    expect(evaluateCommand("bit relay serve", rules).verdict).toBe("deny");
  });
});

describe("loadRules fail-closed behavior", () => {
  test.each([undefined, "not-json"])(
    "retains the built-in deny floor for %s",
    (jsonText) => {
      expect(
        evaluateCommand("bit issue claim x", loadRules(jsonText)).verdict,
      ).toBe("deny");
    },
  );

  test("compensates for an invalid deny regex", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [{ pattern: "([", reason: "壊れたルール" }],
        ask: [],
      }),
    );

    expect(evaluateCommand("bit issue claim x", rules).verdict).toBe("deny");
  });

  test("evaluates deny before allow", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [{ pattern: "^echo secret$", reason: "拒否" }],
        allow: [{ pattern: "^echo secret$" }],
        ask: [],
      }),
    );

    expect(evaluateCommand("echo secret", rules).verdict).toBe("deny");
  });

  test("evaluates allow before the destructive default", () => {
    const rules = loadRules(
      JSON.stringify({
        deny: [],
        allow: [{ pattern: "^git reset --hard" }],
        ask: [],
      }),
    );

    expect(evaluateCommand("git reset --hard HEAD~1", rules).verdict).toBe(
      "allow",
    );
  });
});
