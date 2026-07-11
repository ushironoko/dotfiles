import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_AGENT_TYPES,
  DEFAULT_FANOUT_AGENT_TYPE,
  MAX_STAGE_TASKS,
  MAX_WORKFLOW_STAGES,
  scopeRoot,
  scopesOverlap,
  validateWorkflowPlan,
} from "../../pi/extensions/pi-harness/features/workflow/plan";

const reviewerTask = (task = "review the diff") => ({
  agentType: "codex-reviewer",
  task,
});

const runnerTask = (writeScope?: string[], task = "write module") => ({
  agentType: "codex-runner",
  task,
  ...(writeScope === undefined ? {} : { writeScope }),
});

const fanout = (
  tasks: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) => ({ mode: "fanout", tasks, ...extra });

const plan = (stages: Record<string, unknown>[]) => ({ stages });

const expectErrors = (input: unknown, ...fragments: string[]): string[] => {
  const result = validateWorkflowPlan(input);
  if (result.ok) {
    throw new Error("Expected validation to fail but it passed");
  }
  for (const fragment of fragments) {
    expect(result.errors.join("\n")).toContain(fragment);
  }
  return result.errors;
};

const expectValid = (input: unknown) => {
  const result = validateWorkflowPlan(input);
  if (!result.ok) {
    throw new Error(`Expected valid plan, got: ${result.errors.join("; ")}`);
  }
  return result.stages;
};

describe("scopeRoot", () => {
  test.each([
    ["packages/a/**", "packages/a"],
    ["packages/a/*", "packages/a"],
    ["packages/a", "packages/a"],
    ["packages/a/", "packages/a"],
    ["src/**/*.ts", "src"],
    ["*.ts", ""],
    ["/abs/path/**", "/abs/path"],
  ])("scopeRoot(%j) === %j", (entry, expected) => {
    expect(scopeRoot(entry)).toBe(expected);
  });
});

describe("scopesOverlap", () => {
  test.each([
    ["packages/a/**", "packages/a/**", true],
    ["packages/a/**", "packages/a/sub/**", true],
    ["packages/a/**", "packages/b/**", false],
    // Segment boundary: "packages/a" must not swallow "packages/ab".
    ["packages/a/**", "packages/ab/**", false],
    // A root-wide glob overlaps everything.
    ["*.ts", "packages/a/**", true],
    ["/repo/a/**", "/repo/a/x.ts", true],
    ["/repo/a/**", "/repo/b/**", false],
  ])("scopesOverlap(%j, %j) === %j", (a, b, expected) => {
    expect(scopesOverlap(a, b)).toBe(expected);
  });
});

describe("validateWorkflowPlan structure", () => {
  test("accepts a minimal fan-out stage of codex reviewers", () => {
    const stages = expectValid(
      plan([fanout([reviewerTask(), reviewerTask("second lens")])]),
    );
    expect(stages).toHaveLength(1);
    expect(stages[0]?.tasks).toHaveLength(2);
  });

  test.each([
    [undefined],
    [null],
    ["stages"],
    [{}],
    [{ stages: [] }],
    [{ stages: "not-an-array" }],
  ])("rejects a plan without stages: %j", (input) => {
    expectErrors(input, "stages");
  });

  test("rejects more than the stage cap", () => {
    const stages = Array.from({ length: MAX_WORKFLOW_STAGES + 1 }, () =>
      fanout([reviewerTask()]),
    );
    expectErrors(plan(stages), `${MAX_WORKFLOW_STAGES}`);
  });

  test("rejects more tasks than the per-stage cap", () => {
    const tasks = Array.from({ length: MAX_STAGE_TASKS + 1 }, () =>
      reviewerTask(),
    );
    expectErrors(plan([fanout(tasks)]), `${MAX_STAGE_TASKS}`);
  });

  test("rejects an unknown stage mode", () => {
    expectErrors(
      plan([{ mode: "sequential", tasks: [reviewerTask()] }]),
      "stages[0].mode",
    );
  });

  test("rejects a single stage holding more than one task", () => {
    expectErrors(
      plan([{ mode: "single", tasks: [reviewerTask(), reviewerTask()] }]),
      "stages[0]",
      "exactly 1 task",
    );
  });

  test("rejects a stage without tasks", () => {
    expectErrors(plan([fanout([])]), "stages[0].tasks");
  });

  test("rejects an empty task text", () => {
    expectErrors(plan([fanout([reviewerTask("")])]), "stages[0].tasks[0]");
  });

  test("rejects a non-worktree isolation value", () => {
    expectErrors(
      plan([fanout([{ ...reviewerTask(), isolation: "container" }])]),
      "stages[0].tasks[0]",
      "worktree",
    );
  });

  test("collects every violation instead of stopping at the first", () => {
    const errors = expectErrors(
      plan([
        { mode: "single", tasks: [reviewerTask(), reviewerTask()] },
        fanout([{ agentType: "codex-poc", task: "poc" }]),
      ]),
      "stages[0]",
      "stages[1]",
    );
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("codex mandate", () => {
  test("defaults a fan-out task without agentType to the codex reviewer", () => {
    const stages = expectValid(plan([fanout([{ task: "review this" }])]));
    expect(stages[0]?.tasks[0]?.agentType).toBe(DEFAULT_FANOUT_AGENT_TYPE);
    expect(CODEX_AGENT_TYPES).toContain(DEFAULT_FANOUT_AGENT_TYPE);
  });

  test("rejects a fan-out stage whose roster is entirely non-codex", () => {
    expectErrors(
      plan([
        fanout([
          { agentType: "claude", task: "review" },
          { agentType: "rust-reviewer", task: "review" },
        ]),
      ]),
      "stages[0]",
      "codexSkip",
    );
  });

  test("allows Claude +α tasks alongside a codex baseline", () => {
    expectValid(
      plan([
        fanout([reviewerTask(), { agentType: "claude", task: "extra lens" }]),
      ]),
    );
  });

  test("codexSkip: true opts a fan-out stage out of the mandate", () => {
    expectValid(
      plan([
        fanout([{ agentType: "claude", task: "review" }], { codexSkip: true }),
      ]),
    );
  });

  test("single stages carry no mandate", () => {
    expectValid(
      plan([
        { mode: "single", tasks: [{ agentType: "claude", task: "judge" }] },
      ]),
    );
  });
});

describe("codex-poc isolation", () => {
  test("rejects codex-poc without isolation worktree", () => {
    expectErrors(
      plan([fanout([{ agentType: "codex-poc", task: "build poc" }])]),
      "codex-poc",
      "worktree",
    );
  });

  test("accepts codex-poc paired with isolation worktree", () => {
    expectValid(
      plan([
        fanout([
          { agentType: "codex-poc", task: "build poc", isolation: "worktree" },
        ]),
      ]),
    );
  });

  test("rejects cwd combined with isolation worktree", () => {
    expectErrors(
      plan([
        fanout([
          {
            agentType: "codex-poc",
            task: "build poc",
            isolation: "worktree",
            cwd: "/somewhere",
          },
        ]),
      ]),
      "cwd",
    );
  });
});

describe("codex-runner writeScope", () => {
  test("a single runner needs no writeScope", () => {
    expectValid(plan([fanout([runnerTask(), reviewerTask()])]));
  });

  test("parallel runners must each declare a writeScope", () => {
    expectErrors(
      plan([fanout([runnerTask(["packages/a/**"]), runnerTask()])]),
      "writeScope",
    );
  });

  test("parallel runners with an empty writeScope array are rejected", () => {
    expectErrors(
      plan([fanout([runnerTask(["packages/a/**"]), runnerTask([])])]),
      "writeScope",
    );
  });

  test("rejects overlapping writeScopes across parallel runners", () => {
    expectErrors(
      plan([
        fanout([
          runnerTask(["packages/a/**"]),
          runnerTask(["packages/a/sub/**"]),
        ]),
      ]),
      "overlap",
    );
  });

  test("rejects identical writeScopes across parallel runners", () => {
    expectErrors(
      plan([
        fanout([runnerTask(["packages/a/**"]), runnerTask(["packages/a/**"])]),
      ]),
      "overlap",
    );
  });

  test("accepts disjoint writeScopes across parallel runners", () => {
    expectValid(
      plan([
        fanout([runnerTask(["packages/a/**"]), runnerTask(["packages/b/**"])]),
      ]),
    );
  });

  test("rejects a mix of absolute and relative writeScopes", () => {
    expectErrors(
      plan([
        fanout([
          runnerTask(["/repo/packages/a/**"]),
          runnerTask(["packages/b/**"]),
        ]),
      ]),
      "absolute",
    );
  });

  test("runners in different stages never conflict", () => {
    expectValid(
      plan([
        fanout([runnerTask(["packages/a/**"]), reviewerTask()]),
        fanout([runnerTask(["packages/a/**"]), reviewerTask()]),
      ]),
    );
  });
});

describe("multi-model-workflows.md templates", () => {
  // The skill reference is the user-facing contract for this validator; a
  // template the validator rejects is a doc bug (found by review: single-mode
  // stages without agentType shipped in Templates A/B).
  test("every complete plan template passes the validator", () => {
    const source = readFileSync(
      join(
        import.meta.dir,
        "../../pi/skills/start-work/references/multi-model-workflows.md",
      ),
      "utf8",
    );
    const fences = [...source.matchAll(/```json\n([\s\S]*?)```/g)].map(
      (match) => match[1],
    );
    expect(fences.length).toBeGreaterThanOrEqual(3);
    const plans = fences
      .map((fence) => JSON.parse(fence))
      .filter(
        (parsed): parsed is Record<string, unknown> =>
          typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as Record<string, unknown>).stages),
      );
    // Templates A, B, C are the complete plans; fragments (single-task
    // examples) carry no stages and are exercised only as valid JSON above.
    expect(plans.length).toBeGreaterThanOrEqual(3);
    for (const candidate of plans) {
      const result = validateWorkflowPlan(candidate);
      if (!result.ok) {
        throw new Error(
          `template rejected by validator: ${result.errors.join("; ")}`,
        );
      }
    }
  });
});
