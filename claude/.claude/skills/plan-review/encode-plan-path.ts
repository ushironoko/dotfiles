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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
};

const main = (): void => {
  if (Bun.argv.length !== 2) {
    throw new Error("usage: encode-plan-path.ts");
  }
  const sourcePath = findLatestPlanPath();
  const snapshot = createPlanSnapshot(sourcePath);
  process.stdout.write(
    JSON.stringify({
      sourcePath,
      path: snapshot.path,
      pathBase64: encodePlanPath(snapshot.path),
      sha256: snapshot.sha256,
    }),
  );
};

if (import.meta.main) main();

export { createPlanSnapshot, encodePlanPath, findLatestPlanPath };
