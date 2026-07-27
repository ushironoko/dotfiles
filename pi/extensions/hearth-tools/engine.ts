import type { EngineOptions, HearthEngine, ShellSpec } from "@hearthdev/napi";
import type { HearthToolsConfig } from "./config";

export interface HearthModule {
  HearthEngine: new (options?: EngineOptions) => HearthEngine;
}

export interface PiToolSettings {
  shellPath?: string;
  shellCommandPrefix?: string;
  imageAutoResize: boolean;
  shell: ShellSpec;
}

export interface HearthAccessGate {
  shared<T>(operation: () => Promise<T>): Promise<T>;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
}

type AccessMode = "shared" | "exclusive";

interface AccessWaiter {
  mode: AccessMode;
  operation(): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/**
 * A fair process-local shared/exclusive gate around one resident Engine.
 *
 * File-backed tools may overlap. Bash and explicit invalidation wait for every
 * active file operation, then keep later operations out until cache clearing is
 * complete. FIFO admission prevents a stream of reads from starving Bash.
 */
export class HearthEngineGate implements HearthAccessGate {
  private readonly waiters: AccessWaiter[] = [];
  private activeReaders = 0;
  private activeWriter = false;

  shared<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue("shared", operation);
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue("exclusive", operation);
  }

  private enqueue<T>(
    mode: AccessMode,
    operation: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiters.push({
        mode,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.drain();
    });
  }

  private drain(): void {
    if (this.activeWriter) return;
    const first = this.waiters[0];
    if (first === undefined) return;

    if (first.mode === "exclusive") {
      if (this.activeReaders > 0) return;
      this.waiters.shift();
      this.activeWriter = true;
      this.start(first, () => {
        this.activeWriter = false;
      });
      return;
    }

    while (this.waiters[0]?.mode === "shared" && !this.activeWriter) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) break;
      this.activeReaders += 1;
      this.start(waiter, () => {
        this.activeReaders -= 1;
      });
    }
  }

  private start(waiter: AccessWaiter, release: () => void): void {
    void Promise.resolve()
      .then(waiter.operation)
      .then(waiter.resolve, waiter.reject)
      .finally(() => {
        release();
        this.drain();
      });
  }
}

class ImmediateHearthAccessGate implements HearthAccessGate {
  shared<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }
}

export const IMMEDIATE_HEARTH_ACCESS_GATE: HearthAccessGate =
  new ImmediateHearthAccessGate();

export interface HearthEngineRuntime {
  engine: HearthEngine;
  gate: HearthEngineGate;
  options: EngineOptions;
}

// Bump the symbol whenever the slot shape changes so /reload cannot interpret
// a runtime created by an older extension revision as the current contract.
const ENGINE_SLOT = Symbol.for("ushironoko.pi-hearth-tools.engine.v2");
const LEGACY_ENGINE_SLOT = Symbol.for("ushironoko.pi-hearth-tools.engine.v1");

interface GlobalWithEngine {
  [ENGINE_SLOT]?: HearthEngineRuntime;
  [LEGACY_ENGINE_SLOT]?: unknown;
}

export class HearthEngineRestartRequiredError extends Error {
  constructor() {
    super("Hearth Engine settings changed; restart pi to apply them");
    this.name = "HearthEngineRestartRequiredError";
  }
}

const createOptions = (
  cwd: string,
  config: HearthToolsConfig,
  shell: ShellSpec,
): EngineOptions => ({
  cwd,
  trustCache: config.trustCache,
  warmShell: config.warmShell,
  enableOptimizer: config.enableOptimizer,
  bashTimeoutMs: config.bashTimeoutMs,
  shell,
  ...(config.maxCachedFiles === undefined
    ? {}
    : { maxCachedFiles: config.maxCachedFiles }),
});

const sameShell = (
  left: ShellSpec | undefined,
  right: ShellSpec | undefined,
): boolean =>
  left?.program === right?.program &&
  left?.transport === right?.transport &&
  JSON.stringify(left?.args ?? []) === JSON.stringify(right?.args ?? []);

const sameOptions = (left: EngineOptions, right: EngineOptions): boolean =>
  left.cwd === right.cwd &&
  left.trustCache === right.trustCache &&
  left.warmShell === right.warmShell &&
  left.enableOptimizer === right.enableOptimizer &&
  left.bashTimeoutMs === right.bashTimeoutMs &&
  left.maxCachedFiles === right.maxCachedFiles &&
  sameShell(left.shell, right.shell);

export const getOrCreateEngineRuntime = (
  module: HearthModule,
  cwd: string,
  config: HearthToolsConfig,
  shell: ShellSpec,
): HearthEngineRuntime => {
  const host = globalThis as GlobalWithEngine;
  // A live /reload from the pre-gate slot must release its global root before
  // constructing v2. The stale extension runtime may keep a short-lived local
  // reference until reload teardown completes, but the old optimizer/warm shell
  // can then drop instead of remaining process-rooted forever.
  delete host[LEGACY_ENGINE_SLOT];
  const options = createOptions(cwd, config, shell);
  const existing = host[ENGINE_SLOT];
  if (existing !== undefined) {
    if (!sameOptions(existing.options, options)) {
      throw new HearthEngineRestartRequiredError();
    }
    return existing;
  }

  const runtime: HearthEngineRuntime = {
    engine: new module.HearthEngine(options),
    gate: new HearthEngineGate(),
    options,
  };
  host[ENGINE_SLOT] = runtime;
  return runtime;
};

export const clearProcessEngineForTests = (): void => {
  const host = globalThis as GlobalWithEngine;
  delete host[ENGINE_SLOT];
  delete host[LEGACY_ENGINE_SLOT];
};
