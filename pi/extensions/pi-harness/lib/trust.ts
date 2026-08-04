/**
 * Fail-closed trusted-root gate (S2 in the plan).
 *
 * pi's own project trust only protects loading project-local resources; it
 * does not cover commands this global extension spawns itself (verified in
 * Phase 0, V12). Any feature that executes repository-defined commands
 * (format via coding_cycle, lint/typecheck/test via statusline) must pass
 * this gate first. Unknown roots, unreadable config, and symlink escapes all
 * resolve to "not trusted" — features then skip silently.
 */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { updateLocalConfig } from "./local-config";

export interface TrustConfig {
  trustedRoots: string[];
}

export const parseTrustConfig = (json: string): TrustConfig => {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { trustedRoots: [] };
    }
    const roots = (parsed as Record<string, unknown>).trustedRoots;
    if (!Array.isArray(roots)) return { trustedRoots: [] };
    return {
      trustedRoots: roots.filter(
        (root): root is string => typeof root === "string",
      ),
    };
  } catch {
    return { trustedRoots: [] };
  }
};

export const loadTrustConfig = (localConfigFile: string): TrustConfig => {
  try {
    return parseTrustConfig(readFileSync(localConfigFile, "utf8"));
  } catch {
    return { trustedRoots: [] };
  }
};

/**
 * Atomically adds one canonical path to the machine-local trust config while
 * preserving unrelated keys and the existing file mode. The returned config
 * is suitable for replacing the active in-memory trust snapshot.
 */
export const appendTrustedRoot = (
  configFile: string,
  requestedRoot: string,
): TrustConfig => {
  const canonicalRoot = realpathSync(requestedRoot);
  return updateLocalConfig(configFile, (root) => {
    const existing = root.trustedRoots;
    if (
      existing !== undefined &&
      (!Array.isArray(existing) ||
        existing.some((value) => typeof value !== "string"))
    ) {
      throw new Error("trustedRoots must be an array of strings");
    }
    const trustedRoots = existing === undefined ? [] : [...existing];
    if (trustedRoots[0] === canonicalRoot) {
      return { changed: false, value: { trustedRoots } };
    }
    const prioritizedRoots = [
      canonicalRoot,
      ...trustedRoots.filter((value) => value !== canonicalRoot),
    ];
    root.trustedRoots = prioritizedRoots;
    return { changed: true, value: { trustedRoots: prioritizedRoots } };
  });
};

/**
 * Pure containment check on already-canonicalized paths.
 */
export const isPathWithin = (candidate: string, root: string): boolean => {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
};

type GitBoundary = string | null | undefined;

const isMissingPath = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * Returns the nearest canonical directory containing a real .git file or
 * directory. null means no repository marker; undefined means fail closed.
 */
const nearestGitBoundary = (candidate: string): GitBoundary => {
  let cursor: string;
  try {
    cursor = statSync(candidate).isDirectory() ? candidate : dirname(candidate);
  } catch {
    return undefined;
  }

  while (true) {
    try {
      const marker = lstatSync(join(cursor, ".git"));
      return marker.isFile() || marker.isDirectory() ? cursor : undefined;
    } catch (error) {
      if (!isMissingPath(error)) return undefined;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
};

/**
 * Returns the CANONICAL trusted root that contains `cwd` (symlinks resolved on
 * both sides), or undefined when `cwd` is not within any trusted root. A Git
 * checkout grants containment trust only inside the same nearest .git boundary;
 * a non-Git container may still grant trust to repositories below it. Callers
 * that spawn repository-defined commands pass this canonical root down as a
 * boundary so a shell-side project-root re-discovery cannot ascend past it into
 * an untrusted parent (statusline TOCTOU fix). Any resolution failure is
 * treated as untrusted.
 */
export const matchedTrustedRoot = (
  cwd: string,
  config: TrustConfig,
): string | undefined => {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return undefined;
  }
  const candidateBoundary = nearestGitBoundary(realCwd);
  if (candidateBoundary === undefined) return undefined;

  for (const root of config.trustedRoots) {
    try {
      const realRoot = realpathSync(root);
      if (!isPathWithin(realCwd, realRoot)) continue;
      const rootBoundary = nearestGitBoundary(realRoot);
      if (
        rootBoundary !== undefined &&
        (rootBoundary === null || rootBoundary === candidateBoundary)
      ) {
        return realRoot;
      }
    } catch {
      // Unresolvable root entries never grant trust.
    }
  }
  return undefined;
};

/**
 * Resolves symlinks on both sides before comparing so a symlinked cwd cannot
 * escape into (or fake membership of) a trusted root. Any resolution failure
 * is treated as untrusted.
 */
export const isTrustedRoot = (cwd: string, config: TrustConfig): boolean =>
  matchedTrustedRoot(cwd, config) !== undefined;
