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

export interface HearthExternalWriterLease {
  ready: Promise<void>;
  complete: Promise<void>;
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
  private activeExternalWriters = 0;
  private externalWriterInvalidation?: () => unknown;

  shared<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueExternalWriterSafe("shared", operation);
  }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueExternalWriterSafe("exclusive", operation);
  }

  /**
   * Keeps Engine caches coherent while an out-of-process writer is active
   * without holding the gate for that writer's full lifetime. Parent tools
   * remain runnable; each one gets a fresh cache view and runs exclusively
   * with respect to other Engine operations while external writes may race.
   */
  protectExternalWriter(
    finished: Promise<void>,
    invalidate: () => unknown,
  ): HearthExternalWriterLease {
    this.activeExternalWriters += 1;
    this.externalWriterInvalidation = invalidate;

    // The child does not start before this short barrier. Operations already
    // admitted by the gate finish first, then their cached view is discarded.
    const ready = this.enqueue("exclusive", async () => {
      invalidate();
    });
    const readySettled = ready.then(
      () => undefined,
      () => undefined,
    );
    const writerSettled = finished.then(
      () => undefined,
      () => undefined,
    );
    const complete = Promise.all([readySettled, writerSettled]).then(() =>
      this.enqueue("exclusive", async () => {
        try {
          invalidate();
        } finally {
          this.activeExternalWriters = Math.max(
            0,
            this.activeExternalWriters - 1,
          );
          if (this.activeExternalWriters === 0) {
            this.externalWriterInvalidation = undefined;
          }
        }
      }),
    );
    return { ready, complete };
  }

  private enqueueExternalWriterSafe<T>(
    mode: AccessMode,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (this.activeExternalWriters === 0) {
      return this.enqueue(mode, operation);
    }
    return this.enqueue("exclusive", async () => {
      this.externalWriterInvalidation?.();
      return operation();
    });
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
    const [first] = this.waiters;
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
const ENGINE_SLOT = Symbol.for("ushironoko.pi-hearth-tools.engine.v3");
const LEGACY_ENGINE_SLOT_V2 = Symbol.for(
  "ushironoko.pi-hearth-tools.engine.v2",
);
const LEGACY_ENGINE_SLOT_V1 = Symbol.for(
  "ushironoko.pi-hearth-tools.engine.v1",
);
const RETIRED_ENGINE_SLOT = Symbol.for(
  "ushironoko.pi-hearth-tools.retired-engines.v1",
);

interface GlobalWithEngine {
  [ENGINE_SLOT]?: HearthEngineRuntime;
  [LEGACY_ENGINE_SLOT_V2]?: unknown;
  [LEGACY_ENGINE_SLOT_V1]?: unknown;
  [RETIRED_ENGINE_SLOT]?: unknown[];
}

const retireLegacyEngines = (host: GlobalWithEngine): void => {
  let retired = host[RETIRED_ENGINE_SLOT];
  for (const legacy of [
    host[LEGACY_ENGINE_SLOT_V2],
    host[LEGACY_ENGINE_SLOT_V1],
  ]) {
    if (legacy === undefined) continue;
    retired ??= [];
    if (!retired.includes(legacy)) retired.push(legacy);
  }
  if (retired !== undefined) host[RETIRED_ENGINE_SLOT] = retired;
  delete host[LEGACY_ENGINE_SLOT_V2];
  delete host[LEGACY_ENGINE_SLOT_V1];
};

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
  // A live /reload must detach pre-graph and pre-gate slots before constructing
  // v3. Keep their native runtimes strongly reachable, though: dropping a warm
  // HearthEngine during extension reload can block native finalization and
  // prevent Pi from ever loading the new extension. Hearth has no async close
  // boundary, so an ordinary forward migration deliberately keeps at most the
  // two named legacy runtimes (including their caches, optimizer, and shells)
  // until the process restarts.
  retireLegacyEngines(host);
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
  delete host[LEGACY_ENGINE_SLOT_V2];
  delete host[LEGACY_ENGINE_SLOT_V1];
  delete host[RETIRED_ENGINE_SLOT];
};
