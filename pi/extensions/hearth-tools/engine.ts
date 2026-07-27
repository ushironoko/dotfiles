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

interface EngineSlot {
  engine: HearthEngine;
  options: EngineOptions;
}

const ENGINE_SLOT = Symbol.for("ushironoko.pi-hearth-tools.engine.v1");

type GlobalWithEngine = typeof globalThis & {
  [ENGINE_SLOT]?: EngineSlot;
};

export const getOrCreateEngine = (
  module: HearthModule,
  cwd: string,
  config: HearthToolsConfig,
  shell: ShellSpec,
): HearthEngine => {
  const host = globalThis as GlobalWithEngine;
  if (host[ENGINE_SLOT] !== undefined) return host[ENGINE_SLOT].engine;

  const options: EngineOptions = {
    cwd,
    trustCache: config.trustCache,
    warmShell: config.warmShell,
    enableOptimizer: config.enableOptimizer,
    bashTimeoutMs: config.bashTimeoutMs,
    shell,
    ...(config.maxCachedFiles === undefined
      ? {}
      : { maxCachedFiles: config.maxCachedFiles }),
  };
  const engine = new module.HearthEngine(options);
  host[ENGINE_SLOT] = { engine, options };
  return engine;
};

export const clearProcessEngineForTests = (): void => {
  delete (globalThis as GlobalWithEngine)[ENGINE_SLOT];
};
