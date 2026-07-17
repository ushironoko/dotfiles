import type { CtxLike, PiLike } from "../../lib/pi-like";
import type { HarnessConfig } from "../../config";
import { replacePrevious } from "../../lib/placeholder";
import type { ChildObservation } from "../child-runs/model";
import { renderChildRunsResult } from "../child-runs/presentation";
import { ChildRunRegistry } from "../child-runs/registry";
import { findAgent, loadAgents } from "./loader";
import { MAX_CHAIN_DEPTH, MAX_PARALLEL_TASKS } from "./limits";
import { SubagentParameters } from "./parameters.generated";
import {
  capText,
  spawnAgent,
  type SpawnFunction,
  type SpawnResult,
} from "./spawn";

const MAX_CONCURRENCY = 4;

interface TaskItem {
  agent: string;
  task: string;
  cwd?: string;
}

interface SubagentParams {
  agent?: string;
  task?: string;
  tasks?: TaskItem[];
  chain?: TaskItem[];
  cwd?: string;
}

interface ChildRunsIntegration {
  registry: ChildRunRegistry;
  ensureVisible(ctx: CtxLike): void;
}

interface SetupSubagentOptions {
  spawnFn?: SpawnFunction;
  termGraceMs?: number;
  childRuns?: ChildRunsIntegration;
}

interface SubagentDetails {
  mode: "single" | "parallel" | "chain";
  results: SpawnResult[];
}

interface Semaphore {
  acquire(signal?: AbortSignal): Promise<() => void>;
}

interface AbortControllerLike {
  signal: AbortSignal;
  abort(): void;
}

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && "aborted" in signal && signal.aborted === true;

const isAbortSignal = (value: unknown): value is AbortSignal =>
  typeof value === "object" &&
  value !== null &&
  "aborted" in value &&
  typeof value.aborted === "boolean" &&
  "addEventListener" in value &&
  typeof value.addEventListener === "function" &&
  "removeEventListener" in value &&
  typeof value.removeEventListener === "function";

const createAbortController = (): AbortControllerLike => {
  const controller: unknown = new AbortController();
  if (
    typeof controller !== "object" ||
    controller === null ||
    !("abort" in controller) ||
    typeof controller.abort !== "function" ||
    !("signal" in controller) ||
    !isAbortSignal(controller.signal)
  ) {
    throw new Error("AbortController is unavailable");
  }
  const { abort, signal } = controller;
  return {
    signal,
    abort: () => Reflect.apply(abort, controller, []),
  };
};

const getResultOutput = (result: SpawnResult): string =>
  result.output || result.stderr || "(no output)";

const assertSuccessful = (result: SpawnResult): void => {
  if (!result.failed) return;

  const reasons: string[] = [];
  if (result.exitCode === null) {
    reasons.push(
      result.signal === undefined
        ? "terminated by a signal"
        : `terminated by signal ${result.signal}`,
    );
  } else if (result.exitCode !== 0) {
    reasons.push(`exit code ${result.exitCode}`);
  }
  if (result.stopReason !== undefined) {
    reasons.push(`stopReason ${result.stopReason}`);
  }
  if (result.errorMessage !== undefined) {
    reasons.push(`errorMessage ${result.errorMessage}`);
  }
  throw new Error(
    capText(
      `Agent ${result.agent} failed (${reasons.join("; ")}): ${getResultOutput(result)}`,
    ),
  );
};

const createSemaphore = (limit: number): Semaphore => {
  let available = limit;
  const waiters: ((release: () => void) => void)[] = [];

  const createRelease = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = waiters.shift();
      if (waiter === undefined) {
        available += 1;
      } else {
        waiter(createRelease());
      }
    };
  };

  return {
    acquire(signal?: AbortSignal) {
      if (isAborted(signal)) {
        return Promise.reject(new Error("Subagent was aborted"));
      }
      if (available > 0) {
        available -= 1;
        return Promise.resolve(createRelease());
      }
      // Queued waiters must be removable on abort: a cancelled invocation
      // parked behind four unrelated children rejects immediately instead of
      // waiting for a slot (re-review finding). Listener wiring uses the same
      // structural guards as the rest of this file.
      return new Promise((resolve, reject) => {
        const removeListener = () => {
          if (
            signal !== undefined &&
            "removeEventListener" in signal &&
            typeof signal.removeEventListener === "function"
          ) {
            signal.removeEventListener("abort", onAbort);
          }
        };
        const waiter = (release: () => void) => {
          removeListener();
          resolve(release);
        };
        const onAbort = () => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error("Subagent was aborted"));
        };
        if (
          signal !== undefined &&
          "addEventListener" in signal &&
          typeof signal.addEventListener === "function"
        ) {
          signal.addEventListener("abort", onAbort, { once: true });
        }
        waiters.push(waiter);
      });
    },
  };
};

const mapWithConcurrencyLimit = async <Input, Output>(
  items: Input[],
  concurrency: number,
  run: (item: Input, index: number) => Promise<Output>,
  onFirstFailure: () => void,
): Promise<Output[]> => {
  if (items.length === 0) return [];
  const results: Output[] = [];
  let nextIndex = 0;
  let stopped = false;
  let failureRecorded = false;
  let firstFailure: unknown;

  const worker = async () => {
    while (!stopped) {
      if (nextIndex >= items.length) return;
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await run(items[index], index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          failureRecorded = true;
          firstFailure = error;
          onFirstFailure();
        }
        return;
      }
    }
  };

  await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  if (failureRecorded) throw firstFailure;
  return results;
};

const setupSubagent = (
  pi: PiLike,
  config: HarnessConfig,
  options: SetupSubagentOptions = {},
): void => {
  const semaphore = createSemaphore(MAX_CONCURRENCY);

  const tool = {
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate work to a configured agent in single, parallel, or chain mode.",
    parameters: SubagentParameters,
    async execute(
      toolCallId: string,
      params: SubagentParams,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: CtxLike,
    ) {
      const agents = loadAgents(config.paths.claudeAgentsDir);
      const hasChain = (params.chain?.length ?? 0) > 0;
      const hasTasks = (params.tasks?.length ?? 0) > 0;
      const hasSingle = params.agent !== undefined && params.task !== undefined;
      const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle);
      if (modeCount !== 1) {
        throw new Error(
          "Invalid parameters: provide exactly one of agent + task, tasks, or chain.",
        );
      }

      if (params.chain !== undefined && params.chain.length > MAX_CHAIN_DEPTH) {
        throw new Error(
          `Too many chain steps (${params.chain.length}). Max is ${MAX_CHAIN_DEPTH}.`,
        );
      }
      if (
        params.tasks !== undefined &&
        params.tasks.length > MAX_PARALLEL_TASKS
      ) {
        throw new Error(
          `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
        );
      }
      if (params.tasks !== undefined) {
        for (const task of params.tasks) findAgent(agents, task.agent);
      }

      const defaultCwd = ctx.cwd ?? process.cwd();
      const declaredItems: TaskItem[] =
        params.chain && params.chain.length > 0
          ? params.chain
          : params.tasks && params.tasks.length > 0
            ? params.tasks
            : params.agent !== undefined && params.task !== undefined
              ? [{ agent: params.agent, task: params.task, cwd: params.cwd }]
              : [];
      const mode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
      const childRuns = options.childRuns;
      const started = childRuns?.registry.beginInvocation({
        toolCallId,
        source: "subagent",
        mode,
        label: `subagent ${mode}`,
        runs: declaredItems.map((item, taskIndex) => ({
          agent: item.agent,
          task: item.task,
          taskIndex,
        })),
      });
      const invocationId = started?.invocationId;
      const runIds = started?.runIds ?? [];
      if (started !== undefined) childRuns?.ensureVisible(ctx);

      let lastUpdateText = `Subagent ${mode} started`;
      const emitUpdate =
        typeof onUpdate === "function"
          ? (text: string) => {
              lastUpdateText = text;
              const details =
                invocationId === undefined
                  ? undefined
                  : childRuns?.registry.getUpdateDetails(invocationId);
              onUpdate({
                content: [{ type: "text", text: capText(text) }],
                ...(details === undefined ? {} : { details }),
              });
            }
          : undefined;
      emitUpdate?.(lastUpdateText);

      const observeFor =
        (runId: string | undefined) => (observation: ChildObservation) => {
          if (runId === undefined || childRuns === undefined) return;
          childRuns.registry.observe(runId, observation);
          if (observation.type !== "assistant_draft") {
            emitUpdate?.(lastUpdateText);
          }
        };

      const finishSpawnResult = (
        runId: string | undefined,
        result: SpawnResult,
      ): void => {
        if (runId === undefined || childRuns === undefined) return;
        let reason:
          | "length"
          | "model-error"
          | "model-aborted"
          | "spawn-error"
          | "completed" = "completed";
        if (result.stopReason === "length") reason = "length";
        else if (result.stopReason === "aborted") reason = "model-aborted";
        else if (result.stopReason === "error") reason = "model-error";
        else if (result.failed) reason = "spawn-error";
        childRuns.registry.finishRun(runId, {
          status:
            result.stopReason === "aborted"
              ? "aborted"
              : result.failed
                ? "failed"
                : "succeeded",
          reason,
          exitCode: result.exitCode,
          signal: result.signal,
          stopReason: result.stopReason,
          model: result.model,
        });
      };

      const runTask = async (
        item: TaskItem,
        runId: string | undefined,
        taskSignal: AbortSignal | undefined = signal,
      ): Promise<SpawnResult> => {
        let release: (() => void) | undefined;
        try {
          release = await semaphore.acquire(taskSignal);
          if (isAborted(taskSignal)) {
            throw new Error("Subagent was aborted");
          }
          const result = await spawnAgent(
            findAgent(agents, item.agent),
            item.task,
            {
              cwd: item.cwd ?? defaultCwd,
              signal: taskSignal,
              spawnFn: options.spawnFn,
              onUpdate: emitUpdate,
              observe: observeFor(runId),
              termGraceMs: options.termGraceMs,
            },
          );
          finishSpawnResult(runId, result);
          return result;
        } catch (error) {
          if (runId !== undefined && childRuns !== undefined) {
            const status = childRuns.registry.getRunStatus(runId);
            const parentAborted = isAborted(signal);
            const taskAborted = isAborted(taskSignal);
            let terminalStatus: "skipped" | "aborted" | "failed" = "failed";
            if (taskAborted) {
              terminalStatus =
                status === "queued" && !parentAborted ? "skipped" : "aborted";
            }
            let reason:
              | "parent-abort"
              | "fail-fast"
              | "spawn-error"
              | "setup-error" =
              status === "running" ? "spawn-error" : "setup-error";
            if (parentAborted) reason = "parent-abort";
            else if (taskAborted) reason = "fail-fast";
            childRuns.registry.finishRun(runId, {
              status: terminalStatus,
              reason,
            });
          }
          throw error;
        } finally {
          release?.();
        }
      };

      let incompleteReason: "dependency-failed" | "fail-fast" =
        "dependency-failed";
      try {
        if (params.chain !== undefined && params.chain.length > 0) {
          const results: SpawnResult[] = [];
          let previous = "";
          for (const [index, step] of params.chain.entries()) {
            const result = await runTask(
              { ...step, task: replacePrevious(step.task, previous) },
              runIds[index],
            );
            assertSuccessful(result);
            results.push(result);
            previous = result.output;
          }
          return {
            content: [
              { type: "text", text: capText(previous || "(no output)") },
            ],
            details: { mode: "chain", results } satisfies SubagentDetails,
          };
        }

        if (params.tasks !== undefined && params.tasks.length > 0) {
          const controller = createAbortController();
          const forwardAbort = () => controller.abort();
          if (isAborted(signal)) controller.abort();
          else if (
            signal !== undefined &&
            "addEventListener" in signal &&
            typeof signal.addEventListener === "function"
          ) {
            signal.addEventListener("abort", forwardAbort, { once: true });
          }

          let results: SpawnResult[];
          try {
            results = await mapWithConcurrencyLimit(
              params.tasks,
              MAX_CONCURRENCY,
              async (task, index) => {
                const result = await runTask(
                  task,
                  runIds[index],
                  controller.signal,
                );
                assertSuccessful(result);
                return result;
              },
              () => {
                incompleteReason = "fail-fast";
                controller.abort();
              },
            );
          } finally {
            if (
              signal !== undefined &&
              "removeEventListener" in signal &&
              typeof signal.removeEventListener === "function"
            ) {
              signal.removeEventListener("abort", forwardAbort);
            }
          }

          const summaries = results.map(
            (result) =>
              `### [${result.agent}] completed\n\n${getResultOutput(result)}`,
          );
          return {
            content: [
              {
                type: "text",
                text: capText(
                  `Parallel: ${results.length}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
                ),
              },
            ],
            details: { mode: "parallel", results } satisfies SubagentDetails,
          };
        }

        if (params.agent !== undefined && params.task !== undefined) {
          const result = await runTask(
            { agent: params.agent, task: params.task, cwd: params.cwd },
            runIds[0],
          );
          assertSuccessful(result);
          return {
            content: [
              {
                type: "text",
                text: capText(result.output || "(no output)"),
              },
            ],
            details: {
              mode: "single",
              results: [result],
            } satisfies SubagentDetails,
          };
        }

        throw new Error("Invalid subagent parameters.");
      } finally {
        if (invocationId !== undefined && childRuns !== undefined) {
          const parentAborted = isAborted(signal);
          childRuns.registry.terminalizeInvocation(
            invocationId,
            {
              status: parentAborted ? "aborted" : "skipped",
              reason: parentAborted ? "parent-abort" : incompleteReason,
            },
            {
              status: "aborted",
              reason: parentAborted ? "parent-abort" : "fail-fast",
            },
          );
          emitUpdate?.(lastUpdateText);
        }
      }
    },
    renderResult: renderChildRunsResult,
  };
  pi.registerTool(tool);
};

export default setupSubagent;
