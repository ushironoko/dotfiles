import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { setupTestDirectory, cleanupTestDirectory } from "../../test-helpers";

const STATUSLINE = resolve(
  import.meta.dir,
  "../../../claude/.claude/statusline.sh",
);
const LIB = resolve(
  import.meta.dir,
  "../../../claude/.claude/hooks/lib/statusline_checks_lib.sh",
);

beforeAll(async () => {
  await fs.access(STATUSLINE);
  await fs.access(LIB);
});

type CheckStatus = "ok" | "fail" | "running" | "skipped";

const writeCache = async (
  cacheDir: string,
  projectRoot: string,
  language: "ts" | "moonbit" | "rust",
  label: "TS" | "MB" | "RS",
  statuses: { lint: CheckStatus; typecheck: CheckStatus; test: CheckStatus },
): Promise<void> => {
  const hash = createHash("sha1").update(projectRoot).digest("hex");
  await fs.mkdir(cacheDir, { recursive: true });
  const buildSlot = (status: CheckStatus) => ({
    status,
    previous_status: null,
    running_since: null,
    last_completed_at: status === "skipped" ? null : 12345,
  });
  const payload = {
    project_root: projectRoot,
    language,
    label,
    updated_at: 12345,
    checks: {
      lint: buildSlot(statuses.lint),
      typecheck: buildSlot(statuses.typecheck),
      test: buildSlot(statuses.test),
    },
  };
  await fs.writeFile(
    join(cacheDir, `${hash}.json`),
    JSON.stringify(payload, null, 2),
  );
};

const runStatusline = async (
  jsonInput: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ stdout: string; exitCode: number }> => {
  const proc = Bun.spawn(["bash", STATUSLINE], {
    env: { ...process.env, STATUSLINE_LIB: LIB, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(jsonInput));
  proc.stdin.end();
  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  return { stdout, exitCode };
};

const setupProject = async (): Promise<{ project: string; cache: string }> => {
  const tmp = await setupTestDirectory("render");
  const project = join(tmp, "proj");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(join(project, "package.json"), "{}");
  await fs.writeFile(join(project, "tsconfig.json"), "{}");
  const cache = join(tmp, "cache");
  return { project, cache };
};

describe("statusline render: checks section", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("renders TS L✓ T✓ X✓ when all checks are ok", async () => {
    const { project, cache } = await setupProject();
    tmps.push(join(project, ".."));
    await writeCache(cache, project, "ts", "TS", {
      lint: "ok",
      typecheck: "ok",
      test: "ok",
    });

    const r = await runStatusline(
      { workspace: { current_dir: project } },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).toContain(
      "TS L\x1b[32m✓\x1b[0m T\x1b[32m✓\x1b[0m X\x1b[32m✓\x1b[0m",
    );
  });

  test("renders fail glyph with red color", async () => {
    const { project, cache } = await setupProject();
    tmps.push(join(project, ".."));
    await writeCache(cache, project, "ts", "TS", {
      lint: "ok",
      typecheck: "fail",
      test: "ok",
    });

    const r = await runStatusline(
      { workspace: { current_dir: project } },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).toContain("T\x1b[31m✗\x1b[0m");
  });

  test("renders running glyph with yellow color", async () => {
    const { project, cache } = await setupProject();
    tmps.push(join(project, ".."));
    await writeCache(cache, project, "ts", "TS", {
      lint: "running",
      typecheck: "ok",
      test: "ok",
    });

    const r = await runStatusline(
      { workspace: { current_dir: project } },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).toContain("L\x1b[33m…\x1b[0m");
  });

  test("renders skipped glyph with grey color", async () => {
    const { project, cache } = await setupProject();
    tmps.push(join(project, ".."));
    await writeCache(cache, project, "ts", "TS", {
      lint: "skipped",
      typecheck: "ok",
      test: "ok",
    });

    const r = await runStatusline(
      { workspace: { current_dir: project } },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).toContain("L\x1b[90m-\x1b[0m");
  });

  test("omits section when all checks are skipped", async () => {
    const { project, cache } = await setupProject();
    tmps.push(join(project, ".."));
    await writeCache(cache, project, "ts", "TS", {
      lint: "skipped",
      typecheck: "skipped",
      test: "skipped",
    });

    const r = await runStatusline(
      { workspace: { current_dir: project } },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).not.toContain("TS L");
    expect(r.stdout).not.toContain("\x1b[90m-\x1b[0m");
  });

  test("omits section when no cache file exists", async () => {
    const { project, cache } = await setupProject();
    tmps.push(join(project, ".."));

    const r = await runStatusline(
      { workspace: { current_dir: project } },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).not.toContain("TS L");
  });

  test("omits section when project type is undetected", async () => {
    const tmp = await setupTestDirectory("render-no-project");
    tmps.push(tmp);
    // No project markers in tmp itself.
    const cache = join(tmp, "cache");

    const r = await runStatusline(
      { workspace: { current_dir: tmp } },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).not.toContain("TS L");
    expect(r.stdout).not.toContain("RS L");
    expect(r.stdout).not.toContain("MB L");
  });

  test("uses Rust label for Cargo.toml projects", async () => {
    const tmp = await setupTestDirectory("render-rust");
    tmps.push(tmp);
    const project = join(tmp, "proj");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(join(project, "Cargo.toml"), "[package]\n");
    const cache = join(tmp, "cache");

    await writeCache(cache, project, "rust", "RS", {
      lint: "ok",
      typecheck: "ok",
      test: "fail",
    });

    const r = await runStatusline(
      { workspace: { current_dir: project } },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).toContain(
      "RS L\x1b[32m✓\x1b[0m T\x1b[32m✓\x1b[0m X\x1b[31m✗\x1b[0m",
    );
  });

  test("falls back from workspace.current_dir to .cwd", async () => {
    const { project, cache } = await setupProject();
    tmps.push(join(project, ".."));
    await writeCache(cache, project, "ts", "TS", {
      lint: "ok",
      typecheck: "ok",
      test: "ok",
    });

    const r = await runStatusline(
      { cwd: project },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).toContain("TS L\x1b[32m✓\x1b[0m");
  });
});
