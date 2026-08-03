import {
  type AbortControllerLike,
  createAbortController,
  isAbortSignal,
} from "../../lib/abort";
import { stripTerminalControls } from "../../lib/terminal-text";
import type { TrustConfig } from "../../lib/trust";
import {
  AgentMemoryCli,
  AgentMemoryCliError,
  type AgentMemoryFailureKind,
  type MemoryAggregate,
  type MemoryUpdateResult,
} from "./cli";
import { MEMORY_INDEX_ITEM_LIMIT, type SourcedMemoryRecord } from "./model";

export interface AgentMemoryDataSource {
  aggregate(
    cwd: string,
    trust: TrustConfig,
    signal?: AbortSignal,
  ): Promise<MemoryAggregate>;
  update(
    cwd: string,
    trust: TrustConfig,
    sessionId: string,
    input:
      | {
          readonly action: "put";
          readonly path: string;
          readonly description: string;
          readonly content: string;
        }
      | { readonly action: "remove"; readonly path: string },
    signal?: AbortSignal,
  ): Promise<MemoryUpdateResult>;
}

export interface AgentMemorySummary {
  readonly path: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly sourceRef: string;
}

export interface AgentMemorySnapshot {
  readonly entries: readonly AgentMemorySummary[];
  readonly truncated: boolean;
  readonly loading: boolean;
  readonly stale: boolean;
  readonly diagnosticCount: number;
  readonly error?: string;
  readonly refreshedAt?: number;
}

export type AgentMemoryRefreshOutcome =
  | {
      readonly ok: true;
      readonly count: number;
      readonly truncated: boolean;
      readonly aggregate: MemoryAggregate;
    }
  | {
      readonly ok: false;
      readonly kind: AgentMemoryFailureKind;
      readonly message: string;
      readonly error: AgentMemoryCliError;
    };

interface AgentMemoryRegistryOptions {
  readonly cli?: AgentMemoryDataSource;
  readonly trust: TrustConfig;
  readonly now?: () => number;
}

const abortedOutcome = (message: string): AgentMemoryRefreshOutcome => {
  const error = new AgentMemoryCliError("aborted", message);
  return { ok: false, kind: error.kind, message: error.message, error };
};

const safeMessage = (error: unknown): string =>
  stripTerminalControls(
    error instanceof Error ? error.message : String(error),
    " ",
  )
    .replace(/\s+/g, " ")
    .trim();

const asCliError = (error: unknown): AgentMemoryCliError =>
  error instanceof AgentMemoryCliError
    ? error
    : new AgentMemoryCliError("command-failed", safeMessage(error));

const initialSnapshot = (): AgentMemorySnapshot => ({
  entries: [],
  truncated: false,
  loading: false,
  stale: false,
  diagnosticCount: 0,
});

const cloneSourced = (entry: SourcedMemoryRecord): SourcedMemoryRecord => ({
  ...entry,
  record: { ...entry.record },
});

export class AgentMemoryRegistry {
  private readonly cli: AgentMemoryDataSource;
  private readonly trust: TrustConfig;
  private readonly now: () => number;
  private readonly subscribers = new Set<() => void>();
  private readonly details = new Map<string, SourcedMemoryRecord>();
  private snapshot: AgentMemorySnapshot = initialSnapshot();
  private cwd: string | undefined;
  private generation = 0;
  private refreshController: AbortControllerLike | undefined;
  private refreshPromise: Promise<AgentMemoryRefreshOutcome> | undefined;
  private refreshWaiters = 0;
  private disposed = false;

  constructor(options: AgentMemoryRegistryOptions) {
    this.cli = options.cli ?? new AgentMemoryCli();
    this.trust = options.trust;
    this.now = options.now ?? Date.now;
  }

  beginSession(cwd: string): void {
    if (this.disposed) return;
    this.refreshController?.abort();
    this.refreshController = undefined;
    this.refreshPromise = undefined;
    this.refreshWaiters = 0;
    this.generation += 1;
    this.cwd = cwd;
    this.snapshot = initialSnapshot();
    this.details.clear();
    this.publish();
  }

  getSnapshot(): AgentMemorySnapshot {
    return {
      ...this.snapshot,
      entries: this.snapshot.entries.map((entry) => ({ ...entry })),
    };
  }

  getEntry(path: string): SourcedMemoryRecord | undefined {
    const entry = this.details.get(path);
    return entry === undefined ? undefined : cloneSourced(entry);
  }

  async refresh(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<AgentMemoryRefreshOutcome> {
    if (this.disposed) {
      return abortedOutcome("project memory registry is disposed");
    }
    if (this.cwd !== cwd) this.beginSession(cwd);
    if (this.refreshPromise !== undefined) {
      return this.waitForRefresh(this.refreshPromise, signal);
    }

    const controller = createAbortController();
    this.refreshController = controller;
    const { generation } = this;
    this.snapshot = { ...this.snapshot, loading: true };
    this.publish();

    const refreshPromise = this.load(
      cwd,
      generation,
      controller.signal,
    ).finally(() => {
      if (this.refreshPromise !== refreshPromise) return;
      this.refreshPromise = undefined;
      this.refreshController = undefined;
      this.refreshWaiters = 0;
    });
    this.refreshPromise = refreshPromise;
    return this.waitForRefresh(refreshPromise, signal);
  }

  async aggregate(cwd: string, signal?: AbortSignal): Promise<MemoryAggregate> {
    const outcome = await this.refresh(cwd, signal);
    if (!outcome.ok) throw outcome.error;
    return outcome.aggregate;
  }

  async update(
    cwd: string,
    sessionId: string,
    input:
      | {
          readonly action: "put";
          readonly path: string;
          readonly description: string;
          readonly content: string;
        }
      | { readonly action: "remove"; readonly path: string },
    signal?: AbortSignal,
  ): Promise<MemoryUpdateResult> {
    const result = await this.cli.update(
      cwd,
      this.trust,
      sessionId,
      input,
      signal,
    );
    const pending = this.refreshPromise;
    if (pending !== undefined) await pending;
    await this.refresh(cwd, signal);
    return result;
  }

  subscribe(callback: () => void): () => void {
    if (this.disposed) return () => {};
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.refreshController?.abort();
    this.refreshController = undefined;
    this.refreshPromise = undefined;
    this.refreshWaiters = 0;
    this.details.clear();
    this.subscribers.clear();
  }

  private waitForRefresh(
    promise: Promise<AgentMemoryRefreshOutcome>,
    signal?: AbortSignal,
  ): Promise<AgentMemoryRefreshOutcome> {
    this.refreshWaiters += 1;
    let released = false;
    const release = (aborted: boolean): void => {
      if (released) return;
      released = true;
      if (this.refreshPromise !== promise) return;
      this.refreshWaiters = Math.max(0, this.refreshWaiters - 1);
      if (aborted && this.refreshWaiters === 0) {
        this.refreshController?.abort();
      }
    };
    if (!isAbortSignal(signal)) {
      return promise.finally(() => release(false));
    }
    return new Promise<AgentMemoryRefreshOutcome>((resolve, reject) => {
      const abort = (): void => {
        signal.removeEventListener("abort", abort);
        release(true);
        resolve(abortedOutcome("project memory refresh aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      void promise.then(
        (outcome) => {
          signal.removeEventListener("abort", abort);
          release(false);
          resolve(outcome);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", abort);
          release(false);
          reject(error);
        },
      );
    });
  }

  private async load(
    cwd: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<AgentMemoryRefreshOutcome> {
    try {
      const aggregate = await this.cli.aggregate(cwd, this.trust, signal);
      if (this.disposed || generation !== this.generation) {
        const error = new AgentMemoryCliError(
          "aborted",
          "stale project memory refresh discarded",
        );
        return { ok: false, kind: error.kind, message: error.message, error };
      }
      const sorted = [...aggregate.merged.entries.values()].sort(
        (left, right) => left.record.path.localeCompare(right.record.path),
      );
      const selected = sorted.slice(0, MEMORY_INDEX_ITEM_LIMIT);
      const truncated =
        aggregate.truncated || sorted.length > MEMORY_INDEX_ITEM_LIMIT;
      this.details.clear();
      const entries = selected.map((entry): AgentMemorySummary => {
        this.details.set(entry.record.path, cloneSourced(entry));
        return {
          path: entry.record.path,
          description: entry.record.description,
          updatedAt: entry.record.updatedAt,
          sourceRef: entry.sourceRef,
        };
      });
      this.snapshot = {
        entries,
        truncated,
        loading: false,
        stale: false,
        diagnosticCount: aggregate.diagnostics.length,
        refreshedAt: this.now(),
      };
      this.publish();
      return {
        ok: true,
        count: entries.length,
        truncated,
        aggregate,
      };
    } catch (error) {
      const failure = asCliError(error);
      if (this.disposed || generation !== this.generation) {
        return {
          ok: false,
          kind: "aborted",
          message: "stale project memory refresh discarded",
          error: new AgentMemoryCliError(
            "aborted",
            "stale project memory refresh discarded",
          ),
        };
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
        error: failure,
      };
    }
  }

  private publish(): void {
    if (this.disposed) return;
    for (const callback of this.subscribers) {
      try {
        callback();
      } catch {
        // One TUI listener must not poison memory recall or later listeners.
      }
    }
  }
}
