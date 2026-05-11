import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { setupTestDirectory, cleanupTestDirectory } from "../../test-helpers";

const RUNNER = resolve(
  import.meta.dir,
  "../../../claude/.claude/hooks/lib/statusline_checks_run.sh",
);
const FIXTURES = resolve(import.meta.dir, "../../fixtures/statusline-checks");
const LIB = resolve(
  import.meta.dir,
  "../../../claude/.claude/hooks/lib/statusline_checks_lib.sh",
);

beforeAll(async () => {
  await fs.access(RUNNER);
});

const copyFixture = async (
  fixtureName: string,
  destParent: string,
): Promise<string> => {
  const src = join(FIXTURES, fixtureName);
  const dst = join(destParent, fixtureName);
  await fs.cp(src, dst, { recursive: true });
  return dst;
};

const lockDirFor = async (
  projectRoot: string,
  cacheDir: string,
): Promise<string> => {
  // Invoke lock_dir_path via the lib to compute the exact path.
  const proc = Bun.spawn(
    ["bash", "-c", `source "${LIB}" && lock_dir_path "${projectRoot}"`],
    {
      env: { ...process.env, STATUSLINE_CACHE_DIR: cacheDir },
      stdout: "pipe",
    },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return out;
};

describe("runner: concurrency", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("10 parallel invocations result in only one execution", async () => {
    const tmp = await setupTestDirectory("lock-parallel");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");
    const counter = join(tmp, "counter.txt");

    const procs = Array.from({ length: 10 }, () =>
      Bun.spawn(["bash", RUNNER, project], {
        env: {
          ...process.env,
          STATUSLINE_CACHE_DIR: cacheDir,
          STATUSLINE_COUNTER_FILE: counter,
          STATUSLINE_NOW_OVERRIDE: "100000",
        },
        stdout: "ignore",
        stderr: "ignore",
      }),
    );

    await Promise.all(procs.map((p) => p.exited));

    const contents = await fs.readFile(counter, "utf-8").catch(() => "");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });
});

describe("runner: stale lock recovery", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("recovers from lockdir owned by a non-existent PID", async () => {
    const tmp = await setupTestDirectory("lock-stale-pid");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");

    const lockdir = await lockDirFor(project, cacheDir);
    await fs.mkdir(lockdir, { recursive: true });
    // PID 99999 is virtually guaranteed not to exist; "now" timestamp.
    await fs.writeFile(join(lockdir, "owner"), `99999 200000\n`);

    const proc = Bun.spawn(["bash", RUNNER, project], {
      env: {
        ...process.env,
        STATUSLINE_CACHE_DIR: cacheDir,
        STATUSLINE_NOW_OVERRIDE: "200005",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(0);

    // Lockdir should be gone (runner removed it via trap).
    const exists = await fs
      .access(lockdir)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);

    // Cache should be populated.
    const cacheFiles = await fs.readdir(cacheDir);
    expect(cacheFiles.some((f) => f.endsWith(".json"))).toBe(true);
  });

  test("recovers from lockdir older than 30 minutes", async () => {
    const tmp = await setupTestDirectory("lock-stale-age");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");

    const lockdir = await lockDirFor(project, cacheDir);
    await fs.mkdir(lockdir, { recursive: true });
    // Owned by current process (kill -0 succeeds) but very old timestamp.
    await fs.writeFile(join(lockdir, "owner"), `${process.pid} 1000\n`);

    const proc = Bun.spawn(["bash", RUNNER, project], {
      env: {
        ...process.env,
        STATUSLINE_CACHE_DIR: cacheDir,
        STATUSLINE_NOW_OVERRIDE: "10000", // 9000s = 2.5h > 30min
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(0);

    const cacheFiles = await fs.readdir(cacheDir);
    expect(cacheFiles.some((f) => f.endsWith(".json"))).toBe(true);
  });

  test("respects a fresh lock held by an existing PID", async () => {
    const tmp = await setupTestDirectory("lock-fresh");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");

    const lockdir = await lockDirFor(project, cacheDir);
    await fs.mkdir(lockdir, { recursive: true });
    // Current process exists, recent timestamp → must NOT be reclaimed.
    await fs.writeFile(join(lockdir, "owner"), `${process.pid} 300000\n`);

    const counter = join(tmp, "counter.txt");
    const proc = Bun.spawn(["bash", RUNNER, project], {
      env: {
        ...process.env,
        STATUSLINE_CACHE_DIR: cacheDir,
        STATUSLINE_COUNTER_FILE: counter,
        STATUSLINE_NOW_OVERRIDE: "300010",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await proc.exited).toBe(0);

    // Counter must NOT have an entry (runner aborted at lock acquisition).
    const contents = await fs.readFile(counter, "utf-8").catch(() => "");
    expect(contents).toBe("");
  });
});
