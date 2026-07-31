import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashSandboxConfig } from "../../config";
import {
  discoverProjectContext,
  runGitCommonDir,
} from "../permission-policy/context";

export const BASH_SANDBOX_PROJECT_DISCOVERY_TIMEOUT_MS = 5_000;

export interface BashSandboxProfile {
  readonly cwd: string;
  readonly activeWorktree?: string;
  readonly writableRoots: readonly string[];
  readonly configuredWriteRoots: readonly string[];
  readonly scratchDirectory: string;
  readonly networkMode: "denied" | "allowlisted";
  readonly fingerprint: string;
  readonly runtimeConfig: SandboxRuntimeConfig;
}

interface BuildProfileOptions {
  readonly home?: string;
  readonly discoverProject?: typeof discoverProjectContext;
  readonly discoverGitCommonDir?: typeof runGitCommonDir;
  readonly canonicalize?: (path: string) => Promise<string>;
}

const expandHome = (path: string, home: string): string => {
  if (path === "~") return home;
  return path.startsWith("~/") ? resolve(home, path.slice(2)) : path;
};

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const canonicalizeWithMissingTail = async (
  path: string,
  canonicalize: (path: string) => Promise<string>,
): Promise<string> => {
  let current = resolve(path);
  const missingTail: string[] = [];
  while (true) {
    try {
      return resolve(await canonicalize(current), ...missingTail);
    } catch (error) {
      const { code } = error as NodeJS.ErrnoException;
      const parent = dirname(current);
      if ((code !== "ENOENT" && code !== "ENOTDIR") || parent === current) {
        throw error;
      }
      missingTail.unshift(basename(current));
      current = parent;
    }
  }
};

const profileFingerprint = (runtimeConfig: SandboxRuntimeConfig): string =>
  createHash("sha256")
    .update("pi-harness-bash-sandbox-v1")
    .update("\0")
    .update(JSON.stringify(runtimeConfig))
    .digest("hex");

export const withBashSandboxWritableRoots = (
  profile: BashSandboxProfile,
  writableRoots: readonly string[],
): BashSandboxProfile => {
  const nextWritableRoots = unique(writableRoots);
  const runtimeConfig: SandboxRuntimeConfig = {
    ...profile.runtimeConfig,
    filesystem: {
      ...profile.runtimeConfig.filesystem,
      allowWrite: nextWritableRoots,
    },
  };
  return {
    ...profile,
    writableRoots: nextWritableRoots,
    fingerprint: profileFingerprint(runtimeConfig),
    runtimeConfig,
  };
};

export const buildBashSandboxProfile = async (
  cwd: string,
  scratchDirectory: string,
  config: BashSandboxConfig,
  signal?: AbortSignal,
  options: BuildProfileOptions = {},
): Promise<BashSandboxProfile> => {
  if (config.configurationError !== undefined) {
    throw new Error(config.configurationError);
  }
  const canonicalize = options.canonicalize ?? realpath;
  const canonicalCwd = await canonicalize(cwd);
  const discover = options.discoverProject ?? discoverProjectContext;
  const project = await discover(
    canonicalCwd,
    { timeoutMs: BASH_SANDBOX_PROJECT_DISCOVERY_TIMEOUT_MS },
    signal,
  );
  if (project.kind === "unavailable") {
    throw new Error(`project boundary unavailable: ${project.reason}`);
  }

  const projectRoots =
    project.kind === "git" ? [project.activeWorktree] : [project.cwd];
  let gitCommonDir: string | undefined;
  if (project.kind === "git") {
    gitCommonDir = await (options.discoverGitCommonDir ?? runGitCommonDir)(
      project.cwd,
      signal,
      { timeoutMs: BASH_SANDBOX_PROJECT_DISCOVERY_TIMEOUT_MS },
    );
    if (gitCommonDir === undefined) {
      throw new Error("Git common directory unavailable");
    }
  }

  const home = options.home ?? homedir();
  const configuredWriteRoots = await Promise.all(
    config.filesystem.allowWrite.map((path) =>
      canonicalizeWithMissingTail(expandHome(path, home), canonicalize),
    ),
  );
  const writableRoots = unique([
    ...projectRoots,
    ...(gitCommonDir === undefined ? [] : [gitCommonDir]),
    scratchDirectory,
    ...configuredWriteRoots,
  ]);
  const denyRead = unique(
    config.filesystem.denyRead.map((path) => expandHome(path, home)),
  );
  const denyWrite = unique([
    ...config.filesystem.denyWrite.map((path) => expandHome(path, home)),
    ...(gitCommonDir === undefined
      ? []
      : [join(gitCommonDir, "config"), join(gitCommonDir, "hooks")]),
  ]);
  const runtimeConfig: SandboxRuntimeConfig = {
    network: {
      allowedDomains: [...config.network.allowedDomains],
      deniedDomains: [...config.network.deniedDomains],
      allowLocalBinding: false,
    },
    filesystem: {
      denyRead,
      allowWrite: writableRoots,
      denyWrite,
      allowGitConfig: false,
    },
    enableWeakerNestedSandbox: false,
    mandatoryDenySearchDepth: 5,
  };
  const fingerprint = profileFingerprint(runtimeConfig);

  return {
    cwd: canonicalCwd,
    ...(project.kind === "git"
      ? { activeWorktree: project.activeWorktree }
      : {}),
    writableRoots,
    configuredWriteRoots,
    scratchDirectory,
    networkMode:
      config.network.allowedDomains.length === 0 ? "denied" : "allowlisted",
    fingerprint,
    runtimeConfig,
  };
};
