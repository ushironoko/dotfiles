import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupProgressReminder, {
  hasVisibleAssistantText,
  PROGRESS_REMINDER,
  PROGRESS_REMINDER_CUSTOM_TYPE,
  SILENT_TURN_THRESHOLD,
} from "../../pi/extensions/pi-harness/features/progress-reminder/index";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import type {
  PiLike,
  TurnEndEvent,
} from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi, type FakePi } from "./fake-pi";

const REAL_PI_CONTRACT: ExtensionAPI extends PiLike ? true : false = true;

const makeConfig = (isChild = false): HarnessConfig => ({
  isChild,
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
  paths: resolvePaths("/tmp/pi-progress-reminder-test"),
});

const silentTurn = (turnIndex = 0): TurnEndEvent => ({
  type: "turn_end",
  turnIndex,
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "still working" },
      { type: "toolCall", id: "call-1", name: "read", arguments: {} },
    ],
  },
  toolResults: [],
});

const emitSilentTurns = async (
  pi: FakePi,
  count = SILENT_TURN_THRESHOLD,
): Promise<void> => {
  for (let turn = 0; turn < count; turn += 1) {
    await pi.emitTurnEnd(silentTurn(turn));
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const reminders = (messages: readonly unknown[]): Record<string, unknown>[] =>
  messages.filter(
    (message): message is Record<string, unknown> =>
      isRecord(message) && message.customType === PROGRESS_REMINDER_CUSTOM_TYPE,
  );

describe("visible assistant text classification", () => {
  test.each([
    ["thinking", [{ type: "thinking", thinking: "analysis" }]],
    ["tool call", [{ type: "toolCall", name: "read", arguments: {} }]],
    ["empty text", [{ type: "text", text: "  \n" }]],
    ["non-assistant text", [{ type: "text", text: "user text" }]],
  ])("does not treat %s as visible feedback", (kind, content) => {
    const role = kind === "non-assistant text" ? "user" : "assistant";
    expect(hasVisibleAssistantText({ role, content })).toBe(false);
  });

  test("accepts non-whitespace assistant text mixed with hidden blocks", () => {
    expect(
      hasVisibleAssistantText({
        role: "assistant",
        content: [
          { type: "thinking", thinking: "analysis" },
          { type: "text", text: "  Progress update. " },
          { type: "toolCall", name: "read", arguments: {} },
        ],
      }),
    ).toBe(true);
  });
});

describe("progress reminder lifecycle", () => {
  test("matches the real pi public event contract", () => {
    expect(REAL_PI_CONTRACT).toBe(true);
  });

  test("injects one hidden transient reminder only after ten silent turns", async () => {
    const pi = createFakePi();
    setupProgressReminder(pi);
    const history = [{ role: "user", content: "work" }];

    await emitSilentTurns(pi, SILENT_TURN_THRESHOLD - 1);
    expect(await pi.emitContext(history)).toEqual(history);

    await pi.emitTurnEnd(silentTurn(SILENT_TURN_THRESHOLD - 1));
    const messages = await pi.emitContext(history);
    const injected = reminders(messages);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toMatchObject({
      role: "custom",
      customType: PROGRESS_REMINDER_CUSTOM_TYPE,
      content: PROGRESS_REMINDER,
      display: false,
    });
    expect(history).toEqual([{ role: "user", content: "work" }]);
    expect(pi.appendedEntries).toEqual([]);

    expect(reminders(await pi.emitContext(history))).toHaveLength(1);
    expect(reminders(await pi.emitContext(messages))).toHaveLength(1);
  });

  test("keeps reminding after ignored tool-only turns until text is visible", async () => {
    const pi = createFakePi();
    setupProgressReminder(pi);
    await emitSilentTurns(pi);

    expect(reminders(await pi.emitContext([]))).toHaveLength(1);
    await pi.emitTurnEnd(silentTurn(SILENT_TURN_THRESHOLD));
    expect(reminders(await pi.emitContext([]))).toHaveLength(1);

    await pi.emitTurnEnd({
      type: "turn_end",
      turnIndex: SILENT_TURN_THRESHOLD + 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Here is the progress so far." }],
      },
      toolResults: [],
    });
    expect(await pi.emitContext([])).toEqual([]);
  });

  test.each([
    {
      name: "before_agent_start",
      reset: (pi: FakePi) =>
        pi.emitBeforeAgentStart({
          type: "before_agent_start",
          prompt: "new user prompt",
        }),
    },
    {
      name: "queued steer input",
      reset: (pi: FakePi) =>
        pi.emitInput({
          type: "input",
          text: "queued user prompt",
          source: "interactive",
          streamingBehavior: "steer",
        }),
    },
    {
      name: "queued follow-up input",
      reset: (pi: FakePi) =>
        pi.emitInput({
          type: "input",
          text: "queued user prompt",
          source: "interactive",
          streamingBehavior: "followUp",
        }),
    },
    {
      name: "session_start",
      reset: (pi: FakePi) =>
        pi.emitSessionStart({ type: "session_start", reason: "resume" }),
    },
    {
      name: "session_shutdown",
      reset: (pi: FakePi) => pi.emitSessionShutdown(),
    },
  ])("$name resets pending reminder state", async ({ reset }) => {
    const pi = createFakePi();
    setupProgressReminder(pi);
    await emitSilentTurns(pi);
    expect(reminders(await pi.emitContext([]))).toHaveLength(1);

    await reset(pi);
    expect(await pi.emitContext([])).toEqual([]);
  });

  test("composes context handlers in registration order", async () => {
    const pi = createFakePi();
    setupProgressReminder(pi);
    let messagesSeenByLaterHandler: unknown[] = [];
    pi.on("context", (event) => {
      messagesSeenByLaterHandler = event.messages;
      return {
        messages: [
          ...event.messages,
          {
            role: "custom",
            customType: "later-handler",
            content: "later context",
            display: false,
            timestamp: Date.now(),
          },
        ],
      };
    });
    await emitSilentTurns(pi);

    const messages = await pi.emitContext([]);
    expect(reminders(messagesSeenByLaterHandler)).toHaveLength(1);
    expect(reminders(messages)).toHaveLength(1);
    expect(
      messages.some(
        (message) =>
          isRecord(message) && message.customType === "later-handler",
      ),
    ).toBe(true);
  });

  test("the umbrella registers reminders only in parent sessions", async () => {
    const parent = createFakePi();
    setupHarness(parent, makeConfig());
    await emitSilentTurns(parent);
    expect(reminders(await parent.emitContext([]))).toHaveLength(1);

    const child = createFakePi({ hasUI: false });
    setupHarness(child, makeConfig(true));
    await emitSilentTurns(child);
    expect(await child.emitContext([])).toEqual([]);
  });
});
