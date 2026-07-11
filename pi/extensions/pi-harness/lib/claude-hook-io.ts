/**
 * Claude Code hook protocol types and stdin synthesis (pure functions).
 *
 * The hook-bridge feature reuses the existing bash hooks under
 * ~/.claude/hooks unmodified: it synthesizes the stdin JSON those scripts
 * expect and interprets their stdout/exit code back into pi return values.
 *
 * Output interpretation (the PreToolUse truth table) is implemented in
 * Phase 2B, test-first from the table in plans/eventual-questing-deer.md.
 */

export interface PreToolUseStdin {
  hook_event_name: "PreToolUse";
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface PostToolUseStdin {
  hook_event_name: "PostToolUse";
  session_id: string;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: {
    content: string;
    isError: boolean;
  };
}

export interface UserPromptSubmitStdin {
  hook_event_name: "UserPromptSubmit";
  session_id: string;
  cwd: string;
  prompt: string;
}

export type HookStdin =
  | PreToolUseStdin
  | PostToolUseStdin
  | UserPromptSubmitStdin;

/**
 * Existing hooks never read session_id; a fixed marker keeps the field
 * present for forward compatibility without threading pi session state here.
 */
const SESSION_ID = "pi-harness";

export interface ClaudeToolInvocation {
  toolName: string;
  toolInput: Record<string, unknown>;
}

export function makePreToolUseStdin(
  invocation: ClaudeToolInvocation,
  cwd: string,
): PreToolUseStdin {
  return {
    hook_event_name: "PreToolUse",
    session_id: SESSION_ID,
    cwd,
    tool_name: invocation.toolName,
    tool_input: invocation.toolInput,
  };
}

export function makePostToolUseStdin(
  invocation: ClaudeToolInvocation,
  cwd: string,
  response: { content: string; isError: boolean },
): PostToolUseStdin {
  return {
    hook_event_name: "PostToolUse",
    session_id: SESSION_ID,
    cwd,
    tool_name: invocation.toolName,
    tool_input: invocation.toolInput,
    tool_response: response,
  };
}

export function makeUserPromptSubmitStdin(
  prompt: string,
  cwd: string,
): UserPromptSubmitStdin {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: SESSION_ID,
    cwd,
    prompt,
  };
}

/** Raw observable outcome of running a hook script (input to interpretation). */
export interface RawHookResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Structured JSON a Claude hook may print on stdout. */
export interface HookJsonOutput {
  decision?: string;
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
}

export function parseHookJson(stdout: string): HookJsonOutput | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HookJsonOutput;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

interface HookNotification {
  message: string;
  level: "info" | "warning" | "error";
}

export type PreToolUseOutcome =
  | { kind: "continue"; reason?: string; notify?: HookNotification }
  | { kind: "block"; reason?: string; notify?: HookNotification }
  | { kind: "ask"; reason?: string; notify?: HookNotification };

const warning = (message: string): HookNotification => ({
  message,
  level: "warning",
});

const info = (message: string): HookNotification => ({
  message,
  level: "info",
});

const failureMessage = (raw: RawHookResult): string => {
  const exit =
    raw.exitCode === null
      ? "without an exit code"
      : `with code ${raw.exitCode}`;
  const detail = raw.stderr.trim();
  return detail === ""
    ? `Hook exited ${exit}; continuing without its output.`
    : `Hook exited ${exit}; continuing without its output: ${detail}`;
};

export const interpretPreToolUse = (raw: RawHookResult): PreToolUseOutcome => {
  if (raw.timedOut) {
    return {
      kind: "continue",
      notify: warning("PreToolUse hook timed out; continuing."),
    };
  }
  if (raw.exitCode === 2) {
    return { kind: "block", reason: raw.stderr };
  }
  if (raw.exitCode !== 0) {
    return { kind: "continue", notify: warning(failureMessage(raw)) };
  }
  if (raw.stdout.trim() === "") return { kind: "continue" };

  const output = parseHookJson(raw.stdout);
  if (output === undefined) {
    return {
      kind: "continue",
      notify: warning("PreToolUse hook returned malformed JSON; continuing."),
    };
  }

  const specific = output.hookSpecificOutput;
  const systemNotify =
    typeof output.systemMessage === "string"
      ? info(output.systemMessage)
      : undefined;
  const permissionReason =
    typeof specific?.permissionDecisionReason === "string"
      ? specific.permissionDecisionReason
      : undefined;

  if (specific?.permissionDecision === "deny") {
    return systemNotify === undefined
      ? { kind: "block", reason: permissionReason }
      : { kind: "block", reason: permissionReason, notify: systemNotify };
  }
  // Legacy decision:"block" outranks a simultaneous allow/ask: when a hook
  // emits contradictory verdicts the blocking one wins (fail-safe).
  if (output.decision === "block") {
    const reason =
      typeof output.reason === "string" ? output.reason : undefined;
    return systemNotify === undefined
      ? { kind: "block", reason }
      : { kind: "block", reason, notify: systemNotify };
  }
  if (specific?.permissionDecision === "ask") {
    return systemNotify === undefined
      ? { kind: "ask", reason: permissionReason }
      : { kind: "ask", reason: permissionReason, notify: systemNotify };
  }
  if (specific?.permissionDecision === "allow") {
    return systemNotify === undefined
      ? { kind: "continue" }
      : { kind: "continue", notify: systemNotify };
  }
  if (specific?.permissionDecision !== undefined) {
    // Unrecognized permissionDecision (e.g. a typo like "denny") continues,
    // but never silently — surface it so a broken policy hook gets noticed.
    return {
      kind: "continue",
      notify: warning(
        `PreToolUse hook returned unknown permissionDecision "${String(specific.permissionDecision)}"; continuing.`,
      ),
    };
  }

  const additionalNotify =
    typeof specific?.additionalContext === "string"
      ? info(specific.additionalContext)
      : undefined;
  const notify = systemNotify ?? additionalNotify;
  return notify === undefined
    ? { kind: "continue" }
    : { kind: "continue", notify };
};

export const interpretPostToolUse = (
  raw: RawHookResult,
): {
  additionalText?: string;
  notify?: HookNotification;
} => {
  if (raw.timedOut) {
    return { notify: warning("PostToolUse hook timed out; continuing.") };
  }
  if (raw.exitCode !== 0) {
    return { notify: warning(failureMessage(raw)) };
  }
  if (raw.stdout.trim() === "") return {};

  const output = parseHookJson(raw.stdout);
  if (output === undefined) {
    return {
      notify: warning("PostToolUse hook returned malformed JSON; continuing."),
    };
  }

  const blockReason =
    output.decision === "block" && typeof output.reason === "string"
      ? output.reason
      : undefined;
  const additionalContext =
    typeof output.hookSpecificOutput?.additionalContext === "string"
      ? output.hookSpecificOutput.additionalContext
      : undefined;
  const additionalText = blockReason ?? additionalContext;
  const notify =
    typeof output.systemMessage === "string"
      ? info(output.systemMessage)
      : undefined;

  if (additionalText !== undefined && notify !== undefined) {
    return { additionalText, notify };
  }
  if (additionalText !== undefined) return { additionalText };
  if (notify !== undefined) return { notify };
  return {};
};

export const interpretUserPromptSubmit = (
  raw: RawHookResult,
): {
  additionalContext?: string;
} => {
  if (raw.timedOut || raw.exitCode !== 0) return {};
  const output = parseHookJson(raw.stdout);
  const additionalContext = output?.hookSpecificOutput?.additionalContext;
  return typeof additionalContext === "string" ? { additionalContext } : {};
};
