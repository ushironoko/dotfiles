/**
 * Sanitize the environment handed to a child process (git / bit / bash hook /
 * child pi). The inherited environment (`process.env`) is repository-influenced
 * and must not be able to:
 *
 *  - steer git's own resolution so a verification self-satisfies — a spoofed
 *    `GIT_COMMON_DIR` / `GIT_DIR` makes a common-dir identity check trust the
 *    attacker's value. ALL `GIT_*` are scrubbed from the inherited base;
 *    the harness re-adds only the specific vars it sets itself (e.g. a verified
 *    `GIT_DIR`) via `overrides`, which are applied AFTER the scrub.
 *  - inject code into a child shell / dynamic loader — `BASH_FUNC_*` and
 *    function-valued exports (Shellshock), `BASH_ENV` / `ENV` / `SHELLOPTS`,
 *    `LD_PRELOAD` / `LD_*` / `DYLD_*`, `NODE_OPTIONS`, etc.
 *  - hijack a binary via `PATH` — empty and relative entries (which resolve
 *    against the child's cwd) and entries at/under the cwd are dropped, so a
 *    repository-planted `<cwd>/bin/git` cannot precede the real one.
 *
 * `overrides` are HARNESS-OWNED (literals or values the harness itself
 * computed/verified) — never pass repository-derived data through them. The
 * returned object is a COMPLETE env: pass it as the child's `env` so the child
 * does not inherit `process.env` implicitly.
 */
import { delimiter, isAbsolute, resolve, sep } from "node:path";

// Exact-match keys that are pure injection vectors (no legitimate need in the
// controlled commands the harness runs).
const DANGEROUS_ENV_EXACT: ReadonlySet<string> = new Set([
  // shell startup / option injection
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "IFS",
  "CDPATH",
  "GLOBIGNORE",
  // dynamic-loader injection (Linux + macOS)
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  // interpreter option injection
  "NODE_OPTIONS",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
]);

// A bash function exported into the environment has a value beginning with the
// function body sigil. Newer bash keys it as `BASH_FUNC_name%%`; older/other
// shells use `name()` with a `() {` value. Match on both the key prefix and the
// value shape so neither form survives.
const isFunctionExport = (key: string, value: string): boolean =>
  key.startsWith("BASH_FUNC_") ||
  value.startsWith("() {") ||
  value.startsWith("() (");

const isDangerousKey = (key: string, value: string): boolean => {
  if (DANGEROUS_ENV_EXACT.has(key)) return true;
  // Scrub the entire GIT_* namespace from the inherited base: rather than
  // enumerate every resolution/config/hook var, deny by default and let the
  // harness re-add the exact ones it owns through overrides.
  if (key.startsWith("GIT_")) return true;
  if (isFunctionExport(key, value)) return true;
  return false;
};

// Drop PATH entries that resolve against the child's cwd (empty / relative) or
// live at/under it, so a repository-planted binary cannot shadow a real one.
// Absolute entries outside the cwd subtree (system dirs, user bin dirs) survive.
const sanitizePath = (
  raw: string | undefined,
  cwd: string | undefined,
): string => {
  if (raw === undefined || raw === "") return "";
  const cwdCanon = cwd === undefined ? undefined : resolve(cwd);
  const kept = raw.split(delimiter).filter((entry) => {
    if (entry === "") return false; // empty entry == current directory
    if (!isAbsolute(entry)) return false; // relative == resolved against cwd
    if (cwdCanon !== undefined) {
      const canon = resolve(entry);
      if (canon === cwdCanon || canon.startsWith(`${cwdCanon}${sep}`)) {
        return false; // at/under the child's cwd
      }
    }
    return true;
  });
  return kept.join(delimiter);
};

export interface SanitizeChildEnvOptions {
  /** The child's cwd; PATH entries at/under it are dropped. */
  readonly cwd?: string;
}

export const sanitizeChildEnv = (
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined> = {},
  options: SanitizeChildEnvOptions = {},
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (isDangerousKey(key, value)) continue;
    out[key] = value;
  }
  // The inherited PATH is untrusted (an attacker can seed process.env), so drop
  // its empty/relative/cwd-subtree entries. An override PATH (below) is
  // harness-owned and applied verbatim, so this must run BEFORE overrides.
  if (out.PATH !== undefined) out.PATH = sanitizePath(out.PATH, options.cwd);
  // Harness-owned overrides are applied after scrubbing so an intentional value
  // (e.g. a verified GIT_DIR, or a vetted PATH that includes a cwd-local tool)
  // is not dropped. Never route repository-derived data through overrides.
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
};
