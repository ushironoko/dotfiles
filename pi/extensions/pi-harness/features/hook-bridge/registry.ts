import { join } from "node:path";
import type { HarnessPaths } from "../../lib/paths";

export interface BridgeHookSpec {
  id: string;
  stage: "tool_call" | "tool_result" | "before_agent_start";
  matcher?: RegExp;
  script: string;
  timeoutMs: number;
  maxOutputBytes: number;
  requiresTrust?: boolean;
}

const HOOK_OUTPUT_CAP_BYTES = 65_536;

export const buildRegistry = (paths: HarnessPaths): BridgeHookSpec[] => [
  {
    id: "npm-script-preference",
    stage: "tool_call",
    matcher: /^Bash$/,
    script: join(paths.claudeHooksDir, "pre_tool_use/npm_script_preference.sh"),
    timeoutMs: 10_000,
    maxOutputBytes: HOOK_OUTPUT_CAP_BYTES,
  },
  {
    id: "codex-stage-guard",
    stage: "tool_call",
    matcher: /^Workflow$/,
    script: join(paths.claudeHooksDir, "pre_tool_use/codex_stage_guard.sh"),
    timeoutMs: 10_000,
    maxOutputBytes: HOOK_OUTPUT_CAP_BYTES,
  },
  {
    id: "coding-cycle",
    stage: "tool_result",
    matcher: /^(Write|Edit|MultiEdit)$/,
    script: join(paths.claudeHooksDir, "post_tool_use/coding_cycle.sh"),
    timeoutMs: 60_000,
    maxOutputBytes: HOOK_OUTPUT_CAP_BYTES,
    requiresTrust: true,
  },
  {
    id: "type-safety-check",
    stage: "tool_result",
    matcher: /^(Write|Edit|MultiEdit)$/,
    script: join(paths.claudeHooksDir, "post_tool_use/type_safety_check.sh"),
    timeoutMs: 10_000,
    maxOutputBytes: HOOK_OUTPUT_CAP_BYTES,
    requiresTrust: true,
  },
  {
    id: "ultracode-codex-context",
    stage: "before_agent_start",
    script: join(
      paths.claudeHooksDir,
      "user_prompt_submit/ultracode_codex_context.sh",
    ),
    timeoutMs: 10_000,
    maxOutputBytes: HOOK_OUTPUT_CAP_BYTES,
  },
];
