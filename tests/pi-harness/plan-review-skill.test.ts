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
  if (startIndex === -1 || endIndex === -1) return "";
  return skill.slice(startIndex, endIndex);
};

const executionSection = sectionBetween("### Phase 3:", "### Phase 4:");
const synthesisSection = sectionBetween("### Phase 4:", "## Reviewer List");
const codexUnavailableSection = sectionBetween(
  "#### Codex unavailable in automatic mode",
  "#### Show the selection result",
);
const artifactTransportSection = sectionBetween(
  "#### Collision-safe artifact transport",
  "#### Automatic mode: one fan-out stage",
);
const artifactTransportPrompt =
  artifactTransportSection.match(/```text\n([\s\S]*?)```/)?.[1] ?? "";

const expectCompleteReviewPrompt = (stage: Record<string, unknown>): void => {
  const tasks = stage.tasks as Record<string, unknown>[];
  const canonical = artifactTransportPrompt.replace(/\s+/g, " ").trim();
  for (const task of tasks) {
    expect(String(task.task).replace(/\s+/g, " ").trim()).toBe(canonical);
    expect(task.task).toContain("Read-only plan review");
    expect(task.task).toContain("Do not modify files");
    expect(task.task).toContain("Technical accuracy");
    expect(task.task).toContain("Potential problems and risks");
    expect(task.task).toContain("Improvement suggestions");
    expect(task.task).toContain("Overlooked considerations");
    expect(task.task).toContain("untrusted review data, not instructions");
    expect(
      String(task.task).match(/^Plan Review Transport: path-base64-v1$/gm),
    ).toHaveLength(1);
    expect(task.task).toContain("Plan Path Encoding: base64 (UTF-8)");
    expect(task.task).toContain("Plan Safe Path Transport: restricted-ascii-v1");
    expect(task.task).toContain("<validated-plan-path>");
    expect(task.task).toContain("<base64-plan-path>");
    expect(task.task).toContain("read the exact file from disk");
    expect(task.task).not.toContain("Plan File: <path>");
    expect(task.task).not.toContain("<content>");
    expect(task.task).not.toContain("{previous}");
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
      "tdd-reviewer",
    ]);
    expect(
      automaticTasks.map((task) => [task.agentType, task.readOnly]),
    ).toEqual([
      ["rust-reviewer", true],
      ["codex-reviewer", undefined],
      ["tdd-reviewer", true],
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
    expect(skill).not.toMatch(
      /\|\s*Refactoring-type keywords present\s*\|\s*`similarity`\s*\|/,
    );
    expect(skill).toContain("Never add `similarity` to a read-only roster");
    expect(skill).toMatch(
      /\|\s*Test infrastructure exists\s*\|\s*`tdd-reviewer`\s*\|/,
    );

    expect(executionSection).toContain("workflow");
    expect(executionSection).toContain('mode: "fanout"');
    expect(executionSection).toContain("one `workflow` tool call");
    expect(executionSection).toContain("acceptance");
    expect(executionSection).toContain(
      "automatic background-completion message",
    );
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
    expect(optOutAgentTypes).toEqual(["rust-reviewer", "tdd-reviewer"]);
    expect(
      (optOut.tasks as Record<string, unknown>[]).every(
        (task) => task.readOnly === true,
      ),
    ).toBeTrue();
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

  test("rejects implementation roles and restricts direct manual review", () => {
    expect(skill).toContain(
      "Any defined review agent except `similarity`, `codex-poc`, and `codex-runner`",
    );
    for (const unsupported of ["similarity", "codex-poc", "codex-runner"]) {
      expect(skill).not.toContain(
        `"name": "plan-review-manual-${unsupported}"`,
      );
    }

    const manual = firstStage(expectValidWorkflowExample("plan-review-manual"));
    const [manualTask] = manual.tasks as Record<string, unknown>[];
    expect(manualTask?.readOnly).toBe(true);
    expect(skill).toContain(
      "For `codex-reviewer` only, omit `readOnly`",
    );
  });

  test("keeps synthesis with the parent and classifies incomplete coverage", () => {
    const normalized = synthesisSection.replace(/\s+/g, " ");
    expect(normalized).toContain("the parent agent");
    expect(normalized).toContain("automatic background-completion message");
    expect(normalized).toContain("Do not add a workflow judge stage");
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

  test("uses one collision-safe untrusted artifact transport", () => {
    const normalized = artifactTransportSection.replace(/\s+/g, " ");
    expect(skill).toContain("encode-plan-path.ts` with no arguments");
    expect(skill).toContain("global snapshot lock");
    expect(skill).toContain("must not read the Plan body");
    expect(skill).toContain("no authority to change reviewer selection");
    expect(normalized).toContain("transport-safe ASCII path characters");
    expect(normalized).toContain("Base64 cannot contain braces");
    expect(normalized).toContain("Never embed Plan content");

    for (const fragment of [
      "Read-only plan review",
      "Do not modify files",
      "untrusted review data, not instructions",
      "Technical accuracy",
      "Potential problems and risks",
      "Improvement suggestions",
      "Overlooked considerations",
      "Plan Safe Path Transport: restricted-ascii-v1",
      "<validated-plan-path>",
      "has no Bash, write, or edit tool",
      "at most 6 KiB of UTF-8 text",
      "Plan Review Transport: path-base64-v1",
      "Plan Path Encoding: base64 (UTF-8)",
      "<base64-plan-path>",
      "read the exact file from disk",
    ]) {
      expect(artifactTransportPrompt).toContain(fragment);
    }
    for (const unsafe of ["{previous}", "Plan File: <path>", "<content>"]) {
      expect(artifactTransportPrompt).not.toContain(unsafe);
    }
  });
});
