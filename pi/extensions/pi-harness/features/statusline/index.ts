/**
 * statusline feature — refreshes the quality-check cache and renders it as a
 * pi widget.
 *
 * - agent_settled launches statusline_checks_run.sh detached (output
 *   discarded), gated by the trusted-root check (S2): the runner executes
 *   repository-defined lint/typecheck/test commands.
 * - session_start and agent_settled render the cache JSON + git branch via
 *   ctx.ui.setWidget. Rendering only reads files, so it is not trust-gated.
 *
 * Cache location and project-root detection mirror
 * statusline_checks_lib.sh so both harnesses share one cache.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HarnessConfig } from "../../config";
import { launchDetached, type DetachedSpawnFunction } from "../../lib/detached";
import type { CtxLike, PiLike } from "../../lib/pi-like";
import { isTrustedRoot } from "../../lib/trust";
import {
  parseStatuslineCache,
  renderStatusline,
  STATUSLINE_WIDGET_KEY,
  type StatuslineCache,
} from "./render";

interface StatuslineDeps {
  cacheDir?: string;
  spawnDetached?: DetachedSpawnFunction;
  getBranch?: (cwd: string) => Promise<string | undefined>;
}

// The shell library tests markers with [ -f ] (regular file, symlinks
// followed); existsSync would also accept directories and make the two
// harnesses disagree on the project root — and therefore on the cache file.
const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** TS port of find_project_root in statusline_checks_lib.sh. */
const findProjectRoot = (start: string): string | undefined => {
  let dir = start;
  for (;;) {
    if (
      isRegularFile(join(dir, "Cargo.toml")) ||
      isRegularFile(join(dir, "moon.mod.json"))
    ) {
      return dir;
    }
    if (
      isRegularFile(join(dir, "package.json")) &&
      (isRegularFile(join(dir, "tsconfig.json")) ||
        isRegularFile(join(dir, "pnpm-lock.yaml")) ||
        isRegularFile(join(dir, "bun.lock")) ||
        isRegularFile(join(dir, "bun.lockb")))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
};

const defaultCacheDir = (): string =>
  process.env.STATUSLINE_CACHE_DIR ??
  join(tmpdir(), "claude-statusline-checks");

const cacheFilePath = (cacheDir: string, root: string): string =>
  join(cacheDir, `${createHash("sha1").update(root).digest("hex")}.json`);

const defaultGetBranch = (cwd: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["branch", "--show-current"],
      { cwd, timeout: 2_000 },
      (error, stdout) => {
        if (error !== null || typeof stdout !== "string") {
          resolve(undefined);
          return;
        }
        const branch = stdout.trim();
        resolve(branch === "" ? undefined : branch);
      },
    );
  });

export default function setupStatusline(
  pi: PiLike,
  config: HarnessConfig,
  deps: StatuslineDeps = {},
): void {
  const spawnDetached = deps.spawnDetached ?? launchDetached;
  const getBranch = deps.getBranch ?? defaultGetBranch;
  const runner = join(
    config.paths.claudeHooksDir,
    "lib/statusline_checks_run.sh",
  );

  const refresh = async (ctx: CtxLike, launchChecks: boolean) => {
    const cwd = ctx.cwd ?? process.cwd();
    if (
      launchChecks &&
      isTrustedRoot(cwd, config.trust) &&
      existsSync(runner)
    ) {
      spawnDetached("bash", [runner, cwd], { cwd });
    }

    if (ctx.ui.setWidget === undefined) return;
    let cache: StatuslineCache | undefined;
    const root = findProjectRoot(cwd);
    if (root !== undefined) {
      const cacheDir = deps.cacheDir ?? defaultCacheDir();
      try {
        cache = parseStatuslineCache(
          await readFile(cacheFilePath(cacheDir, root), "utf8"),
        );
      } catch {
        cache = undefined;
      }
    }
    const branch = await getBranch(cwd);
    ctx.ui.setWidget(STATUSLINE_WIDGET_KEY, renderStatusline(cache, branch));
  };

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx, false);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await refresh(ctx, true);
  });
}
