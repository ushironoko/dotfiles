import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const TEMPORARY_TTL_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10 * 1000;
const LOCK_RETRY_MS = 10;
const LOCK_NAME = ".snapshot.lock";
const LOCK_OWNER_NAME = "owner";
const LOCK_OWNER_PATTERN = /^(\d+):([0-9a-f-]+)$/;
const SNAPSHOT_NAME = /^[a-f0-9]{64}\.md$/;
const TEMPORARY_NAME = /^\.[a-f0-9]{64}\.\d+\.[0-9a-f-]+\.tmp$/;
const PROMPT_SAFE_SNAPSHOT_PATH = /^[A-Za-z0-9/._-]+$/;

const promptSafeSnapshotPath = (path: string): string => {
  if (!isAbsolute(path) || !PROMPT_SAFE_SNAPSHOT_PATH.test(path)) {
    throw new Error(
      "snapshot path contains characters that are unsafe for direct read transport",
    );
  }
  return path;
};

const encodePlanPath = (path: string): string => {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("plan path must be a non-NUL absolute path");
  }
  return Buffer.from(path, "utf8").toString("base64");
};

const gitOutput = (args: string[], cwd: string): string | undefined => {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const output = result.stdout.toString();
  const record = output.endsWith("\n") ? output.slice(0, -1) : output;
  return record === "" ? undefined : record;
};

const mainWorktreeRoot = (cwd: string): string | undefined => {
  const result = Bun.spawnSync({
    cmd: ["git", "worktree", "list", "--porcelain", "-z"],
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) return undefined;
  const prefix = "worktree ";
  const firstWorktreeField = result.stdout
    .toString()
    .split("\0")
    .find((field) => field.startsWith(prefix));
  return firstWorktreeField?.slice(prefix.length);
};

const repositoryRoots = (cwd: string): string[] => {
  const worktreeRoot = gitOutput(["rev-parse", "--show-toplevel"], cwd);
  const roots = new Set([resolve(worktreeRoot ?? cwd)]);
  const mainRoot = mainWorktreeRoot(cwd);
  if (mainRoot !== undefined) roots.add(resolve(mainRoot));
  return [...roots];
};

const findLatestPlanPath = (cwd = process.cwd()): string => {
  const candidates = repositoryRoots(cwd).flatMap((root) => {
    const plans = join(root, "plans");
    let names: string[];
    try {
      const plansStat = lstatSync(plans);
      if (plansStat.isSymbolicLink() || !plansStat.isDirectory()) return [];
      realpathSync(plans);
      names = readdirSync(plans);
    } catch {
      return [];
    }
    return names.flatMap((name) => {
      if (!name.endsWith(".md")) return [];
      const path = join(plans, name);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) return [];
        return [{ path, modifiedAt: stat.mtimeMs }];
      } catch {
        return [];
      }
    });
  });
  candidates.sort(
    (left, right) =>
      right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path),
  );
  const latest = candidates[0]?.path;
  if (latest === undefined) throw new Error("no plans/*.md file found");
  return latest;
};

const secureSnapshotRoot = (): string => {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const requestedRoot = join(tmpdir(), `dotfiles-plan-review-snapshots-${uid}`);
  try {
    mkdirSync(requestedRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const requestedStat = lstatSync(requestedRoot);
  if (
    requestedStat.isSymbolicLink() ||
    !requestedStat.isDirectory() ||
    (typeof process.getuid === "function" &&
      requestedStat.uid !== process.getuid())
  ) {
    throw new Error(
      "Plan snapshot root must be an owned, non-symlink directory",
    );
  }
  chmodSync(requestedRoot, 0o700);
  const root = realpathSync(requestedRoot);
  const resolvedStat = lstatSync(root);
  if (resolvedStat.isSymbolicLink() || !resolvedStat.isDirectory()) {
    throw new Error("resolved Plan snapshot root is not a directory");
  }
  return root;
};

const readPlanSource = (sourcePath: string): Buffer => {
  const descriptor = openSync(
    sourcePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    if (!fstatSync(descriptor).isFile()) {
      throw new Error("Plan source is not a regular file");
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const verifySnapshot = (path: string, content: Buffer): void => {
  const stat = lstatSync(path);
  const existing =
    stat.isFile() && !stat.isSymbolicLink() && readFileSync(path);
  if (existing === false || !existing.equals(content)) {
    throw new Error("existing Plan snapshot does not match its digest");
  }
};

const sleepSync = (milliseconds: number): void => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readLockOwner = (lockPath: string): string | undefined => {
  try {
    const ownerPath = join(lockPath, LOCK_OWNER_NAME);
    const stat = lstatSync(ownerPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return undefined;
    const owner = readFileSync(ownerPath, "utf8");
    return LOCK_OWNER_PATTERN.test(owner) ? owner : undefined;
  } catch {
    return undefined;
  }
};

const removeLockDirectory = (lockPath: string, expectedOwner: string): void => {
  if (readLockOwner(lockPath) !== expectedOwner) return;
  const releasedPath = `${lockPath}.released.${process.pid}.${randomUUID()}`;
  try {
    renameSync(lockPath, releasedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  unlinkSync(join(releasedPath, LOCK_OWNER_NAME));
  rmdirSync(releasedPath);
};

const staleLockOwnerIsLive = (lockPath: string): boolean => {
  const owner = readLockOwner(lockPath);
  if (owner === undefined) return false;
  const match = LOCK_OWNER_PATTERN.exec(owner);
  return match !== null && processIsAlive(Number(match[1]));
};

const recoverStaleLock = (root: string, lockPath: string): void => {
  const stalePath = join(
    root,
    `.snapshot.lock.stale.${process.pid}.${randomUUID()}`,
  );
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const owner = readLockOwner(stalePath);
  if (owner === undefined) {
    // Unknown contents are not recursively removed. Keep the tombstone and
    // fail closed instead of following or deleting attacker-controlled paths.
    throw new Error("stale Plan snapshot lock has no valid owner");
  }
  unlinkSync(join(stalePath, LOCK_OWNER_NAME));
  rmdirSync(stalePath);
};

const withSnapshotLock = <T>(root: string, action: () => T): T => {
  const lockPath = join(root, LOCK_NAME);
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      try {
        writeFileSync(join(lockPath, LOCK_OWNER_NAME), owner, {
          flag: "wx",
          mode: 0o400,
        });
      } catch (error) {
        try {
          rmdirSync(lockPath);
        } catch {
          // Preserve the owner-publication failure.
        }
        throw error;
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) {
        throw new Error("Plan snapshot lock must be an owned directory");
      }
      if (
        Date.now() - stat.mtimeMs > LOCK_STALE_MS &&
        !staleLockOwnerIsLive(lockPath)
      ) {
        recoverStaleLock(root, lockPath);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error("timed out acquiring Plan snapshot lock");
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return action();
  } finally {
    removeLockDirectory(lockPath, owner);
  }
};

const cleanupExpiredSnapshots = (root: string, now = Date.now()): void => {
  for (const name of readdirSync(root)) {
    let ttl: number | undefined;
    if (SNAPSHOT_NAME.test(name)) ttl = SNAPSHOT_TTL_MS;
    else if (TEMPORARY_NAME.test(name)) ttl = TEMPORARY_TTL_MS;
    if (ttl === undefined) continue;
    const path = join(root, name);
    try {
      const stat = lstatSync(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        now - stat.mtimeMs <= ttl
      ) {
        continue;
      }
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
};

const createPlanSnapshot = (
  sourcePath: string,
): { path: string; sha256: string } => {
  const content = readPlanSource(sourcePath);
  const sha256 = new Bun.CryptoHasher("sha256")
    .update(sourcePath)
    .update("\0")
    .update(content)
    .digest("hex");
  const root = secureSnapshotRoot();
  return withSnapshotLock(root, () => {
    cleanupExpiredSnapshots(root);
    const path = join(root, `${sha256}.md`);
    const temporaryPath = join(
      root,
      `.${sha256}.${process.pid}.${randomUUID()}.tmp`,
    );
    try {
      writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o400 });
      chmodSync(temporaryPath, 0o400);
      try {
        linkSync(temporaryPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      verifySnapshot(path, content);
      chmodSync(path, 0o400);
      // Refresh the reusable content-addressed lease while holding the global
      // snapshot lock so another helper cannot garbage-collect this path
      // between verification and renewal.
      const now = new Date();
      utimesSync(path, now, now);
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the publication error; stale hidden temp files are never read.
      }
      throw error;
    }
    unlinkSync(temporaryPath);
    return { path, sha256 };
  });
};

const main = (): void => {
  if (Bun.argv.length !== 2) {
    throw new Error("usage: encode-plan-path.ts");
  }
  const sourcePath = findLatestPlanPath();
  const snapshot = createPlanSnapshot(sourcePath);
  const path = promptSafeSnapshotPath(snapshot.path);
  process.stdout.write(
    JSON.stringify({
      sourcePath,
      path,
      pathBase64: encodePlanPath(path),
      sha256: snapshot.sha256,
    }),
  );
};

if (import.meta.main) main();

export {
  cleanupExpiredSnapshots,
  createPlanSnapshot,
  encodePlanPath,
  SNAPSHOT_TTL_MS,
  findLatestPlanPath,
  promptSafeSnapshotPath,
};
