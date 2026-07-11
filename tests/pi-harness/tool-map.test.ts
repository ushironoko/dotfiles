import { describe, expect, test } from "bun:test";
import { mapToolCall } from "../../pi/extensions/pi-harness/lib/tool-map";

describe("mapToolCall workflow", () => {
  // codex_stage_guard.sh greps `.tool_input.script` for codex markers; the
  // structured plan alone would leave that field empty and silence the guard.
  test("serializes the plan into a script field the advisory guard can grep", () => {
    const input = {
      stages: [
        {
          mode: "fanout",
          tasks: [{ agentType: "codex-reviewer", task: "review" }],
        },
      ],
    };
    const invocation = mapToolCall("workflow", input);
    expect(invocation.toolName).toBe("Workflow");
    expect(invocation.toolInput.stages).toEqual(input.stages);
    const script = invocation.toolInput.script;
    if (typeof script !== "string") throw new Error("Expected script string");
    expect(script).toContain("codex-reviewer");
  });

  test("a plan without codex markers yields a script without them", () => {
    const invocation = mapToolCall("workflow", {
      stages: [
        {
          mode: "fanout",
          codexSkip: false,
          tasks: [{ agentType: "claude", task: "review" }],
        },
      ],
    });
    const script = invocation.toolInput.script;
    if (typeof script !== "string") throw new Error("Expected script string");
    expect(script).not.toMatch(/codex-(reviewer|runner|poc|skip|stage)/);
  });

  test("codexSkip: true surfaces the literal codex-skip opt-out marker", () => {
    const invocation = mapToolCall("workflow", {
      stages: [
        {
          mode: "fanout",
          codexSkip: true,
          tasks: [{ agentType: "claude", task: "review" }],
        },
      ],
    });
    const script = invocation.toolInput.script;
    if (typeof script !== "string") throw new Error("Expected script string");
    expect(script).toContain("codex-skip");
  });
});
