import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { runHook } from "../../../pi/extensions/pi-harness/lib/run-hook";
import {
  matchesFileIdentity,
  parseWorktreeIdentity,
} from "../../../pi/extensions/pi-harness/lib/worktree-identity";
import { cleanupTestDirectory, setupTestDirectory } from "../../test-helpers";

const ROOT = resolve(import.meta.dir, "../../..");
const CREATE_HOOK = join(ROOT, "codex/hooks/worktree/create.sh");
const REMOVE_HOOK = join(ROOT, "codex/hooks/worktree/remove.sh");
const BRANCH = "harness-safety-test";

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface WorktreeFixture {
  root: string;
  repository: string;
  worktree: string;
  commonDirectory: string;
  markerPath: string;
}

interface CreateHookFixture {
  root: string;
  repository: string;
  binDirectory: string;
  realGit: string;
  realMkdir: string;
}

const runCommand = async (
  command: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    input?: string;
  } = {},
): Promise<CommandResult> => {
  const proc = Bun.spawn(command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (options.input !== undefined) {
    const { stdin } = proc;
    if (stdin === undefined)
      throw new Error("command stdin pipe is unavailable");
    stdin.write(options.input);
    stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: stdout.trim(), stderr, exitCode };
};

const runGit = async (args: string[], cwd?: string): Promise<CommandResult> => {
  const result = await runCommand(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
};

const parseCreateOutput = (stdout: string) => {
  const [path = "", identityLine, ...extra] = stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  expect(extra).toEqual([]);
  return {
    path,
    identity:
      identityLine === undefined
        ? undefined
        : parseWorktreeIdentity(JSON.parse(identityLine)),
  };
};

const createFixture = async (): Promise<WorktreeFixture> => {
  const root = await fs.realpath(
    await setupTestDirectory("codex-worktree-safety"),
  );
  const repository = join(root, "repository");
  const worktree = join(root, "linked-worktree");
  await fs.mkdir(repository);
  await runGit(["init", "-q", "-b", "main", repository]);
  await runGit(["config", "user.email", "codex-test@example.com"], repository);
  await runGit(["config", "user.name", "Codex Test"], repository);
  await runGit(["commit", "-q", "--allow-empty", "-m", "initial"], repository);
  await runGit(["worktree", "add", "-q", "-b", BRANCH, worktree], repository);

  const commonDirectory = await fs.realpath(join(repository, ".git"));
  const markerDirectory = join(commonDirectory, "codex-harness-worktrees");
  const pathSha1 = createHash("sha1").update(worktree).digest("hex");
  const markerPath = join(markerDirectory, `${pathSha1}.json`);
  await fs.mkdir(markerDirectory, { mode: 0o700 });
  const [rootStats, dotGitStats] = await Promise.all([
    fs.lstat(worktree, { bigint: true }),
    fs.lstat(join(worktree, ".git"), { bigint: true }),
  ]);
  await fs.writeFile(
    markerPath,
    JSON.stringify({
      version: 1,
      path: worktree,
      branch: BRANCH,
      root: {
        dev: rootStats.dev.toString(10),
        ino: rootStats.ino.toString(10),
      },
      dotGit: {
        dev: dotGitStats.dev.toString(10),
        ino: dotGitStats.ino.toString(10),
      },
    }),
    { mode: 0o600 },
  );

  return { root, repository, worktree, commonDirectory, markerPath };
};

const createCreateHookFixture = async (
  prefix: string,
): Promise<CreateHookFixture> => {
  const root = await fs.realpath(await setupTestDirectory(prefix));
  const repository = join(root, "repository");
  const binDirectory = join(root, "bin");
  const realGit = Bun.which("git");
  const realMkdir = Bun.which("mkdir");
  if (realGit === null || realMkdir === null) {
    throw new Error("git and mkdir are required for this test");
  }
  await fs.mkdir(repository);
  await fs.mkdir(binDirectory);
  await runGit(["init", "-q", "-b", "main", repository]);
  await runGit(["config", "user.email", "codex-test@example.com"], repository);
  await runGit(["config", "user.name", "Codex Test"], repository);
  await runGit(["commit", "-q", "--allow-empty", "-m", "initial"], repository);
  await fs.writeFile(
    join(binDirectory, "gwq"),
    [
      "#!/usr/bin/env bash",
      String.raw`printf '%s\n' "$*" >> "$GWQ_CALLS"`,
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { root, repository, binDirectory, realGit, realMkdir };
};

const runRemoveHook = async (
  fixture: WorktreeFixture,
  input: Record<string, unknown>,
  env?: Record<string, string | undefined>,
): Promise<CommandResult> =>
  runCommand(["bash", REMOVE_HOOK], {
    cwd: fixture.repository,
    env,
    input: JSON.stringify(input),
  });

describe("Codex worktree removal safety", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(cleanupTestDirectory));
  });

  const fixture = async (): Promise<WorktreeFixture> => {
    const value = await createFixture();
    temporaryDirectories.push(value.root);
    return value;
  };

  test("rejects removal without explicit confirmation", async () => {
    const value = await fixture();
    const result = await runRemoveHook(value, {
      worktree_path: value.worktree,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("confirmed=true");
    expect(await pathExists(value.worktree)).toBe(true);
    expect(await pathExists(value.markerPath)).toBe(true);
  });

  test("rejects a dirty linked worktree", async () => {
    const value = await fixture();
    await fs.writeFile(join(value.worktree, "untracked.txt"), "dirty\n");

    const result = await runRemoveHook(value, {
      worktree_path: value.worktree,
      confirmed: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("dirty worktree");
    expect(await pathExists(value.worktree)).toBe(true);
    expect(await pathExists(value.markerPath)).toBe(true);
  });

  test("rejects a marker whose branch does not exactly match", async () => {
    const value = await fixture();
    await fs.writeFile(
      value.markerPath,
      JSON.stringify({ path: value.worktree, branch: "different-branch" }),
    );

    const result = await runRemoveHook(value, {
      worktree_path: value.worktree,
      confirmed: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("marker does not exactly match");
    expect(await pathExists(value.worktree)).toBe(true);
    expect(await pathExists(value.markerPath)).toBe(true);
  });

  test("rejects a clean replacement that only restores the original .git contents", async () => {
    const value = await fixture();
    const originalDotGit = await fs.readFile(join(value.worktree, ".git"));
    await fs.rm(value.worktree, { recursive: true, force: true });
    await fs.mkdir(value.worktree);
    await fs.writeFile(join(value.worktree, ".git"), originalDotGit);

    const result = await runRemoveHook(value, {
      worktree_path: value.worktree,
      confirmed: true,
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("identity no longer matches");
    expect(await pathExists(value.worktree)).toBe(true);
    expect(await pathExists(value.markerPath)).toBe(true);
  });

  test("removes a clean confirmed worktree without force, then deletes its marker", async () => {
    const value = await fixture();
    const binDirectory = join(value.root, "bin");
    const gitCalls = join(value.root, "git-calls.log");
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git is required for this test");
    await fs.mkdir(binDirectory);
    await fs.writeFile(
      join(binDirectory, "git"),
      [
        "#!/usr/bin/env bash",
        String.raw`printf '%s\n' "$*" >> "$GIT_CALLS"`,
        String.raw`exec "$REAL_GIT" "$@"`,
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await runRemoveHook(
      value,
      { worktree_path: value.worktree, confirmed: true },
      {
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        GIT_CALLS: gitCalls,
        REAL_GIT: realGit,
      },
    );

    expect(result.exitCode).toBe(0);
    expect(await pathExists(value.worktree)).toBe(false);
    expect(await pathExists(value.markerPath)).toBe(false);

    const gitCallLog = await fs.readFile(gitCalls, "utf8");
    const calls = gitCallLog.split("\n").filter(Boolean);
    const removeCall = calls.find((call) => call.includes("worktree remove"));
    expect(removeCall).toBeDefined();
    expect(removeCall).not.toMatch(/(?:^|\s)(?:--force|-f)(?:\s|$)/);

    const list = await runGit(
      ["worktree", "list", "--porcelain"],
      value.repository,
    );
    expect(list.stdout).not.toContain(value.worktree);
  });

  test("create marker is accepted by the confirmed clean removal path", async () => {
    const root = await fs.realpath(
      await setupTestDirectory("codex-worktree-roundtrip"),
    );
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const worktree = join(root, "linked-worktree");
    const binDirectory = join(root, "bin");
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git is required for this test");
    await fs.mkdir(repository);
    await fs.mkdir(binDirectory);
    await runGit(["init", "-q", "-b", "main", repository]);
    await runGit(
      ["config", "user.email", "codex-test@example.com"],
      repository,
    );
    await runGit(["config", "user.name", "Codex Test"], repository);
    await runGit(
      ["commit", "-q", "--allow-empty", "-m", "initial"],
      repository,
    );
    await fs.writeFile(
      join(binDirectory, "gwq"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "add" ]; then',
        '  exec "$REAL_GIT" -C "$GWQ_REPOSITORY" worktree add -q "$GWQ_WORKTREE" "$2"',
        "fi",
        String.raw`if [ "$1" = "get" ]; then printf "%s\n" "$GWQ_WORKTREE"; exit 0; fi`,
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const created = await runCommand(["bash", CREATE_HOOK], {
      cwd: repository,
      env: {
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        REAL_GIT: realGit,
        GWQ_REPOSITORY: repository,
        GWQ_WORKTREE: worktree,
      },
      input: JSON.stringify({ name: BRANCH }),
    });

    expect(created.exitCode).toBe(0);
    const publication = parseCreateOutput(created.stdout);
    expect(publication.path).toBe(worktree);
    expect(publication.identity).toBeDefined();
    const { identity } = publication;
    if (identity === undefined) throw new Error("missing creation identity");
    const [rootStats, dotGitStats] = await Promise.all([
      fs.lstat(worktree, { bigint: true }),
      fs.lstat(join(worktree, ".git"), { bigint: true }),
    ]);
    expect(matchesFileIdentity(rootStats, identity.root)).toBe(true);
    expect(matchesFileIdentity(dotGitStats, identity.dotGit)).toBe(true);
    const gitDirResult = await runGit(
      ["rev-parse", "--absolute-git-dir"],
      worktree,
    );
    expect(identity.gitDir).toBe(await fs.realpath(gitDirResult.stdout));
    const commonDirectory = await fs.realpath(join(repository, ".git"));
    const pathSha1 = createHash("sha1").update(worktree).digest("hex");
    const markerPath = join(
      commonDirectory,
      "codex-harness-worktrees",
      `${pathSha1}.json`,
    );
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    expect(marker).toEqual({
      version: 1,
      path: worktree,
      branch: BRANCH,
      root: identity.root,
      dotGit: identity.dotGit,
    });
    const markerStats = await fs.stat(markerPath);
    expect(markerStats.mode & 0o777).toBe(0o600);

    const fixtureValue: WorktreeFixture = {
      root,
      repository,
      worktree,
      commonDirectory,
      markerPath,
    };
    const removed = await runRemoveHook(fixtureValue, {
      worktree_path: worktree,
      confirmed: true,
    });
    expect(removed.exitCode).toBe(0);
    expect(await pathExists(worktree)).toBe(false);
    expect(await pathExists(markerPath)).toBe(false);
  });

  test("rejects replacement between initial and final hook identity checks", async () => {
    const value = await createCreateHookFixture("codex-worktree-identity-swap");
    temporaryDirectories.push(value.root);
    const branch = "harness-identity-swap-test";
    const worktree = join(value.root, "linked-worktree");
    const statCount = join(value.root, "stat-count");
    const realStat = Bun.which("stat");
    const realRm = Bun.which("rm");
    if (realStat === null || realRm === null) {
      throw new Error("stat and rm are required for this test");
    }
    await fs.writeFile(
      join(value.binDirectory, "gwq"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "add" ]; then',
        '  exec "$REAL_GIT" -C "$GWQ_REPOSITORY" worktree add -q "$GWQ_WORKTREE" "$2"',
        "fi",
        String.raw`if [ "$1" = "get" ]; then printf "%s\n" "$GWQ_WORKTREE"; exit 0; fi`,
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    await fs.writeFile(
      join(value.binDirectory, "stat"),
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'output=$("$REAL_STAT" "$@" 2>/dev/null)',
        "status=$?",
        '[ "$status" -eq 0 ] || exit "$status"',
        String.raw`printf '%s\n' "$output"`,
        "last=$" + "{!#}",
        'if [ "$last" = "$GWQ_WORKTREE" ] || [ "$last" = "$GWQ_WORKTREE/.git" ]; then',
        '  count=$(cat "$STAT_COUNT" 2>/dev/null || printf 0)',
        "  count=$((count + 1))",
        String.raw`  printf "%s\n" "$count" > "$STAT_COUNT"`,
        '  if [ "$count" -eq 2 ]; then',
        '    dot_git=$(cat "$GWQ_WORKTREE/.git")',
        '    "$REAL_RM" -rf -- "$GWQ_WORKTREE"',
        '    "$REAL_MKDIR" -- "$GWQ_WORKTREE"',
        String.raw`    printf "%s\n" "$dot_git" > "$GWQ_WORKTREE/.git"`,
        "  fi",
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await runCommand(["bash", CREATE_HOOK], {
      cwd: value.repository,
      env: {
        PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
        REAL_GIT: value.realGit,
        REAL_MKDIR: value.realMkdir,
        REAL_RM: realRm,
        REAL_STAT: realStat,
        GWQ_REPOSITORY: value.repository,
        GWQ_WORKTREE: worktree,
        STAT_COUNT: statCount,
      },
      input: JSON.stringify({ name: branch }),
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(
      "created worktree root identity changed before publication",
    );
    expect(parseCreateOutput(result.stdout).path).toBe(worktree);
    expect(await pathExists(worktree)).toBe(true);
    const branchLookup = await runCommand(
      ["git", "show-ref", "--verify", `refs/heads/${branch}`],
      { cwd: value.repository },
    );
    expect(branchLookup.exitCode).toBe(0);
    const commonDirectory = await fs.realpath(join(value.repository, ".git"));
    const markerPath = join(
      commonDirectory,
      "codex-harness-worktrees",
      `${createHash("sha1").update(worktree).digest("hex")}.json`,
    );
    expect(await pathExists(markerPath)).toBe(false);
  });

  test("TERM immediately after create-lock mkdir leaves no stale ownership", async () => {
    const value = await createCreateHookFixture("codex-worktree-lock-term");
    temporaryDirectories.push(value.root);
    const branch = "harness-lock-term-test";
    const signalSent = join(value.root, "lock-signal-sent");
    const gwqCalls = join(value.root, "gwq-calls.log");
    const commonDirectory = await fs.realpath(join(value.repository, ".git"));
    const lockPath = join(
      commonDirectory,
      "codex-harness-worktree-create-locks",
      `${createHash("sha1").update(branch).digest("hex")}.lock`,
    );
    await fs.writeFile(
      join(value.binDirectory, "mkdir"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "last=${!#}",
        'if [[ "$last" == *.lock ]] && [ ! -e "$SIGNAL_SENT" ]; then',
        '  "$REAL_MKDIR" "$@"',
        '  : > "$SIGNAL_SENT"',
        "  kill -TERM 0",
        "  exit 0",
        "fi",
        'exec "$REAL_MKDIR" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          REAL_MKDIR: value.realMkdir,
          GWQ_CALLS: gwqCalls,
          SIGNAL_SENT: signalSent,
        },
        timeoutMs: 5_000,
        termGraceMs: 1_000,
      },
    );

    expect(result.exitCode).toBe(130);
    expect(result.timedOut).toBe(false);
    expect(await pathExists(signalSent)).toBe(true);
    expect(await pathExists(lockPath)).toBe(false);
    expect(await pathExists(gwqCalls)).toBe(false);
    expect(
      (
        await runCommand(
          ["git", "show-ref", "--verify", `refs/heads/${branch}`],
          { cwd: value.repository },
        )
      ).exitCode,
    ).not.toBe(0);

    const retry = await runHook(CREATE_HOOK, JSON.stringify({ name: branch }), {
      cwd: value.repository,
      env: {
        PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
        REAL_MKDIR: value.realMkdir,
        GWQ_CALLS: gwqCalls,
        SIGNAL_SENT: signalSent,
      },
      timeoutMs: 5_000,
    });
    expect(retry.stderr).toContain("gwq could not create worktree");
    expect(retry.stderr).not.toContain("another worktree create");
    expect(await pathExists(lockPath)).toBe(false);
  });

  test("owner-file setup failure rolls back the new lock", async () => {
    const value = await createCreateHookFixture("codex-worktree-owner-failure");
    temporaryDirectories.push(value.root);
    const branch = "harness-owner-failure-test";
    const failOnce = join(value.root, "chmod-failed-once");
    const gwqCalls = join(value.root, "gwq-calls.log");
    const realChmod = Bun.which("chmod");
    if (realChmod === null) throw new Error("chmod is required for this test");
    await fs.writeFile(
      join(value.binDirectory, "chmod"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ "${!#}" == *.lock/owner.* ]] && [ ! -e "$FAIL_ONCE" ]; then',
        '  : > "$FAIL_ONCE"',
        "  exit 1",
        "fi",
        'exec "$REAL_CHMOD" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const commonDirectory = await fs.realpath(join(value.repository, ".git"));
    const lockPath = join(
      commonDirectory,
      "codex-harness-worktree-create-locks",
      `${createHash("sha1").update(branch).digest("hex")}.lock`,
    );

    const failed = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          REAL_CHMOD: realChmod,
          FAIL_ONCE: failOnce,
          GWQ_CALLS: gwqCalls,
        },
        timeoutMs: 5_000,
      },
    );
    expect(failed.exitCode).not.toBe(0);
    expect(await pathExists(failOnce)).toBe(true);
    expect(await pathExists(lockPath)).toBe(false);

    const retry = await runHook(CREATE_HOOK, JSON.stringify({ name: branch }), {
      cwd: value.repository,
      env: {
        PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
        REAL_CHMOD: realChmod,
        FAIL_ONCE: failOnce,
        GWQ_CALLS: gwqCalls,
      },
      timeoutMs: 5_000,
    });
    expect(retry.stderr).toContain("gwq could not create worktree");
    expect(retry.stderr).not.toContain("another worktree create");
  });

  test("owner publication and rollback failures cannot strand the lock", async () => {
    const value = await createCreateHookFixture("codex-worktree-owner-publish");
    temporaryDirectories.push(value.root);
    const branch = "harness-owner-publish-test";
    const sabotaged = join(value.root, "owner-publication-sabotaged");
    const rmdirFailed = join(value.root, "rollback-rmdir-failed");
    const gwqCalls = join(value.root, "gwq-calls.log");
    const realChmod = Bun.which("chmod");
    const realRmdir = Bun.which("rmdir");
    if (realChmod === null || realRmdir === null) {
      throw new Error("chmod and rmdir are required for this test");
    }
    await fs.writeFile(
      join(value.binDirectory, "mkdir"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "last=${!#}",
        'if [[ "$last" == *.lock ]] && [ ! -e "$SABOTAGED" ]; then',
        '  "$REAL_MKDIR" "$@"',
        '  "$REAL_CHMOD" 500 "$last"',
        '  : > "$SABOTAGED"',
        "  exit 0",
        "fi",
        'exec "$REAL_MKDIR" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    await fs.writeFile(
      join(value.binDirectory, "rmdir"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "last=${!#}",
        'if [[ "$last" == *.lock.releasing.owner.* ]] && [ ! -e "$RMDIR_FAILED" ]; then',
        '  : > "$RMDIR_FAILED"',
        "  exit 1",
        "fi",
        'exec "$REAL_RMDIR" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const commonDirectory = await fs.realpath(join(value.repository, ".git"));
    const lockName = `${createHash("sha1").update(branch).digest("hex")}.lock`;
    const lockParent = join(
      commonDirectory,
      "codex-harness-worktree-create-locks",
    );

    const failed = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          REAL_CHMOD: realChmod,
          REAL_MKDIR: value.realMkdir,
          REAL_RMDIR: realRmdir,
          SABOTAGED: sabotaged,
          RMDIR_FAILED: rmdirFailed,
          GWQ_CALLS: gwqCalls,
        },
        timeoutMs: 5_000,
      },
    );
    expect(failed.stderr).toContain(
      "could not initialize worktree create lock",
    );
    expect(await pathExists(rmdirFailed)).toBe(true);
    expect(
      (await fs.readdir(lockParent)).filter((name) =>
        name.startsWith(lockName),
      ),
    ).toEqual([]);

    const retry = await runHook(CREATE_HOOK, JSON.stringify({ name: branch }), {
      cwd: value.repository,
      env: {
        PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
        REAL_CHMOD: realChmod,
        REAL_MKDIR: value.realMkdir,
        REAL_RMDIR: realRmdir,
        SABOTAGED: sabotaged,
        RMDIR_FAILED: rmdirFailed,
        GWQ_CALLS: gwqCalls,
      },
      timeoutMs: 5_000,
    });
    expect(retry.stderr).toContain("gwq could not create worktree");
    expect(retry.stderr).not.toContain("another worktree create");
  });

  test("TERM immediately after update-ref leaves no orphan branch", async () => {
    const value = await createCreateHookFixture("codex-worktree-ref-term");
    temporaryDirectories.push(value.root);
    const branch = "harness-ref-term-test";
    const signalSent = join(value.root, "ref-signal-sent");
    const gwqCalls = join(value.root, "gwq-calls.log");
    await fs.writeFile(
      join(value.binDirectory, "git"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [[ " $* " == *" update-ref refs/heads/$TARGET_BRANCH "* ]] && [ ! -e "$SIGNAL_SENT" ]; then',
        '  "$REAL_GIT" "$@"',
        '  : > "$SIGNAL_SENT"',
        "  kill -TERM 0",
        "  exit 0",
        "fi",
        'exec "$REAL_GIT" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          REAL_GIT: value.realGit,
          GWQ_CALLS: gwqCalls,
          SIGNAL_SENT: signalSent,
          TARGET_BRANCH: branch,
        },
        timeoutMs: 5_000,
        termGraceMs: 1_000,
      },
    );

    expect(result.exitCode).toBe(130);
    expect(result.timedOut).toBe(false);
    expect(await pathExists(signalSent)).toBe(true);
    const gwqCallLog = (await pathExists(gwqCalls))
      ? await fs.readFile(gwqCalls, "utf8")
      : "";
    expect(gwqCallLog).not.toContain("add");
    expect(
      (
        await runCommand(
          [value.realGit, "show-ref", "--verify", `refs/heads/${branch}`],
          { cwd: value.repository },
        )
      ).exitCode,
    ).not.toBe(0);
    const lockPath = join(
      await fs.realpath(join(value.repository, ".git")),
      "codex-harness-worktree-create-locks",
      `${createHash("sha1").update(branch).digest("hex")}.lock`,
    );
    expect(await pathExists(lockPath)).toBe(false);

    const retry = await runHook(CREATE_HOOK, JSON.stringify({ name: branch }), {
      cwd: value.repository,
      env: {
        PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
        REAL_GIT: value.realGit,
        GWQ_CALLS: gwqCalls,
        SIGNAL_SENT: signalSent,
        TARGET_BRANCH: branch,
      },
      timeoutMs: 5_000,
    });
    expect(retry.stderr).toContain("gwq could not create worktree");
    expect(retry.stderr).not.toContain("branch already exists");
  });

  test("cancellation never deletes a reserved branch moved by another actor", async () => {
    const value = await createCreateHookFixture("codex-worktree-moved-ref");
    temporaryDirectories.push(value.root);
    const branch = "harness-moved-ref-test";
    const otherCommit = (
      await runGit(
        ["commit-tree", "HEAD^{tree}", "-m", "other"],
        value.repository,
      )
    ).stdout;
    await fs.writeFile(
      join(value.binDirectory, "gwq"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "add" ]; then',
        '  "$REAL_GIT" -C "$GWQ_REPOSITORY" update-ref "refs/heads/$2" "$OTHER_COMMIT"',
        "  kill -TERM 0",
        "  exit 1",
        "fi",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          REAL_GIT: value.realGit,
          GWQ_REPOSITORY: value.repository,
          OTHER_COMMIT: otherCommit,
        },
        timeoutMs: 5_000,
        termGraceMs: 1_000,
      },
    );

    expect(result.exitCode).toBe(130);
    expect(result.timedOut).toBe(false);
    expect(
      (await runGit(["rev-parse", `refs/heads/${branch}`], value.repository))
        .stdout,
    ).toBe(otherCommit);
    const lockPath = join(
      await fs.realpath(join(value.repository, ".git")),
      "codex-harness-worktree-create-locks",
      `${createHash("sha1").update(branch).digest("hex")}.lock`,
    );
    expect(await pathExists(lockPath)).toBe(false);
  });

  test("TERM immediately after normal lock release keeps the published worktree removable", async () => {
    const value = await createCreateHookFixture("codex-worktree-release-term");
    temporaryDirectories.push(value.root);
    const branch = "harness-release-term-test";
    const worktree = join(value.root, "linked-worktree");
    const signalSent = join(value.root, "release-signal-sent");
    const realRmdir = Bun.which("rmdir");
    if (realRmdir === null) throw new Error("rmdir is required for this test");
    await fs.writeFile(
      join(value.binDirectory, "gwq"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "add" ]; then',
        '  exec "$REAL_GIT" -C "$GWQ_REPOSITORY" worktree add -q "$GWQ_WORKTREE" "$2"',
        "fi",
        String.raw`if [ "$1" = "get" ]; then printf "%s\n" "$GWQ_WORKTREE"; exit 0; fi`,
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    await fs.writeFile(
      join(value.binDirectory, "rmdir"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "last=${!#}",
        'if [[ "$last" == *.lock.releasing.owner.* ]] && [ ! -e "$SIGNAL_SENT" ]; then',
        '  "$REAL_RMDIR" "$@"',
        '  "$REAL_MKDIR" "$SUCCESSOR_LOCK"',
        '  : > "$SIGNAL_SENT"',
        "  kill -TERM 0",
        "  exit 0",
        "fi",
        'exec "$REAL_RMDIR" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const commonDirectory = await fs.realpath(join(value.repository, ".git"));
    const markerPath = join(
      commonDirectory,
      "codex-harness-worktrees",
      `${createHash("sha1").update(worktree).digest("hex")}.json`,
    );
    const lockPath = join(
      commonDirectory,
      "codex-harness-worktree-create-locks",
      `${createHash("sha1").update(branch).digest("hex")}.lock`,
    );

    const result = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          REAL_GIT: value.realGit,
          REAL_MKDIR: value.realMkdir,
          REAL_RMDIR: realRmdir,
          GWQ_REPOSITORY: value.repository,
          GWQ_WORKTREE: worktree,
          SIGNAL_SENT: signalSent,
          SUCCESSOR_LOCK: lockPath,
        },
        timeoutMs: 10_000,
        termGraceMs: 2_000,
      },
    );

    expect(result.exitCode).toBe(130);
    expect(result.timedOut).toBe(false);
    expect(parseCreateOutput(result.stdout).path).toBe(worktree);
    expect(await pathExists(signalSent)).toBe(true);
    expect(await pathExists(worktree)).toBe(true);
    expect(await pathExists(markerPath)).toBe(true);
    // Simulates a successor acquiring the same branch lock immediately after
    // rmdir but before this process commits CREATE_LOCK_HELD=0. Deferred
    // cancellation must not let EXIT cleanup remove the successor's directory.
    expect(await pathExists(lockPath)).toBe(true);
    await fs.rmdir(lockPath);

    const removed = await runRemoveHook(
      {
        root: value.root,
        repository: value.repository,
        worktree,
        commonDirectory,
        markerPath,
      },
      { worktree_path: worktree, confirmed: true },
    );
    expect(removed.exitCode).toBe(0);
  });

  test("a transient tombstone rmdir failure is retried without blocking the branch lock", async () => {
    const value = await createCreateHookFixture("codex-worktree-release-retry");
    temporaryDirectories.push(value.root);
    const branch = "harness-release-retry-test";
    const worktree = join(value.root, "linked-worktree");
    const failOnce = join(value.root, "rmdir-failed-once");
    const realRmdir = Bun.which("rmdir");
    if (realRmdir === null) throw new Error("rmdir is required for this test");
    await fs.writeFile(
      join(value.binDirectory, "gwq"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "add" ]; then',
        '  exec "$REAL_GIT" -C "$GWQ_REPOSITORY" worktree add -q "$GWQ_WORKTREE" "$2"',
        "fi",
        String.raw`if [ "$1" = "get" ]; then printf "%s\n" "$GWQ_WORKTREE"; exit 0; fi`,
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    await fs.writeFile(
      join(value.binDirectory, "rmdir"),
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        "last=${!#}",
        'if [[ "$last" == *.lock.releasing.owner.* ]]; then',
        '  failures=$(cat "$FAIL_ONCE" 2>/dev/null || printf 0)',
        '  if [ "$failures" -lt 2 ]; then',
        '    printf "%s\n" "$((failures + 1))" > "$FAIL_ONCE"',
        "    exit 1",
        "  fi",
        "fi",
        'exec "$REAL_RMDIR" "$@"',
      ].join("\n"),
      { mode: 0o755 },
    );
    const commonDirectory = await fs.realpath(join(value.repository, ".git"));
    const markerPath = join(
      commonDirectory,
      "codex-harness-worktrees",
      `${createHash("sha1").update(worktree).digest("hex")}.json`,
    );
    const lockName = `${createHash("sha1").update(branch).digest("hex")}.lock`;
    const lockParent = join(
      commonDirectory,
      "codex-harness-worktree-create-locks",
    );

    const result = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          REAL_GIT: value.realGit,
          REAL_RMDIR: realRmdir,
          GWQ_REPOSITORY: value.repository,
          GWQ_WORKTREE: worktree,
          FAIL_ONCE: failOnce,
        },
        timeoutMs: 10_000,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("could not release worktree create lock");
    expect(parseCreateOutput(result.stdout).path).toBe(worktree);
    expect(await pathExists(markerPath)).toBe(true);
    expect(
      (await fs.readdir(lockParent)).filter((name) =>
        name.startsWith(lockName),
      ),
    ).toEqual([]);

    const removed = await runRemoveHook(
      {
        root: value.root,
        repository: value.repository,
        worktree,
        commonDirectory,
        markerPath,
      },
      { worktree_path: worktree, confirmed: true },
    );
    expect(removed.exitCode).toBe(0);
  });

  test("never removes another invocation's existing lock or branch", async () => {
    const value = await createCreateHookFixture("codex-worktree-foreign-owner");
    temporaryDirectories.push(value.root);
    const branch = "harness-foreign-owner-test";
    const commonDirectory = await fs.realpath(join(value.repository, ".git"));
    const lockPath = join(
      commonDirectory,
      "codex-harness-worktree-create-locks",
      `${createHash("sha1").update(branch).digest("hex")}.lock`,
    );
    const foreignOwner = join(lockPath, "owner.foreign");
    await fs.mkdir(lockPath, { recursive: true });
    await fs.writeFile(foreignOwner, "foreign\n");

    const locked = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          GWQ_CALLS: join(value.root, "gwq-calls.log"),
        },
        timeoutMs: 5_000,
      },
    );
    expect(locked.stderr).toContain("another worktree create");
    expect(await fs.readFile(foreignOwner, "utf8")).toBe("foreign\n");

    await fs.rm(lockPath, { recursive: true });
    const head = (await runGit(["rev-parse", "HEAD"], value.repository)).stdout;
    await runGit(["branch", branch, head], value.repository);
    const branchExists = await runHook(
      CREATE_HOOK,
      JSON.stringify({ name: branch }),
      {
        cwd: value.repository,
        env: {
          PATH: `${value.binDirectory}:${process.env.PATH ?? ""}`,
          GWQ_CALLS: join(value.root, "gwq-calls.log"),
        },
        timeoutMs: 5_000,
      },
    );
    expect(branchExists.stderr).toContain("branch already exists");
    expect(
      (await runGit(["rev-parse", `refs/heads/${branch}`], value.repository))
        .stdout,
    ).toBe(head);
  });

  test("cancellation retains an unmarked worktree created mid-hook", async () => {
    const root = await fs.realpath(
      await setupTestDirectory("codex-worktree-cancel"),
    );
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const worktree = join(root, "linked-worktree");
    const readyPath = join(root, "gwq-created");
    const binDirectory = join(root, "bin");
    const branch = "harness-cancel-test";
    const realGit = Bun.which("git");
    if (realGit === null) throw new Error("git is required for this test");
    await fs.mkdir(repository);
    await fs.mkdir(binDirectory);
    await runGit(["init", "-q", "-b", "main", repository]);
    await runGit(
      ["config", "user.email", "codex-test@example.com"],
      repository,
    );
    await runGit(["config", "user.name", "Codex Test"], repository);
    await runGit(
      ["commit", "-q", "--allow-empty", "-m", "initial"],
      repository,
    );
    await fs.writeFile(
      join(binDirectory, "gwq"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = "add" ]; then',
        '  "$REAL_GIT" -C "$GWQ_REPOSITORY" worktree add -q "$GWQ_WORKTREE" "$2" || exit 1',
        '  : > "$GWQ_READY"',
        "  sleep 30",
        "  exit 0",
        "fi",
        String.raw`if [ "$1" = "get" ]; then printf "%s\n" "$GWQ_WORKTREE"; exit 0; fi`,
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );

    const controller = new AbortController() as unknown as {
      signal: AbortSignal;
      abort(): void;
    };
    const running = runHook(CREATE_HOOK, JSON.stringify({ name: branch }), {
      cwd: repository,
      env: {
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        REAL_GIT: realGit,
        GWQ_REPOSITORY: repository,
        GWQ_WORKTREE: worktree,
        GWQ_READY: readyPath,
      },
      timeoutMs: 10_000,
      termGraceMs: 3_000,
      signal: controller.signal,
    });

    let createdBeforeAbort = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await pathExists(readyPath)) {
        createdBeforeAbort = true;
        break;
      }
      await Bun.sleep(10);
    }
    controller.abort();
    const result = await running;

    expect(createdBeforeAbort).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(parseCreateOutput(result.stdout).path).toBe(worktree);
    expect(await pathExists(worktree)).toBe(true);
    const branchLookup = await runCommand(
      ["git", "show-ref", "--verify", `refs/heads/${branch}`],
      { cwd: repository },
    );
    expect(branchLookup.exitCode).toBe(0);
    const commonDirectory = await fs.realpath(join(repository, ".git"));
    const pathSha1 = createHash("sha1").update(worktree).digest("hex");
    const markerPath = join(
      commonDirectory,
      "codex-harness-worktrees",
      `${pathSha1}.json`,
    );
    expect(await pathExists(markerPath)).toBe(false);
    expect(await pathExists(worktree)).toBe(true);
  });
});
