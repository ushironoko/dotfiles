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
