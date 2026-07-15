/**
 * tskm source-of-truth for the workflow tool's parameter schema.
 *
 * Compiled ahead-of-time by scripts/gen-pi-schemas.ts into
 * pi/extensions/pi-harness/features/workflow/parameters.generated.ts. See
 * pi/schemas/subagent.ts for the passthrough / optional-outermost conventions.
 *
 * Limit constants and the default fan-out agent come from the workflow plan
 * validator (the single source that also enforces them at runtime).
 */
import {
  array,
  boolean,
  description,
  literal,
  maxLength,
  object,
  optional,
  pipe,
  string,
  union,
} from "@tskm/core";
import {
  DEFAULT_FANOUT_AGENT_TYPE,
  MAX_STAGE_TASKS,
  MAX_WORKFLOW_STAGES,
} from "../extensions/pi-harness/features/workflow/plan";

const passthrough = { rest: "passthrough" } as const;

const WorkflowTaskParameters = object(
  {
    agentType: optional(
      pipe(
        string(),
        description(
          `Agent to run; fan-out tasks default to ${DEFAULT_FANOUT_AGENT_TYPE} (codex mandate)`,
        ),
      ),
    ),
    task: pipe(string(), description("Task delegated to the agent")),
    cwd: optional(
      pipe(
        string(),
        description("Working directory (not allowed with isolation)"),
      ),
    ),
    isolation: optional(
      pipe(
        literal("worktree"),
        description(
          "Provision an isolated linked worktree as the task cwd (required for codex-poc)",
        ),
      ),
    ),
    writeScope: optional(
      pipe(
        array(string()),
        description(
          "Paths this task may write; required and pairwise disjoint for parallel codex-runner tasks",
        ),
      ),
    ),
  },
  passthrough,
);

const WorkflowStageParameters = object(
  {
    name: optional(pipe(string(), description("Stage label for the report"))),
    mode: union([literal("fanout"), literal("single")]),
    codexSkip: optional(
      pipe(
        boolean(),
        description(
          "Explicit user opt-out from the codex mandate for this fan-out stage",
        ),
      ),
    ),
    tasks: pipe(
      array(WorkflowTaskParameters),
      maxLength(MAX_STAGE_TASKS),
      description("Tasks in this stage"),
    ),
  },
  passthrough,
);

export const WorkflowParameters = object(
  {
    stages: pipe(
      array(WorkflowStageParameters),
      maxLength(MAX_WORKFLOW_STAGES),
      description("Stages executed sequentially"),
    ),
  },
  passthrough,
);
