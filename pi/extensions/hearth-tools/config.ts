import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_TIMEOUT_MS } from "./constants";

const MIN_CACHED_FILES = 1;
const MAX_CACHED_FILES = 1_000_000;
const MIN_TIMEOUT_MS = 1;

export interface HearthToolsConfig {
  trustCache: boolean;
  warmShell: boolean;
  enableOptimizer: boolean;
  maxCachedFiles?: number;
  bashTimeoutMs: number;
}

export const DEFAULT_HEARTH_TOOLS_CONFIG: Readonly<HearthToolsConfig> = {
  trustCache: true,
  warmShell: true,
  enableOptimizer: true,
  bashTimeoutMs: MAX_TIMEOUT_MS,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const optionalBoolean = (
  value: unknown,
  name: string,
  fallback: boolean,
): boolean => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
};

const boundedInteger = (
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback?: number,
): number | undefined => {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
};

const CONFIG_KEYS = new Set([
  "trustCache",
  "warmShell",
  "enableOptimizer",
  "maxCachedFiles",
  "bashTimeoutMs",
]);

export const parseHearthToolsConfig = (value: unknown): HearthToolsConfig => {
  if (!isRecord(value))
    throw new Error("hearth-tools config must be an object");
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key))
      throw new Error(`unknown hearth-tools config key: ${key}`);
  }
  const maxCachedFiles = boundedInteger(
    value.maxCachedFiles,
    "maxCachedFiles",
    MIN_CACHED_FILES,
    MAX_CACHED_FILES,
  );
  return {
    trustCache: optionalBoolean(
      value.trustCache,
      "trustCache",
      DEFAULT_HEARTH_TOOLS_CONFIG.trustCache,
    ),
    warmShell: optionalBoolean(
      value.warmShell,
      "warmShell",
      DEFAULT_HEARTH_TOOLS_CONFIG.warmShell,
    ),
    enableOptimizer: optionalBoolean(
      value.enableOptimizer,
      "enableOptimizer",
      DEFAULT_HEARTH_TOOLS_CONFIG.enableOptimizer,
    ),
    ...(maxCachedFiles === undefined ? {} : { maxCachedFiles }),
    bashTimeoutMs:
      boundedInteger(
        value.bashTimeoutMs,
        "bashTimeoutMs",
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
        DEFAULT_HEARTH_TOOLS_CONFIG.bashTimeoutMs,
      ) ?? DEFAULT_HEARTH_TOOLS_CONFIG.bashTimeoutMs,
  };
};

export const loadHearthToolsConfig = (agentDir: string): HearthToolsConfig => {
  const path = join(agentDir, "hearth-tools.local.json");
  try {
    return parseHearthToolsConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    if (isRecord(error) && "code" in error && error.code === "ENOENT") {
      return { ...DEFAULT_HEARTH_TOOLS_CONFIG };
    }
    throw new Error("invalid hearth-tools.local.json", { cause: error });
  }
};
