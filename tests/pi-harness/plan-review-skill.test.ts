import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CODEX_AGENT_TYPES,
  validateWorkflowPlan,
} from "../../pi/extensions/pi-harness/features/workflow/plan";

const skill = readFileSync(
  join(import.meta.dir, "../../pi/skills/plan-review/SKILL.md"),
  "utf8",
);

const workflowExamples = (): Record<string, unknown>[] =>
  [...skill.matchAll(/```json\n([\s\S]*?)```/g)]
    .map((match) => JSON.parse(match[1]) as Record<string, unknown>)
    .filter((candidate) => Array.isArray(candidate.stages));

const exampleByStageName = (name: string): Record<string, unknown> => {
  const candidate = workflowExamples().find((plan) => {
    const stages = plan.stages as Record<string, unknown>[];
    return stages[0]?.name === name;
  });
  if (candidate === undefined) {
    throw new Error(`Missing workflow example for stage ${name}`);
  }
  return candidate;
};

const expectValidWorkflowExample = (name: string): Record<string, unknown> => {
  const candidate = exampleByStageName(name);
  const stages = candidate.stages as Record<string, unknown>[];
  expect(stages).toHaveLength(1);
  const result = validateWorkflowPlan(candidate);
  if (!result.ok) {
    throw new Error(`${name} example rejected: ${result.errors.join("; ")}`);
  }
  return candidate;
};

const firstStage = (plan: Record<string, unknown>): Record<string, unknown> =>
  (plan.stages as Record<string, unknown>[])[0] ?? {};

const sectionBetween = (start: string, end: string): string => {
  const startIndex = skill.indexOf(start);
  const endIndex = skill.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) return "";
  return skill.slice(startIndex, endIndex);
};

const executionSection = sectionBetween("### Phase 3:", "### Phase 4:");
const synthesisSection = sectionBetween("### Phase 4:", "## Reviewer List");
const codexUnavailableSection = sectionBetween(
  "#### Codex unavailable in automatic mode",
  "#### Show the selection result",
);
const reservedPlaceholderSection = sectionBetween(
  "#### Reserved placeholder safety",
  "#### Automatic mode: one fan-out stage",
);
const reservedTransportPrompt =
  reservedPlaceholderSection.match(/```text\n([\s\S]*?)```/)?.[1] ?? "";

const expectCompleteReviewPrompt = (stage: Record<string, unknown>): void => {
  const tasks = stage.tasks as Record<string, unknown>[];
  for (const task of tasks) {
    expect(task.task).toContain("Read-only plan review");
    expect(task.task).toContain("Do not modify files");
    expect(task.task).toContain("Technical accuracy");
    expect(task.task).toContain("Potential problems and risks");
    expect(task.task).toContain("Improvement suggestions");
    expect(task.task).toContain("Overlooked considerations");
    expect(task.task).toContain("Plan File: <path>");
    expect(task.task).toContain("<content>");
  }
};

describe("pi plan-review skill workflow contract", () => {
  test("documents validator-backed one-stage workflow plans with complete prompts", () => {
    const automatic = firstStage(
      expectValidWorkflowExample("plan-review-auto"),
    );
    expect(automatic.mode).toBe("fanout");
    expect(automatic.codexSkip).not.toBe(true);

    const automaticTasks = automatic.tasks as Record<string, unknown>[];
    expect(automaticTasks.map((task) => task.agentType)).toEqual([
      "rust-reviewer",
      "codex-reviewer",
      "similarity",
      "tdd-reviewer",
    ]);
    expectCompleteReviewPrompt(automatic);

    const optOut = firstStage(
      expectValidWorkflowExample("plan-review-codex-opt-out"),
    );
    expectCompleteReviewPrompt(optOut);

    const manual = firstStage(expectValidWorkflowExample("plan-review-manual"));
    expect(manual.mode).toBe("single");
    expect(manual.tasks).toHaveLength(1);
    expectCompleteReviewPrompt(manual);
  });

  test("preserves exact reviewer mappings and invokes workflow instead of subagent", () => {
    expect(skill).toMatch(/\|\s*Rust project\s*\|\s*`rust-reviewer`\s*\|/);
    expect(skill).toMatch(
      /\|\s*codex CLI available\s*\|\s*`codex-reviewer`\s*\|/,
    );
    expect(skill).toMatch(
      /\|\s*Refactoring-type keywords present\s*\|\s*`similarity`\s*\|/,
    );
    expect(skill).toMatch(
      /\|\s*Test infrastructure exists\s*\|\s*`tdd-reviewer`\s*\|/,
    );

    expect(executionSection).toContain("workflow");
    expect(executionSection).toContain('mode: "fanout"');
    expect(executionSection).toContain("one `workflow` tool call");
    expect(executionSection).not.toMatch(
      /(?:launch|invoke|call)[^\n]*`subagent`/i,
    );
  });

  test("requires a separate explicit Codex opt-out before specialist fan-out", () => {
    const optOut = firstStage(
      expectValidWorkflowExample("plan-review-codex-opt-out"),
    );
    expect(optOut.mode).toBe("fanout");
    expect(optOut.codexSkip).toBe(true);
    const optOutAgentTypes = (optOut.tasks as Record<string, unknown>[]).map(
      (task) => task.agentType,
    );
    expect(optOutAgentTypes).toEqual([
      "rust-reviewer",
      "similarity",
      "tdd-reviewer",
    ]);
    for (const codexAgentType of CODEX_AGENT_TYPES) {
      expect(optOutAgentTypes).not.toContain(codexAgentType);
    }

    expect(codexUnavailableSection).toContain("Call `AskUserQuestion` alone");
    expect(codexUnavailableSection).toContain("wait for the answer");
    expect(codexUnavailableSection).toContain("affirmative");
    expect(codexUnavailableSection).toContain(
      "Do not emit a `workflow` call in the same turn",
    );
    expect(codexUnavailableSection).toContain(
      "denial, cancellation, or unavailable interactive UI",
    );
    expect(skill).toContain("Do not silently fall back to `subagent`");
  });

  test("preserves arbitrary manual agents and isolates write-capable Codex roles", () => {
    expect(skill).toContain(
      "Any agent whose definition exists may be selected manually",
    );
    expect(skill).toContain("preserves the previous manual interface");

    const poc = firstStage(
      expectValidWorkflowExample("plan-review-manual-codex-poc"),
    );
    expect(poc.mode).toBe("single");
    expect(poc.tasks).toHaveLength(1);
    const pocTask = (poc.tasks as Record<string, unknown>[])[0];
    expect(pocTask?.agentType).toBe("codex-poc");
    expect(pocTask?.isolation).toBe("worktree");
    expectCompleteReviewPrompt(poc);

    const runner = firstStage(
      expectValidWorkflowExample("plan-review-manual-codex-runner"),
    );
    expect(runner.mode).toBe("single");
    expect(runner.tasks).toHaveLength(1);
    const runnerTask = (runner.tasks as Record<string, unknown>[])[0];
    expect(runnerTask?.agentType).toBe("codex-runner");
    expect(runnerTask?.isolation).toBe("worktree");
    expectCompleteReviewPrompt(runner);
  });

  test("keeps synthesis with the parent and classifies incomplete coverage", () => {
    expect(synthesisSection).toContain("The parent agent");
    expect(synthesisSection).toContain("Do not add a workflow judge stage");
    expect(synthesisSection).toContain("**Usable review**");
    expect(synthesisSection).toContain("**Task failure**");
    expect(synthesisSection).toContain("**reviewer-reported inability**");
    expect(synthesisSection).toContain("**Empty or non-actionable success**");
    expect(synthesisSection).toContain("`(no output)`");
    expect(synthesisSection).toContain(
      "Do not rely only on workflow status headers",
    );
    expect(synthesisSection).toContain("coverage gap");
    expect(synthesisSection).toContain("truncated");
    expect(synthesisSection).toContain("preflight failure means no review ran");
  });

  test("protects literal workflow placeholders in the plan path and content", () => {
    expect(skill).toContain("reserved `{previous}` placeholder");
    expect(skill).toContain("plan path or content");
    expect(skill).toContain("Do not place the raw plan path or content");

    for (const fragment of [
      "Read-only plan review",
      "Do not modify files",
      "Technical accuracy",
      "Potential problems and risks",
      "Improvement suggestions",
      "Overlooked considerations",
      "Plan File Path Encoding: base64 (UTF-8)",
      "Plan Content Encoding: base64 (UTF-8)",
      "<base64-path>",
      "<base64-content>",
    ]) {
      expect(reservedTransportPrompt).toContain(fragment);
    }
    expect(reservedTransportPrompt).not.toContain("{previous}");
  });
});
