/**
 * Claude-compatible statusline feature.
 *
 * - agent_settled launches statusline_checks_run.sh detached, gated by the
 *   trusted-root check because the runner executes repository-defined commands.
 * - session_start and agent_settled refresh read-only git/check state.
 * - a custom footer renders repository, directory, branch, tracked diff,
 *   checks, model, and remaining context in the same order as Claude Code.
 *
 * Cache location and project-root detection mirror statusline_checks_lib.sh so
 * Claude Code and pi share one quality-check cache.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { HarnessConfig } from "../../config";
import { sanitizeChildEnv } from "../../lib/child-env";
import { launchDetached, type DetachedSpawnFunction } from "../../lib/detached";
import type { CtxLike, PiLike, ThemeLike } from "../../lib/pi-like";
import { matchedTrustedRoot } from "../../lib/trust";
import {
  formatModelName,
  type GitStatus,
  parseStatuslineCache,
  remainingContextPercent,
  renderStatusline,
  STATUSLINE_WIDGET_KEY,
  type StatuslineCache,
  type StatuslineSnapshot,
} from "./render";

interface StatuslineDeps {
  cacheDir?: string;
  spawnDetached?: DetachedSpawnFunction;
  getGitStatus?: (cwd: string) => Promise<GitStatus>;
  getBranch?: (cwd: string) => Promise<string | undefined>;
}

const EMPTY_GIT_STATUS: GitStatus = {
  isRepository: false,
  additions: 0,
  deletions: 0,
};

const IDENTITY_THEME: ThemeLike = { fg: (_color, text) => text };

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

const projectLabel = (root: string): string | undefined => {
  if (isRegularFile(join(root, "Cargo.toml"))) return "RS";
  if (isRegularFile(join(root, "moon.mod.json"))) return "MB";
  if (isRegularFile(join(root, "package.json"))) return "TS";
  return undefined;
};

const defaultCacheDir = (): string =>
  process.env.STATUSLINE_CACHE_DIR ??
  join(tmpdir(), "claude-statusline-checks");

const cacheFilePath = (cacheDir: string, root: string): string =>
  join(cacheDir, `${createHash("sha1").update(root).digest("hex")}.json`);

const gitOutput = (cwd: string, args: string[]): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 1_000_000,
        timeout: 2_000,
        env: sanitizeChildEnv(process.env, {}, { cwd }),
      },
      (error, stdout) => {
        resolve(
          error === null && typeof stdout === "string" ? stdout : undefined,
        );
      },
    );
  });

/** Extract the final org/repo pair from SSH, HTTPS, or file-style remotes. */
export const parseOriginRepository = (origin: string): string | undefined => {
  const trimmed = origin.trim().replace(/\.git$/, "");
  if (/^[^/:]+\/[^/:]+$/.test(trimmed)) return trimmed;
  const match = /[/:]([^/:]+\/[^/:]+)$/.exec(trimmed);
  return match?.[1];
};

/** Sum text-file additions/deletions from git diff --numstat output. */
export const parseNumstat = (
  output: string,
): Pick<GitStatus, "additions" | "deletions"> => {
  let additions = 0;
  let deletions = 0;
  for (const line of output.split("\n")) {
    const [added, deleted] = line.split("\t", 3);
    if (added !== undefined && /^\d+$/.test(added)) {
      additions += Number(added);
    }
    if (deleted !== undefined && /^\d+$/.test(deleted)) {
      deletions += Number(deleted);
    }
  }
  return { additions, deletions };
};

const defaultGetGitStatus = async (cwd: string): Promise<GitStatus> => {
  const gitDir = await gitOutput(cwd, ["rev-parse", "--git-dir"]);
  if (gitDir === undefined) return { ...EMPTY_GIT_STATUS };

  const [origin, numstat] = await Promise.all([
    gitOutput(cwd, ["remote", "get-url", "origin"]),
    gitOutput(cwd, [
      "-c",
      "core.fsmonitor=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "HEAD",
    ]),
  ]);
  const diff = parseNumstat(numstat ?? "");
  return {
    isRepository: true,
    repository:
      origin === undefined ? undefined : parseOriginRepository(origin),
    ...diff,
  };
};

const defaultGetBranch = async (cwd: string): Promise<string | undefined> => {
  const branch = await gitOutput(cwd, ["branch", "--show-current"]);
  const trimmed = branch?.trim();
  return trimmed === "" ? undefined : trimmed;
};

export default function setupStatusline(
  pi: PiLike,
  config: HarnessConfig,
  deps: StatuslineDeps = {},
): void {
  const spawnDetached = deps.spawnDetached ?? launchDetached;
  const getGitStatus = deps.getGitStatus ?? defaultGetGitStatus;
  const getBranch = deps.getBranch ?? defaultGetBranch;
  const runner = join(
    config.paths.claudeHooksDir,
    "lib/statusline_checks_run.sh",
  );

  let snapshot: StatuslineSnapshot = {
    directory: "",
    git: { ...EMPTY_GIT_STATUS },
  };
  let activeContext: CtxLike | undefined;
  let footerInstalled = false;
  let requestFooterRender: (() => void) | undefined;

  const installOrRefreshFooter = async (
    ctx: CtxLike,
    allowGit: boolean,
  ): Promise<void> => {
    activeContext = ctx;
    if (ctx.mode === "tui" && ctx.ui.setFooter !== undefined) {
      if (!footerInstalled) {
        // Clear the legacy widget when hot-reloading from an older pi-harness.
        ctx.ui.setWidget?.(STATUSLINE_WIDGET_KEY, undefined);
        ctx.ui.setFooter((tui, theme, footerData) => {
          const requestRender = () => tui.requestRender();
          requestFooterRender = requestRender;
          const unsubscribeBranch = footerData.onBranchChange(requestRender);
          return {
            invalidate() {},
            render(width: number): string[] {
              const current = activeContext;
              return renderStatusline(
                snapshot,
                {
                  branch: footerData.getGitBranch(),
                  modelName: formatModelName(current?.model),
                  remainingContext: remainingContextPercent(
                    current?.getContextUsage?.(),
                  ),
                },
                width,
                theme,
              );
            },
            dispose() {
              unsubscribeBranch();
              if (requestFooterRender === requestRender) {
                requestFooterRender = undefined;
              }
            },
          };
        });
        footerInstalled = true;
      }
      requestFooterRender?.();
      return;
    }

    // RPC supports widgets but intentionally ignores component factories.
    // Git subprocesses remain trust-gated in this fallback too.
    const branch = allowGit
      ? await getBranch(ctx.cwd ?? process.cwd())
      : undefined;
    ctx.ui.setWidget?.(
      STATUSLINE_WIDGET_KEY,
      renderStatusline(
        snapshot,
        {
          branch,
          modelName: formatModelName(ctx.model),
          remainingContext: remainingContextPercent(ctx.getContextUsage?.()),
        },
        Number.MAX_SAFE_INTEGER,
        IDENTITY_THEME,
      ),
    );
  };

  const refresh = async (ctx: CtxLike, launchChecks: boolean) => {
    const cwd = ctx.cwd ?? process.cwd();
    // Pass the canonical trusted root down as a boundary: the runner executes
    // repository-defined commands, and its own find_project_root can otherwise
    // ascend past the trusted root into an untrusted parent.
    const trustedRoot = matchedTrustedRoot(cwd, config.trust);
    if (launchChecks && trustedRoot !== undefined && existsSync(runner)) {
      spawnDetached("bash", [runner, cwd, trustedRoot], { cwd });
    }

    // Print/JSON modes expose no-op UI methods. Preserve lifecycle checks, but
    // avoid paying for git/cache collection that no statusline can consume.
    if (ctx.mode === "print" || ctx.mode === "json") return;

    const root = findProjectRoot(cwd);
    let cache: StatuslineCache | undefined;
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

    let git: GitStatus = { ...EMPTY_GIT_STATUS };
    if (trustedRoot !== undefined) {
      try {
        git = await getGitStatus(cwd);
      } catch {
        git = { ...EMPTY_GIT_STATUS };
      }
    }
    snapshot = {
      directory: basename(cwd),
      git,
      projectLabel: root === undefined ? undefined : projectLabel(root),
      cache,
    };
    await installOrRefreshFooter(ctx, trustedRoot !== undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    await refresh(ctx, false);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await refresh(ctx, true);
  });
}
