/**
 * workflow feature — ultracode-equivalent orchestration with the multi-model
 * ground rules enforced by the engine, not by prompts (plan.ts is the
 * authoritative validator; codex_stage_guard stays advisory):
 *
 * - Stages run sequentially; fan-out tasks run with a bounded worker pool.
 * - A failing task degrades the stage instead of aborting the workflow
 *   (codex-stage.sh exit 15 = rate-limited must not sink other results);
 *   synthesis/judging over the reported results stays with the parent LLM.
 * - isolation "worktree" provisions a validated linked worktree via the
 *   bit-task creator (S1 postconditions) and assigns it as the task cwd.
 *   Created worktrees are never merged or removed by the engine.
 */
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { HarnessConfig } from "../../config";
import type { CtxLike, PiLike } from "../../lib/pi-like";
import type { AgentDefinition } from "../../lib/agent-md";
import {
  createValidatedWorktree,
  makeWorktreeCreator,
} from "../bit-task/index";
import { loadAgents } from "../subagent/loader";
import {
  capText,
  PER_TASK_OUTPUT_CAP,
  spawnAgent,
  type SpawnFunction,
  type SpawnResult,
} from "../subagent/spawn";
import {
  DEFAULT_FANOUT_AGENT_TYPE,
  MAX_STAGE_TASKS,
  MAX_WORKFLOW_STAGES,
  validateWorkflowPlan,
  type WorkflowStagePlan,
  type WorkflowTaskPlan,
} from "./plan";

const MAX_CONCURRENCY = 4;
const optional = Type.Optional;

interface SetupWorkflowOptions {
  spawnFn?: SpawnFunction;
  termGraceMs?: number;
  createWorktree?: (cwd: string, name: string) => Promise<string>;
}

interface SpawnFailure {
  failed: true;
  errorMessage: string;
}

interface WorkflowTaskReport {
  agentType: string;
  task: string;
  cwd: string;
  worktree?: string;
  result: SpawnResult | SpawnFailure;
}

interface WorkflowStageReport {
  name?: string;
  mode: WorkflowStagePlan["mode"];
  tasks: WorkflowTaskReport[];
}

interface WorkflowDetails {
  stages: WorkflowStageReport[];
  succeeded: number;
  total: number;
}

const WorkflowTaskParameters = Type.Object({
  agentType: optional(
    Type.String({
      description: `Agent to run; fan-out tasks default to ${DEFAULT_FANOUT_AGENT_TYPE} (codex mandate)`,
    }),
  ),
  task: Type.String({ description: "Task delegated to the agent" }),
  cwd: optional(
    Type.String({
      description: "Working directory (not allowed with isolation)",
    }),
  ),
  isolation: optional(
    Type.Literal("worktree", {
      description:
        "Provision an isolated linked worktree as the task cwd (required for codex-poc)",
    }),
  ),
  writeScope: optional(
    Type.Array(Type.String(), {
      description:
        "Paths this task may write; required and pairwise disjoint for parallel codex-runner tasks",
    }),
  ),
});

const WorkflowStageParameters = Type.Object({
  name: optional(Type.String({ description: "Stage label for the report" })),
  mode: Type.Union([Type.Literal("fanout"), Type.Literal("single")]),
  codexSkip: optional(
    Type.Boolean({
      description:
        "Explicit user opt-out from the codex mandate for this fan-out stage",
    }),
  ),
  tasks: Type.Array(WorkflowTaskParameters, {
    description: "Tasks in this stage",
    maxItems: MAX_STAGE_TASKS,
  }),
});

const WorkflowParameters = Type.Object({
  stages: Type.Array(WorkflowStageParameters, {
    description: "Stages executed sequentially",
    maxItems: MAX_WORKFLOW_STAGES,
  }),
});

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && "aborted" in signal && signal.aborted === true;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const resolveAgent = (
  agents: AgentDefinition[],
  name: string,
): AgentDefinition => {
  const agent = agents.find((candidate) => candidate.name === name);
  if (agent !== undefined) return agent;
  const available = agents.map((candidate) => candidate.name).join(", ");
  throw new Error(
    capText(
      `Unknown agent: "${name}". Available agents: ${available || "none"}.`,
    ),
  );
};

const isSpawnFailure = (
  result: SpawnResult | SpawnFailure,
): result is SpawnFailure => !("exitCode" in result);

const runWithConcurrency = async <Item>(
  items: readonly Item[],
  limit: number,
  run: (item: Item, index: number) => Promise<void>,
): Promise<void> => {
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await run(items[index], index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
};

const worktreeBranchName = (stageIndex: number, taskIndex: number): string =>
  `pi-workflow-${randomUUID().slice(0, 8)}-s${stageIndex + 1}t${taskIndex + 1}`;

const failureLabel = (result: SpawnResult): string => {
  if (result.exitCode === null) {
    return result.signal === undefined
      ? "terminated by a signal"
      : `terminated by signal ${result.signal}`;
  }
  if (result.exitCode !== 0) return `exit code ${result.exitCode}`;
  return result.stopReason === undefined
    ? "failed"
    : `stopReason ${result.stopReason}`;
};

// The report text shares one PER_TASK_OUTPUT_CAP budget across every task; a
// single prefix-preserving cap would let one oversized early output erase
// later tasks (including PoC worktree paths the parent needs for judging).
// Headers and worktree identities are never subject to the output budget.
const REPORT_OVERHEAD_BYTES = 2_048;
const REPORT_TASK_HEADER_ALLOWANCE = 256;
const MIN_TASK_OUTPUT_BUDGET = 512;

const taskOutputBudget = (taskCount: number): number => {
  const available =
    PER_TASK_OUTPUT_CAP -
    REPORT_OVERHEAD_BYTES -
    taskCount * REPORT_TASK_HEADER_ALLOWANCE;
  return Math.max(
    MIN_TASK_OUTPUT_BUDGET,
    Math.floor(available / Math.max(1, taskCount)),
  );
};

const describeTaskReport = (
  report: WorkflowTaskReport,
  outputBudget: number,
): string => {
  const worktreeSuffix =
    report.worktree === undefined
      ? ""
      : ` (worktree: ${report.worktree} — left in place)`;
  if (isSpawnFailure(report.result)) {
    return `### [${report.agentType}] FAILED${worktreeSuffix}\n\n${capText(report.result.errorMessage, outputBudget)}`;
  }
  if (report.result.failed) {
    const output =
      report.result.stderr || report.result.output || "(no output)";
    return `### [${report.agentType}] FAILED (${failureLabel(report.result)})${worktreeSuffix}\n\n${capText(output, outputBudget)}`;
  }
  return `### [${report.agentType}] succeeded${worktreeSuffix}\n\n${capText(report.result.output || "(no output)", outputBudget)}`;
};

const setupWorkflow = (
  pi: PiLike,
  config: HarnessConfig,
  options: SetupWorkflowOptions = {},
): void => {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description:
      "Run a staged multi-agent workflow (ultracode-equivalent). Fan-out stages default to the codex agent family; the engine enforces codex-poc worktree isolation and disjoint codex-runner writeScopes, and never merges or removes created worktrees.",
    parameters: WorkflowParameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: CtxLike,
    ) {
      if (isAborted(signal)) throw new Error("Workflow was aborted");

      const validation = validateWorkflowPlan(params);
      if (!validation.ok) {
        throw new Error(
          capText(
            `workflow plan rejected:\n- ${validation.errors.join("\n- ")}`,
          ),
        );
      }

      // Pre-flight the whole roster before any worktree or process side
      // effect: an unknown agent in stage 3 must not leave stages 1-2 ran.
      const agents = loadAgents(config.paths.claudeAgentsDir);
      for (const stage of validation.stages) {
        for (const task of stage.tasks) resolveAgent(agents, task.agentType);
      }

      const defaultCwd = ctx.cwd ?? process.cwd();
      const createWorktree =
        options.createWorktree ??
        ((cwd: string, name: string) =>
          createValidatedWorktree(makeWorktreeCreator(config), cwd, name));
      const emitUpdate =
        typeof onUpdate === "function"
          ? (text: string) =>
              onUpdate({ content: [{ type: "text", text: capText(text) }] })
          : undefined;

      const stageReports: WorkflowStageReport[] = [];
      for (const [stageIndex, stage] of validation.stages.entries()) {
        if (isAborted(signal)) throw new Error("Workflow was aborted");

        // Provision worktrees sequentially before the stage runs; a
        // provisioning failure is an environment error, not a degradable
        // task result.
        const worktrees: (string | undefined)[] = [];
        for (const [taskIndex, task] of stage.tasks.entries()) {
          worktrees[taskIndex] =
            task.isolation === "worktree"
              ? await createWorktree(
                  defaultCwd,
                  worktreeBranchName(stageIndex, taskIndex),
                )
              : undefined;
        }

        const taskReports: WorkflowTaskReport[] = [];
        const runTask = async (
          task: WorkflowTaskPlan,
          taskIndex: number,
        ): Promise<void> => {
          const cwd = worktrees[taskIndex] ?? task.cwd ?? defaultCwd;
          const base = {
            agentType: task.agentType,
            task: task.task,
            cwd,
            ...(worktrees[taskIndex] === undefined
              ? {}
              : { worktree: worktrees[taskIndex] }),
          };
          try {
            const result = await spawnAgent(
              resolveAgent(agents, task.agentType),
              task.task,
              {
                cwd,
                signal,
                spawnFn: options.spawnFn,
                onUpdate: emitUpdate,
                termGraceMs: options.termGraceMs,
              },
            );
            taskReports[taskIndex] = { ...base, result };
          } catch (error) {
            taskReports[taskIndex] = {
              ...base,
              result: { failed: true, errorMessage: errorMessage(error) },
            };
          }
        };
        await runWithConcurrency(stage.tasks, MAX_CONCURRENCY, runTask);

        stageReports.push({
          ...(stage.name === undefined ? {} : { name: stage.name }),
          mode: stage.mode,
          tasks: taskReports,
        });
      }

      if (isAborted(signal)) throw new Error("Workflow was aborted");

      const allReports = stageReports.flatMap((stage) => stage.tasks);
      const total = allReports.length;
      const succeeded = allReports.filter(
        (report) => !isSpawnFailure(report.result) && !report.result.failed,
      ).length;
      const hasWorktrees = allReports.some(
        (report) => report.worktree !== undefined,
      );

      const outputBudget = taskOutputBudget(total);
      const sections = stageReports.map((stage, index) => {
        const title = stage.name ?? `Stage ${index + 1}`;
        const body = stage.tasks
          .map((report) => describeTaskReport(report, outputBudget))
          .join("\n\n");
        return `## ${title} (${stage.mode})\n\n${body}`;
      });
      const worktreeNote = hasWorktrees
        ? "\n\nWorktrees are left in place for review; never merged automatically. Removal requires the user-approved worktree_remove tool."
        : "";
      const summary = `Workflow completed: ${succeeded}/${total} tasks succeeded across ${stageReports.length} stage(s).`;

      return {
        content: [
          {
            type: "text",
            text: capText(
              `${summary}\n\n${sections.join("\n\n")}${worktreeNote}`,
            ),
          },
        ],
        details: {
          stages: stageReports,
          succeeded,
          total,
        } satisfies WorkflowDetails,
      };
    },
  });
};

export default setupWorkflow;
