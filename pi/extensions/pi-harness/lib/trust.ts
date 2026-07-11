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
import { readFileSync, realpathSync } from "node:fs";
import { sep } from "node:path";

export interface TrustConfig {
  trustedRoots: string[];
}

export function parseTrustConfig(json: string): TrustConfig {
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
}

export function loadTrustConfig(localConfigFile: string): TrustConfig {
  try {
    return parseTrustConfig(readFileSync(localConfigFile, "utf8"));
  } catch {
    return { trustedRoots: [] };
  }
}

/**
 * Pure containment check on already-canonicalized paths.
 */
export function isPathWithin(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/**
 * Resolves symlinks on both sides before comparing so a symlinked cwd cannot
 * escape into (or fake membership of) a trusted root. Any resolution failure
 * is treated as untrusted.
 */
export function isTrustedRoot(cwd: string, config: TrustConfig): boolean {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return false;
  }
  for (const root of config.trustedRoots) {
    try {
      if (isPathWithin(realCwd, realpathSync(root))) return true;
    } catch {
      // Unresolvable root entries never grant trust.
    }
  }
  return false;
}
