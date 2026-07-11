/**
 * Maps pi built-in tool invocations to the Claude Code tool vocabulary the
 * existing bash hooks were written against.
 *
 * Field shapes measured on pi 0.80.6 (Phase 0, V3 —
 * tests/fixtures/pi-harness/raw/):
 *   bash  = { command, timeout? (seconds) }
 *   write = { path, content }
 *   edit  = { path, edits: [{ oldText, newText }] }
 *   read  = { path, offset?, limit? }
 *
 * Claude equivalents: Bash { command, timeout (ms) }, Write { file_path,
 * content }, MultiEdit { file_path, edits: [{ old_string, new_string }] },
 * Read { file_path, offset, limit }. Unknown tools pass through unchanged so
 * registry matchers simply never match them.
 */
import type { ClaudeToolInvocation } from "./claude-hook-io";

interface PiEditEntry {
  oldText?: string;
  newText?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function mapToolCall(
  toolName: string,
  input: Record<string, unknown>,
): ClaudeToolInvocation {
  switch (toolName) {
    case "bash": {
      const toolInput: Record<string, unknown> = { command: input.command };
      if (typeof input.timeout === "number") {
        toolInput.timeout = input.timeout * 1000;
      }
      return { toolName: "Bash", toolInput };
    }
    case "write":
      return {
        toolName: "Write",
        toolInput: { file_path: input.path, content: input.content },
      };
    case "edit": {
      const edits = Array.isArray(input.edits)
        ? (input.edits as PiEditEntry[])
        : [];
      return {
        toolName: "MultiEdit",
        toolInput: {
          file_path: input.path,
          edits: edits.map((edit) => {
            const entry = asRecord(edit);
            return { old_string: entry.oldText, new_string: entry.newText };
          }),
        },
      };
    }
    case "workflow": {
      // pi-harness registers its orchestration tool as lowercase "workflow";
      // Claude-side hooks (codex_stage_guard) match on "Workflow" and grep a
      // `script` string for codex markers, so the structured plan is
      // serialized into one. The guard is advisory; the workflow validator
      // (features/workflow/plan.ts) stays authoritative. A codexSkip opt-out
      // is surfaced as the literal "codex-skip" marker the guard understands.
      const script = JSON.stringify(input);
      return {
        toolName: "Workflow",
        toolInput: {
          ...input,
          script: /"codexSkip"\s*:\s*true/.test(script)
            ? `${script} // codex-skip`
            : script,
        },
      };
    }
    case "read":
      return {
        toolName: "Read",
        toolInput: {
          file_path: input.path,
          offset: input.offset,
          limit: input.limit,
        },
      };
    default:
      return { toolName, toolInput: input };
  }
}
