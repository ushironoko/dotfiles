import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  interpretPostToolUse,
  interpretPreToolUse,
  interpretUserPromptSubmit,
  type PreToolUseOutcome,
  type RawHookResult,
} from "../../pi/extensions/pi-harness/lib/claude-hook-io";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { buildRegistry } from "../../pi/extensions/pi-harness/features/hook-bridge/registry";

const makeRaw = (overrides: Partial<RawHookResult> = {}): RawHookResult => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  ...overrides,
});

interface ExpectedPreToolUse {
  kind: PreToolUseOutcome["kind"];
  reason?: string;
  notify?: {
    level: "info" | "warning" | "error";
    message?: string;
  };
}

const preToolUseCases: [string, RawHookResult, ExpectedPreToolUse][] = [
  [
    "timeout continues with a warning",
    makeRaw({
      exitCode: 2,
      timedOut: true,
      stderr: "ignored timeout stderr",
    }),
    { kind: "continue", notify: { level: "warning" } },
  ],
  [
    "exit 2 blocks with stderr",
    makeRaw({ exitCode: 2, stderr: "blocked by hook" }),
    { kind: "block", reason: "blocked by hook" },
  ],
  [
    "permission deny blocks",
    makeRaw({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "denied by policy",
        },
      }),
    }),
    { kind: "block", reason: "denied by policy" },
  ],
  [
    "permission ask requests confirmation",
    makeRaw({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "ask",
          permissionDecisionReason: "confirm this action",
        },
      }),
    }),
    { kind: "ask", reason: "confirm this action" },
  ],
  [
    "permission allow continues",
    makeRaw({
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: "allow" },
      }),
    }),
    { kind: "continue" },
  ],
  [
    "legacy block decision blocks",
    makeRaw({
      stdout: JSON.stringify({ decision: "block", reason: "legacy denial" }),
    }),
    { kind: "block", reason: "legacy denial" },
  ],
  [
    "additional context continues with an info notification",
    makeRaw({
      stdout: JSON.stringify({
        hookSpecificOutput: { additionalContext: "advisory context" },
      }),
    }),
    {
      kind: "continue",
      notify: { level: "info", message: "advisory context" },
    },
  ],
  [
    "deny and system message both survive interpretation",
    makeRaw({
      stdout: JSON.stringify({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: "denied with notice",
        },
        systemMessage: "deny system notice",
      }),
    }),
    {
      kind: "block",
      reason: "denied with notice",
      notify: { level: "info", message: "deny system notice" },
    },
  ],
  [
    "allow and system message both survive interpretation",
    makeRaw({
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: "allow" },
        systemMessage: "allow system notice",
      }),
    }),
    {
      kind: "continue",
      notify: { level: "info", message: "allow system notice" },
    },
  ],
  [
    "empty JSON object continues silently",
    makeRaw({ stdout: "{}" }),
    { kind: "continue" },
  ],
  ["empty stdout continues silently", makeRaw(), { kind: "continue" }],
  [
    "non-JSON stdout continues with a warning",
    makeRaw({ stdout: "not-json" }),
    { kind: "continue", notify: { level: "warning" } },
  ],
  [
    "JSON scalar continues with a warning",
    makeRaw({ stdout: "42" }),
    { kind: "continue", notify: { level: "warning" } },
  ],
  [
    "other exit code continues with a warning",
    makeRaw({ exitCode: 3, stderr: "hook failed" }),
    { kind: "continue", notify: { level: "warning" } },
  ],
  [
    "missing exit code continues with a warning",
    makeRaw({ exitCode: null }),
    { kind: "continue", notify: { level: "warning" } },
  ],
  // Contradictory verdicts: the blocking one must win (review finding —
  // exit 0 + deny JSON must block even when an allow rides along).
  [
    "legacy block outranks simultaneous permission allow",
    makeRaw({
      stdout: JSON.stringify({
        decision: "block",
        reason: "legacy deny",
        hookSpecificOutput: { permissionDecision: "allow" },
      }),
    }),
    { kind: "block", reason: "legacy deny" },
  ],
  [
    "legacy block outranks simultaneous permission ask",
    makeRaw({
      stdout: JSON.stringify({
        decision: "block",
        reason: "legacy deny",
        hookSpecificOutput: { permissionDecision: "ask" },
      }),
    }),
    { kind: "block", reason: "legacy deny" },
  ],
  // Unknown permissionDecision values continue, but never silently.
  [
    "unknown permissionDecision continues with a warning",
    makeRaw({
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: "denny" },
      }),
    }),
    { kind: "continue", notify: { level: "warning" } },
  ],
];

describe("interpretPreToolUse", () => {
  test.each(preToolUseCases)("%s", (_name, raw, expected) => {
    const outcome = interpretPreToolUse(raw);

    expect(outcome.kind).toBe(expected.kind);
    if (expected.reason === undefined) {
      expect(outcome.reason).toBeUndefined();
    } else {
      expect(outcome.reason).toBe(expected.reason);
    }
    if (expected.notify === undefined) {
      expect(outcome.notify).toBeUndefined();
      return;
    }

    const { notify } = outcome;
    expect(notify).toBeDefined();
    if (notify === undefined) return;
    expect(notify.level).toBe(expected.notify.level);
    expect(notify.message.length).toBeGreaterThan(0);
    if (expected.notify.message !== undefined) {
      expect(notify.message).toBe(expected.notify.message);
    }
  });
});

describe("interpretPostToolUse", () => {
  test("turns a legacy block reason into additional text and still notifies", () => {
    expect(
      interpretPostToolUse(
        makeRaw({
          stdout: JSON.stringify({
            decision: "block",
            reason: "fix the formatter failure",
            systemMessage: "formatter failed",
          }),
        }),
      ),
    ).toEqual({
      additionalText: "fix the formatter failure",
      notify: { message: "formatter failed", level: "info" },
    });
  });

  test("turns hook-specific additional context into additional text", () => {
    expect(
      interpretPostToolUse(
        makeRaw({
          stdout: JSON.stringify({
            hookSpecificOutput: { additionalContext: "post-tool advice" },
          }),
        }),
      ),
    ).toEqual({ additionalText: "post-tool advice" });
  });

  test.each([
    ["timeout", makeRaw({ timedOut: true })],
    ["non-zero exit", makeRaw({ exitCode: 1, stderr: "failed" })],
    ["missing exit code", makeRaw({ exitCode: null })],
    ["malformed stdout", makeRaw({ stdout: "not-json" })],
  ])("%s only notifies with a warning", (_name, raw) => {
    const outcome = interpretPostToolUse(raw);
    expect(outcome.additionalText).toBeUndefined();
    expect(outcome.notify?.level).toBe("warning");
    expect(outcome.notify?.message.length).toBeGreaterThan(0);
  });

  test("empty stdout has no effect", () => {
    expect(interpretPostToolUse(makeRaw())).toEqual({});
  });
});

describe("interpretUserPromptSubmit", () => {
  test("returns hook-specific additional context for a successful hook", () => {
    expect(
      interpretUserPromptSubmit(
        makeRaw({
          stdout: JSON.stringify({
            hookSpecificOutput: { additionalContext: "prompt context" },
          }),
        }),
      ),
    ).toEqual({ additionalContext: "prompt context" });
  });

  test.each([
    ["empty stdout", makeRaw()],
    ["malformed stdout", makeRaw({ stdout: "not-json" })],
    [
      "non-zero exit",
      makeRaw({
        exitCode: 1,
        stdout: JSON.stringify({
          hookSpecificOutput: { additionalContext: "ignored" },
        }),
      }),
    ],
    [
      "timeout",
      makeRaw({
        timedOut: true,
        stdout: JSON.stringify({
          hookSpecificOutput: { additionalContext: "ignored" },
        }),
      }),
    ],
  ])("%s does not inject context", (_name, raw) => {
    expect(interpretUserPromptSubmit(raw)).toEqual({});
  });
});

describe("buildRegistry", () => {
  test("builds the Phase 2B hook table from harness paths", () => {
    const paths = resolvePaths("/tmp/pi-harness-home");
    const registry = buildRegistry(paths).map((spec) => ({
      ...spec,
      matcher: spec.matcher?.toString(),
    }));

    expect(registry).toEqual([
      {
        id: "npm-script-preference",
        stage: "tool_call",
        matcher: "/^Bash$/",
        script: join(
          paths.claudeHooksDir,
          "pre_tool_use/npm_script_preference.sh",
        ),
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
      },
      {
        id: "codex-stage-guard",
        stage: "tool_call",
        matcher: "/^Workflow$/",
        script: join(paths.claudeHooksDir, "pre_tool_use/codex_stage_guard.sh"),
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
      },
      {
        id: "coding-cycle",
        stage: "tool_result",
        matcher: "/^(Write|Edit|MultiEdit)$/",
        script: join(paths.claudeHooksDir, "post_tool_use/coding_cycle.sh"),
        timeoutMs: 60_000,
        maxOutputBytes: 65_536,
        requiresTrust: true,
      },
      {
        id: "type-safety-check",
        stage: "tool_result",
        matcher: "/^(Write|Edit|MultiEdit)$/",
        script: join(
          paths.claudeHooksDir,
          "post_tool_use/type_safety_check.sh",
        ),
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
        requiresTrust: true,
      },
      {
        id: "ultracode-codex-context",
        stage: "before_agent_start",
        matcher: undefined,
        script: join(
          paths.claudeHooksDir,
          "user_prompt_submit/ultracode_codex_context.sh",
        ),
        timeoutMs: 10_000,
        maxOutputBytes: 65_536,
      },
    ]);
  });
});
