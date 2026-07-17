import { describe, expect, test } from "bun:test";
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
  validateCwdInSameRepo,
  validateCwdWithinRepo,
} from "../../pi/extensions/pi-harness/lib/repo-boundary";

const tempRoot = async (prefix: string): Promise<string> =>
  // realpath so macOS /var → /private/var canonicalization matches the module's.
  realpath(await mkdtemp(join(tmpdir(), prefix)));

const gitInit = (cwd: string): void => {
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
};

describe("validateCwdInSameRepo", () => {
  test("accepts an outside linked-worktree shape with the same common dir", async () => {
    const root = await tempRoot("same-repo-root-");
    const linked = await tempRoot("same-repo-linked-");
    const sameRepo = async (): Promise<string> => "/common/.git";

    expect(await validateCwdInSameRepo(linked, root, sameRepo)).toEqual({
      ok: true,
    });
  });

  test("rejects different or missing repository identities", async () => {
    const root = await tempRoot("same-repo-root-");
    const candidate = await tempRoot("same-repo-other-");
    const different = async (cwd: string): Promise<string | undefined> =>
      cwd === root ? "/root/.git" : "/other/.git";
    const differentResult = await validateCwdInSameRepo(
      candidate,
      root,
      different,
    );
    expect(differentResult.ok).toBe(false);

    const noRootRepo = async (): Promise<undefined> => undefined;
    const noRepoResult = await validateCwdInSameRepo(
      candidate,
      root,
      noRootRepo,
    );
    expect(noRepoResult.ok).toBe(false);

    const missingResult = await validateCwdInSameRepo(
      join(root, "missing"),
      root,
      async () => "/root/.git",
    );
    expect(missingResult.ok).toBe(false);
  });

  test("accepts a real linked worktree and rejects a distinct repository", async () => {
    const parent = await tempRoot("same-repo-real-");
    const root = join(parent, "root");
    const linked = join(parent, "linked");
    const other = join(parent, "other");
    await mkdir(root);
    await mkdir(other);
    gitInit(root);
    gitInit(other);
    await writeFile(join(root, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=pi-harness",
        "-c",
        "user.email=pi-harness@example.test",
        "commit",
        "-qm",
        "initial",
      ],
      { cwd: root, stdio: "ignore" },
    );
    execFileSync("git", ["worktree", "add", "-q", "-b", "linked", linked], {
      cwd: root,
      stdio: "ignore",
    });
    const escape = join(root, "escape");
    await symlink(other, escape);

    try {
      const linkedResult = await validateCwdInSameRepo(linked, root);
      const otherResult = await validateCwdInSameRepo(other, root);
      const escapeResult = await validateCwdInSameRepo(escape, root);
      expect(linkedResult.ok).toBe(true);
      expect(otherResult.ok).toBe(false);
      expect(escapeResult.ok).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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
    });
  });

  test("rejects a cwd outside the root", async () => {
    const root = await tempRoot("rb-");
    const outside = await tempRoot("rb-out-");
    const result = await validateCwdWithinRepo(outside, root, sameRepo);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("outside");
  });

  test("rejects a nested distinct repository (different common-dir)", async () => {
    const root = await tempRoot("rb-");
    const nested = join(root, "vendor", "other");
    await mkdir(nested, { recursive: true });
    const perPath = async (cwd: string): Promise<string> =>
      cwd === nested ? `${nested}/.git` : `${root}/.git`;
    const result = await validateCwdWithinRepo(nested, root, perPath);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("different git repository");
  });

  test("accepts when the root is not a git repo (containment only)", async () => {
    const root = await tempRoot("rb-");
    const sub = join(root, "x");
    await mkdir(sub);
    const notARepo = async (): Promise<undefined> => undefined;
    expect(await validateCwdWithinRepo(sub, root, notARepo)).toEqual({
      ok: true,
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
    expect(result.reason).toContain("not in a git repository");
  });

  test("rejects a symlinked cwd that resolves outside the root", async () => {
    const root = await tempRoot("rb-");
    const outside = await tempRoot("rb-ext-");
    const link = join(root, "escape");
    await symlink(outside, link);
    const result = await validateCwdWithinRepo(link, root, sameRepo);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("outside");
  });

  test("rejects a nonexistent cwd", async () => {
    const root = await tempRoot("rb-");
    const result = await validateCwdWithinRepo(
      join(root, "nope"),
      root,
      sameRepo,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not resolve");
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
    expect(nestedResult.reason).toContain("different git repository");

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
