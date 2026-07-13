import type { CtxLike, PiLike } from "../../lib/pi-like";
import type { HarnessConfig } from "../../config";
import type { AgentDefinition } from "../../lib/agent-md";
import { replacePrevious } from "../../lib/placeholder";
import { loadAgents } from "./loader";
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

interface SetupSubagentOptions {
  spawnFn?: SpawnFunction;
  termGraceMs?: number;
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

const findAgent = (
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

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Delegate work to a configured agent in single, parallel, or chain mode.",
    parameters: SubagentParameters,
    async execute(
      _toolCallId: string,
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

      const defaultCwd = ctx.cwd ?? process.cwd();
      const emitUpdate =
        typeof onUpdate === "function"
          ? (text: string) =>
              onUpdate({ content: [{ type: "text", text: capText(text) }] })
          : undefined;
      const runTask = async (
        item: TaskItem,
        taskSignal: AbortSignal | undefined = signal,
      ): Promise<SpawnResult> => {
        const release = await semaphore.acquire(taskSignal);
        try {
          if (isAborted(taskSignal)) {
            throw new Error("Subagent was aborted");
          }
          return await spawnAgent(findAgent(agents, item.agent), item.task, {
            cwd: item.cwd ?? defaultCwd,
            signal: taskSignal,
            spawnFn: options.spawnFn,
            onUpdate: emitUpdate,
            termGraceMs: options.termGraceMs,
          });
        } finally {
          release();
        }
      };

      if (params.chain !== undefined && params.chain.length > 0) {
        if (params.chain.length > MAX_CHAIN_DEPTH) {
          throw new Error(
            `Too many chain steps (${params.chain.length}). Max is ${MAX_CHAIN_DEPTH}.`,
          );
        }
        const results: SpawnResult[] = [];
        let previous = "";
        for (const step of params.chain) {
          const result = await runTask({
            ...step,
            task: replacePrevious(step.task, previous),
          });
          assertSuccessful(result);
          results.push(result);
          previous = result.output;
        }
        return {
          content: [{ type: "text", text: capText(previous || "(no output)") }],
          details: { mode: "chain", results } satisfies SubagentDetails,
        };
      }

      if (params.tasks !== undefined && params.tasks.length > 0) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) {
          throw new Error(
            `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
          );
        }
        for (const task of params.tasks) findAgent(agents, task.agent);

        const controller = createAbortController();
        const forwardAbort = () => controller.abort();
        if (isAborted(signal)) {
          controller.abort();
        } else if (
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
            async (task) => {
              const result = await runTask(task, controller.signal);
              assertSuccessful(result);
              return result;
            },
            () => controller.abort(),
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
        const result = await runTask({
          agent: params.agent,
          task: params.task,
          cwd: params.cwd,
        });
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
    },
  });
};

export default setupSubagent;
