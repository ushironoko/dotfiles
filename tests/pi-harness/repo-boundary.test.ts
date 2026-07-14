import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateCwdWithinRepo } from "../../pi/extensions/pi-harness/lib/repo-boundary";

const tempRoot = async (prefix: string): Promise<string> =>
  // realpath so macOS /var → /private/var canonicalization matches the module's.
  realpath(await mkdtemp(join(tmpdir(), prefix)));

const gitInit = (cwd: string): void => {
  execFileSync("git", ["init", "-q"], { cwd, stdio: "ignore" });
};

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
});
