import {
  getAgentDir,
  getShellConfig,
  SettingsManager,
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
import { registerHearthReadService } from "./service";

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
const POST_TOOL_INVALIDATION = new Set([
  "write",
  "edit",
  "bash",
  "subagent",
  "workflow",
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
) =>
  [
    createHearthReadDefinition(cwd, runtime.engine, settings, runtime.gate),
    createHearthWriteDefinition(cwd, runtime.engine, runtime.gate),
    createHearthEditDefinition(cwd, runtime.engine, runtime.gate),
    createHearthBashDefinition(cwd, runtime.engine, settings, {
      defaultTimeoutMs: config.bashTimeoutMs,
      gate: runtime.gate,
    }),
    createHearthGrepDefinition(cwd, runtime.engine, runtime.gate),
  ] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

const isHearthSource = (path: string): boolean =>
  /(?:^|[/\\])hearth-tools(?:[/\\]|$)/.test(path);

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
  const service = registerHearthReadService(pi, () => state);
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

      assertNoExistingOverride(pi);
      const activeBefore = pi.getActiveTools();
      const [read, write, edit, bash, grep] = definitions(
        ctx.cwd,
        runtime,
        settings,
        config,
      );
      pi.registerTool(read);
      pi.registerTool(write);
      pi.registerTool(edit);
      pi.registerTool(bash);
      pi.registerTool(grep);
      pi.setActiveTools(activeBefore);
      assertHearthOwnership(pi);

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

  pi.on("before_agent_start", () => {
    if (registered) {
      try {
        assertHearthOwnership(pi);
      } catch {
        fatal(COLLISION_ERROR);
      }
    }
  });

  pi.on("message_start", async (event) => {
    if (isChildCompletion(event)) await clearCaches();
  });

  pi.on("message_end", async (event) => {
    const toolName = completedToolName(event);
    if (toolName !== undefined && POST_TOOL_INVALIDATION.has(toolName)) {
      await clearCaches();
    }
  });

  pi.on("session_shutdown", () => service.dispose());

  pi.on("user_bash", () => {
    if (state === undefined) return;
    return {
      operations: createHearthBashOperations(
        state.runtime.engine,
        state.settings.shell,
        {
          defaultTimeoutMs: state.config.bashTimeoutMs,
          gate: state.runtime.gate,
        },
      ),
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
