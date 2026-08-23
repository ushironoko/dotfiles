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
  createHearthFindDefinition,
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
  createHearthGraphDefinition,
  HearthGraphObserver,
  HEARTH_GRAPH_TOOL_NAME,
  type HearthGraphRuntime,
} from "./graph";
import {
  registerHearthInvalidationService,
  registerHearthReadService,
} from "./service";

export const HEARTH_OVERRIDE_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
] as const;
export const HEARTH_TOOL_NAMES = [
  ...HEARTH_OVERRIDE_TOOL_NAMES,
  HEARTH_GRAPH_TOOL_NAME,
] as const;

const STARTUP_ERROR = "pi-hearth-tools: Hearth native backend is unavailable";
const CONFIG_ERROR = "pi-hearth-tools: invalid local configuration";
const COLLISION_ERROR = "pi-hearth-tools: competing tool override detected";
const RESTART_ERROR =
  "pi-hearth-tools: Engine settings changed; restart pi to apply them";
const HARNESS_CHILD_ENV = "PI_HARNESS_CHILD";
const RESTRICTED_CHILD_TOOLS_ENV = "PI_HARNESS_RESTRICTED_TOOLS";
const RESTRICTED_CHILD_HEARTH_GRAPH_ENV = "PI_HARNESS_RESTRICTED_HEARTH_GRAPH";
const RESTRICTED_CHILD_BUILTINS_ENV = "PI_HARNESS_RESTRICTED_BUILTINS";
const CHILD_RUN_COMPLETION_ENTRY = "pi-harness/child-run-completion";
const BASH_SANDBOX_PROVIDER_EVENT = "pi-harness:bash-sandbox-provider";

interface BashSandboxOperationsProvider {
  readonly sandboxedOperations: BashOperations;
  readonly userOperations: BashOperations;
  attach(options?: { readonly commandPrefix?: string }): void;
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

const usesRestrictedChildTools = (
  env: NodeJS.ProcessEnv = process.env,
): boolean =>
  env[HARNESS_CHILD_ENV] === "1" && env[RESTRICTED_CHILD_TOOLS_ENV] === "1";

const allowsHearthGraphInRestrictedChild = (): boolean =>
  process.env[RESTRICTED_CHILD_HEARTH_GRAPH_ENV] === "1";

const restrictedBuiltinToolNames = (): readonly string[] | undefined => {
  const raw = process.env[RESTRICTED_CHILD_BUILTINS_ENV] ?? "";
  if (raw === "") return [];
  if (Buffer.byteLength(raw, "utf8") > 256) return undefined;
  const names = raw.split(",");
  if (
    names.some(
      (name) =>
        !(HEARTH_OVERRIDE_TOOL_NAMES as readonly string[]).includes(name),
    )
  ) {
    return undefined;
  }
  return [...new Set(names)];
};

export interface HearthSetupDependencies {
  loadModule?: () => Promise<HearthModule>;
  fatal?: Fatal;
  getAgentDir?: () => string;
  loadConfig?: typeof loadHearthToolsConfig;
  createSettings?: typeof SettingsManager.create;
  usesRestrictedChildTools?: () => boolean;
  allowsHearthGraphInRestrictedChild?: () => boolean;
  restrictedBuiltinToolNames?: () => readonly string[] | undefined;
}

export interface RuntimeState {
  runtime: HearthEngineRuntime;
  settings: PiToolSettings;
  config: HearthToolsConfig;
  graph: HearthGraphRuntime;
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

export const guardHearthBashOperations = (
  runtime: HearthEngineRuntime,
  operations: BashOperations,
): BashOperations => ({
  exec(command, cwd, options) {
    return runtime.gate.exclusive(async () => {
      try {
        return await operations.exec(command, cwd, options);
      } finally {
        runtime.engine.clearCaches();
      }
    });
  },
});

const definitions = (
  cwd: string,
  runtime: HearthEngineRuntime,
  settings: PiToolSettings,
  config: HearthToolsConfig,
  graph: HearthGraphRuntime,
  bashOperations?: BashOperations,
) =>
  [
    createHearthReadDefinition(
      cwd,
      runtime.engine,
      settings,
      runtime.gate,
      graph,
    ),
    createHearthWriteDefinition(cwd, runtime.engine, runtime.gate),
    createHearthEditDefinition(cwd, runtime.engine, runtime.gate),
    createHearthBashDefinition(cwd, runtime.engine, settings, {
      defaultTimeoutMs: config.bashTimeoutMs,
      gate: runtime.gate,
      ...(bashOperations === undefined
        ? {}
        : {
            operations: guardHearthBashOperations(runtime, bashOperations),
            commandPrefixHandled: true,
          }),
    }),
    createHearthGrepDefinition(cwd, runtime.engine, runtime.gate, graph),
    createHearthFindDefinition(cwd, runtime.engine, runtime.gate),
    createHearthGraphDefinition(cwd, runtime.engine, runtime.gate, graph),
  ] as const;

const createExternalWriterProtector =
  (runtime: HearthEngineRuntime) => (finished: Promise<void>) =>
    runtime.gate.protectExternalWriter(finished, () =>
      runtime.engine.clearCaches(),
    );

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

const assertNoExistingOverride = (
  pi: ExtensionAPI,
  toolNames: readonly string[] = HEARTH_TOOL_NAMES,
): void => {
  const byName = effectiveTools(pi);
  for (const name of toolNames) {
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

const assertHearthOwnership = (
  pi: ExtensionAPI,
  toolNames: readonly string[] = HEARTH_TOOL_NAMES,
): void => {
  const byName = effectiveTools(pi);
  for (const name of toolNames) {
    const sourcePath = byName.get(name)?.sourceInfo.path;
    if (sourcePath === undefined || !isHearthSource(sourcePath)) {
      throw new Error(COLLISION_ERROR);
    }
  }
};

const assertBuiltinOwnership = (
  pi: ExtensionAPI,
  toolNames: readonly string[],
): void => {
  const byName = effectiveTools(pi);
  for (const name of toolNames) {
    if (byName.get(name)?.sourceInfo.source !== "builtin") {
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
  // Pi's --tools profile installs CLI-owned wrappers around selected builtins.
  // A restricted harness child therefore keeps those builtins. If its profile
  // explicitly requests Hearth's unique graph tool, register only that tool;
  // otherwise avoid loading the native backend at all.
  const restrictedChild = (
    dependencies.usesRestrictedChildTools ?? usesRestrictedChildTools
  )();
  const restrictedChildAllowsGraph = (
    dependencies.allowsHearthGraphInRestrictedChild ??
    allowsHearthGraphInRestrictedChild
  )();
  const fatal = dependencies.fatal ?? defaultFatal;
  const selectedRestrictedBuiltins = (
    dependencies.restrictedBuiltinToolNames ?? restrictedBuiltinToolNames
  )();
  if (restrictedChild && selectedRestrictedBuiltins === undefined) {
    fatal(COLLISION_ERROR);
  }
  const restrictedBuiltins = selectedRestrictedBuiltins ?? [];
  const restrictedChildAllowsBash =
    restrictedChild && restrictedBuiltins.includes("bash");
  const verifyRestrictedBuiltins = (
    toolNames: readonly string[] = restrictedBuiltins,
  ): void => {
    try {
      assertBuiltinOwnership(pi, toolNames);
    } catch {
      fatal(COLLISION_ERROR);
    }
  };
  if (
    restrictedChild &&
    !restrictedChildAllowsGraph &&
    !restrictedChildAllowsBash
  ) {
    pi.on("session_start", () => verifyRestrictedBuiltins());
    pi.on("before_agent_start", () => verifyRestrictedBuiltins());
    pi.on("tool_call", () => verifyRestrictedBuiltins());
    return;
  }
  const ownedToolNames: readonly string[] = restrictedChild
    ? [
        ...(restrictedChildAllowsBash ? ["bash"] : []),
        ...(restrictedChildAllowsGraph ? [HEARTH_GRAPH_TOOL_NAME] : []),
      ]
    : HEARTH_TOOL_NAMES;
  const retainedBuiltinNames = restrictedChildAllowsBash
    ? restrictedBuiltins.filter((name) => name !== "bash")
    : restrictedBuiltins;

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
      if (restrictedChild) {
        assertBuiltinOwnership(pi, restrictedBuiltins);
      }
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
      const graph = new HearthGraphObserver(
        ctx.cwd,
        runtime.engine,
        runtime.gate,
      );
      state = { runtime, settings, config, graph };
      invalidation.activate({
        clearCaches,
        protectExternalWriter: createExternalWriterProtector(runtime),
      });

      assertNoExistingOverride(pi, ownedToolNames);
      const activeBefore = pi.getActiveTools();
      const [read, write, edit, bash, grep, find, hearthGraph] = definitions(
        ctx.cwd,
        runtime,
        settings,
        config,
        graph,
        bashSandboxProvider?.sandboxedOperations,
      );
      if (restrictedChild) {
        if (restrictedChildAllowsBash) pi.registerTool(bash);
        if (restrictedChildAllowsGraph) pi.registerTool(hearthGraph);
      } else {
        pi.registerTool(read);
        pi.registerTool(write);
        pi.registerTool(edit);
        pi.registerTool(bash);
        pi.registerTool(grep);
        pi.registerTool(find);
        pi.registerTool(hearthGraph);
      }
      pi.setActiveTools([
        ...new Set([
          ...activeBefore,
          ...(!restrictedChild || restrictedChildAllowsGraph
            ? [HEARTH_GRAPH_TOOL_NAME]
            : []),
        ]),
      ]);
      assertHearthOwnership(pi, ownedToolNames);
      if (!restrictedChild || restrictedChildAllowsBash) {
        bashSandboxProvider?.attach({
          commandPrefix: settings.shellCommandPrefix,
        });
      }

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
      if (restrictedChild) {
        assertBuiltinOwnership(pi, retainedBuiltinNames);
      }
      assertHearthOwnership(pi, ownedToolNames);
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

  pi.on("session_shutdown", () => {
    state?.graph.dispose();
    service.dispose();
  });

  pi.on("user_bash", () => {
    if (state === undefined || (restrictedChild && !restrictedChildAllowsBash))
      return;
    return {
      operations:
        bashSandboxProvider === undefined
          ? createHearthBashOperations(
              state.runtime.engine,
              state.settings.shell,
              {
                defaultTimeoutMs: state.config.bashTimeoutMs,
                gate: state.runtime.gate,
              },
            )
          : guardHearthBashOperations(
              state.runtime,
              bashSandboxProvider.userOperations,
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

export {
  CONFIG_ERROR,
  COLLISION_ERROR,
  RESTART_ERROR,
  STARTUP_ERROR,
  usesRestrictedChildTools,
};
export default hearthTools;
