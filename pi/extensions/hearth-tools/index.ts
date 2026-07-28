import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAgentDir,
  getShellConfig,
  SettingsManager,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { ShellSpec } from "@hearthdev/napi";
import {
  createHearthBashDefinition,
  createHearthBashOperations,
  createHearthEditDefinition,
  createHearthGrepDefinition,
  createHearthReadDefinition,
  createHearthWriteDefinition,
} from "./adapters";
import { loadHearthToolsConfig, type HearthToolsConfig } from "./config";
import {
  getOrCreateEngineRuntime,
  HearthEngineRestartRequiredError,
  type HearthEngineRuntime,
  type HearthModule,
  type PiToolSettings,
} from "./engine";
import {
  registerHearthInvalidationService,
  registerHearthReadService,
} from "./service";

export const HEARTH_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
] as const;

const STARTUP_ERROR = "pi-hearth-tools: Hearth native backend is unavailable";
const CONFIG_ERROR = "pi-hearth-tools: invalid local configuration";
const COLLISION_ERROR = "pi-hearth-tools: competing tool override detected";
const RESTART_ERROR =
  "pi-hearth-tools: Engine settings changed; restart pi to apply them";
const CHILD_RUN_COMPLETION_ENTRY = "pi-harness/child-run-completion";
const BASH_SANDBOX_PROVIDER_EVENT = "pi-harness:bash-sandbox-provider";

interface BashSandboxOperationsProvider {
  readonly sandboxedOperations: BashOperations;
  readonly userOperations: BashOperations;
  attach(): void;
}
const HEARTH_ENTRY_PATH = fileURLToPath(import.meta.url);
const POST_TOOL_INVALIDATION = new Set([
  "write",
  "edit",
  "bash",
  "subagent",
  "workflow",
  "worktree_create",
  "worktree_remove",
]);

type Fatal = (message: string) => never;

export interface HearthSetupDependencies {
  loadModule?: () => Promise<HearthModule>;
  fatal?: Fatal;
  getAgentDir?: () => string;
  loadConfig?: typeof loadHearthToolsConfig;
  createSettings?: typeof SettingsManager.create;
}

export interface RuntimeState {
  runtime: HearthEngineRuntime;
  settings: PiToolSettings;
  config: HearthToolsConfig;
}

const defaultFatal: Fatal = (message) => {
  console.error(message);
  process.exit(1);
};

const shellSpec = (shellPath?: string): ShellSpec => {
  const resolved = getShellConfig(shellPath);
  return {
    program: resolved.shell,
    args: resolved.args,
    transport: resolved.commandTransport === "stdin" ? "stdin" : "arg",
  } as ShellSpec;
};

const definitions = (
  cwd: string,
  runtime: HearthEngineRuntime,
  settings: PiToolSettings,
  config: HearthToolsConfig,
  bashOperations?: BashOperations,
) =>
  [
    createHearthReadDefinition(cwd, runtime.engine, settings, runtime.gate),
    createHearthWriteDefinition(cwd, runtime.engine, runtime.gate),
    createHearthEditDefinition(cwd, runtime.engine, runtime.gate),
    createHearthBashDefinition(cwd, runtime.engine, settings, {
      defaultTimeoutMs: config.bashTimeoutMs,
      gate: runtime.gate,
      ...(bashOperations === undefined ? {} : { operations: bashOperations }),
    }),
    createHearthGrepDefinition(cwd, runtime.engine, runtime.gate),
  ] as const;

interface ExternalWriterGroup {
  accepting: boolean;
  active: number;
  ready: Promise<void>;
  markReady(): void;
  drained: Promise<void>;
  markDrained(): void;
  complete: Promise<void>;
}

const createExternalWriterProtector = (runtime: HearthEngineRuntime) => {
  let group: ExternalWriterGroup | undefined;

  return (finished: Promise<void>) => {
    if (group === undefined || !group.accepting) {
      let markReady = (): void => {};
      let markDrained = (): void => {};
      const next: ExternalWriterGroup = {
        accepting: true,
        active: 0,
        ready: new Promise<void>((resolve) => {
          markReady = resolve;
        }),
        markReady: () => markReady(),
        drained: new Promise<void>((resolve) => {
          markDrained = resolve;
        }),
        markDrained: () => markDrained(),
        complete: Promise.resolve(),
      };
      next.complete = runtime.gate.exclusive(async () => {
        next.markReady();
        await next.drained;
        runtime.engine.clearCaches();
      });
      const retire = (): void => {
        if (group === next) group = undefined;
      };
      void next.complete.then(retire, retire);
      group = next;
    }

    const current = group;
    current.active += 1;
    const release = (): void => {
      current.active -= 1;
      if (current.active === 0) {
        current.accepting = false;
        current.markDrained();
      }
    };
    void finished.then(release, release);
    return { ready: current.ready, complete: current.complete };
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const canonicalSourcePath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

const isHearthSource = (path: string): boolean =>
  canonicalSourcePath(path) === canonicalSourcePath(HEARTH_ENTRY_PATH);

const effectiveTools = (pi: ExtensionAPI) =>
  new Map(pi.getAllTools().map((tool) => [tool.name, tool]));

const assertNoExistingOverride = (pi: ExtensionAPI): void => {
  const byName = effectiveTools(pi);
  for (const name of HEARTH_TOOL_NAMES) {
    const tool = byName.get(name);
    if (
      tool !== undefined &&
      tool.sourceInfo.source !== "builtin" &&
      !isHearthSource(tool.sourceInfo.path)
    ) {
      throw new Error(COLLISION_ERROR);
    }
  }
};

const assertHearthOwnership = (pi: ExtensionAPI): void => {
  const byName = effectiveTools(pi);
  for (const name of HEARTH_TOOL_NAMES) {
    const sourcePath = byName.get(name)?.sourceInfo.path;
    if (sourcePath === undefined || !isHearthSource(sourcePath)) {
      throw new Error(COLLISION_ERROR);
    }
  }
};

const isChildCompletion = (event: unknown): boolean => {
  if (!isRecord(event) || !isRecord(event.message)) return false;
  return (
    event.message.role === "custom" &&
    event.message.customType === CHILD_RUN_COMPLETION_ENTRY
  );
};

const completedToolName = (event: unknown): string | undefined => {
  if (!isRecord(event) || !isRecord(event.message)) return undefined;
  if (event.message.role !== "toolResult") return undefined;
  return typeof event.message.toolName === "string"
    ? event.message.toolName
    : undefined;
};

const isBackgroundAcceptance = (event: unknown): boolean => {
  if (!isRecord(event) || !isRecord(event.message)) return false;
  const { details } = event.message;
  return (
    isRecord(details) &&
    isRecord(details.background) &&
    details.background.status === "accepted"
  );
};

export const setupHearthTools = async (
  pi: ExtensionAPI,
  dependencies: HearthSetupDependencies = {},
): Promise<void> => {
  const fatal = dependencies.fatal ?? defaultFatal;
  let module: HearthModule;
  try {
    module = await (dependencies.loadModule?.() ?? import("@hearthdev/napi"));
  } catch {
    fatal(STARTUP_ERROR);
  }

  let state: RuntimeState | undefined;
  let registered = false;
  let bashSandboxProvider: BashSandboxOperationsProvider | undefined;
  pi.events.on(BASH_SANDBOX_PROVIDER_EVENT, (value: unknown) => {
    if (value === null || typeof value !== "object") return;
    const candidate = value as Partial<BashSandboxOperationsProvider>;
    if (
      candidate.sandboxedOperations === undefined ||
      candidate.userOperations === undefined ||
      typeof candidate.attach !== "function"
    ) {
      return;
    }
    bashSandboxProvider = candidate as BashSandboxOperationsProvider;
  });
  const service = registerHearthReadService(pi, () => state);
  const invalidation = registerHearthInvalidationService(pi);
  const clearCaches = async (): Promise<void> => {
    const current = state;
    if (current === undefined) return;
    await current.runtime.gate.exclusive(async () => {
      current.runtime.engine.clearCaches();
    });
  };

  pi.on("session_start", (_event, ctx) => {
    if (registered) return;

    let config: HearthToolsConfig;
    try {
      const agentDir = (dependencies.getAgentDir ?? getAgentDir)();
      try {
        config = (dependencies.loadConfig ?? loadHearthToolsConfig)(agentDir);
      } catch {
        throw new Error(CONFIG_ERROR);
      }
      const settingsManager = (
        dependencies.createSettings ?? SettingsManager.create
      )(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
      const settings: PiToolSettings = {
        shellPath: settingsManager.getShellPath(),
        shellCommandPrefix: settingsManager.getShellCommandPrefix(),
        imageAutoResize: settingsManager.getImageAutoResize(),
        shell: shellSpec(settingsManager.getShellPath()),
      };
      const runtime = getOrCreateEngineRuntime(
        module,
        ctx.cwd,
        config,
        settings.shell,
      );
      state = { runtime, settings, config };
      invalidation.activate({
        clearCaches,
        protectExternalWriter: createExternalWriterProtector(runtime),
      });

      assertNoExistingOverride(pi);
      const activeBefore = pi.getActiveTools();
      const [read, write, edit, bash, grep] = definitions(
        ctx.cwd,
        runtime,
        settings,
        config,
        bashSandboxProvider?.sandboxedOperations,
      );
      pi.registerTool(read);
      pi.registerTool(write);
      pi.registerTool(edit);
      pi.registerTool(bash);
      pi.registerTool(grep);
      pi.setActiveTools(activeBefore);
      assertHearthOwnership(pi);
      bashSandboxProvider?.attach();

      registered = true;
      service.announce();
    } catch (error) {
      if (error instanceof HearthEngineRestartRequiredError) {
        fatal(RESTART_ERROR);
      }
      if (error instanceof Error && error.message === COLLISION_ERROR) {
        fatal(COLLISION_ERROR);
      }
      if (error instanceof Error && error.message === CONFIG_ERROR) {
        fatal(CONFIG_ERROR);
      }
      fatal(STARTUP_ERROR);
    }
  });

  const verifyOwnership = (): void => {
    if (!registered) return;
    try {
      assertHearthOwnership(pi);
    } catch {
      fatal(COLLISION_ERROR);
    }
  };
  pi.on("before_agent_start", verifyOwnership);
  pi.on("tool_call", verifyOwnership);

  pi.on("message_start", async (event) => {
    if (isChildCompletion(event)) await clearCaches();
  });

  pi.on("message_end", async (event) => {
    const toolName = completedToolName(event);
    if (toolName === undefined || !POST_TOOL_INVALIDATION.has(toolName)) return;
    if (
      (toolName === "subagent" || toolName === "workflow") &&
      isBackgroundAcceptance(event)
    ) {
      return;
    }
    await clearCaches();
  });

  pi.on("session_shutdown", () => service.dispose());

  pi.on("user_bash", () => {
    if (state === undefined) return;
    return {
      operations:
        bashSandboxProvider?.userOperations ??
        createHearthBashOperations(state.runtime.engine, state.settings.shell, {
          defaultTimeoutMs: state.config.bashTimeoutMs,
          gate: state.runtime.gate,
        }),
    };
  });

  pi.registerCommand("hearth-clear-cache", {
    description: "Clear all Hearth file and walk caches",
    handler: async (_args, ctx) => {
      const current = state;
      if (current === undefined)
        throw new Error("Hearth Engine is not initialized");
      const result = await current.runtime.gate.exclusive(async () =>
        current.runtime.engine.clearCaches(),
      );
      ctx.ui.notify(
        `Hearth cache cleared (${result.filesInvalidated} files, ${result.walksInvalidated} walks)`,
        "info",
      );
    },
  });
};

const hearthTools: ExtensionFactory = async (pi) => setupHearthTools(pi);

export { CONFIG_ERROR, COLLISION_ERROR, RESTART_ERROR, STARTUP_ERROR };
export default hearthTools;
