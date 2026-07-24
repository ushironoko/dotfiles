import type { PiLike } from "../../lib/pi-like";

const PERMISSION_ASK_REMINDER_THRESHOLD = 3;
const PERMISSION_ASK_REMINDER_CUSTOM_TYPE =
  "pi-harness-permission-ask-reminder";

export interface PermissionAskReminderIntegration {
  recordDisplayedConfirmation(): void;
}

const permissionAskReminderContent = (
  count: number,
): string => `<system-reminder>
You have encountered ${count} Bash permission confirmations in this session.
Repeated ASK challenges can indicate that command shape is broader or more complex than necessary.
Before issuing another Bash command, preserve the task intent while making the command easier to evaluate:
- use a narrow, single-purpose command
- separate directory navigation from the action when practical
- avoid unnecessary compound shell syntax, command substitution, or indirect execution
- prefer an existing checked-in package script when it expresses the intended operation
Do not weaken or bypass the permission policy, and do not treat prior approval as an automatic ALLOW label.
If the confirmations were intentional and the command is already minimal, continue without changing its meaning.
</system-reminder>`;

const reminderMessage = (count: number) => ({
  role: "custom" as const,
  customType: PERMISSION_ASK_REMINDER_CUSTOM_TYPE,
  content: permissionAskReminderContent(count),
  display: false,
  timestamp: Date.now(),
});

const setupPermissionAskReminder = (
  pi: PiLike,
): PermissionAskReminderIntegration => {
  let displayedConfirmations = 0;
  let pendingCount = 0;
  let deliveredCount = 0;

  const reset = (): void => {
    displayedConfirmations = 0;
    pendingCount = 0;
    deliveredCount = 0;
  };

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("context", (event) => {
    if (pendingCount === 0 || pendingCount <= deliveredCount) return undefined;
    deliveredCount = pendingCount;
    return {
      messages: [...event.messages, reminderMessage(pendingCount)],
    };
  });

  return {
    recordDisplayedConfirmation() {
      displayedConfirmations += 1;
      if (displayedConfirmations % PERMISSION_ASK_REMINDER_THRESHOLD === 0) {
        pendingCount = displayedConfirmations;
      }
    },
  };
};

export {
  PERMISSION_ASK_REMINDER_CUSTOM_TYPE,
  PERMISSION_ASK_REMINDER_THRESHOLD,
  permissionAskReminderContent,
};
export default setupPermissionAskReminder;
