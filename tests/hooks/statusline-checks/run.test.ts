import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { setupTestDirectory, cleanupTestDirectory } from "../../test-helpers";

const RUNNER = resolve(
  import.meta.dir,
  "../../../claude/.claude/hooks/lib/statusline_checks_run.sh",
);
const FIXTURES = resolve(import.meta.dir, "../../fixtures/statusline-checks");

beforeAll(async () => {
  await fs.access(RUNNER);
  await fs.access(FIXTURES);
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

const runRunner = async (
  projectDir: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(["bash", RUNNER, projectDir], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

const readCache = async (
  cacheDir: string,
): Promise<Record<string, unknown> | null> => {
  let files: string[];
  try {
    files = await fs.readdir(cacheDir);
  } catch {
    return null;
  }
  const json = files.find((f) => f.endsWith(".json"));
  if (!json) return null;
  const content = await fs.readFile(join(cacheDir, json), "utf-8");
  return JSON.parse(content);
};

describe("runner: TS bun all-pass fixture", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("writes ok/ok/ok cache when all scripts exit 0", async () => {
    const tmp = await setupTestDirectory("run-ts-pass");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");

    const r = await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "1000",
    });
    expect(r.exitCode).toBe(0);

    const cache = await readCache(cacheDir);
    expect(cache).not.toBeNull();
    expect(cache!.language).toBe("ts");
    expect(cache!.label).toBe("TS");
    const checks = cache!.checks as Record<string, { status: string }>;
    expect(checks.lint.status).toBe("ok");
    expect(checks.typecheck.status).toBe("ok");
    expect(checks.test.status).toBe("ok");
  });
});

describe("runner: TS pnpm typecheck-fail fixture", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("typecheck fails, lint and test pass", async () => {
    const tmp = await setupTestDirectory("run-ts-tcfail");
    tmps.push(tmp);
    const project = await copyFixture("ts-pnpm-typecheck-fail", tmp);
    const cacheDir = join(tmp, "cache");

    const r = await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "2000",
    });
    expect(r.exitCode).toBe(0);

    const cache = await readCache(cacheDir);
    const checks = cache!.checks as Record<string, { status: string }>;
    expect(checks.lint.status).toBe("ok");
    expect(checks.typecheck.status).toBe("fail");
    expect(checks.test.status).toBe("ok");
  });
});

describe("runner: TS without lint script", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("lint slot is marked skipped", async () => {
    const tmp = await setupTestDirectory("run-ts-nolint");
    tmps.push(tmp);
    const project = await copyFixture("ts-no-lint-script", tmp);
    const cacheDir = join(tmp, "cache");

    const r = await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "3000",
    });
    expect(r.exitCode).toBe(0);

    const cache = await readCache(cacheDir);
    const checks = cache!.checks as Record<string, { status: string }>;
    expect(checks.lint.status).toBe("skipped");
    expect(checks.typecheck.status).toBe("ok");
    expect(checks.test.status).toBe("ok");
  });
});

describe("runner: bare package.json (no tsconfig, no lockfile)", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("creates no cache (project type not detected)", async () => {
    const tmp = await setupTestDirectory("run-ts-bare");
    tmps.push(tmp);
    const project = await copyFixture("ts-no-tsconfig-no-lockfile", tmp);
    const cacheDir = join(tmp, "cache");

    const r = await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "4000",
    });
    expect(r.exitCode).toBe(0);

    const cache = await readCache(cacheDir);
    expect(cache).toBeNull();
  });
});

describe("runner: TTL behavior", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("second invocation within TTL keeps the same last_completed_at", async () => {
    const tmp = await setupTestDirectory("run-ttl");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");

    await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "10000",
    });
    const first = await readCache(cacheDir);
    const firstLint = (
      first!.checks as Record<string, { last_completed_at: number }>
    ).lint.last_completed_at;

    // 5 seconds later, well within 30s lint TTL
    await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "10005",
    });
    const second = await readCache(cacheDir);
    const secondLint = (
      second!.checks as Record<string, { last_completed_at: number }>
    ).lint.last_completed_at;

    expect(secondLint).toBe(firstLint);
  });

  test("expired TTL causes re-run and last_completed_at advances", async () => {
    const tmp = await setupTestDirectory("run-ttl-expire");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");

    await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "20000",
    });
    const first = await readCache(cacheDir);
    const firstLint = (
      first!.checks as Record<string, { last_completed_at: number }>
    ).lint.last_completed_at;

    // 100s later, way past lint TTL (30s)
    await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "20100",
    });
    const second = await readCache(cacheDir);
    const secondLint = (
      second!.checks as Record<string, { last_completed_at: number }>
    ).lint.last_completed_at;

    expect(secondLint).toBe(20100);
    expect(secondLint).toBeGreaterThan(firstLint);
  });

  test("re-running with prior completion does not strand any slot in 'running'", async () => {
    // Regression guard: an earlier two-pass design re-evaluated should_run_slot
    // against the cache after mark_running had written status='running'. A
    // future regression of that shape could mark a due slot running in pass 1
    // then skip it in pass 2, leaving cache in a stuck `running` state with no
    // last_completed_at advancement.
    const tmp = await setupTestDirectory("run-no-strand");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");

    await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "40000",
    });
    // TTL expired well past lint/typecheck (30s) and test (300s).
    await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "41000",
    });

    const cache = await readCache(cacheDir);
    const checks = cache!.checks as Record<
      string,
      { status: string; last_completed_at: number | null }
    >;
    for (const slot of ["lint", "typecheck", "test"] as const) {
      expect(checks[slot].status).not.toBe("running");
      expect(checks[slot].last_completed_at).toBe(41000);
    }
  });

  test("STATUSLINE_TTL_LINT=0 forces re-run within seconds", async () => {
    const tmp = await setupTestDirectory("run-ttl-zero");
    tmps.push(tmp);
    const project = await copyFixture("ts-bun-all-pass", tmp);
    const cacheDir = join(tmp, "cache");

    const env = {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_TTL_LINT: "0",
    };

    await runRunner(project, { ...env, STATUSLINE_NOW_OVERRIDE: "30000" });
    await runRunner(project, { ...env, STATUSLINE_NOW_OVERRIDE: "30001" });

    const cache = await readCache(cacheDir);
    const lint = (
      cache!.checks as Record<string, { last_completed_at: number }>
    ).lint.last_completed_at;
    expect(lint).toBe(30001);
  });
});

const e2eRust = process.env.STATUSLINE_E2E_RUST === "1";
describe.skipIf(!e2eRust)("runner: rust fixture (gated)", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("rust-passing fixture writes ok/ok/ok", async () => {
    const tmp = await setupTestDirectory("run-rust");
    tmps.push(tmp);
    const project = await copyFixture("rust-passing", tmp);
    const cacheDir = join(tmp, "cache");

    const r = await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "50000",
    });
    expect(r.exitCode).toBe(0);

    const cache = await readCache(cacheDir);
    expect(cache!.label).toBe("RS");
    const checks = cache!.checks as Record<string, { status: string }>;
    expect(checks.lint.status).toBe("ok");
    expect(checks.typecheck.status).toBe("ok");
    expect(checks.test.status).toBe("ok");
  }, 120000);
});

const e2eMoonbit = process.env.STATUSLINE_E2E_MOONBIT === "1";
describe.skipIf(!e2eMoonbit)("runner: moonbit fixture (gated)", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("moonbit-passing fixture writes ok/ok/ok", async () => {
    const tmp = await setupTestDirectory("run-moonbit");
    tmps.push(tmp);
    const project = await copyFixture("moonbit-passing", tmp);
    const cacheDir = join(tmp, "cache");

    const r = await runRunner(project, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "60000",
    });
    expect(r.exitCode).toBe(0);

    const cache = await readCache(cacheDir);
    expect(cache!.label).toBe("MB");
  }, 60000);
});

const runRunnerBounded = async (
  projectDir: string,
  boundary: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number }> => {
  const proc = Bun.spawn(["bash", RUNNER, projectDir, boundary], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return { exitCode: await proc.exited };
};

const runRunnerIdentified = async (
  projectDir: string,
  boundary: string,
  dev: string,
  ino?: string,
  env: Record<string, string> = {},
): Promise<{ exitCode: number }> => {
  const proc = Bun.spawn(
    [
      "bash",
      RUNNER,
      projectDir,
      boundary,
      dev,
      ...(ino === undefined ? [] : [ino]),
    ],
    {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  return { exitCode: await proc.exited };
};

const seedRunnableProject = async (
  root: string,
  sentinel: string,
): Promise<void> => {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    join(root, "package.json"),
    JSON.stringify({ scripts: { lint: "bash check.sh" } }),
  );
  await fs.writeFile(join(root, "bun.lock"), "");
  await fs.writeFile(join(root, ".git"), "gitdir: /nonexistent\n");
  await fs.writeFile(
    join(root, "check.sh"),
    `#!/bin/bash\nprintf 'ran\\n' >> ${JSON.stringify(sentinel)}\n`,
    { mode: 0o755 },
  );
};

describe("runner: pinned worktree identity", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("partial identity arguments fail closed for an otherwise runnable project", async () => {
    const tmp = await setupTestDirectory("run-identity-partial");
    tmps.push(tmp);
    const project = join(tmp, "project");
    const sentinel = join(tmp, "ran");
    const cacheDir = join(tmp, "cache");
    await seedRunnableProject(project, sentinel);
    const stats = await fs.lstat(project, { bigint: true });

    const result = await runRunnerIdentified(
      project,
      project,
      stats.dev.toString(10),
      undefined,
      { STATUSLINE_CACHE_DIR: cacheDir },
    );
    expect(result.exitCode).toBe(0);
    expect(await readCache(cacheDir)).toBeNull();
    expect(fs.access(sentinel)).rejects.toThrow();
  });

  test("rejects an otherwise runnable replacement before cwd pinning", async () => {
    const tmp = await setupTestDirectory("run-identity-pre-pin");
    tmps.push(tmp);
    const project = join(tmp, "project");
    const oldSentinel = join(tmp, "old-ran");
    const replacementSentinel = join(tmp, "replacement-ran");
    const cacheDir = join(tmp, "cache");
    await seedRunnableProject(project, oldSentinel);
    const stats = await fs.lstat(project, { bigint: true });
    await fs.rm(project, { recursive: true, force: true });
    await seedRunnableProject(project, replacementSentinel);

    const result = await runRunnerIdentified(
      project,
      project,
      stats.dev.toString(10),
      stats.ino.toString(10),
      { STATUSLINE_CACHE_DIR: cacheDir },
    );
    expect(result.exitCode).toBe(0);
    expect(await readCache(cacheDir)).toBeNull();
    expect(fs.access(oldSentinel)).rejects.toThrow();
    expect(fs.access(replacementSentinel)).rejects.toThrow();
  });

  test("executes only from the pinned inode after pathname replacement", async () => {
    const tmp = await setupTestDirectory("run-identity-post-pin");
    tmps.push(tmp);
    const project = join(tmp, "project");
    const moved = join(tmp, "moved-original");
    const replacement = join(tmp, "replacement-seed");
    const oldSentinel = join(tmp, "old-ran");
    const replacementSentinel = join(tmp, "replacement-ran");
    const cacheDir = join(tmp, "cache");
    const bin = join(tmp, "bin");
    const swapped = join(tmp, "swapped");
    await seedRunnableProject(project, oldSentinel);
    await seedRunnableProject(replacement, replacementSentinel);
    await fs.mkdir(bin);
    const stats = await fs.lstat(project, { bigint: true });
    const realStat = Bun.which("stat");
    const realMv = Bun.which("mv");
    const realCp = Bun.which("cp");
    if (realStat === null || realMv === null || realCp === null) {
      throw new Error("stat, mv, and cp are required for this test");
    }
    await fs.writeFile(
      join(bin, "stat"),
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        'output=$("$REAL_STAT" "$@" 2>/dev/null)',
        "status=$?",
        '[ "$status" -eq 0 ] || exit "$status"',
        String.raw`printf '%s\n' "$output"`,
        "last=${!#}",
        'if [ "$last" = "." ] && [ ! -e "$SWAPPED" ]; then',
        '  : > "$SWAPPED"',
        '  "$REAL_MV" -- "$PROJECT" "$MOVED"',
        '  "$REAL_CP" -R -- "$REPLACEMENT" "$PROJECT"',
        "fi",
      ].join("\n"),
      { mode: 0o755 },
    );

    const result = await runRunnerIdentified(
      project,
      project,
      stats.dev.toString(10),
      stats.ino.toString(10),
      {
        STATUSLINE_CACHE_DIR: cacheDir,
        STATUSLINE_NOW_OVERRIDE: "70000",
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        REAL_STAT: realStat,
        REAL_MV: realMv,
        REAL_CP: realCp,
        PROJECT: project,
        MOVED: moved,
        REPLACEMENT: replacement,
        SWAPPED: swapped,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(await fs.readFile(oldSentinel, "utf8")).toContain("ran");
    expect(fs.access(replacementSentinel)).rejects.toThrow();
    const cache = await readCache(cacheDir);
    const checks = cache?.checks as Record<string, { status: string }>;
    expect(checks.lint.status).toBe("ok");
  });
});

describe("runner: trust boundary", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  // The project marker lives in the (untrusted) parent; the trusted boundary is
  // the child the caller verified. find_project_root ascends to the parent, so
  // the runner must refuse and write no cache.
  const seedParentMarkerChildCwd = async (
    tmp: string,
  ): Promise<{ parent: string; child: string; cacheDir: string }> => {
    const parent = join(tmp, "parent");
    const child = join(parent, "child");
    await fs.mkdir(child, { recursive: true });
    await fs.writeFile(join(parent, "package.json"), JSON.stringify({}));
    await fs.writeFile(join(parent, "bun.lock"), "");
    return { parent, child, cacheDir: join(tmp, "cache") };
  };

  test("refuses when the discovered project root escapes the boundary", async () => {
    const tmp = await setupTestDirectory("run-boundary-escape");
    tmps.push(tmp);
    const { child, cacheDir } = await seedParentMarkerChildCwd(tmp);

    const r = await runRunnerBounded(child, child, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "2000",
    });
    expect(r.exitCode).toBe(0);
    // The parent (untrusted) root's checks must never run.
    expect(await readCache(cacheDir)).toBeNull();
  });

  test("runs when the discovered project root is within the boundary", async () => {
    const tmp = await setupTestDirectory("run-boundary-ok");
    tmps.push(tmp);
    const { parent, child, cacheDir } = await seedParentMarkerChildCwd(tmp);

    const r = await runRunnerBounded(child, parent, {
      STATUSLINE_CACHE_DIR: cacheDir,
      STATUSLINE_NOW_OVERRIDE: "2000",
    });
    expect(r.exitCode).toBe(0);
    const cache = await readCache(cacheDir);
    expect(cache).not.toBeNull();
    expect(cache!.project_root).toBe(parent);
  });
});
