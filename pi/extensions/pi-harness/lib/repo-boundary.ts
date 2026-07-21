/**
 * Runtime boundary check for a workflow task's explicit `cwd`. The plan
 * validator (plan.ts) is a pure structural check and cannot see the filesystem;
 * an explicit `cwd` is otherwise passed straight to the spawned child, so a cwd
 * outside the workflow root — or inside a NESTED, DISTINCT repository (e.g. a
 * vendored `.git` under the root path) — would escape the intended boundary.
 *
 * The check is two-layered so neither a symlink nor a nested repo slips through:
 *  1. realpath containment (symlinks resolved on both sides), and
 *  2. same git repository identity (`--git-common-dir` realpath-equal), which
 *     distinguishes a monorepo subdirectory (same repo → allowed) from a nested
 *     distinct repository (different common-dir → rejected).
 * realpath canonicalization also folds case on a case-insensitive volume, so
 * `/Repo/sub` and `/repo` resolve to the same on-disk form before comparison.
 */
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { sanitizeChildEnv } from "./child-env";
import { isPathWithin } from "./trust";

export type CwdBoundaryResult =
  | { readonly ok: true; readonly canonicalCwd: string }
  | { readonly ok: false; readonly reason: string };

// Absolute, realpath'd git common-dir of `cwd`, or undefined when `cwd` is not
// in a git repository / git is unavailable. The env is sanitized so an inherited
// GIT_COMMON_DIR cannot make this self-satisfy.
export const gitCommonDir = (cwd: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, timeout: 5_000, env: sanitizeChildEnv(process.env, {}, { cwd }) },
      (error, stdout) => {
        if (error !== null || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        const out = stdout.trim();
        if (out === "") {
          resolve(undefined);
          return;
        }
        realpath(out).then(
          (canonical) => resolve(canonical),
          () => resolve(undefined),
        );
      },
    );
  });

export type GitCommonDirFn = (cwd: string) => Promise<string | undefined>;

export const validateSameGitRepository = async (
  candidateCwd: string,
  rootCwd: string,
  gitCommonDirFn: GitCommonDirFn = gitCommonDir,
): Promise<CwdBoundaryResult> => {
  let realCandidate: string;
  let realRoot: string;
  try {
    [realCandidate, realRoot] = await Promise.all([
      realpath(candidateCwd),
      realpath(rootCwd),
    ]);
    const [candidateStats, rootStats] = await Promise.all([
      stat(realCandidate),
      stat(realRoot),
    ]);
    if (!candidateStats.isDirectory() || !rootStats.isDirectory()) {
      return { ok: false, reason: "repository cwd is not a directory" };
    }
  } catch {
    return { ok: false, reason: "repository cwd does not resolve" };
  }

  const [candidateCommon, rootCommon] = await Promise.all([
    gitCommonDirFn(realCandidate),
    gitCommonDirFn(realRoot),
  ]);
  if (candidateCommon === undefined || rootCommon === undefined) {
    return { ok: false, reason: "repository identity could not be resolved" };
  }
  if (candidateCommon !== rootCommon) {
    return {
      ok: false,
      reason: `cwd ${candidateCwd} belongs to a different git repository than ${rootCwd}`,
    };
  }
  return { ok: true, canonicalCwd: realCandidate };
};

export const validateCwdWithinRepo = async (
  candidateCwd: string,
  rootCwd: string,
  gitCommonDirFn: GitCommonDirFn = gitCommonDir,
): Promise<CwdBoundaryResult> => {
  let realCandidate: string;
  try {
    realCandidate = await realpath(candidateCwd);
  } catch {
    return { ok: false, reason: `cwd does not resolve: ${candidateCwd}` };
  }
  try {
    if (!(await stat(realCandidate)).isDirectory()) {
      return { ok: false, reason: `cwd is not a directory: ${candidateCwd}` };
    }
  } catch {
    return { ok: false, reason: `cwd does not resolve: ${candidateCwd}` };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(rootCwd);
    if (!(await stat(realRoot)).isDirectory()) {
      return {
        ok: false,
        reason: `workflow root is not a directory: ${rootCwd}`,
      };
    }
  } catch {
    return { ok: false, reason: `workflow root does not resolve: ${rootCwd}` };
  }

  if (!isPathWithin(realCandidate, realRoot)) {
    return {
      ok: false,
      reason: `cwd ${candidateCwd} is outside the workflow root ${rootCwd}`,
    };
  }

  const [candidateCommon, rootCommon] = await Promise.all([
    gitCommonDirFn(realCandidate),
    gitCommonDirFn(realRoot),
  ]);

  // If the root is not a git repository, containment (above) is the only
  // boundary available and has already passed.
  if (rootCommon === undefined) {
    return { ok: true, canonicalCwd: realCandidate };
  }

  if (candidateCommon === undefined) {
    return {
      ok: false,
      reason: `cwd ${candidateCwd} is not in a git repository`,
    };
  }
  if (candidateCommon !== rootCommon) {
    return {
      ok: false,
      reason: `cwd ${candidateCwd} belongs to a different git repository than the workflow root (nested-repo boundary)`,
    };
  }
  return { ok: true, canonicalCwd: realCandidate };
};
