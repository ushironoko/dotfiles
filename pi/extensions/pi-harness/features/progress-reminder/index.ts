import type { PiLike } from "../../lib/pi-like";

const SILENT_TURN_THRESHOLD = 10;
const PROGRESS_REMINDER_CUSTOM_TYPE = "pi-harness-progress-reminder";
const PROGRESS_REMINDER = `<system-reminder>
You have completed 10 or more turns without giving the user a visible progress update.
Before continuing with more tool calls, provide a concise progress summary covering:
- what has been investigated or changed
- current findings
- what remains to be done
</system-reminder>`;

interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
}

interface MessageLike {
  role?: unknown;
  content?: unknown;
  customType?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const asMessage = (value: unknown): MessageLike | undefined =>
  isRecord(value) ? value : undefined;

const hasVisibleAssistantText = (message: unknown): boolean => {
  const candidate = asMessage(message);
  if (candidate?.role !== "assistant" || !Array.isArray(candidate.content)) {
    return false;
  }

  return candidate.content.some((block: unknown) => {
    if (!isRecord(block)) return false;
    const candidateBlock: ContentBlockLike = block;
    return (
      candidateBlock.type === "text" &&
      typeof candidateBlock.text === "string" &&
      candidateBlock.text.trim().length > 0
    );
  });
};

const containsProgressReminder = (messages: readonly unknown[]): boolean =>
  messages.some((message) => {
    const candidate = asMessage(message);
    return (
      candidate?.role === "custom" &&
      candidate.customType === PROGRESS_REMINDER_CUSTOM_TYPE
    );
  });

const progressReminderMessage = () => ({
  role: "custom" as const,
  customType: PROGRESS_REMINDER_CUSTOM_TYPE,
  content: PROGRESS_REMINDER,
  display: false,
  timestamp: Date.now(),
});

const setupProgressReminder = (pi: PiLike): void => {
  let silentTurns = 0;
  const reset = (): void => {
    silentTurns = 0;
  };

  pi.on("session_start", reset);
  pi.on("input", reset);
  pi.on("before_agent_start", reset);
  pi.on("session_shutdown", reset);

  pi.on("turn_end", (event) => {
    if (hasVisibleAssistantText(event.message)) {
      reset();
      return;
    }
    silentTurns += 1;
  });

  pi.on("context", (event) => {
    if (
      silentTurns < SILENT_TURN_THRESHOLD ||
      containsProgressReminder(event.messages)
    ) {
      return undefined;
    }

    return {
      messages: [...event.messages, progressReminderMessage()],
    };
  });
};

export {
  hasVisibleAssistantText,
  PROGRESS_REMINDER,
  PROGRESS_REMINDER_CUSTOM_TYPE,
  SILENT_TURN_THRESHOLD,
};
export default setupProgressReminder;
