import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CwdBoundaryResult,
  validateCwdWithinRepo,
  validateSameGitRepository,
} from "../../pi/extensions/pi-harness/lib/repo-boundary";

const temporaryDirectories: string[] = [];

const tempRoot = async (prefix: string): Promise<string> => {
  // realpath so macOS /var → /private/var canonicalization matches the module's.
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const gitInit = (cwd: string): void => {
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
};

const rejectionReason = (result: CwdBoundaryResult): string => {
  if (result.ok)
    throw new Error(`Expected rejection for ${result.canonicalCwd}`);
  return result.reason;
};

describe("validateSameGitRepository (injected git identity)", () => {
  test("accepts an external linked-worktree path with the same identity", async () => {
    const root = await tempRoot("rb-root-");
    const linked = await tempRoot("rb-linked-");
    const sameRepo = async (): Promise<string> => "/common/.git";
    expect(await validateSameGitRepository(linked, root, sameRepo)).toEqual({
      ok: true,
      canonicalCwd: linked,
    });
  });

  test("rejects a resolvable path with a different identity", async () => {
    const root = await tempRoot("rb-root-");
    const unrelated = await tempRoot("rb-other-");
    const perPath = async (cwd: string): Promise<string> =>
      cwd === unrelated ? "/other/.git" : "/root/.git";
    const result = await validateSameGitRepository(unrelated, root, perPath);
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toContain("different git repository");
  });
});

describe("validateCwdWithinRepo (injected git identity)", () => {
  const sameRepo = async (): Promise<string> => "/common/.git";

  test("accepts a subdirectory of the root within the same repo", async () => {
    const root = await tempRoot("rb-");
    const sub = join(root, "packages", "a");
    await mkdir(sub, { recursive: true });
    expect(await validateCwdWithinRepo(sub, root, sameRepo)).toEqual({
      ok: true,
      canonicalCwd: sub,
    });
  });

  test("rejects a cwd outside the root", async () => {
    const root = await tempRoot("rb-");
    const outside = await tempRoot("rb-out-");
    const result = await validateCwdWithinRepo(outside, root, sameRepo);
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toContain("outside");
  });

  test("rejects a nested distinct repository (different common-dir)", async () => {
    const root = await tempRoot("rb-");
    const nested = join(root, "vendor", "other");
    await mkdir(nested, { recursive: true });
    const perPath = async (cwd: string): Promise<string> =>
      cwd === nested ? `${nested}/.git` : `${root}/.git`;
    const result = await validateCwdWithinRepo(nested, root, perPath);
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toContain("different git repository");
  });

  test("accepts when the root is not a git repo (containment only)", async () => {
    const root = await tempRoot("rb-");
    const sub = join(root, "x");
    await mkdir(sub);
    const notARepo = async (): Promise<undefined> => undefined;
    expect(await validateCwdWithinRepo(sub, root, notARepo)).toEqual({
      ok: true,
      canonicalCwd: sub,
    });
  });

  test("rejects when the root is a repo but the cwd is not", async () => {
    const root = await tempRoot("rb-");
    const sub = join(root, "x");
    await mkdir(sub);
    const onlyRootIsRepo = async (cwd: string): Promise<string | undefined> =>
      cwd === root ? "/r/.git" : undefined;
    const result = await validateCwdWithinRepo(sub, root, onlyRootIsRepo);
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toContain("not in a git repository");
  });

  test("rejects a symlinked cwd that resolves outside the root", async () => {
    const root = await tempRoot("rb-");
    const outside = await tempRoot("rb-ext-");
    const link = join(root, "escape");
    await symlink(outside, link);
    const result = await validateCwdWithinRepo(link, root, sameRepo);
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toContain("outside");
  });

  test("rejects a regular file even under a non-repository root", async () => {
    const root = await tempRoot("rb-");
    const file = join(root, "not-a-directory");
    await writeFile(file, "file\n");
    const notARepo = async (): Promise<undefined> => undefined;
    const result = await validateCwdWithinRepo(file, root, notARepo);
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toContain("not a directory");
  });

  test("rejects a workflow root that is a regular file", async () => {
    const parent = await tempRoot("rb-");
    const candidate = join(parent, "candidate");
    const rootFile = join(parent, "root-file");
    await mkdir(candidate);
    await writeFile(rootFile, "file\n");
    const notARepo = async (): Promise<undefined> => undefined;
    const result = await validateCwdWithinRepo(candidate, rootFile, notARepo);
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toContain("root is not a directory");
  });

  test("rejects a nonexistent cwd", async () => {
    const root = await tempRoot("rb-");
    const result = await validateCwdWithinRepo(
      join(root, "nope"),
      root,
      sameRepo,
    );
    expect(result.ok).toBe(false);
    expect(rejectionReason(result)).toContain("does not resolve");
  });
});

describe("validateCwdWithinRepo (real git)", () => {
  test("subdir accepted, nested repo rejected, outside repo rejected", async () => {
    const root = await tempRoot("rb-real-");
    gitInit(root);

    const sub = join(root, "packages", "a");
    await mkdir(sub, { recursive: true });
    expect((await validateCwdWithinRepo(sub, root)).ok).toBe(true);

    const nested = join(root, "vendor", "other");
    await mkdir(nested, { recursive: true });
    gitInit(nested);
    const nestedResult = await validateCwdWithinRepo(nested, root);
    expect(nestedResult.ok).toBe(false);
    expect(rejectionReason(nestedResult)).toContain("different git repository");

    const outside = await tempRoot("rb-real-out-");
    gitInit(outside);
    expect((await validateCwdWithinRepo(outside, root)).ok).toBe(false);
  });

  test("a non-repo root falls back to containment (real git returns no common-dir)", async () => {
    // No gitInit: the real gitCommonDir errors on a non-repo → undefined, so the
    // check accepts a contained subdir on containment alone.
    const root = await tempRoot("rb-nonrepo-");
    const sub = join(root, "packages", "a");
    await mkdir(sub, { recursive: true });
    expect((await validateCwdWithinRepo(sub, root)).ok).toBe(true);
  });
});
