/**
 * Runtime boundary check for a workflow task's explicit `cwd`. The plan
 * validator (plan.ts) is a pure structural check and cannot see the filesystem;
 * an explicit `cwd` is otherwise passed straight to the spawned child, so a cwd
 * outside the workflow root — or inside a NESTED, DISTINCT repository (e.g. a
 * vendored `.git` under the root path) — would escape the intended boundary.
 *
 * The check is layered so neither a symlink, forged `.git` pointer, nor nested
 * repo slips through:
 *  1. realpath canonicalization (symlinks resolved on both sides),
 *  2. containment in a canonical, registered non-bare `git worktree list`
 *     root, and
 *  3. same git repository identity (`--git-common-dir` realpath-equal), which
 *     distinguishes a monorepo subdirectory (same repo → allowed) from a nested
 *     distinct repository (different common-dir → rejected).
 * realpath canonicalization also folds case on a case-insensitive volume, so
 * `/Repo/sub` and `/repo` resolve to the same on-disk form before comparison.
 */
import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sanitizeChildEnv } from "./child-env";
import { isPathWithin } from "./trust";

export type CwdBoundaryResult =
  | { readonly ok: true; readonly canonicalCwd: string }
  | { readonly ok: false; readonly reason: string };

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

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
        let out = stdout;
        if (out.endsWith("\n")) out = out.slice(0, -1);
        if (out.endsWith("\r")) out = out.slice(0, -1);
        if (out === "" || !isAbsolute(out) || hasControlCharacter(out)) {
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

const MAX_WORKTREE_LIST_BYTES = 64 * 1_024;
const MAX_WORKTREE_COUNT = 128;
const MAX_WORKTREE_PATH_BYTES = 1_024;
const fatalUtf8 = new TextDecoder(undefined, { fatal: true, ignoreBOM: true });

interface WorktreeRecord {
  readonly path: string;
  readonly bare: boolean;
  readonly prunable: boolean;
}

const parseWorktreeRoots = async (
  stdout: Uint8Array,
): Promise<readonly string[] | undefined> => {
  if (stdout.byteLength === 0 || stdout.byteLength > MAX_WORKTREE_LIST_BYTES) {
    return undefined;
  }
  let text: string;
  try {
    text = fatalUtf8.decode(stdout);
  } catch {
    return undefined;
  }
  if (!text.endsWith("\0\0")) return undefined;

  const records: WorktreeRecord[] = [];
  let fields: string[] = [];
  const consume = (): boolean => {
    if (fields.length === 0) return true;
    const [first] = fields;
    if (first === undefined || !first.startsWith("worktree ")) return false;
    if (fields.filter((field) => field.startsWith("worktree ")).length !== 1) {
      return false;
    }
    const path = first.slice("worktree ".length);
    if (
      !isAbsolute(path) ||
      Buffer.byteLength(path, "utf8") > MAX_WORKTREE_PATH_BYTES ||
      hasControlCharacter(path)
    ) {
      return false;
    }
    const seenKinds = new Set<string>();
    for (const field of fields.slice(1)) {
      const kind = field.split(" ", 1)[0];
      if (
        kind === undefined ||
        !["HEAD", "branch", "detached", "bare", "locked", "prunable"].includes(
          kind,
        ) ||
        seenKinds.has(kind)
      ) {
        return false;
      }
      seenKinds.add(kind);
    }
    if (seenKinds.has("branch") && seenKinds.has("detached")) return false;
    records.push({
      path,
      bare: seenKinds.has("bare"),
      prunable: seenKinds.has("prunable"),
    });
    return records.length <= MAX_WORKTREE_COUNT;
  };

  for (const field of text.split("\0")) {
    if (field !== "") {
      fields.push(field);
      continue;
    }
    if (!consume()) return undefined;
    fields = [];
  }
  if (fields.length !== 0 || records.length === 0) return undefined;

  const lexical = new Set<string>();
  const canonical = new Set<string>();
  for (const record of records) {
    if (lexical.has(record.path)) return undefined;
    lexical.add(record.path);
    // A prunable administrative record is not a currently registered,
    // navigable worktree even when an attacker recreates its old path.
    if (record.bare || record.prunable) continue;
    let root: string;
    try {
      root = await realpath(record.path);
      if (!(await stat(root)).isDirectory()) return undefined;
    } catch {
      return undefined;
    }
    if (canonical.has(root)) return undefined;
    canonical.add(root);
  }
  return canonical.size === 0 ? undefined : [...canonical].sort();
};

export type GitWorktreeRootsFn = (
  cwd: string,
) => Promise<readonly string[] | undefined>;

export const gitWorktreeRoots: GitWorktreeRootsFn = (cwd) =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["worktree", "list", "--porcelain", "-z"],
      {
        cwd,
        encoding: "buffer",
        maxBuffer: MAX_WORKTREE_LIST_BYTES,
        timeout: 5_000,
        env: sanitizeChildEnv(
          process.env,
          { GIT_OPTIONAL_LOCKS: "0" },
          { cwd },
        ),
      },
      (error, stdout) => {
        if (error !== null) {
          resolve(undefined);
          return;
        }
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        void parseWorktreeRoots(bytes).then(resolve, () => resolve(undefined));
      },
    );
  });

export const validateSameGitRepository = async (
  candidateCwd: string,
  rootCwd: string,
  gitCommonDirFn: GitCommonDirFn = gitCommonDir,
  gitWorktreeRootsFn: GitWorktreeRootsFn = gitWorktreeRoots,
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

  const registeredRoots = await gitWorktreeRootsFn(realRoot);
  if (
    registeredRoots === undefined ||
    !registeredRoots.some((root) => isPathWithin(realRoot, root)) ||
    !registeredRoots.some((root) => isPathWithin(realCandidate, root))
  ) {
    return {
      ok: false,
      reason: "repository cwd is not inside a registered non-bare worktree",
    };
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

// Legacy callers share the registered-worktree + repository-identity boundary.
// Keep the descriptive alias for trusted leading `cd` tests and compatibility.
export const validateCwdInSameRepo = validateSameGitRepository;

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
