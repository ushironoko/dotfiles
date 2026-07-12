/**
 * Pure validation and normalization for workflow plans (ultracode-equivalent
 * orchestration). The engine enforces the multi-model ground rules in code —
 * the codex_stage_guard hook is advisory only; this module is authoritative:
 *
 * - codex mandate: a fan-out stage without codexSkip must keep a codex-family
 *   baseline (Claude tasks are optional +α additions).
 * - codex-poc must run inside an isolated worktree (codex-stage.sh refuses
 *   non-worktree targets with exit 14).
 * - parallel codex-runner tasks must declare disjoint writeScopes — the
 *   wrapper does not lock the tree, so overlapping parallel writes corrupt it.
 */
import { isAbsolute } from "node:path";

export const CODEX_AGENT_TYPES = [
  "codex-reviewer",
  "codex-runner",
  "codex-poc",
] as const;

export const DEFAULT_FANOUT_AGENT_TYPE = "codex-reviewer";
export const MAX_WORKFLOW_STAGES = 8;
export const MAX_STAGE_TASKS = 8;

export interface WorkflowTaskPlan {
  agentType: string;
  task: string;
  cwd?: string;
  isolation?: "worktree";
  writeScope?: string[];
}

export interface WorkflowStagePlan {
  name?: string;
  mode: "fanout" | "single";
  codexSkip: boolean;
  tasks: WorkflowTaskPlan[];
}

export type WorkflowPlanValidation =
  | { ok: true; stages: WorkflowStagePlan[] }
  | { ok: false; errors: string[] };

const GLOB_CHARS = /[*?[{]/;

/**
 * Longest literal directory prefix of a glob-ish scope entry. "" means the
 * entry can match anywhere (e.g. "*.ts") and therefore overlaps everything.
 */
export const scopeRoot = (entry: string): string => {
  const match = GLOB_CHARS.exec(entry);
  const literal = match === null ? entry : entry.slice(0, match.index);
  const cut =
    match === null ? literal : literal.slice(0, literal.lastIndexOf("/") + 1);
  return cut.replace(/\/+$/, "");
};

export const scopesOverlap = (a: string, b: string): boolean => {
  const rootA = scopeRoot(a);
  const rootB = scopeRoot(b);
  if (rootA === "" || rootB === "") return true;
  return (
    rootA === rootB ||
    rootA.startsWith(`${rootB}/`) ||
    rootB.startsWith(`${rootA}/`)
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.every((entry) => typeof entry === "string" && entry.trim() !== "");

const isCodexAgentType = (agentType: string): boolean =>
  (CODEX_AGENT_TYPES as readonly string[]).includes(agentType);

interface TaskValidation {
  task?: WorkflowTaskPlan;
  errors: string[];
}

const validateTask = (
  value: unknown,
  label: string,
  isFanout: boolean,
): TaskValidation => {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { errors: [`${label}: must be an object`] };
  }

  let taskText: string | undefined;
  if (typeof value.task !== "string" || value.task.trim() === "") {
    errors.push(`${label}.task: must be a non-empty string`);
  } else {
    taskText = value.task;
  }

  let agentType: string | undefined;
  if (value.agentType === undefined) {
    // The default roster is codex; the read-only reviewer is the safe default.
    if (isFanout) agentType = DEFAULT_FANOUT_AGENT_TYPE;
    else errors.push(`${label}.agentType: required for single stages`);
  } else if (
    typeof value.agentType !== "string" ||
    value.agentType.trim() === ""
  ) {
    errors.push(`${label}.agentType: must be a non-empty string`);
  } else {
    agentType = value.agentType;
  }

  let cwd: string | undefined;
  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string" || value.cwd === "") {
      errors.push(`${label}.cwd: must be a non-empty string`);
    } else {
      cwd = value.cwd;
    }
  }

  let isolation: "worktree" | undefined;
  if (value.isolation !== undefined) {
    if (value.isolation !== "worktree") {
      errors.push(`${label}.isolation: must be "worktree" when present`);
    } else {
      isolation = "worktree";
    }
  }

  let writeScope: string[] | undefined;
  if (value.writeScope !== undefined) {
    if (!isNonEmptyStringArray(value.writeScope)) {
      errors.push(`${label}.writeScope: must be an array of non-empty strings`);
    } else {
      writeScope = value.writeScope;
    }
  }

  if (agentType === "codex-poc" && isolation !== "worktree") {
    errors.push(
      `${label}: codex-poc requires isolation "worktree" (codex-stage.sh refuses non-worktree targets with exit 14)`,
    );
  }
  if (isolation === "worktree" && cwd !== undefined) {
    errors.push(
      `${label}: cwd cannot be combined with isolation "worktree" (the engine assigns the created worktree as cwd)`,
    );
  }

  if (errors.length > 0 || agentType === undefined || taskText === undefined) {
    return { errors };
  }
  return {
    task: {
      agentType,
      task: taskText,
      ...(cwd === undefined ? {} : { cwd }),
      ...(isolation === undefined ? {} : { isolation }),
      ...(writeScope === undefined ? {} : { writeScope }),
    },
    errors,
  };
};

const validateRunnerScopes = (
  tasks: WorkflowTaskPlan[],
  label: string,
  errors: string[],
): void => {
  const runners = tasks
    .map((task, index) => ({ task, index }))
    .filter(({ task }) => task.agentType === "codex-runner");
  if (runners.length < 2) return;

  for (const { task, index } of runners) {
    if (task.writeScope === undefined || task.writeScope.length === 0) {
      errors.push(
        `${label}.tasks[${index}]: parallel codex-runner tasks require a non-empty writeScope`,
      );
    }
  }

  const scoped = runners.filter(
    ({ task }) => task.writeScope !== undefined && task.writeScope.length > 0,
  );
  const styles = new Set(
    scoped.flatMap(({ task }) =>
      (task.writeScope ?? []).map((entry) =>
        isAbsolute(entry) ? "absolute" : "relative",
      ),
    ),
  );
  if (styles.size > 1) {
    errors.push(
      `${label}: codex-runner writeScope entries mix absolute and relative paths; use one style so overlap can be checked`,
    );
    return;
  }

  for (let i = 0; i < scoped.length; i += 1) {
    for (let j = i + 1; j < scoped.length; j += 1) {
      const left = scoped[i];
      const right = scoped[j];
      for (const a of left.task.writeScope ?? []) {
        for (const b of right.task.writeScope ?? []) {
          if (scopesOverlap(a, b)) {
            errors.push(
              `${label}: codex-runner writeScope overlap between tasks[${left.index}] "${a}" and tasks[${right.index}] "${b}"`,
            );
          }
        }
      }
    }
  }
};

export const validateWorkflowPlan = (
  input: unknown,
): WorkflowPlanValidation => {
  const errors: string[] = [];
  if (!isRecord(input) || !Array.isArray(input.stages)) {
    return { ok: false, errors: ["stages: must be an array of stages"] };
  }
  if (input.stages.length === 0) {
    return { ok: false, errors: ["stages: must contain at least 1 stage"] };
  }
  if (input.stages.length > MAX_WORKFLOW_STAGES) {
    return {
      ok: false,
      errors: [
        `stages: must contain at most ${MAX_WORKFLOW_STAGES} stages (got ${input.stages.length})`,
      ],
    };
  }

  const stages: WorkflowStagePlan[] = [];
  input.stages.forEach((stageValue, stageIndex) => {
    const label = `stages[${stageIndex}]`;
    if (!isRecord(stageValue)) {
      errors.push(`${label}: must be an object`);
      return;
    }

    const mode = stageValue.mode;
    if (mode !== "fanout" && mode !== "single") {
      errors.push(`${label}.mode: must be "fanout" or "single"`);
      return;
    }

    let name: string | undefined;
    if (stageValue.name !== undefined) {
      if (typeof stageValue.name !== "string") {
        errors.push(`${label}.name: must be a string`);
      } else {
        name = stageValue.name;
      }
    }

    const codexSkip = stageValue.codexSkip === true;
    const rawTasks = stageValue.tasks;
    if (!Array.isArray(rawTasks) || rawTasks.length === 0) {
      errors.push(`${label}.tasks: must contain at least 1 task`);
      return;
    }
    if (mode === "single" && rawTasks.length !== 1) {
      errors.push(
        `${label}: single stage must contain exactly 1 task (got ${rawTasks.length})`,
      );
      return;
    }
    if (rawTasks.length > MAX_STAGE_TASKS) {
      errors.push(
        `${label}.tasks: must contain at most ${MAX_STAGE_TASKS} tasks (got ${rawTasks.length})`,
      );
      return;
    }

    const tasks: WorkflowTaskPlan[] = [];
    let taskErrors = false;
    rawTasks.forEach((taskValue, taskIndex) => {
      const validated = validateTask(
        taskValue,
        `${label}.tasks[${taskIndex}]`,
        mode === "fanout",
      );
      errors.push(...validated.errors);
      if (validated.task === undefined) taskErrors = true;
      else tasks.push(validated.task);
    });
    if (taskErrors) return;

    if (
      mode === "fanout" &&
      !codexSkip &&
      !tasks.some((task) => isCodexAgentType(task.agentType))
    ) {
      errors.push(
        `${label}: fan-out stage has no codex-family task (${CODEX_AGENT_TYPES.join("/")}); Claude tasks are +α only — set codexSkip: true only when the user explicitly opted out`,
      );
    }

    validateRunnerScopes(tasks, label, errors);

    stages.push({
      ...(name === undefined ? {} : { name }),
      mode,
      codexSkip,
      tasks,
    });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, stages };
};
