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
};

export interface HarnessConfig {
  isChild: boolean;
  features: Record<ToggleableFeature, boolean>;
  trust: TrustConfig;
  paths: HarnessPaths;
}

function readLocalToggles(
  localConfigFile: string,
): Partial<Record<ToggleableFeature, boolean>> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(localConfigFile, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    const features = (parsed as Record<string, unknown>).features;
    if (!features || typeof features !== "object" || Array.isArray(features))
      return {};
    const overrides: Partial<Record<ToggleableFeature, boolean>> = {};
    for (const name of TOGGLEABLE_FEATURES) {
      const value = (features as Record<string, unknown>)[name];
      if (typeof value === "boolean") overrides[name] = value;
    }
    return overrides;
  } catch {
    return {};
  }
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  paths: HarnessPaths = resolvePaths(),
): HarnessConfig {
  const isChild = env.PI_HARNESS_CHILD === "1";
  const overrides = readLocalToggles(paths.localConfigFile);

  const features = {} as Record<ToggleableFeature, boolean>;
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
  };
}
