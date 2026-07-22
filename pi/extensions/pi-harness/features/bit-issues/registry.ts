import { stripTerminalControls } from "../../lib/terminal-text";
import { BitIssueCli } from "./cli";
import {
  BitIssueCliError,
  type BitIssueDetailState,
  type BitIssueFailureKind,
  type BitIssueSnapshot,
} from "./model";

export type BitIssueRefreshOutcome =
  | {
      readonly ok: true;
      readonly count: number;
      readonly truncated: boolean;
    }
  | {
      readonly ok: false;
      readonly kind: BitIssueFailureKind;
      readonly message: string;
    };

export type BitIssueDataSource = Pick<BitIssueCli, "listOpen" | "getDetail">;

interface BitIssueRegistryOptions {
  readonly cli?: BitIssueDataSource;
  readonly now?: () => number;
}

interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(
    event: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(event: "abort", listener: () => void): void;
}

interface AbortControllerLike {
  readonly signal: AbortSignal & AbortSignalLike;
  abort(): void;
}

interface LinkedController {
  readonly controller: AbortControllerLike;
  dispose(): void;
}

const isAbortSignal = (
  value: unknown,
): value is AbortSignal & AbortSignalLike =>
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

const linkedController = (signal?: AbortSignal): LinkedController => {
  const controller = createAbortController();
  const abort = (): void => controller.abort();
  if (isAbortSignal(signal))
    signal.addEventListener("abort", abort, { once: true });
  if (isAbortSignal(signal) && signal.aborted) abort();
  return {
    controller,
    dispose() {
      if (isAbortSignal(signal)) signal.removeEventListener("abort", abort);
    },
  };
};

const safeMessage = (error: unknown): string =>
  stripTerminalControls(
    error instanceof Error ? error.message : String(error),
    " ",
  )
    .replace(/\s+/g, " ")
    .trim();

const asCliError = (error: unknown): BitIssueCliError =>
  error instanceof BitIssueCliError
    ? error
    : new BitIssueCliError("command-failed", safeMessage(error));

const initialSnapshot = (): BitIssueSnapshot => ({
  issues: [],
  truncated: false,
  loading: false,
  stale: false,
});

export class BitIssueRegistry {
  private readonly cli: BitIssueDataSource;
  private readonly now: () => number;
  private readonly subscribers = new Set<() => void>();
  private readonly detailStates = new Map<string, BitIssueDetailState>();
  private readonly detailControllers = new Map<string, AbortControllerLike>();
  private readonly detailTokens = new Map<string, number>();
  private snapshot: BitIssueSnapshot = initialSnapshot();
  private cwd: string | undefined;
  private generation = 0;
  private refreshController: AbortControllerLike | undefined;
  private refreshPromise: Promise<BitIssueRefreshOutcome> | undefined;
  private refreshRequests = 0;
  private disposed = false;

  constructor(options: BitIssueRegistryOptions = {}) {
    this.cli = options.cli ?? new BitIssueCli();
    this.now = options.now ?? Date.now;
  }

  beginSession(cwd: string): void {
    if (this.disposed) return;
    this.abortInFlight();
    this.generation += 1;
    this.cwd = cwd;
    this.refreshRequests = 0;
    this.snapshot = initialSnapshot();
    this.detailStates.clear();
    this.detailTokens.clear();
    this.publish();
  }

  getSnapshot(): BitIssueSnapshot {
    return {
      ...this.snapshot,
      issues: this.snapshot.issues.map((issue) => ({
        ...issue,
        labels: [...issue.labels],
      })),
    };
  }

  getDetailState(id: string): BitIssueDetailState {
    return this.detailStates.get(id) ?? { status: "idle" };
  }

  prepareDetail(id: string): void {
    if (this.disposed) return;
    this.detailControllers.get(id)?.abort();
    this.detailControllers.delete(id);
    this.detailTokens.set(id, (this.detailTokens.get(id) ?? 0) + 1);
    this.detailStates.set(id, { status: "loading" });
    this.publish();
  }

  async refresh(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<BitIssueRefreshOutcome> {
    if (this.disposed) {
      return {
        ok: false,
        kind: "aborted",
        message: "bit issue registry is disposed",
      };
    }
    if (this.cwd !== cwd) this.beginSession(cwd);
    this.refreshRequests += 1;
    if (this.refreshPromise !== undefined) return this.refreshPromise;

    const linked = linkedController(signal);
    this.refreshController = linked.controller;
    const { generation } = this;
    this.snapshot = { ...this.snapshot, loading: true };
    this.publish();

    const refreshPromise = this.drainRefreshRequests(
      cwd,
      generation,
      linked.controller.signal,
    ).finally(() => {
      linked.dispose();
      if (this.refreshPromise !== refreshPromise) return;
      this.refreshPromise = undefined;
      this.refreshController = undefined;
    });
    this.refreshPromise = refreshPromise;
    return refreshPromise;
  }

  private async drainRefreshRequests(
    cwd: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<BitIssueRefreshOutcome> {
    while (!this.disposed && generation === this.generation) {
      const request = this.refreshRequests;
      try {
        const result = await this.cli.listOpen(cwd, signal);
        if (this.disposed || generation !== this.generation) break;
        if (request !== this.refreshRequests) continue;

        this.snapshot = {
          issues: result.issues,
          truncated: result.truncated,
          loading: false,
          stale: false,
          refreshedAt: this.now(),
        };
        this.publish();
        if (request !== this.refreshRequests) {
          this.snapshot = { ...this.snapshot, loading: true };
          this.publish();
          continue;
        }
        return {
          ok: true,
          count: result.issues.length,
          truncated: result.truncated,
        };
      } catch (error) {
        const failure = asCliError(error);
        if (this.disposed || generation !== this.generation) break;
        if (request !== this.refreshRequests && failure.kind !== "aborted") {
          continue;
        }
        this.snapshot = {
          ...this.snapshot,
          loading: false,
          stale: this.snapshot.refreshedAt !== undefined,
          error: safeMessage(failure),
        };
        this.publish();
        return {
          ok: false,
          kind: failure.kind,
          message: safeMessage(failure),
        };
      }
    }
    return {
      ok: false,
      kind: "aborted",
      message: "stale bit issue refresh discarded",
    };
  }

  async loadDetail(
    id: string,
    signal?: AbortSignal,
  ): Promise<BitIssueDetailState> {
    if (this.disposed || this.cwd === undefined) {
      return { status: "error", message: "bit issue session is unavailable" };
    }
    this.prepareDetail(id);
    const token = this.detailTokens.get(id) ?? 0;
    const linked = linkedController(signal);
    this.detailControllers.set(id, linked.controller);
    const { generation, cwd } = this;
    try {
      const detail = await this.cli.getDetail(
        cwd,
        id,
        linked.controller.signal,
      );
      if (
        this.disposed ||
        generation !== this.generation ||
        token !== this.detailTokens.get(id)
      ) {
        return { status: "error", message: "stale bit issue detail discarded" };
      }
      const state: BitIssueDetailState = { status: "ready", detail };
      this.detailStates.set(id, state);
      if (detail.issue.state !== "open") {
        this.snapshot = {
          ...this.snapshot,
          issues: this.snapshot.issues.filter((issue) => issue.id !== id),
        };
      }
      this.publish();
      return state;
    } catch (error) {
      const failure = asCliError(error);
      const state: BitIssueDetailState = {
        status: "error",
        message: safeMessage(failure),
      };
      if (
        !this.disposed &&
        generation === this.generation &&
        token === this.detailTokens.get(id) &&
        failure.kind !== "aborted"
      ) {
        this.detailStates.set(id, state);
        this.publish();
      }
      return state;
    } finally {
      linked.dispose();
      if (this.detailControllers.get(id) === linked.controller) {
        this.detailControllers.delete(id);
      }
    }
  }

  cancelDetail(id: string): void {
    this.detailControllers.get(id)?.abort();
    this.detailControllers.delete(id);
    this.detailTokens.set(id, (this.detailTokens.get(id) ?? 0) + 1);
    this.detailStates.delete(id);
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => {};
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abortInFlight();
    this.subscribers.clear();
    this.detailStates.clear();
    this.detailTokens.clear();
  }

  private abortInFlight(): void {
    this.refreshController?.abort();
    this.refreshController = undefined;
    this.refreshPromise = undefined;
    for (const controller of this.detailControllers.values())
      controller.abort();
    this.detailControllers.clear();
  }

  private publish(): void {
    if (this.disposed) return;
    for (const subscriber of this.subscribers) {
      try {
        subscriber();
      } catch {
        // One TUI listener must not prevent updates reaching the others.
      }
    }
  }
}
