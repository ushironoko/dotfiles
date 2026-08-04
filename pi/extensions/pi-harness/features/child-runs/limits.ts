/**
 * Shared child-run capacity bounds.
 *
 * A workflow may retain at most one persisted invocation's worth of runs, while
 * execution concurrency is independently bounded so large fan-outs queue
 * instead of creating an unbounded process burst.
 */
export const MAX_CHILD_RUNS_PER_INVOCATION = 64;
export const DEFAULT_MAX_CONCURRENT_CHILDREN = 32;
export const MIN_CONCURRENT_CHILDREN = 1;
export const MAX_CONCURRENT_CHILDREN = MAX_CHILD_RUNS_PER_INVOCATION;

export const isValidChildConcurrency = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= MIN_CONCURRENT_CHILDREN &&
  value <= MAX_CONCURRENT_CHILDREN;

export const assertChildRunsConfiguration = (
  configurationError: string | undefined,
): void => {
  if (configurationError === undefined) return;
  throw new Error(
    `pi-harness childRuns configuration error: ${configurationError}`,
  );
};
