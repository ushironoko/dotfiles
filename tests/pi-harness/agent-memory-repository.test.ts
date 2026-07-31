import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  MemoryRepositoryError,
  resolveMemoryRepository,
  type RunRepositoryGit,
} from "../../pi/extensions/pi-harness/features/agent-memory/repository";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

const git = async (cwd: string, ...args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
  });
  return stdout;
};

const runGit: RunRepositoryGit = async (cwd, args) => {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "buffer",
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as {
      code?: number;
      stdout?: Uint8Array;
      stderr?: Uint8Array;
    };
    return {
      exitCode: typeof failure.code === "number" ? failure.code : 1,
      stdout: failure.stdout ?? Buffer.alloc(0),
      stderr: failure.stderr ?? Buffer.alloc(0),
    };
  }
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("agent memory trusted repository identity", () => {
  test("resolves symlinks but does not let a trusted checkout bless a nested repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-memory-repository-"));
    roots.push(root);
    const trusted = join(root, "trusted");
    const nested = join(trusted, "nested");
    const symlinked = join(root, "trusted-link");
    await git(root, "init", trusted);
    await git(trusted, "init", nested);
    await symlink(trusted, symlinked);

    const direct = await resolveMemoryRepository(
      symlinked,
      { trustedRoots: [trusted] },
      { runGit },
    );
    expect(direct.topLevel).toBe(await realpath(trusted));
    expect(direct.trustSource).toBe("direct");

    await expect(
      resolveMemoryRepository(nested, { trustedRoots: [trusted] }, { runGit }),
    ).rejects.toBeInstanceOf(MemoryRepositoryError);
    await expect(
      resolveMemoryRepository(nested, { trustedRoots: [trusted] }, { runGit }),
    ).rejects.toMatchObject({ kind: "untrusted" });
  });

  test("allows a configured non-Git container but rejects an unrelated root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-memory-container-"));
    roots.push(root);
    const container = join(root, "repositories");
    const repository = join(container, "project");
    const unrelated = join(root, "unrelated");
    await git(root, "init", repository);
    await git(root, "init", unrelated);

    const trusted = await resolveMemoryRepository(
      repository,
      { trustedRoots: [container] },
      { runGit },
    );
    expect(trusted.trustSource).toBe("direct");

    await expect(
      resolveMemoryRepository(
        unrelated,
        { trustedRoots: [container] },
        { runGit },
      ),
    ).rejects.toMatchObject({ kind: "untrusted" });
  });
});
