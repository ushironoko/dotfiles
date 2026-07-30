import { constants } from "node:fs";
import { access, chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBashTool,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  SandboxAskCallback,
  SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import {
  DEFAULT_BASH_SANDBOX_CONFIG,
  type BashSandboxConfig,
  type HarnessConfig,
} from "../../config";
import type { PiLike, ToolDefLike } from "../../lib/pi-like";
import { validateCwdInSameRepo } from "../../lib/repo-boundary";
import {
  PERMISSION_AUDIT_UNAVAILABLE_REASON,
  type PermissionAuditIntegration,
} from "../permission-audit";
import type { PermissionBlockResult } from "../permission-policy/block";
import {
  buildBashSandboxProfile,
  type BashSandboxProfile,
  withBashSandboxWritableRoots,
} from "./profile";
import {
  CONTROLLED_BASH_PATH,
  createControlledBashOperations,
  type SpawnFunction,
} from "./runtime";

interface SandboxManagerLike {
  initialize(
    config: SandboxRuntimeConfig,
    ask?: SandboxAskCallback,
    enableLogMonitor?: boolean,
  ): Promise<void>;
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    signal?: AbortSignal,
  ): Promise<string>;
  updateConfig(config: SandboxRuntimeConfig): void;
  reset(): Promise<void>;
}

interface SandboxRuntimeModule {
  SandboxManager: SandboxManagerLike;
}

export interface BashExecutionBoundary {
  readonly mode: "sandboxed" | "escalated";
  readonly network: "denied" | "allowlisted" | "unavailable";
  readonly profileFingerprint: string;
}

export interface BashScratchBoundary {
  readonly path: string;
  readonly identity: string;
}

export const BASH_SANDBOX_PROVIDER_EVENT = "pi-harness:bash-sandbox-provider";

export interface BashSandboxOperationsProvider {
  readonly sandboxedOperations: BashOperations;
  readonly userOperations: BashOperations;
  attach(options?: { readonly commandPrefix?: string }): void;
}

export interface BashSandboxController {
  registerWritableWorktree(path: string): Promise<void>;
  revokeWritableWorktree(path: string): Promise<void>;
  boundaryFor(toolName: string): BashExecutionBoundary | undefined;
  registerExecutionBoundary(options: {
    blockToolCall: (reason: string) => PermissionBlockResult;
    permissionAudit?: PermissionAuditIntegration;
  }): void;
}

interface BashSandboxState {
  readonly kind: "starting" | "ready" | "failed" | "stopped";
  readonly scratchDirectory?: string;
  readonly scratchBoundary?: BashScratchBoundary;
  readonly manager?: SandboxManagerLike;
  readonly profile?: BashSandboxProfile;
  readonly reason?: string;
}

interface SetupBashSandboxOptions {
  readonly loadRuntime?: () => Promise<SandboxRuntimeModule>;
  readonly buildProfile?: typeof buildBashSandboxProfile;
  readonly makeTempDirectory?: (prefix: string) => Promise<string>;
  readonly chmodPath?: (path: string, mode: number) => Promise<void>;
  readonly removePath?: (
    path: string,
    options: { recursive: boolean; force: boolean },
  ) => Promise<void>;
  readonly accessPath?: (path: string, mode?: number) => Promise<void>;
  readonly pinScratchDirectory?: (path: string) => Promise<BashScratchBoundary>;
  readonly validateWritableWorktree?: typeof validateCwdInSameRepo;
  readonly spawnFn?: SpawnFunction;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

const loadSandboxRuntime = async (): Promise<SandboxRuntimeModule> =>
  import("@anthropic-ai/sandbox-runtime");

const cloneDefaultConfig = (): BashSandboxConfig => ({
  network: {
    allowedDomains: [...DEFAULT_BASH_SANDBOX_CONFIG.network.allowedDomains],
    deniedDomains: [...DEFAULT_BASH_SANDBOX_CONFIG.network.deniedDomains],
  },
  filesystem: {
    denyRead: [...DEFAULT_BASH_SANDBOX_CONFIG.filesystem.denyRead],
    allowWrite: [...DEFAULT_BASH_SANDBOX_CONFIG.filesystem.allowWrite],
    denyWrite: [...DEFAULT_BASH_SANDBOX_CONFIG.filesystem.denyWrite],
  },
});

const failureReason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const pinScratchDirectory = async (
  path: string,
): Promise<BashScratchBoundary> => {
  const canonicalPath = await realpath(path);
  const stat = await lstat(canonicalPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("bash sandbox scratch is not a safe directory");
  }
  return {
    path: canonicalPath,
    identity: `${stat.dev}:${stat.ino}`,
  };
};

export const setupBashSandbox = (
  pi: PiLike,
  config: HarnessConfig,
  options: SetupBashSandboxOptions = {},
): BashSandboxController => {
  const loadRuntime = options.loadRuntime ?? loadSandboxRuntime;
  const createProfile = options.buildProfile ?? buildBashSandboxProfile;
  const createTemp = options.makeTempDirectory ?? mkdtemp;
  const setMode = options.chmodPath ?? chmod;
  const remove = options.removePath ?? rm;
  const checkAccess = options.accessPath ?? access;
  const pinScratch = options.pinScratchDirectory ?? pinScratchDirectory;
  const validateWritableWorktree =
    options.validateWritableWorktree ?? validateCwdInSameRepo;
  let state: BashSandboxState = { kind: "stopped" };
  let sessionGeneration = 0;
  const dynamicWritableWorktrees = new Set<string>();
  const approvedHosts = new Set<string>();
  const deniedHosts = new Set<string>();
  let backendAttached = false;
  let backendCommandPrefix: string | undefined;

  const networkMode = (): BashExecutionBoundary["network"] => {
    const { profile } = state;
    if (profile === undefined) return "unavailable";
    return profile.networkMode === "allowlisted" || approvedHosts.size > 0
      ? "allowlisted"
      : "denied";
  };
  const scratchDirectory = (): string | undefined => state.scratchDirectory;
  const controlledOptions = {
    getScratchDirectory: scratchDirectory,
    ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
    ...(options.baseEnv === undefined ? {} : { baseEnv: options.baseEnv }),
  };
  const sandboxedOperations = createControlledBashOperations(controlledOptions);
  const escalatedOperations = createControlledBashOperations(controlledOptions);
  const userOperations = createControlledBashOperations({
    ...controlledOptions,
    wrapCommand: async (command, signal) => {
      if (
        state.kind !== "ready" ||
        state.manager === undefined ||
        state.profile === undefined
      ) {
        throw new Error(state.reason ?? "bash sandbox is not ready");
      }
      return state.manager.wrapWithSandbox(
        command,
        CONTROLLED_BASH_PATH,
        undefined,
        signal,
      );
    },
  });

  const provider: BashSandboxOperationsProvider = {
    sandboxedOperations,
    userOperations,
    attach(attachOptions = {}) {
      backendAttached = true;
      backendCommandPrefix = attachOptions.commandPrefix;
    },
  };
  // Cover both extension load orders. A Hearth extension already loaded sees
  // this publication immediately; one loaded later sees the session_start
  // replay after all extensions have registered their listeners.
  pi.events.emit(BASH_SANDBOX_PROVIDER_EVENT, provider);

  const cwd = process.cwd();
  let sessionCwd = cwd;
  const escalatedBash = createBashTool(cwd, {
    operations: escalatedOperations as BashOperations,
    spawnHook: (context) => ({ ...context, cwd: sessionCwd }),
  });
  pi.registerTool({
    ...escalatedBash,
    name: "bash_escalated",
    label: "Bash (outside effect sandbox)",
    description:
      "Execute a shell command outside the OS effect sandbox. Use when the requested effect is already known to require execution outside that sandbox (including managed codex-stage launches), or after ordinary bash is blocked. Calls normally require independent classification or user confirmation.",
    promptSnippet:
      "Execute a permission-gated command outside the OS effect sandbox",
    promptGuidelines: [
      "Use bash_escalated directly for managed codex-stage launches and other effects already known to require execution outside Pi's sandbox; otherwise use it only after ordinary bash is blocked, never merely to avoid a sandbox restriction.",
    ],
  } as unknown as ToolDefLike);

  pi.on("session_start", async (_event, ctx) => {
    sessionGeneration += 1;
    sessionCwd = ctx.cwd ?? cwd;
    dynamicWritableWorktrees.clear();
    approvedHosts.clear();
    deniedHosts.clear();
    state = { kind: "starting" };
    let scratch: string | undefined;
    try {
      scratch = await createTemp(join(tmpdir(), "pi-bash-sandbox-"));
      await setMode(scratch, 0o700);
      const scratchBoundary = await pinScratch(scratch);
      scratch = scratchBoundary.path;
      state = {
        kind: "starting",
        scratchDirectory: scratch,
        scratchBoundary,
      };
      await checkAccess(CONTROLLED_BASH_PATH, constants.X_OK);
      const runtime = await loadRuntime();
      const profile = await createProfile(
        ctx.cwd ?? cwd,
        scratch,
        config.bashSandbox ?? cloneDefaultConfig(),
        ctx.signal,
      );
      const askNetwork: SandboxAskCallback = async ({ host, port }) => {
        const key = `${host}:${port ?? "default"}`;
        if (approvedHosts.has(key)) return true;
        if (deniedHosts.has(key) || !ctx.hasUI) return false;
        const allowed = await ctx.ui.confirm(
          "Sandbox network request",
          `Allow ordinary sandboxed Bash to connect to ${key} for this pi session?`,
          ctx.signal === undefined ? undefined : { signal: ctx.signal },
        );
        (allowed ? approvedHosts : deniedHosts).add(key);
        if (allowed && state.profile !== undefined) {
          ctx.ui.setStatus?.(
            "bash-sandbox",
            `sandbox: ${networkMode()}, ${state.profile.writableRoots.length} write roots`,
          );
        }
        return allowed;
      };
      await runtime.SandboxManager.initialize(
        profile.runtimeConfig,
        askNetwork,
        process.platform === "darwin",
      );
      state = {
        kind: "ready",
        scratchDirectory: scratch,
        scratchBoundary,
        manager: runtime.SandboxManager,
        profile,
      };
      ctx.ui.setStatus?.(
        "bash-sandbox",
        `sandbox: ${profile.networkMode}, ${profile.writableRoots.length} write roots`,
      );
    } catch (error) {
      const reason = failureReason(error);
      state = {
        kind: "failed",
        ...(scratch === undefined ? {} : { scratchDirectory: scratch }),
        reason,
      };
      ctx.ui.setStatus?.("bash-sandbox", "sandbox unavailable");
      ctx.ui.notify(
        `Bash sandbox unavailable; ordinary Bash is blocked: ${reason}`,
        "error",
      );
    }
    pi.events.emit(BASH_SANDBOX_PROVIDER_EVENT, provider);
  });

  pi.on("user_bash", () =>
    // Pi accepts the first user_bash result. Once Hearth has attached, yield
    // ownership so its handler can apply the exclusive gate/cache invalidation
    // even when pi-harness was loaded first.
    backendAttached ? undefined : { operations: userOperations },
  );

  pi.on("session_shutdown", async (_event, ctx) => {
    const previous = state;
    sessionGeneration += 1;
    state = { kind: "stopped" };
    dynamicWritableWorktrees.clear();
    backendAttached = false;
    backendCommandPrefix = undefined;
    sessionCwd = cwd;
    ctx.ui.setStatus?.("bash-sandbox", undefined);
    try {
      await previous.manager?.reset();
    } finally {
      if (previous.scratchDirectory !== undefined) {
        await remove(previous.scratchDirectory, {
          recursive: true,
          force: true,
        });
      }
    }
  });

  pi.registerCommand("sandbox", {
    description: "Show the active Bash effect-sandbox boundary",
    handler: async (_args, ctx) => {
      if (state.kind !== "ready" || state.profile === undefined) {
        ctx.ui.notify(
          `Bash sandbox: ${state.kind}${state.reason === undefined ? "" : ` (${state.reason})`}`,
          state.kind === "failed" ? "error" : "info",
        );
        return;
      }
      ctx.ui.notify(
        [
          "Bash effect sandbox: ready",
          `Network: ${networkMode()} (unknown hosts ask once per session)`,
          `Writable roots: ${state.profile.writableRoots.length}`,
          `Profile: ${state.profile.fingerprint.slice(0, 12)}`,
          "Opaque code may freely affect every configured writable root and approved host.",
        ].join("\n"),
        "info",
      );
    },
  });

  return {
    async registerWritableWorktree(path) {
      const initial = state;
      if (initial.kind !== "ready" || initial.profile === undefined) {
        throw new Error("bash sandbox is not ready for worktree registration");
      }
      const generation = sessionGeneration;
      const boundary = await validateWritableWorktree(
        path,
        initial.profile.cwd,
      );
      if (!boundary.ok) {
        throw new Error(
          `bash sandbox rejected writable worktree: ${boundary.reason}`,
        );
      }
      if (sessionGeneration !== generation) {
        throw new Error(
          "bash sandbox session changed during worktree registration",
        );
      }

      const current = state;
      if (
        current.kind !== "ready" ||
        current.manager === undefined ||
        current.profile === undefined
      ) {
        throw new Error("bash sandbox is not ready for worktree registration");
      }
      const canonicalPath = boundary.canonicalCwd;
      if (current.profile.writableRoots.includes(canonicalPath)) return;

      const profile = withBashSandboxWritableRoots(current.profile, [
        ...current.profile.writableRoots,
        canonicalPath,
      ]);
      current.manager.updateConfig(profile.runtimeConfig);
      dynamicWritableWorktrees.add(canonicalPath);
      state = { ...current, profile };
    },
    async revokeWritableWorktree(path) {
      if (!dynamicWritableWorktrees.has(path)) return;
      const current = state;
      if (
        current.kind !== "ready" ||
        current.manager === undefined ||
        current.profile === undefined
      ) {
        throw new Error("bash sandbox is not ready for worktree revocation");
      }
      const profile = withBashSandboxWritableRoots(
        current.profile,
        current.profile.writableRoots.filter((root) => root !== path),
      );
      current.manager.updateConfig(profile.runtimeConfig);
      dynamicWritableWorktrees.delete(path);
      state = { ...current, profile };
    },
    boundaryFor(toolName) {
      if (toolName !== "bash" && toolName !== "bash_escalated") {
        return undefined;
      }
      const { profile } = state;
      return {
        mode: toolName === "bash" ? "sandboxed" : "escalated",
        network: networkMode(),
        profileFingerprint: profile?.fingerprint ?? "unavailable",
      };
    },
    registerExecutionBoundary({ blockToolCall, permissionAudit }) {
      pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash") return undefined;
        const unavailable = async (
          reason: string,
        ): Promise<PermissionBlockResult> => {
          permissionAudit?.addStage(event.toolCallId, {
            type: "error",
            component: "bash-sandbox",
            phase: "pre-execution",
            verdict: "error",
            reasonCode: "sandbox-unavailable",
          });
          if (permissionAudit === undefined) return blockToolCall(reason);
          return (await permissionAudit.finalizeBlock(
            event.toolCallId,
            "sandbox-unavailable",
          ))
            ? blockToolCall(reason)
            : blockToolCall(PERMISSION_AUDIT_UNAVAILABLE_REASON);
        };
        if (
          !backendAttached ||
          state.kind !== "ready" ||
          state.manager === undefined ||
          state.profile === undefined
        ) {
          return unavailable(
            `bash sandbox backend is not ready: ${state.reason ?? (backendAttached ? state.kind : "not attached")}`,
          );
        }
        const { command } = event.input;
        if (typeof command !== "string") {
          return unavailable("bash sandbox received malformed command input");
        }
        try {
          const commandWithPrefix = backendCommandPrefix
            ? `${backendCommandPrefix}\n${command}`
            : command;
          event.input.command = await state.manager.wrapWithSandbox(
            commandWithPrefix,
            CONTROLLED_BASH_PATH,
            undefined,
            ctx.signal,
          );
          return undefined;
        } catch (error) {
          return unavailable(
            `bash sandbox wrapping failed: ${failureReason(error)}`,
          );
        }
      });
    },
  };
};

export default setupBashSandbox;
export type {
  SetupBashSandboxOptions,
  SandboxManagerLike,
  SandboxRuntimeModule,
};
