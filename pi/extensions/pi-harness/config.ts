/**
 * Feature toggles and profile resolution for the pi-harness umbrella
 * extension.
 *
 * - permission-policy is deliberately NOT toggleable (S3: the safety floor).
 * - Child pi processes (spawned by subagent/workflow with PI_HARNESS_CHILD=1)
 *   keep only the safety layer; everything else is disabled to prevent
 *   recursion, duplicated notifications, and shared-log races (Phase 0, V11:
 *   child pi reloads global extensions).
 * - provider-log defaults to OFF (explicit opt-in; it records request
 *   metadata).
 */
import { readFileSync } from "node:fs";
import { loadTrustConfig, type TrustConfig } from "./lib/trust";
import { resolvePaths, type HarnessPaths } from "./lib/paths";

export const TOGGLEABLE_FEATURES = [
  "hook-bridge",
  "subagent",
  "workflow",
  "bit-task",
  "statusline",
  "provider-log",
  "asuku-notify",
  "ask-user-question",
] as const;

export type ToggleableFeature = (typeof TOGGLEABLE_FEATURES)[number];

const CHILD_ALLOWED_FEATURES: ReadonlySet<ToggleableFeature> = new Set([
  "hook-bridge",
]);

const DEFAULT_TOGGLES: Record<ToggleableFeature, boolean> = {
  "hook-bridge": true,
  subagent: true,
  workflow: true,
  "bit-task": true,
  statusline: true,
  "provider-log": false,
  "asuku-notify": true,
  "ask-user-question": true,
};

export interface PermissionJudgeConfig {
  enabled: boolean;
  url: string;
  model: string;
  expectedDigest: string;
  timeoutMs: number;
  keepAlive: string;
  configurationError?: string;
}

export const DEFAULT_PERMISSION_JUDGE_CONFIG: Readonly<PermissionJudgeConfig> =
  {
    enabled: true,
    url: "http://127.0.0.1:11434/api/chat",
    model: "qwen2.5:latest",
    expectedDigest:
      "845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e",
    timeoutMs: 10_000,
    keepAlive: "30m",
  };

export interface HarnessConfig {
  isChild: boolean;
  features: Record<ToggleableFeature, boolean>;
  trust: TrustConfig;
  paths: HarnessPaths;
  /** Always materialized by loadConfig; optional for narrow test adapters. */
  permissionJudge?: PermissionJudgeConfig;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function readLocalToggles(
  localConfigFile: string,
): Partial<Record<ToggleableFeature, boolean>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(localConfigFile, "utf8"));
    if (!isRecord(parsed)) return {};
    const features = parsed.features;
    if (!isRecord(features)) return {};
    const overrides: Partial<Record<ToggleableFeature, boolean>> = {};
    for (const name of TOGGLEABLE_FEATURES) {
      const value = features[name];
      if (typeof value === "boolean") overrides[name] = value;
    }
    return overrides;
  } catch {
    return {};
  }
}

const validJudgeUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
      url.pathname === "/api/chat" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

const validModel = (value: string): boolean =>
  value.length > 0 &&
  value.length <= 128 &&
  /^[A-Za-z0-9._/-]+:[A-Za-z0-9._-]+$/.test(value) &&
  !value.toLowerCase().includes("cloud");

const validDigest = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

const validKeepAlive = (value: string): boolean => {
  const match = /^(\d{1,4})(ms|s|m|h)$/.exec(value);
  if (match === null) return false;
  const amount = Number(match[1]);
  if (amount < 1) return false;
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[
    match[2] as "ms" | "s" | "m" | "h"
  ];
  const durationMs = amount * multiplier;
  return durationMs >= 1_000 && durationMs <= 86_400_000;
};

const readPermissionJudgeConfig = (
  localConfigFile: string,
): PermissionJudgeConfig => {
  let root: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(localConfigFile, "utf8"));
    if (!isRecord(parsed)) {
      return {
        ...DEFAULT_PERMISSION_JUDGE_CONFIG,
        configurationError: "pi-harness.local.json must contain an object",
      };
    }
    root = parsed;
  } catch (error) {
    if (
      isRecord(error) &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return { ...DEFAULT_PERMISSION_JUDGE_CONFIG };
    }
    return {
      ...DEFAULT_PERMISSION_JUDGE_CONFIG,
      configurationError: "pi-harness.local.json could not be parsed",
    };
  }

  const value = root.permissionJudge;
  if (value === undefined) return { ...DEFAULT_PERMISSION_JUDGE_CONFIG };
  if (!isRecord(value)) {
    return {
      ...DEFAULT_PERMISSION_JUDGE_CONFIG,
      configurationError: "permissionJudge must contain an object",
    };
  }

  const errors: string[] = [];
  // Only an omitted field inherits its default. JSON null is an explicit,
  // invalid value and must make the judge unavailable rather than silently
  // enabling or reconfiguring it.
  const enabled =
    value.enabled === undefined
      ? DEFAULT_PERMISSION_JUDGE_CONFIG.enabled
      : value.enabled;
  const url =
    value.url === undefined ? DEFAULT_PERMISSION_JUDGE_CONFIG.url : value.url;
  const model =
    value.model === undefined
      ? DEFAULT_PERMISSION_JUDGE_CONFIG.model
      : value.model;
  const expectedDigest =
    value.expectedDigest === undefined
      ? DEFAULT_PERMISSION_JUDGE_CONFIG.expectedDigest
      : value.expectedDigest;
  const timeoutMs =
    value.timeoutMs === undefined
      ? DEFAULT_PERMISSION_JUDGE_CONFIG.timeoutMs
      : value.timeoutMs;
  const keepAlive =
    value.keepAlive === undefined
      ? DEFAULT_PERMISSION_JUDGE_CONFIG.keepAlive
      : value.keepAlive;

  if (typeof enabled !== "boolean") errors.push("enabled");
  if (typeof url !== "string" || !validJudgeUrl(url)) errors.push("url");
  if (typeof model !== "string" || !validModel(model)) errors.push("model");
  if (typeof expectedDigest !== "string" || !validDigest(expectedDigest)) {
    errors.push("expectedDigest");
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 10_000
  ) {
    errors.push("timeoutMs");
  }
  if (typeof keepAlive !== "string" || !validKeepAlive(keepAlive)) {
    errors.push("keepAlive");
  }

  return {
    enabled:
      typeof enabled === "boolean"
        ? enabled
        : DEFAULT_PERMISSION_JUDGE_CONFIG.enabled,
    url:
      typeof url === "string" && validJudgeUrl(url)
        ? url
        : DEFAULT_PERMISSION_JUDGE_CONFIG.url,
    model:
      typeof model === "string" && validModel(model)
        ? model
        : DEFAULT_PERMISSION_JUDGE_CONFIG.model,
    expectedDigest:
      typeof expectedDigest === "string" && validDigest(expectedDigest)
        ? expectedDigest
        : DEFAULT_PERMISSION_JUDGE_CONFIG.expectedDigest,
    timeoutMs:
      typeof timeoutMs === "number" &&
      Number.isInteger(timeoutMs) &&
      timeoutMs >= 100 &&
      timeoutMs <= 10_000
        ? timeoutMs
        : DEFAULT_PERMISSION_JUDGE_CONFIG.timeoutMs,
    keepAlive:
      typeof keepAlive === "string" && validKeepAlive(keepAlive)
        ? keepAlive
        : DEFAULT_PERMISSION_JUDGE_CONFIG.keepAlive,
    ...(errors.length === 0
      ? {}
      : {
          configurationError: `invalid permissionJudge fields: ${errors.join(", ")}`,
        }),
  };
};

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  paths: HarnessPaths = resolvePaths(),
): HarnessConfig {
  const isChild = env.PI_HARNESS_CHILD === "1";
  const overrides = readLocalToggles(paths.localConfigFile);

  const features: Record<ToggleableFeature, boolean> = { ...DEFAULT_TOGGLES };
  for (const name of TOGGLEABLE_FEATURES) {
    const enabled = overrides[name] ?? DEFAULT_TOGGLES[name];
    features[name] = isChild
      ? enabled && CHILD_ALLOWED_FEATURES.has(name)
      : enabled;
  }

  return {
    isChild,
    features,
    trust: loadTrustConfig(paths.localConfigFile),
    paths,
    permissionJudge: readPermissionJudgeConfig(paths.localConfigFile),
  };
}
