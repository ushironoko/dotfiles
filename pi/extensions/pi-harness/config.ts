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
import {
  DEFAULT_MAX_CONCURRENT_CHILDREN,
  isValidChildConcurrency,
} from "./features/child-runs/limits";

export const TOGGLEABLE_FEATURES = [
  "hook-bridge",
  "subagent",
  "workflow",
  "bit-task",
  "agent-memory",
  "statusline",
  "provider-log",
  "asuku-notify",
  "ask-user-question",
] as const;

export type ToggleableFeature = (typeof TOGGLEABLE_FEATURES)[number];

/** New toggles remain optional only for legacy/narrow test adapters. */
export type HarnessFeatures = Record<
  Exclude<ToggleableFeature, "agent-memory">,
  boolean
> &
  Partial<Record<"agent-memory", boolean>>;

const CHILD_ALLOWED_FEATURES: ReadonlySet<ToggleableFeature> = new Set([
  "hook-bridge",
  "agent-memory",
]);

const DEFAULT_TOGGLES: Record<ToggleableFeature, boolean> = {
  "hook-bridge": true,
  subagent: true,
  workflow: true,
  "bit-task": true,
  "agent-memory": true,
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
  confirmTimeoutMs: number;
  keepAlive: string;
  configurationError?: string;
}

export const DEFAULT_PERMISSION_JUDGE_CONFIG: Readonly<PermissionJudgeConfig> =
  {
    enabled: true,
    url: "http://127.0.0.1:11434/api/chat",
    model: "granite4.1:3b",
    expectedDigest:
      "6fd349357287c7ffc9e38189a93b48ea175d24fc566b38f09cfc564fb7f303eb",
    timeoutMs: 10_000,
    confirmTimeoutMs: 10_000,
    keepAlive: "30m",
  };

export interface ChildRunsConfig {
  maxConcurrent: number;
  configurationError?: string;
}

export const DEFAULT_CHILD_RUNS_CONFIG: Readonly<ChildRunsConfig> = {
  maxConcurrent: DEFAULT_MAX_CONCURRENT_CHILDREN,
};

export interface BashSandboxConfig {
  network: {
    allowedDomains: string[];
    deniedDomains: string[];
  };
  filesystem: {
    denyRead: string[];
    allowWrite: string[];
    denyWrite: string[];
  };
  configurationError?: string;
}

export const DEFAULT_BASH_SANDBOX_CONFIG: Readonly<BashSandboxConfig> = {
  network: {
    allowedDomains: ["api.github.com", "github.com"],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: [
      "~/.ssh",
      "~/.aws",
      "~/.gnupg",
      "~/.kube",
      "~/.config/gcloud",
      "~/.netrc",
      "~/.npmrc",
      "~/.pypirc",
    ],
    allowWrite: [],
    denyWrite: [
      "~/.pi/agent/settings.json",
      "~/.pi/agent/pi-harness.local.json",
      "~/.pi/agent/extensions",
      "~/.claude/settings.json",
      "~/.claude/settings.local.json",
      "~/.claude/hooks",
      "~/.codex/config.toml",
      "~/.codex/hooks",
    ],
  },
};

export interface HarnessConfig {
  isChild: boolean;
  /** Fully materialized by loadConfig; the new key is optional for narrow adapters. */
  features: HarnessFeatures;
  trust: TrustConfig;
  paths: HarnessPaths;
  /** Always materialized by loadConfig; optional for narrow test adapters. */
  permissionJudge?: PermissionJudgeConfig;
  /** Always materialized by loadConfig; optional for narrow test adapters. */
  bashSandbox?: BashSandboxConfig;
  /** Always materialized by loadConfig; optional for narrow test adapters. */
  childRuns?: ChildRunsConfig;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readLocalToggles = (
  localConfigFile: string,
): Partial<Record<ToggleableFeature, boolean>> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(localConfigFile, "utf8"));
    if (!isRecord(parsed)) return {};
    const { features } = parsed;
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
};

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
  const confirmTimeoutMs =
    value.confirmTimeoutMs === undefined
      ? DEFAULT_PERMISSION_JUDGE_CONFIG.confirmTimeoutMs
      : value.confirmTimeoutMs;
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
  if (
    typeof confirmTimeoutMs !== "number" ||
    !Number.isInteger(confirmTimeoutMs) ||
    confirmTimeoutMs < 1_000 ||
    confirmTimeoutMs > 300_000
  ) {
    errors.push("confirmTimeoutMs");
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
    confirmTimeoutMs:
      typeof confirmTimeoutMs === "number" &&
      Number.isInteger(confirmTimeoutMs) &&
      confirmTimeoutMs >= 1_000 &&
      confirmTimeoutMs <= 300_000
        ? confirmTimeoutMs
        : DEFAULT_PERMISSION_JUDGE_CONFIG.confirmTimeoutMs,
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

const readChildRunsConfig = (localConfigFile: string): ChildRunsConfig => {
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(localConfigFile, "utf8"));
    if (!isRecord(parsed)) {
      return {
        ...DEFAULT_CHILD_RUNS_CONFIG,
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
      return { ...DEFAULT_CHILD_RUNS_CONFIG };
    }
    return {
      ...DEFAULT_CHILD_RUNS_CONFIG,
      configurationError: "pi-harness.local.json could not be parsed",
    };
  }

  const value = root.childRuns;
  if (value === undefined) return { ...DEFAULT_CHILD_RUNS_CONFIG };
  if (!isRecord(value)) {
    return {
      ...DEFAULT_CHILD_RUNS_CONFIG,
      configurationError: "childRuns must contain an object",
    };
  }

  const maxConcurrent =
    value.maxConcurrent === undefined
      ? DEFAULT_CHILD_RUNS_CONFIG.maxConcurrent
      : value.maxConcurrent;
  if (!isValidChildConcurrency(maxConcurrent)) {
    return {
      ...DEFAULT_CHILD_RUNS_CONFIG,
      configurationError: "invalid childRuns fields: maxConcurrent",
    };
  }
  return { maxConcurrent };
};

const MAX_SANDBOX_LIST_ENTRIES = 256;
const MAX_SANDBOX_VALUE_BYTES = 4_096;
const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
const LINUX_GLOB_CHARACTER = /[*?[]/;

const cloneBashSandboxDefaults = (): BashSandboxConfig => ({
  network: {
    allowedDomains: [...DEFAULT_BASH_SANDBOX_CONFIG.network.allowedDomains],
    deniedDomains: [...DEFAULT_BASH_SANDBOX_CONFIG.network.deniedDomains],
  },
  filesystem: {
    denyRead: [...DEFAULT_BASH_SANDBOX_CONFIG.filesystem.denyRead],
    allowWrite: [...DEFAULT_BASH_SANDBOX_CONFIG.filesystem.allowWrite],
    denyWrite: [...DEFAULT_BASH_SANDBOX_CONFIG.filesystem.denyWrite],
  },
});

const validSandboxDomain = (value: string): boolean => {
  if (
    value.length === 0 ||
    value.length > 253 ||
    value.includes("://") ||
    value.includes("/") ||
    value.includes(":") ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  if (value === "localhost") return true;
  const domain = value.startsWith("*.") ? value.slice(2) : value;
  if (value.includes("*") && !value.startsWith("*.")) return false;
  const labels = domain.split(".");
  return (
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
    )
  );
};

const validSandboxPath = (value: string, platform: NodeJS.Platform): boolean =>
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= MAX_SANDBOX_VALUE_BYTES &&
  !hasControlCharacter(value) &&
  (value.startsWith("/") || value.startsWith("~/")) &&
  (platform !== "linux" || !LINUX_GLOB_CHARACTER.test(value));

const sandboxStringArray = (
  container: Record<string, unknown> | undefined,
  key: string,
  validate: (value: string) => boolean,
): string[] | undefined => {
  const value = container?.[key];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > MAX_SANDBOX_LIST_ENTRIES ||
    value.some((entry) => typeof entry !== "string" || !validate(entry))
  ) {
    return undefined;
  }
  return [...new Set(value)];
};

const readBashSandboxConfig = (
  localConfigFile: string,
  platform: NodeJS.Platform,
): BashSandboxConfig => {
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(localConfigFile, "utf8"));
    if (!isRecord(parsed)) {
      return {
        ...cloneBashSandboxDefaults(),
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
      return cloneBashSandboxDefaults();
    }
    return {
      ...cloneBashSandboxDefaults(),
      configurationError: "pi-harness.local.json could not be parsed",
    };
  }

  const value = root.bashSandbox;
  if (value === undefined) return cloneBashSandboxDefaults();
  if (!isRecord(value)) {
    return {
      ...cloneBashSandboxDefaults(),
      configurationError: "bashSandbox must contain an object",
    };
  }
  const network = isRecord(value.network) ? value.network : undefined;
  const filesystem = isRecord(value.filesystem) ? value.filesystem : undefined;
  const errors: string[] = [];
  if (value.network !== undefined && network === undefined) {
    errors.push("network");
  }
  if (value.filesystem !== undefined && filesystem === undefined) {
    errors.push("filesystem");
  }

  const allowedDomains = sandboxStringArray(
    network,
    "allowedDomains",
    validSandboxDomain,
  );
  const deniedDomains = sandboxStringArray(
    network,
    "deniedDomains",
    validSandboxDomain,
  );
  const validatePath = (path: string): boolean =>
    validSandboxPath(path, platform);
  const denyRead = sandboxStringArray(filesystem, "denyRead", validatePath);
  const allowWrite = sandboxStringArray(filesystem, "allowWrite", validatePath);
  const denyWrite = sandboxStringArray(filesystem, "denyWrite", validatePath);
  for (const [name, parsed] of [
    ["network.allowedDomains", allowedDomains],
    ["network.deniedDomains", deniedDomains],
    ["filesystem.denyRead", denyRead],
    ["filesystem.allowWrite", allowWrite],
    ["filesystem.denyWrite", denyWrite],
  ] as const) {
    if (parsed === undefined) errors.push(name);
  }

  const defaults = cloneBashSandboxDefaults();
  return {
    network: {
      allowedDomains: [
        ...new Set([
          ...defaults.network.allowedDomains,
          ...(allowedDomains ?? []),
        ]),
      ],
      deniedDomains: [
        ...new Set([
          ...defaults.network.deniedDomains,
          ...(deniedDomains ?? []),
        ]),
      ],
    },
    filesystem: {
      denyRead: [
        ...new Set([...defaults.filesystem.denyRead, ...(denyRead ?? [])]),
      ],
      allowWrite: [
        ...new Set([...defaults.filesystem.allowWrite, ...(allowWrite ?? [])]),
      ],
      denyWrite: [
        ...new Set([...defaults.filesystem.denyWrite, ...(denyWrite ?? [])]),
      ],
    },
    ...(errors.length === 0
      ? {}
      : {
          configurationError: `invalid bashSandbox fields: ${errors.join(", ")}`,
        }),
  };
};

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
  paths: HarnessPaths = resolvePaths(),
  platform: NodeJS.Platform = process.platform,
): HarnessConfig => {
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
    bashSandbox: readBashSandboxConfig(paths.localConfigFile, platform),
    childRuns: readChildRunsConfig(paths.localConfigFile),
  };
};
