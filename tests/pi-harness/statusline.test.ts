import { afterEach, describe, expect, test } from "bun:test";
import { visibleWidth as piVisibleWidth } from "@earendil-works/pi-tui";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupStatusline, {
  parseNumstat,
  parseOriginRepository,
} from "../../pi/extensions/pi-harness/features/statusline/index";
import {
  formatModelName,
  type GitStatus,
  parseStatuslineCache,
  remainingContextPercent,
  renderStatusline,
  STATUSLINE_WIDGET_KEY,
  type StatuslineSnapshot,
  visibleStatuslineWidth,
} from "../../pi/extensions/pi-harness/features/statusline/render";
import type { DetachedSpawnFunction } from "../../pi/extensions/pi-harness/lib/detached";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import type { ThemeLike } from "../../pi/extensions/pi-harness/lib/pi-like";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";
import { createFakePi } from "./fake-pi";

const tempDirectories: string[] = [];
const identityTheme: ThemeLike = { fg: (_color, text) => text };
const ansiTheme: ThemeLike = {
  fg: (color, text) => {
    const code = {
      accent: 36,
      success: 32,
      error: 31,
      warning: 33,
      muted: 90,
      dim: 90,
    }[color];
    return `\u001B[${code}m${text}\u001B[0m`;
  },
};

const tempDirectory = async (prefix: string): Promise<string> => {
  const directory = await setupTestDirectory(prefix);
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(cleanupTestDirectory));
});

const makeConfig = (
  home: string,
  trustedRoots: string[] = [],
): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
    "ask-user-question": true,
  },
  trust: { trustedRoots },
  paths: resolvePaths(home),
});

const waitFor = async (condition: () => Promise<boolean>): Promise<void> => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await condition()) return;
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
};

const sampleCache = (label = "TS") => ({
  project_root: "/repo",
  language: "ts",
  label,
  updated_at: 123,
  checks: {
    lint: { status: "ok" },
    typecheck: { status: "running" },
    test: { status: "fail" },
  },
});

const gitStatus = (overrides: Partial<GitStatus> = {}): GitStatus => ({
  isRepository: true,
  repository: "ushironoko/dotfiles",
  additions: 0,
  deletions: 0,
  ...overrides,
});

const snapshot = (
  overrides: Partial<StatuslineSnapshot> = {},
): StatuslineSnapshot => ({
  directory: "dotfiles",
  git: gitStatus(),
  ...overrides,
});

/** Seed a cache file exactly where the bash runner writes it. */
const seedCache = async (
  cacheDir: string,
  projectRoot: string,
  payload: unknown,
): Promise<void> => {
  const hash = createHash("sha1").update(projectRoot).digest("hex");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(join(cacheDir, `${hash}.json`), JSON.stringify(payload));
};

/** Make a directory look like a TS project so the root detector accepts it. */
const markAsProject = async (root: string): Promise<void> => {
  await fs.writeFile(join(root, "package.json"), "{}");
  await fs.writeFile(join(root, "tsconfig.json"), "{}");
};

const runGit = async (cwd: string, args: string[]): Promise<void> => {
  const process = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
};

describe("Claude-compatible statusline rendering", () => {
  test("renders every Claude field in the same order", () => {
    const lines = renderStatusline(
      snapshot({
        git: gitStatus({ additions: 12, deletions: 3 }),
        projectLabel: "TS",
        cache: sampleCache(),
      }),
      {
        branch: "feat/pi",
        modelName: "Opus 4.8",
        remainingContext: 42,
      },
      200,
      identityTheme,
    );

    expect(lines).toEqual([
      "ushironoko/dotfiles | dotfiles | feat/pi | +12 -3 | TS L✓ T… X✗ | Opus 4.8 | 42%",
    ]);
  });

  test("renders pending checks before the first cache file exists", () => {
    expect(
      renderStatusline(
        snapshot({
          git: {
            isRepository: false,
            additions: 0,
            deletions: 0,
          },
          projectLabel: "TS",
        }),
        {},
        100,
        identityTheme,
      ),
    ).toEqual(["dotfiles | TS L? T? X?"]);
  });

  test("uses Claude-equivalent colors for diffs, checks, model, and context", () => {
    const [line = ""] = renderStatusline(
      snapshot({
        git: gitStatus({ additions: 2, deletions: 1 }),
        projectLabel: "TS",
        cache: sampleCache(),
      }),
      { modelName: "Sonnet", remainingContext: 9 },
      200,
      ansiTheme,
    );

    expect(line).toContain("\u001B[32m+2\u001B[0m");
    expect(line).toContain("\u001B[31m-1\u001B[0m");
    expect(line).toContain("L\u001B[32m✓\u001B[0m");
    expect(line).toContain("T\u001B[33m…\u001B[0m");
    expect(line).toContain("X\u001B[31m✗\u001B[0m");
    expect(line).toContain("\u001B[36mSonnet\u001B[0m");
    expect(line).toContain("\u001B[31m9%\u001B[0m");
  });

  test("omits detached HEAD like git branch --show-current", () => {
    expect(
      renderStatusline(snapshot(), { branch: "detached" }, 100, identityTheme),
    ).toEqual(["ushironoko/dotfiles | dotfiles"]);
  });

  test("sanitizes controls and truncates CJK fields to the component width", () => {
    const [line = ""] = renderStatusline(
      snapshot({
        directory: "日本語-project\nspoofed",
        git: {
          isRepository: false,
          additions: 0,
          deletions: 0,
        },
      }),
      {},
      8,
      identityTheme,
    );

    expect(line).not.toContain("\n");
    expect(line.endsWith("…")).toBe(true);
    expect(visibleStatuslineWidth(line)).toBeLessThanOrEqual(8);
  });

  test("matches pi-tui width for emoji and East Asian wide graphemes", () => {
    for (const directory of ["☕abcde", "\uA960abcde", "\u{17000}abcde"]) {
      const [line = ""] = renderStatusline(
        snapshot({
          directory,
          git: {
            isRepository: false,
            additions: 0,
            deletions: 0,
          },
        }),
        {},
        5,
        identityTheme,
      );

      expect(piVisibleWidth(line)).toBeLessThanOrEqual(5);
    }
  });

  test("matches pi-tui for text emoji and multi-code-point graphemes", () => {
    for (const grapheme of ["❤", "❤️", "가"]) {
      expect(visibleStatuslineWidth(grapheme)).toBe(piVisibleWidth(grapheme));
    }

    const [line = ""] = renderStatusline(
      snapshot({
        directory: "가a",
        git: { isRepository: false, additions: 0, deletions: 0 },
      }),
      {},
      3,
      identityTheme,
    );
    expect(line).toBe("가a");
  });

  test("normalizes model names and reports full-window remaining context", () => {
    expect(
      formatModelName({ id: "claude-opus", name: "Opus 4.8 (1M context)" }),
    ).toBe("Opus 4.8");
    expect(remainingContextPercent({ percent: 70.4 })).toBe(30);
    expect(remainingContextPercent({ percent: 70.5 })).toBe(30);
    expect(remainingContextPercent({ percent: 71.5 })).toBe(28);
    expect(remainingContextPercent({ percent: 110 })).toBe(0);
    expect(remainingContextPercent({ percent: null })).toBeUndefined();
  });

  test("malformed inherited status names fall back without reaching the theme", () => {
    const [line = ""] = renderStatusline(
      snapshot({
        projectLabel: "TS",
        cache: {
          checks: {
            lint: { status: "__proto__" },
            typecheck: { status: "constructor" },
            test: { status: "toString" },
          },
        },
      }),
      {},
      100,
      ansiTheme,
    );

    expect(line).toContain(
      "L\u001B[90m?\u001B[0m T\u001B[90m?\u001B[0m X\u001B[90m?\u001B[0m",
    );
  });

  test("parses cache, remote, and numstat inputs defensively", () => {
    expect(parseStatuslineCache("not json")).toBeUndefined();
    expect(parseStatuslineCache('"string"')).toBeUndefined();
    expect(parseStatuslineCache('{"label":"TS"}')).toEqual({ label: "TS" });
    expect(parseOriginRepository("git@github.com:org/repo.git\n")).toBe(
      "org/repo",
    );
    expect(parseOriginRepository("https://github.com/org/repo.git")).toBe(
      "org/repo",
    );
    expect(parseNumstat("3\t2\ta.ts\n-\t-\timage.png\n4\t0\tb.ts\n")).toEqual({
      additions: 7,
      deletions: 2,
    });
  });
});

describe("pi-harness statusline lifecycle", () => {
  test("inherits trust only while a registered linked worktree stays intact", async () => {
    const home = await tempDirectory("pi-statusline-worktree-trust");
    const project = join(home, "repo");
    const worktree = join(home, "topic-worktree");
    const replacement = join(home, "replacement");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    await runGit(project, ["init", "-b", "main"]);
    await runGit(project, ["config", "user.email", "test@example.com"]);
    await runGit(project, ["config", "user.name", "Status Test"]);
    await runGit(project, ["add", "."]);
    await runGit(project, ["commit", "-m", "initial"]);
    await runGit(project, ["worktree", "add", "-b", "topic", worktree]);
    const canonicalProject = await fs.realpath(project);
    const canonicalWorktree = await fs.realpath(worktree);
    const runner = join(
      resolvePaths(home).claudeHooksDir,
      "lib/statusline_checks_run.sh",
    );
    await fs.mkdir(dirname(runner), { recursive: true });
    await fs.writeFile(runner, "#!/bin/bash\nexit 0\n", { mode: 0o755 });

    const gitReads: string[] = [];
    const checkLaunches: string[][] = [];
    const pi = createFakePi({ cwd: canonicalProject, gitBranch: "main" });
    setupStatusline(pi, makeConfig(home, [canonicalProject]), {
      cacheDir: join(home, "cache"),
      getGitStatus: async (cwd) => {
        gitReads.push(cwd);
        return gitStatus({ repository: undefined });
      },
      getBranch: async (cwd) => (cwd === canonicalWorktree ? "topic" : "main"),
      spawnDetached: (_command, args) => {
        checkLaunches.push(args);
      },
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    await pi.emitToolResult({
      type: "tool_result",
      toolName: "worktree_create",
      input: { name: "topic" },
      content: [{ type: "text", text: canonicalWorktree }],
      isError: false,
    });
    await pi.emitAgentSettled();
    expect(gitReads).toEqual([
      canonicalProject,
      canonicalWorktree,
      canonicalWorktree,
    ]);
    expect(checkLaunches).toEqual([
      [runner, canonicalWorktree, canonicalWorktree],
    ]);

    // Git still has stale registration metadata, but neither a plain
    // replacement nor a retargeted symlink may inherit trust.
    await fs.rm(worktree, { recursive: true, force: true });
    await fs.mkdir(worktree);
    await pi.emitAgentSettled();
    await fs.rm(worktree, { recursive: true, force: true });
    await fs.mkdir(replacement);
    await fs.symlink(replacement, worktree, "dir");
    await pi.emitAgentSettled();

    expect(gitReads).toEqual([
      canonicalProject,
      canonicalWorktree,
      canonicalWorktree,
    ]);
    expect(checkLaunches).toEqual([
      [runner, canonicalWorktree, canonicalWorktree],
    ]);
  });

  test("session_start installs a dynamic custom footer from cache", async () => {
    const home = await tempDirectory("pi-statusline-render");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    const cacheDir = join(home, "cache");
    await seedCache(cacheDir, project, sampleCache("BUN"));

    const pi = createFakePi({
      cwd: project,
      gitBranch: "feat/pi",
      model: { id: "claude-opus", name: "Opus 4.8 (1M context)" },
      contextUsage: { percent: 58.2 },
    });
    setupStatusline(pi, makeConfig(home, [project]), {
      cacheDir,
      getGitStatus: async () =>
        gitStatus({ repository: "acme/repo", additions: 5, deletions: 2 }),
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    expect(pi.renderFooter(200)).toEqual([
      "acme/repo | repo | feat/pi | +5 -2 | BUN L✓ T… X✗ | Opus 4.8 | 42%",
    ]);
    expect(pi.widgets.get(STATUSLINE_WIDGET_KEY)).toBeUndefined();
    expect(pi.footerRenderRequests).toBeGreaterThan(0);
  });

  test("branch, model, and context updates are reflected without reinstalling", async () => {
    const home = await tempDirectory("pi-statusline-dynamic");
    const plainDirectory = join(home, "plain");
    await fs.mkdir(plainDirectory, { recursive: true });
    const pi = createFakePi({
      cwd: plainDirectory,
      gitBranch: "main",
      model: { id: "model-a", name: "Model A" },
      contextUsage: { percent: 20 },
    });
    setupStatusline(pi, makeConfig(home, [plainDirectory]), {
      getGitStatus: async () => gitStatus({ repository: undefined }),
    });
    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    const requestsBeforeBranchChange = pi.footerRenderRequests;

    pi.setGitBranch("topic");
    pi.ctx.model = { id: "model-b", name: "Model B" };
    pi.setContextUsage({ percent: 91 });

    expect(pi.footerRenderRequests).toBeGreaterThan(requestsBeforeBranchChange);
    expect(pi.renderFooter(100)).toEqual(["plain | topic | Model B | 9%"]);
  });

  test("follows a created worktree until that active worktree is removed", async () => {
    const home = await tempDirectory("pi-statusline-worktree");
    const project = join(home, "repo");
    const worktree = join(home, "topic-worktree");
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await markAsProject(project);
    await markAsProject(worktree);

    const gitReads: string[] = [];
    const checkLaunches: string[][] = [];
    let worktreeBranch = "topic";
    let worktreeValid = true;
    const runner = join(
      resolvePaths(home).claudeHooksDir,
      "lib/statusline_checks_run.sh",
    );
    await fs.mkdir(dirname(runner), { recursive: true });
    await fs.writeFile(runner, "#!/bin/bash\nexit 0\n", { mode: 0o755 });

    const pi = createFakePi({ cwd: project, gitBranch: "main" });
    setupStatusline(pi, makeConfig(home, [project]), {
      cacheDir: join(home, "cache"),
      getGitStatus: async (cwd) => {
        gitReads.push(cwd);
        return gitStatus({ repository: undefined });
      },
      getBranch: async (cwd) => (cwd === worktree ? worktreeBranch : "main"),
      spawnDetached: (_command, args) => {
        checkLaunches.push(args);
      },
      validateInheritedWorktree: async () => worktreeValid,
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    await pi.emitToolResult({
      type: "tool_result",
      toolName: "worktree_create",
      input: { name: "topic" },
      content: [{ type: "text", text: worktree }],
      isError: false,
    });
    expect(pi.renderFooter(100)).toEqual([
      "topic-worktree | topic | TS L? T? X?",
    ]);

    // The built-in footer provider remains tied to the session checkout. Its
    // stale update must not replace the active worktree branch.
    pi.setGitBranch("stale-main");
    worktreeBranch = "topic-next";
    await pi.emitAgentSettled();
    expect(pi.renderFooter(100)).toEqual([
      "topic-worktree | topic-next | TS L? T? X?",
    ]);
    expect(checkLaunches).toEqual([[runner, worktree, worktree]]);

    // A later identity failure revokes inherited trust before any Git read or
    // repository-defined check can run, while retaining the last safe branch.
    worktreeValid = false;
    worktreeBranch = "replacement-branch";
    await pi.emitAgentSettled();
    expect(pi.renderFooter(100)).toEqual([
      "topic-worktree | topic-next | TS L? T? X?",
    ]);
    expect(checkLaunches).toEqual([[runner, worktree, worktree]]);
    expect(gitReads).toEqual([project, worktree, worktree]);

    await pi.emitToolResult({
      type: "tool_result",
      toolName: "worktree_remove",
      input: { path: worktree, confirmed: true },
      content: [{ type: "text", text: `Removed worktree: ${worktree}` }],
      isError: false,
    });
    expect(pi.renderFooter(100)).toEqual(["repo | stale-main | TS L? T? X?"]);
    expect(gitReads).toEqual([project, worktree, worktree, project]);
  });

  test("default git collection renders origin and tracked diff totals", async () => {
    const home = await tempDirectory("pi-statusline-git");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    await fs.writeFile(join(project, "source.txt"), "one\ntwo\n");
    await runGit(project, ["init", "-b", "main"]);
    await runGit(project, ["config", "user.email", "test@example.com"]);
    await runGit(project, ["config", "user.name", "Status Test"]);
    await runGit(project, ["add", "."]);
    await runGit(project, ["commit", "-m", "initial"]);
    await runGit(project, [
      "remote",
      "add",
      "origin",
      "git@github.com:owner/project.git",
    ]);
    await fs.writeFile(
      join(project, "source.txt"),
      "one changed\ntwo\nthree\n",
    );

    const pi = createFakePi({ cwd: project, gitBranch: "main" });
    setupStatusline(pi, makeConfig(home, [project]), {
      cacheDir: join(home, "cache"),
    });
    await pi.emitSessionStart({ type: "session_start", reason: "startup" });

    expect(pi.renderFooter(200)).toEqual([
      "owner/project | repo | main | +2 -1 | TS L? T? X?",
    ]);
  });

  test("agent_settled launches the checks runner detached for a trusted root", async () => {
    const home = await tempDirectory("pi-statusline-run");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    const captureFile = join(home, "runner-called.txt");
    const runner = join(
      resolvePaths(home).claudeHooksDir,
      "lib/statusline_checks_run.sh",
    );
    await fs.mkdir(dirname(runner), { recursive: true });
    await fs.writeFile(
      runner,
      [
        "#!/bin/bash",
        `printf '%s\\n' "$1" > "${captureFile}.tmp"`,
        `mv "${captureFile}.tmp" "${captureFile}"`,
      ].join("\n"),
      { mode: 0o755 },
    );

    const pi = createFakePi({ cwd: project });
    setupStatusline(pi, makeConfig(home, [project]), {
      cacheDir: join(home, "cache"),
      getGitStatus: async () => ({
        isRepository: false,
        additions: 0,
        deletions: 0,
      }),
    });

    await pi.emitAgentSettled();
    await waitFor(async () => {
      try {
        await fs.access(captureFile);
        return true;
      } catch {
        return false;
      }
    });
    expect((await fs.readFile(captureFile, "utf8")).trim()).toBe(project);
  });

  test("passes the canonical trusted root to the runner as a boundary", async () => {
    const home = await tempDirectory("pi-statusline-boundary");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    const captureFile = join(home, "runner-args.txt");
    const runner = join(
      resolvePaths(home).claudeHooksDir,
      "lib/statusline_checks_run.sh",
    );
    await fs.mkdir(dirname(runner), { recursive: true });
    await fs.writeFile(
      runner,
      [
        "#!/bin/bash",
        `printf '%s\\n%s\\n' "$1" "$2" > "${captureFile}.tmp"`,
        `mv "${captureFile}.tmp" "${captureFile}"`,
      ].join("\n"),
      { mode: 0o755 },
    );

    const pi = createFakePi({ cwd: project });
    setupStatusline(pi, makeConfig(home, [project]), {
      cacheDir: join(home, "cache"),
      getGitStatus: async () => ({
        isRepository: false,
        additions: 0,
        deletions: 0,
      }),
    });

    await pi.emitAgentSettled();
    await waitFor(async () => {
      try {
        await fs.access(captureFile);
        return true;
      } catch {
        return false;
      }
    });
    const [cwdArgument, boundaryArgument] = (
      await fs.readFile(captureFile, "utf8")
    )
      .trim()
      .split("\n");
    expect(cwdArgument).toBe(project);
    expect(await fs.realpath(boundaryArgument ?? "")).toBe(
      await fs.realpath(project),
    );
  });

  test("an untrusted root never launches the runner but still renders", async () => {
    const home = await tempDirectory("pi-statusline-untrusted");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    const cacheDir = join(home, "cache");
    await seedCache(cacheDir, project, sampleCache());
    const launches: string[] = [];
    const spawnDetached: DetachedSpawnFunction = (command) => {
      launches.push(command);
    };

    let gitReads = 0;
    const pi = createFakePi({ cwd: project, gitBranch: "main" });
    setupStatusline(pi, makeConfig(home), {
      cacheDir,
      spawnDetached,
      getGitStatus: async () => {
        gitReads += 1;
        return gitStatus({ repository: undefined });
      },
    });

    await pi.emitAgentSettled();
    expect(launches).toHaveLength(0);
    expect(gitReads).toBe(0);
    expect(pi.renderFooter(100)).toEqual(["repo | main | TS L✓ T… X✗"]);
  });

  test("directory-valued project markers are ignored like the shell -f test", async () => {
    const home = await tempDirectory("pi-statusline-dirmarker");
    const project = join(home, "repo");
    await fs.mkdir(join(project, "package.json"), { recursive: true });
    await fs.mkdir(join(project, "tsconfig.json"), { recursive: true });
    await fs.mkdir(join(project, "Cargo.toml"), { recursive: true });
    const cacheDir = join(home, "cache");
    await seedCache(cacheDir, project, sampleCache());

    const pi = createFakePi({ cwd: project, gitBranch: "main" });
    setupStatusline(pi, makeConfig(home), {
      cacheDir,
      getGitStatus: async () => gitStatus({ repository: undefined }),
    });
    await pi.emitSessionStart({ type: "session_start", reason: "startup" });

    expect(pi.renderFooter(100)).toEqual(["repo | main"]);
  });

  test("skips git and UI collection in print and JSON modes", async () => {
    const home = await tempDirectory("pi-statusline-headless");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);

    for (const mode of ["print", "json"] as const) {
      let gitReads = 0;
      let branchReads = 0;
      const pi = createFakePi({ cwd: project, mode });
      setupStatusline(pi, makeConfig(home, [project]), {
        getGitStatus: async () => {
          gitReads += 1;
          return gitStatus();
        },
        getBranch: async () => {
          branchReads += 1;
          return "main";
        },
      });

      await pi.emitSessionStart({ type: "session_start", reason: "startup" });
      await pi.emitAgentSettled();
      expect(gitReads).toBe(0);
      expect(branchReads).toBe(0);
      expect(pi.renderFooter(100)).toBeUndefined();
      expect(pi.widgets.size).toBe(0);
    }
  });

  test("uses the widget fallback in RPC mode", async () => {
    const home = await tempDirectory("pi-statusline-fallback");
    const project = join(home, "repo");
    await fs.mkdir(project, { recursive: true });
    await markAsProject(project);
    const pi = createFakePi({ cwd: project, mode: "rpc" });
    setupStatusline(pi, makeConfig(home, [project]), {
      cacheDir: join(home, "cache"),
      getGitStatus: async () => gitStatus({ repository: undefined }),
      getBranch: async () => "main",
    });

    await pi.emitSessionStart({ type: "session_start", reason: "startup" });
    expect(pi.widgets.get(STATUSLINE_WIDGET_KEY)).toEqual([
      "repo | main | TS L? T? X?",
    ]);
  });
});
