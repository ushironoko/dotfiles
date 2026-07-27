import {
  getAgentDir,
  getShellConfig,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { HearthEngine, ShellSpec } from "@hearthdev/napi";
import {
  createHearthBashDefinition,
  createHearthBashOperations,
  createHearthEditDefinition,
  createHearthGrepDefinition,
  createHearthReadDefinition,
  createHearthWriteDefinition,
} from "./adapters";
import { loadHearthToolsConfig } from "./config";
import {
  getOrCreateEngine,
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

type Fatal = (message: string) => never;

export interface HearthSetupDependencies {
  loadModule?: () => Promise<HearthModule>;
  fatal?: Fatal;
  getAgentDir?: () => string;
  loadConfig?: typeof loadHearthToolsConfig;
  createSettings?: typeof SettingsManager.create;
}

export interface RuntimeState {
  engine: HearthEngine;
  settings: PiToolSettings;
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
  engine: HearthEngine,
  settings: PiToolSettings,
) =>
  [
    createHearthReadDefinition(cwd, engine, settings),
    createHearthWriteDefinition(cwd, engine),
    createHearthEditDefinition(cwd, engine),
    createHearthBashDefinition(cwd, engine, settings),
    createHearthGrepDefinition(cwd, engine),
  ] as const;

const isHearthSource = (path: string): boolean =>
  /(?:^|[/\\])hearth-tools(?:[/\\]|$)/.test(path);

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

  pi.on("session_start", (_event, ctx) => {
    if (registered) return;
    try {
      const agentDir = (dependencies.getAgentDir ?? getAgentDir)();
      const config = (dependencies.loadConfig ?? loadHearthToolsConfig)(
        agentDir,
      );
      const settingsManager = (
        dependencies.createSettings ?? SettingsManager.create
      )(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
      const settings: PiToolSettings = {
        shellPath: settingsManager.getShellPath(),
        shellCommandPrefix: settingsManager.getShellCommandPrefix(),
        imageAutoResize: settingsManager.getImageAutoResize(),
        shell: shellSpec(settingsManager.getShellPath()),
      };
      const engine = getOrCreateEngine(module, ctx.cwd, config, settings.shell);
      state = { engine, settings };

      const activeBefore = pi.getActiveTools();
      const [read, write, edit, bash, grep] = definitions(
        ctx.cwd,
        engine,
        settings,
      );
      pi.registerTool(read);
      pi.registerTool(write);
      pi.registerTool(edit);
      pi.registerTool(bash);
      pi.registerTool(grep);
      pi.setActiveTools(activeBefore);

      const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
      for (const name of HEARTH_TOOL_NAMES) {
        const sourcePath = byName.get(name)?.sourceInfo.path;
        if (sourcePath === undefined || !isHearthSource(sourcePath)) {
          fatal("pi-hearth-tools: competing tool override detected");
        }
      }
      registered = true;
      service.announce();
    } catch {
      fatal(STARTUP_ERROR);
    }
  });

  pi.on("session_shutdown", () => service.dispose());

  pi.on("user_bash", () => {
    if (state === undefined) return;
    return {
      operations: createHearthBashOperations(
        state.engine,
        state.settings.shell,
      ),
    };
  });

  pi.registerCommand("hearth-clear-cache", {
    description: "Clear all Hearth file and walk caches",
    handler: async (_args, ctx) => {
      if (state === undefined)
        throw new Error("Hearth Engine is not initialized");
      const result = state.engine.clearCaches();
      ctx.ui.notify(
        `Hearth cache cleared (${result.filesInvalidated} files, ${result.walksInvalidated} walks)`,
        "info",
      );
    },
  });
};

const hearthTools: ExtensionFactory = async (pi) => setupHearthTools(pi);

export { STARTUP_ERROR };
export default hearthTools;
