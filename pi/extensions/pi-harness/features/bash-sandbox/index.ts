import { constants } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
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
import {
  PERMISSION_AUDIT_UNAVAILABLE_REASON,
  type PermissionAuditIntegration,
} from "../permission-audit";
import type { PermissionBlockResult } from "../permission-policy/block";
import { buildBashSandboxProfile, type BashSandboxProfile } from "./profile";
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

export const BASH_SANDBOX_PROVIDER_EVENT = "pi-harness:bash-sandbox-provider";

export interface BashSandboxOperationsProvider {
  readonly sandboxedOperations: BashOperations;
  readonly userOperations: BashOperations;
  attach(options?: { readonly commandPrefix?: string }): void;
}

export interface BashSandboxController {
  boundaryFor(toolName: string): BashExecutionBoundary | undefined;
  registerExecutionBoundary(options: {
    blockToolCall: (reason: string) => PermissionBlockResult;
    permissionAudit?: PermissionAuditIntegration;
  }): void;
}

interface BashSandboxState {
  readonly kind: "starting" | "ready" | "failed" | "stopped";
  readonly scratchDirectory?: string;
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
  let state: BashSandboxState = { kind: "stopped" };
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
      "Execute a shell command outside the OS effect sandbox. Use only when ordinary bash was blocked by the sandbox and the requested effect is required. Every call is independently classified and may require user confirmation.",
    promptSnippet:
      "Execute a classifier-gated command outside the OS effect sandbox",
    promptGuidelines: [
      "Use bash_escalated only after ordinary bash fails because an explicitly requested effect is outside the sandbox; never use it merely to avoid a sandbox restriction.",
    ],
  } as unknown as ToolDefLike);

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd ?? cwd;
    approvedHosts.clear();
    deniedHosts.clear();
    state = { kind: "starting" };
    let scratch: string | undefined;
    try {
      scratch = await createTemp(join(tmpdir(), "pi-bash-sandbox-"));
      await setMode(scratch, 0o700);
      state = { kind: "starting", scratchDirectory: scratch };
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

  pi.on("user_bash", () => ({ operations: userOperations }));

  pi.on("session_shutdown", async (_event, ctx) => {
    const previous = state;
    state = { kind: "stopped" };
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
