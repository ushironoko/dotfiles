import { describe, test, expect, afterEach, beforeAll } from "bun:test";
import { join, resolve } from "node:path";
import { promises as fs } from "node:fs";
import {
  setupTestDirectory,
  createTestFile,
  cleanupTestDirectory,
} from "../../test-helpers";

const LIB = resolve(
  import.meta.dir,
  "../../../claude/.claude/hooks/lib/statusline_checks_lib.sh",
);

// shellcheck: lib is the script under test; make sure it exists before the suite runs.
beforeAll(async () => {
  await fs.access(LIB);
});

const callShellFn = async (
  fn: string,
  args: string[] = [],
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const quotedArgs = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const proc = Bun.spawn(
    ["bash", "-c", `source "${LIB}" && ${fn} ${quotedArgs}`],
    {
      env: { ...process.env, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { stdout: stdout.trimEnd(), stderr, exitCode };
};

describe("find_project_root", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("finds Cargo.toml directory", async () => {
    const root = await setupTestDirectory("lib-rust");
    tmps.push(root);
    await createTestFile(join(root, "Cargo.toml"), "[package]\n");
    await fs.mkdir(join(root, "src"), { recursive: true });
    const result = await callShellFn("find_project_root", [join(root, "src")]);
    expect(result.stdout).toBe(root);
  });

  test("finds moon.mod.json directory", async () => {
    const root = await setupTestDirectory("lib-moonbit");
    tmps.push(root);
    await createTestFile(join(root, "moon.mod.json"), "{}");
    const result = await callShellFn("find_project_root", [root]);
    expect(result.stdout).toBe(root);
  });

  test("finds TS root only when tsconfig or lockfile is present", async () => {
    const root = await setupTestDirectory("lib-ts-ok");
    tmps.push(root);
    await createTestFile(join(root, "package.json"), "{}");
    await createTestFile(join(root, "bun.lock"), "{}");
    const result = await callShellFn("find_project_root", [root]);
    expect(result.stdout).toBe(root);
  });

  test("finds TS root with a binary bun.lockb lockfile", async () => {
    const root = await setupTestDirectory("lib-ts-lockb");
    tmps.push(root);
    await createTestFile(join(root, "package.json"), "{}");
    await createTestFile(join(root, "bun.lockb"), "");
    const result = await callShellFn("find_project_root", [root]);
    expect(result.stdout).toBe(root);
  });

  test("skips bare package.json without tsconfig or lockfile", async () => {
    const root = await setupTestDirectory("lib-ts-skip");
    tmps.push(root);
    await createTestFile(join(root, "package.json"), "{}");
    const result = await callShellFn("find_project_root", [root]);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(1);
  });
});

describe("detect_project_type", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("returns rust for Cargo.toml", async () => {
    const root = await setupTestDirectory("type-rust");
    tmps.push(root);
    await createTestFile(join(root, "Cargo.toml"), "");
    const result = await callShellFn("detect_project_type", [root]);
    expect(result.stdout).toBe("rust");
  });

  test("returns moonbit for moon.mod.json", async () => {
    const root = await setupTestDirectory("type-moonbit");
    tmps.push(root);
    await createTestFile(join(root, "moon.mod.json"), "{}");
    const result = await callShellFn("detect_project_type", [root]);
    expect(result.stdout).toBe("moonbit");
  });

  test("returns ts for package.json + tsconfig.json", async () => {
    const root = await setupTestDirectory("type-ts");
    tmps.push(root);
    await createTestFile(join(root, "package.json"), "{}");
    await createTestFile(join(root, "tsconfig.json"), "{}");
    const result = await callShellFn("detect_project_type", [root]);
    expect(result.stdout).toBe("ts");
  });

  test("returns ts for package.json + bun.lockb", async () => {
    const root = await setupTestDirectory("type-ts-lockb");
    tmps.push(root);
    await createTestFile(join(root, "package.json"), "{}");
    await createTestFile(join(root, "bun.lockb"), "");
    const result = await callShellFn("detect_project_type", [root]);
    expect(result.stdout).toBe("ts");
  });

  test("returns empty for package.json only", async () => {
    const root = await setupTestDirectory("type-bare");
    tmps.push(root);
    await createTestFile(join(root, "package.json"), "{}");
    const result = await callShellFn("detect_project_type", [root]);
    expect(result.stdout).toBe("");
  });

  test("rust wins when both Cargo.toml and package.json exist", async () => {
    const root = await setupTestDirectory("type-mixed");
    tmps.push(root);
    await createTestFile(join(root, "Cargo.toml"), "");
    await createTestFile(join(root, "package.json"), "{}");
    await createTestFile(join(root, "tsconfig.json"), "{}");
    const result = await callShellFn("detect_project_type", [root]);
    expect(result.stdout).toBe("rust");
  });
});

describe("project_label", () => {
  test.each([
    ["rust", "RS"],
    ["moonbit", "MB"],
    ["ts", "TS"],
    ["unknown", ""],
  ])("%s -> %s", async (input, expected) => {
    const result = await callShellFn("project_label", [input]);
    expect(result.stdout).toBe(expected);
  });
});

describe("detect_package_manager", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  test("pnpm-lock.yaml -> pnpm", async () => {
    const root = await setupTestDirectory("pm-pnpm");
    tmps.push(root);
    await createTestFile(join(root, "pnpm-lock.yaml"), "");
    const result = await callShellFn("detect_package_manager", [root]);
    expect(result.stdout).toBe("pnpm");
  });

  test("bun.lock -> bun", async () => {
    const root = await setupTestDirectory("pm-bun");
    tmps.push(root);
    await createTestFile(join(root, "bun.lock"), "");
    const result = await callShellFn("detect_package_manager", [root]);
    expect(result.stdout).toBe("bun");
  });

  test("bun.lockb -> bun", async () => {
    const root = await setupTestDirectory("pm-bun-lockb");
    tmps.push(root);
    await createTestFile(join(root, "bun.lockb"), "");
    const result = await callShellFn("detect_package_manager", [root]);
    expect(result.stdout).toBe("bun");
  });

  test("both present -> pnpm wins", async () => {
    const root = await setupTestDirectory("pm-both");
    tmps.push(root);
    await createTestFile(join(root, "pnpm-lock.yaml"), "");
    await createTestFile(join(root, "bun.lock"), "");
    const result = await callShellFn("detect_package_manager", [root]);
    expect(result.stdout).toBe("pnpm");
  });

  test("neither -> empty", async () => {
    const root = await setupTestDirectory("pm-none");
    tmps.push(root);
    const result = await callShellFn("detect_package_manager", [root]);
    expect(result.stdout).toBe("");
  });
});

describe("resolve_script_key", () => {
  const tmps: string[] = [];
  afterEach(async () => {
    await Promise.all(tmps.splice(0).map(cleanupTestDirectory));
  });

  const writePkg = async (root: string, scripts: Record<string, string>) =>
    createTestFile(
      join(root, "package.json"),
      JSON.stringify({ scripts }, null, 2),
    );

  test("lint slot finds 'lint'", async () => {
    const root = await setupTestDirectory("rs-lint");
    tmps.push(root);
    await writePkg(root, { lint: "echo" });
    const r = await callShellFn("resolve_script_key", [
      "lint",
      join(root, "package.json"),
    ]);
    expect(r.stdout).toBe("lint");
  });

  test("typecheck slot prefers 'typecheck' over 'tsc' and 'check'", async () => {
    const root = await setupTestDirectory("rs-tc-1");
    tmps.push(root);
    await writePkg(root, { typecheck: "x", tsc: "y", check: "z" });
    const r = await callShellFn("resolve_script_key", [
      "typecheck",
      join(root, "package.json"),
    ]);
    expect(r.stdout).toBe("typecheck");
  });

  test("typecheck slot falls back to 'tsc'", async () => {
    const root = await setupTestDirectory("rs-tc-2");
    tmps.push(root);
    await writePkg(root, { tsc: "y", check: "z" });
    const r = await callShellFn("resolve_script_key", [
      "typecheck",
      join(root, "package.json"),
    ]);
    expect(r.stdout).toBe("tsc");
  });

  test("typecheck slot falls back to 'check'", async () => {
    const root = await setupTestDirectory("rs-tc-3");
    tmps.push(root);
    await writePkg(root, { check: "z" });
    const r = await callShellFn("resolve_script_key", [
      "typecheck",
      join(root, "package.json"),
    ]);
    expect(r.stdout).toBe("check");
  });

  test("returns empty when no candidate matches", async () => {
    const root = await setupTestDirectory("rs-none");
    tmps.push(root);
    await writePkg(root, { build: "x" });
    const r = await callShellFn("resolve_script_key", [
      "lint",
      join(root, "package.json"),
    ]);
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });
});

describe("status_to_glyph", () => {
  test.each([
    ["ok", "\x1b[32m✓\x1b[0m"],
    ["fail", "\x1b[31m✗\x1b[0m"],
    ["running", "\x1b[33m…\x1b[0m"],
    ["skipped", "\x1b[90m-\x1b[0m"],
  ])("%s status renders %s", async (status, expected) => {
    const result = await callShellFn("status_to_glyph", [status]);
    expect(result.stdout).toBe(expected);
  });
});

describe("should_skip_for_ttl", () => {
  test("returns skip (0) when last + ttl > now", async () => {
    const r = await callShellFn("should_skip_for_ttl", ["1000", "1010", "30"]);
    expect(r.exitCode).toBe(0);
  });

  test("returns run (1) when last + ttl <= now", async () => {
    const r = await callShellFn("should_skip_for_ttl", ["1000", "1040", "30"]);
    expect(r.exitCode).toBe(1);
  });

  test("returns run when last_completed_at is empty", async () => {
    const r = await callShellFn("should_skip_for_ttl", ["", "1000", "30"]);
    expect(r.exitCode).toBe(1);
  });

  test("returns run when last_completed_at is 'null' string", async () => {
    const r = await callShellFn("should_skip_for_ttl", ["null", "1000", "30"]);
    expect(r.exitCode).toBe(1);
  });
});

describe("statusline_now / statusline_ttl / statusline_cache_dir", () => {
  test("statusline_now honors STATUSLINE_NOW_OVERRIDE", async () => {
    const r = await callShellFn("statusline_now", [], {
      STATUSLINE_NOW_OVERRIDE: "12345",
    });
    expect(r.stdout).toBe("12345");
  });

  test("statusline_ttl defaults", async () => {
    expect((await callShellFn("statusline_ttl", ["lint"])).stdout).toBe("30");
    expect((await callShellFn("statusline_ttl", ["typecheck"])).stdout).toBe(
      "30",
    );
    expect((await callShellFn("statusline_ttl", ["test"])).stdout).toBe("300");
  });

  test("statusline_ttl honors env overrides", async () => {
    const r = await callShellFn("statusline_ttl", ["test"], {
      STATUSLINE_TTL_TEST: "5",
    });
    expect(r.stdout).toBe("5");
  });

  test("statusline_cache_dir honors STATUSLINE_CACHE_DIR", async () => {
    const r = await callShellFn("statusline_cache_dir", [], {
      STATUSLINE_CACHE_DIR: "/tmp/abc",
    });
    expect(r.stdout).toBe("/tmp/abc");
  });
});

describe("project_root_hash / cache_file_path / lock_dir_path", () => {
  test("hash is deterministic per path", async () => {
    const a = await callShellFn("project_root_hash", ["/foo/bar"]);
    const b = await callShellFn("project_root_hash", ["/foo/bar"]);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout.length).toBe(40);
  });

  test("different paths produce different hashes", async () => {
    const a = await callShellFn("project_root_hash", ["/foo/bar"]);
    const b = await callShellFn("project_root_hash", ["/foo/baz"]);
    expect(a.stdout).not.toBe(b.stdout);
  });

  test("cache_file_path uses STATUSLINE_CACHE_DIR and .json suffix", async () => {
    const r = await callShellFn("cache_file_path", ["/foo/bar"], {
      STATUSLINE_CACHE_DIR: "/tmp/cd",
    });
    expect(r.stdout.startsWith("/tmp/cd/")).toBe(true);
    expect(r.stdout.endsWith(".json")).toBe(true);
  });

  test("lock_dir_path uses .lockdir suffix", async () => {
    const r = await callShellFn("lock_dir_path", ["/foo/bar"], {
      STATUSLINE_CACHE_DIR: "/tmp/ld",
    });
    expect(r.stdout.endsWith(".lockdir")).toBe(true);
  });
});
