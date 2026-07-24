import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupPermissionAskReminder, {
  PERMISSION_ASK_REMINDER_CUSTOM_TYPE,
  PERMISSION_ASK_REMINDER_THRESHOLD,
} from "../../pi/extensions/pi-harness/features/permission-ask-reminder/index";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi } from "./fake-pi";

const config = async (): Promise<HarnessConfig> => ({
  isChild: false,
  features: {
    "hook-bridge": false,
    subagent: false,
    workflow: false,
    "bit-task": false,
    statusline: false,
    "provider-log": false,
    "asuku-notify": false,
    "ask-user-question": false,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(await mkdtemp(join(tmpdir(), "pi-ask-reminder-"))),
});

const reminders = (messages: readonly unknown[]) =>
  messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "customType" in message &&
      message.customType === PERMISSION_ASK_REMINDER_CUSTOM_TYPE,
  );

describe("permission ASK reminder", () => {
  test("injects one hidden reminder after every three displayed confirmations", async () => {
    const pi = createFakePi();
    const reminder = setupPermissionAskReminder(pi);

    for (let index = 1; index < PERMISSION_ASK_REMINDER_THRESHOLD; index += 1) {
      reminder.recordDisplayedConfirmation();
    }
    expect(await pi.emitContext([])).toEqual([]);

    reminder.recordDisplayedConfirmation();
    const first = reminders(await pi.emitContext([]));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      role: "custom",
      customType: PERMISSION_ASK_REMINDER_CUSTOM_TYPE,
      display: false,
    });
    expect(JSON.stringify(first[0])).toContain(
      "3 Bash permission confirmations",
    );
    expect(JSON.stringify(first[0])).toContain("Do not weaken or bypass");
    expect(reminders(await pi.emitContext([]))).toEqual([]);

    for (let index = 0; index < PERMISSION_ASK_REMINDER_THRESHOLD; index += 1) {
      reminder.recordDisplayedConfirmation();
    }
    expect(JSON.stringify(reminders(await pi.emitContext([]))[0])).toContain(
      "6 Bash permission confirmations",
    );

    await pi.emitSessionStart({ type: "session_start", reason: "resume" });
    reminder.recordDisplayedConfirmation();
    reminder.recordDisplayedConfirmation();
    expect(await pi.emitContext([])).toEqual([]);
  });

  test("counts accepted policy challenges but excludes UI-less not-shown outcomes", async () => {
    const value = await config();
    const pi = createFakePi({ cwd: value.paths.home });
    setupHarness(pi, value);

    for (let index = 0; index < PERMISSION_ASK_REMINDER_THRESHOLD; index += 1) {
      pi.queueConfirm(true);
      expect(
        await pi.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: `displayed-${index}`,
          input: { command: "git push origin main" },
        }),
      ).toBeUndefined();
    }
    expect(reminders(await pi.emitContext([]))).toHaveLength(1);
    await pi.emitSessionShutdown();

    const headlessValue = await config();
    const headless = createFakePi({
      cwd: headlessValue.paths.home,
      hasUI: false,
    });
    setupHarness(headless, headlessValue);

    for (let index = 0; index < PERMISSION_ASK_REMINDER_THRESHOLD; index += 1) {
      expect(
        await headless.emitToolCall({
          type: "tool_call",
          toolName: "bash",
          toolCallId: `not-shown-${index}`,
          input: { command: "git push origin main" },
        }),
      ).toMatchObject({ block: true });
    }
    expect(await headless.emitContext([])).toEqual([]);
    await headless.emitSessionShutdown();
  });
});
