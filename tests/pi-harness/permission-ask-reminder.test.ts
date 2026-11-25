import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi } from "./fake-pi";

const directories: string[] = [];
const harnesses: ReturnType<typeof createFakePi>[] = [];

const setupConfirmationHarness = async (hasUI: boolean) => {
  const home = await mkdtemp(join(tmpdir(), "pi-confirmation-"));
  directories.push(home);
  const config: HarnessConfig = {
    isChild: false,
    features: {
      "hook-bridge": false,
      subagent: false,
      workflow: false,
      "bit-task": false,
      "agent-memory": false,
      statusline: false,
      "provider-log": false,
      "asuku-notify": false,
      "ask-user-question": false,
    },
    trust: { trustedRoots: [] },
    paths: resolvePaths(home),
  };
  const pi = createFakePi({ cwd: home, hasUI });
  harnesses.push(pi);
  setupHarness(pi, config, {
    setupBashSandbox: () => ({
      async registerWritableWorktree() {},
      async revokeWritableWorktree() {},
      boundaryFor: (toolName) => ({
        mode: toolName === "bash" ? "sandboxed" : "escalated",
        network: "denied",
        profileFingerprint: "e".repeat(64),
      }),
      registerExecutionBoundary() {},
    }),
  });
  return pi;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((pi) => pi.emitSessionShutdown()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("permission confirmations without command coaching", () => {
  test.each([
    [true, true],
    [true, false],
    [false, false],
  ])(
    "preserves confirmation behavior with UI=%s and approval=%s",
    async (hasUI, approved) => {
      const pi = await setupConfirmationHarness(hasUI);
      const messages = [{ role: "user", content: "continue" }];

      for (let index = 0; index < 6; index += 1) {
        if (hasUI) pi.queueConfirm(approved);
        const result = await pi.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: `confirmation-${index}`,
          input: { command: "git push origin main" },
        });
        if (hasUI && approved) {
          expect(result).toBeUndefined();
        } else {
          expect(result).toMatchObject({ block: true });
        }
        expect(await pi.emitContext(messages)).toEqual(messages);
      }

      expect(pi.confirmDialogs).toHaveLength(hasUI ? 6 : 0);
    },
  );
});
