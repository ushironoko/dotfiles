import { afterEach, describe, expect, test } from "bun:test";
import {
  createEventBus,
  type ExtensionAPI,
  type SessionStartEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_HEARTH_TOOLS_CONFIG,
  parseHearthToolsConfig,
} from "../../pi/extensions/hearth-tools/config";
import { clearProcessEngineForTests } from "../../pi/extensions/hearth-tools/engine";
import {
  HEARTH_TOOL_NAMES,
  setupHearthTools,
} from "../../pi/extensions/hearth-tools/index";

interface FakeEngineOptions {
  cwd?: string;
  trustCache?: boolean;
  warmShell?: boolean;
  bashTimeoutMs?: number;
}

class FakeEngine {
  static constructed: FakeEngineOptions[] = [];
  constructor(options: FakeEngineOptions = {}) {
    FakeEngine.constructed.push(options);
  }
  clearCaches() {
    return { filesInvalidated: 2, walksInvalidated: 1 };
  }
}

const fakePi = () => {
  const sessionStart: Array<
    (event: SessionStartEvent, ctx: Record<string, unknown>) => unknown
  > = [];
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, { handler: Function }>();
  let active = ["read", "bash", "write", "edit"];
  const pi = {
    events: createEventBus(),
    on(event: string, handler: Function) {
      if (event === "session_start") sessionStart.push(handler as never);
    },
    registerTool(tool: ToolDefinition) {
      tools.push(tool);
    },
    registerCommand(name: string, options: { handler: Function }) {
      commands.set(name, options);
    },
    getActiveTools: () => [...active],
    setActiveTools(names: string[]) {
      active = [...names];
    },
    getAllTools: () =>
      tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        promptGuidelines: tool.promptGuidelines,
        sourceInfo: {
          path: `/repo/pi/extensions/hearth-tools/${tool.name}.ts`,
          source: "extension",
          scope: "user",
          origin: "top-level",
        },
      })),
  } as unknown as ExtensionAPI;
  return { pi, sessionStart, tools, commands, active: () => active };
};

const settings = {
  getShellPath: () => "/bin/bash",
  getShellCommandPrefix: () => "set -e",
  getImageAutoResize: () => false,
};

const context = {
  cwd: "/workspace",
  isProjectTrusted: () => true,
  ui: { notify() {} },
};

afterEach(() => {
  clearProcessEngineForTests();
  FakeEngine.constructed = [];
});

describe("hearth-tools config", () => {
  test("defaults to the requested maximum-speed profile", () => {
    expect(parseHearthToolsConfig({})).toEqual(DEFAULT_HEARTH_TOOLS_CONFIG);
  });

  test("rejects malformed and out-of-range fields", () => {
    expect(() => parseHearthToolsConfig({ trustCache: "yes" })).toThrow(
      "trustCache",
    );
    expect(() => parseHearthToolsConfig({ maxCachedFiles: 0 })).toThrow(
      "maxCachedFiles",
    );
    expect(() => parseHearthToolsConfig({ bashTimeoutMs: Infinity })).toThrow(
      "bashTimeoutMs",
    );
  });
});

describe("hearth-tools startup", () => {
  test("fails through the injected fatal boundary when the addon cannot load", async () => {
    await expect(
      setupHearthTools(fakePi().pi, {
        loadModule: async () => {
          throw new Error("private loader path");
        },
        fatal: (message) => {
          throw new Error(`fatal:${message}`);
        },
      }),
    ).rejects.toThrow(
      "fatal:pi-hearth-tools: Hearth native backend is unavailable",
    );
  });

  test("registers five overrides on session start without activating grep", async () => {
    const fake = fakePi();
    await setupHearthTools(fake.pi, {
      loadModule: async () => ({ HearthEngine: FakeEngine as never }),
      getAgentDir: () => "/agent",
      loadConfig: () => ({ ...DEFAULT_HEARTH_TOOLS_CONFIG }),
      createSettings: (() => settings) as never,
      fatal: (message) => {
        throw new Error(message);
      },
    });

    expect(fake.tools).toHaveLength(0);
    await fake.sessionStart[0]?.(
      { reason: "startup" } as SessionStartEvent,
      context,
    );

    expect(fake.tools.map((tool) => tool.name)).toEqual([...HEARTH_TOOL_NAMES]);
    expect(fake.active()).toEqual(["read", "bash", "write", "edit"]);
    expect(FakeEngine.constructed).toHaveLength(1);
    expect(FakeEngine.constructed[0]).toMatchObject({
      cwd: "/workspace",
      trustCache: true,
      warmShell: true,
      bashTimeoutMs: 2_147_483_647,
    });
    expect(fake.commands.has("hearth-clear-cache")).toBe(true);
  });

  test("reuses the process Engine across extension reloads", async () => {
    for (let index = 0; index < 2; index += 1) {
      const fake = fakePi();
      await setupHearthTools(fake.pi, {
        loadModule: async () => ({ HearthEngine: FakeEngine as never }),
        getAgentDir: () => "/agent",
        loadConfig: () => ({ ...DEFAULT_HEARTH_TOOLS_CONFIG }),
        createSettings: (() => settings) as never,
        fatal: (message) => {
          throw new Error(message);
        },
      });
      await fake.sessionStart[0]?.(
        { reason: index === 0 ? "startup" : "reload" } as SessionStartEvent,
        context,
      );
    }
    expect(FakeEngine.constructed).toHaveLength(1);
  });
});
