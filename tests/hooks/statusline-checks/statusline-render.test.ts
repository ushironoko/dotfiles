import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { setupTestDirectory, cleanupTestDirectory } from "../../test-helpers";

const STATUSLINE = resolve(
  import.meta.dir,
  "../../../claude/.claude/statusline.sh",
);
beforeAll(async () => {
  await fs.access(STATUSLINE);
});

const SESSION_ID = "0f9a2b34-5678-4abc-9def-0123456789ab";

const writeCache = async (
  cacheDir: string,
  projectRoot: string,
): Promise<void> => {
  const hash = createHash("sha1").update(projectRoot).digest("hex");
  await fs.mkdir(cacheDir, { recursive: true });
  const buildSlot = () => ({
    status: "ok",
    previous_status: null,
    running_since: null,
    last_completed_at: 12345,
  });
  const payload = {
    project_root: projectRoot,
    language: "ts",
    label: "TS",
    updated_at: 12345,
    checks: {
      lint: buildSlot(),
      typecheck: buildSlot(),
      test: buildSlot(),
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
    env: { ...process.env, ...env },
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

describe("statusline render: session section", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("renders the session ID in grey", async () => {
    const { project } = await setupProject();
    tmps.push(join(project, ".."));

    const r = await runStatusline({
      workspace: { current_dir: project },
      session_id: SESSION_ID,
    });

    expect(r.stdout).toContain(`\x1b[90m${SESSION_ID}\x1b[0m`);
  });

  test("omits the session section when session_id is absent", async () => {
    const { project } = await setupProject();
    tmps.push(join(project, ".."));

    const r = await runStatusline({ workspace: { current_dir: project } });

    expect(r.stdout.trim()).toBe("proj");
  });

  test("does not render the checks section even with a project and cache", async () => {
    const { project, cache } = await setupProject();
    tmps.push(join(project, ".."));
    await writeCache(cache, project);

    const r = await runStatusline(
      { workspace: { current_dir: project }, session_id: SESSION_ID },
      { STATUSLINE_CACHE_DIR: cache },
    );

    expect(r.stdout).not.toContain("TS L");
    expect(r.stdout).toContain(`\x1b[90m${SESSION_ID}\x1b[0m`);
  });

  test("falls back from workspace.current_dir to .cwd", async () => {
    const { project } = await setupProject();
    tmps.push(join(project, ".."));

    const r = await runStatusline({ cwd: project, session_id: SESSION_ID });

    expect(r.stdout).toContain("proj");
    expect(r.stdout).toContain(`\x1b[90m${SESSION_ID}\x1b[0m`);
  });
});
