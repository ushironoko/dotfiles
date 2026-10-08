import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { HarnessConfig } from "../../config";
import { sanitizeChildEnv } from "../../lib/child-env";
import type {
  CtxLike,
  PiLike,
  ThemeLike,
  ToolResultEvent,
} from "../../lib/pi-like";
import { isPathWithin, matchedTrustedRoot } from "../../lib/trust";
import {
  matchesFileIdentity,
  type WorktreeIdentityV1,
  worktreeIdentityFromDetails,
} from "../../lib/worktree-identity";
import {
  formatModelName,
  type GitStatus,
  remainingContextPercent,
  renderExtensionStatuses,
  renderStatusline,
  STATUSLINE_WIDGET_KEY,
  type StatuslineSnapshot,
} from "./render";

interface StatuslineDeps {
  getGitStatus?: (cwd: string) => Promise<GitStatus>;
  getBranch?: (cwd: string) => Promise<string | undefined>;
  gitOutput?: (cwd: string, args: string[]) => Promise<string | undefined>;
  validateInheritedWorktree?: (
    sourceCwd: string,
    worktreePath: string,
    identity: WorktreeIdentityV1,
  ) => Promise<boolean>;
}

interface ActiveWorktree {
  path: string;
  branch?: string;
  sourceCwd: string;
  identity?: WorktreeIdentityV1;
}

const successfulToolResultText = (
  event: ToolResultEvent,
): string | undefined => {
  if (event.isError === true || event.content?.length !== 1) return undefined;
  const [block] = event.content;
  if (block?.type !== "text" || typeof block.text !== "string") {
    return undefined;
  }
  const text = block.text.trim();
  return text !== "" && !text.includes("\n") ? text : undefined;
};

const toolInputString = (
  event: ToolResultEvent,
  key: string,
): string | undefined => {
  const { input } = event;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = Reflect.get(input, key);
  return typeof value === "string" && value !== "" ? value : undefined;
};

const createdWorktreePath = (event: ToolResultEvent): string | undefined => {
  if (event.toolName !== "worktree_create") return undefined;
  const path = successfulToolResultText(event);
  return path !== undefined && isAbsolute(path) ? path : undefined;
};

const removedWorktreePath = (event: ToolResultEvent): string | undefined => {
  if (event.toolName !== "worktree_remove") return undefined;
  const text = successfulToolResultText(event);
  const prefix = "Removed worktree: ";
  if (text === undefined || !text.startsWith(prefix)) return undefined;
  const path = text.slice(prefix.length);
  return isAbsolute(path) ? path : undefined;
};

const EMPTY_GIT_STATUS: GitStatus = {
  isRepository: false,
  additions: 0,
  deletions: 0,
};

const IDENTITY_THEME: ThemeLike = { fg: (_color, text) => text };

interface ExtensionStatusFooterData {
  getExtensionStatuses(): ReadonlyMap<string, string>;
}

const hasExtensionStatusData = (
  footerData: object,
): footerData is object & ExtensionStatusFooterData =>
  typeof Reflect.get(footerData, "getExtensionStatuses") === "function";

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

const validateInheritedWorktree = async (
  sourceCwd: string,
  worktreePath: string,
  identity: WorktreeIdentityV1,
  readGit: (
    cwd: string,
    args: string[],
  ) => Promise<string | undefined> = gitOutput,
): Promise<boolean> => {
  try {
    const worktreeDotGit = join(worktreePath, ".git");
    const [canonicalRoot, rootStats, dotGitStats] = await Promise.all([
      realpath(worktreePath),
      lstat(worktreePath, { bigint: true }),
      lstat(worktreeDotGit, { bigint: true }),
    ]);
    if (
      canonicalRoot !== worktreePath ||
      !rootStats.isDirectory() ||
      !dotGitStats.isFile() ||
      !matchesFileIdentity(rootStats, identity.root) ||
      !matchesFileIdentity(dotGitStats, identity.dotGit)
    ) {
      return false;
    }
    const [sourceCommon, worktreeCommon, worktreeTop, worktreeGitDir, list] =
      await Promise.all([
        readGit(sourceCwd, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
        readGit(worktreePath, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
        readGit(worktreePath, [
          "rev-parse",
          "--path-format=absolute",
          "--show-toplevel",
        ]),
        readGit(worktreePath, ["rev-parse", "--absolute-git-dir"]),
        readGit(sourceCwd, ["worktree", "list", "--porcelain"]),
      ]);
    const required = [
      sourceCommon,
      worktreeCommon,
      worktreeTop,
      worktreeGitDir,
      list,
    ];
    if (required.some((value) => value === undefined || value.trim() === "")) {
      return false;
    }

    const [
      canonicalSourceCommon,
      canonicalWorktreeCommon,
      canonicalTop,
      gitDir,
    ] = await Promise.all([
      realpath(sourceCommon?.trim() ?? ""),
      realpath(worktreeCommon?.trim() ?? ""),
      realpath(worktreeTop?.trim() ?? ""),
      realpath(worktreeGitDir?.trim() ?? ""),
    ]);
    const linkedGitDirRoot = join(canonicalSourceCommon, "worktrees");
    const registered = (list ?? "")
      .split("\n")
      .some((line) => line === `worktree ${worktreePath}`);
    if (
      canonicalSourceCommon !== canonicalWorktreeCommon ||
      canonicalTop !== worktreePath ||
      gitDir !== identity.gitDir ||
      gitDir === linkedGitDirRoot ||
      !isPathWithin(gitDir, linkedGitDirRoot) ||
      !registered
    ) {
      return false;
    }

    // Only inspect admin metadata after Git has proved that `gitDir` is a
    // registered linked-worktree directory inside the trusted common dir.
    // This prevents an attacker-controlled replacement path from making us
    // read an arbitrary path (or FIFO) before the containment checks run.
    const backlinkFile = join(gitDir, "gitdir");
    const backlinkStats = await lstat(backlinkFile);
    if (!backlinkStats.isFile() || backlinkStats.size > 4_096) {
      return false;
    }

    const backlinkContents = await readFile(backlinkFile, "utf8");
    const backlink = backlinkContents.trim();
    if (
      backlink === "" ||
      backlink.includes("\0") ||
      backlink.includes("\r") ||
      backlink.includes("\n")
    ) {
      return false;
    }
    const backlinkTarget = isAbsolute(backlink)
      ? backlink
      : resolve(gitDir, backlink);
    const [canonicalDotGit, canonicalBacklink] = await Promise.all([
      realpath(worktreeDotGit),
      realpath(backlinkTarget),
    ]);
    if (canonicalDotGit !== canonicalBacklink) return false;

    const [finalRootStats, finalDotGitStats] = await Promise.all([
      lstat(worktreePath, { bigint: true }),
      lstat(worktreeDotGit, { bigint: true }),
    ]);
    return (
      finalRootStats.isDirectory() &&
      finalDotGitStats.isFile() &&
      matchesFileIdentity(finalRootStats, identity.root) &&
      matchesFileIdentity(finalDotGitStats, identity.dotGit)
    );
  } catch {
    return false;
  }
};

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
  const getGitStatus = deps.getGitStatus ?? defaultGetGitStatus;
  const getBranch = deps.getBranch ?? defaultGetBranch;
  const validateWorktree =
    deps.validateInheritedWorktree ??
    ((sourceCwd, worktreePath, identity) =>
      validateInheritedWorktree(
        sourceCwd,
        worktreePath,
        identity,
        deps.gitOutput ?? gitOutput,
      ));

  let snapshot: StatuslineSnapshot = {
    directory: "",
    git: { ...EMPTY_GIT_STATUS },
  };
  let activeContext: CtxLike | undefined;
  let activeWorktree: ActiveWorktree | undefined;
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
              const lines = renderStatusline(
                snapshot,
                {
                  branch:
                    activeWorktree === undefined
                      ? footerData.getGitBranch()
                      : activeWorktree.branch,
                  modelName: formatModelName(current?.model),
                  remainingContext: remainingContextPercent(
                    current?.getContextUsage?.(),
                  ),
                },
                width,
                theme,
              );
              const extensionStatus = hasExtensionStatusData(footerData)
                ? renderExtensionStatuses(
                    footerData.getExtensionStatuses(),
                    width,
                  )
                : undefined;
              if (extensionStatus !== undefined) lines.push(extensionStatus);
              return lines;
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
    let branch: string | undefined;
    if (activeWorktree !== undefined) {
      ({ branch } = activeWorktree);
    } else if (allowGit) {
      branch = await getBranch(ctx.cwd ?? process.cwd());
    }
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

  const refresh = async (ctx: CtxLike) => {
    if (ctx.mode === "print" || ctx.mode === "json") return;
    const cwd = activeWorktree?.path ?? ctx.cwd ?? process.cwd();
    const directlyTrustedRoot = matchedTrustedRoot(cwd, config.trust);
    let trustedRoot = directlyTrustedRoot;
    if (
      trustedRoot === undefined &&
      activeWorktree?.path === cwd &&
      matchedTrustedRoot(activeWorktree.sourceCwd, config.trust) !== undefined
    ) {
      try {
        if (
          activeWorktree.identity !== undefined &&
          (await validateWorktree(
            activeWorktree.sourceCwd,
            cwd,
            activeWorktree.identity,
          ))
        ) {
          trustedRoot = cwd;
        }
      } catch {
        trustedRoot = undefined;
      }
    }
    let git: GitStatus = { ...EMPTY_GIT_STATUS };
    if (trustedRoot !== undefined) {
      try {
        git = await getGitStatus(cwd);
      } catch {
        git = { ...EMPTY_GIT_STATUS };
      }
      if (activeWorktree?.path === cwd) {
        try {
          activeWorktree.branch = await getBranch(cwd);
        } catch {
          activeWorktree.branch = undefined;
        }
      }
    }
    snapshot = {
      directory: basename(cwd),
      git,
    };
    await installOrRefreshFooter(ctx, trustedRoot !== undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    activeWorktree = undefined;
    await refresh(ctx);
  });
  pi.on("tool_result", async (event, ctx) => {
    const createdPath = createdWorktreePath(event);
    if (createdPath !== undefined) {
      const identity = worktreeIdentityFromDetails(event.details, createdPath);
      activeWorktree = {
        path: createdPath,
        branch: toolInputString(event, "name"),
        sourceCwd: ctx.cwd ?? process.cwd(),
        ...(identity === undefined ? {} : { identity }),
      };
      await refresh(ctx);
      return;
    }

    const removedPath = removedWorktreePath(event);
    if (removedPath !== undefined && removedPath === activeWorktree?.path) {
      activeWorktree = undefined;
      await refresh(ctx);
    }
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await refresh(ctx);
  });
}
