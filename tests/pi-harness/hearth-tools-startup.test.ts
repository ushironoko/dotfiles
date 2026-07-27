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
import {
  clearProcessEngineForTests,
  HearthEngineGate,
} from "../../pi/extensions/hearth-tools/engine";
import {
  COLLISION_ERROR,
  CONFIG_ERROR,
  HEARTH_TOOL_NAMES,
  RESTART_ERROR,
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
  static clearCount = 0;
  constructor(options: FakeEngineOptions = {}) {
    FakeEngine.constructed.push(options);
  }
  clearCaches() {
    FakeEngine.clearCount += 1;
    return { filesInvalidated: 2, walksInvalidated: 1 };
  }
}

const fakePi = (competingTool?: string) => {
  const handlers = new Map<string, Function[]>();
  const sessionStart: Function[] = [];
  handlers.set("session_start", sessionStart);
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, { handler: Function }>();
  let active = ["read", "bash", "write", "edit"];
  const pi = {
    events: createEventBus(),
    on(event: string, handler: Function) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
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
    getAllTools: () => {
      const winners = new Map<string, Record<string, unknown>>();
      if (competingTool !== undefined) {
        winners.set(competingTool, {
          name: competingTool,
          sourceInfo: {
            path: `/project/extension/${competingTool}.ts`,
            source: "project-extension",
            scope: "project",
            origin: "top-level",
          },
        });
      }
      for (const tool of tools) {
        if (winners.has(tool.name)) continue;
        winners.set(tool.name, {
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
        });
      }
      return [...winners.values()];
    },
  } as unknown as ExtensionAPI;
  const emit = async (
    event: string,
    payload: unknown = {},
    eventContext: Record<string, unknown> = context,
  ): Promise<void> => {
    for (const handler of handlers.get(event) ?? []) {
      await handler(payload, eventContext);
    }
  };
  return {
    pi,
    emit,
    sessionStart,
    tools,
    commands,
    active: () => active,
  };
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
  FakeEngine.clearCount = 0;
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
    expect(() => parseHearthToolsConfig({ trustCaches: false })).toThrow(
      "unknown hearth-tools config key: trustCaches",
    );
  });
});

describe("Hearth Engine access gate", () => {
  test("an exclusive operation waits for readers and blocks later readers", async () => {
    const gate = new HearthEngineGate();
    const order: string[] = [];
    let releaseReader: (() => void) | undefined;
    const heldReader = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });

    const reader = gate.shared(async () => {
      order.push("reader:start");
      await heldReader;
      order.push("reader:end");
    });
    await Promise.resolve();
    const writer = gate.exclusive(async () => {
      order.push("writer");
    });
    const laterReader = gate.shared(async () => {
      order.push("reader:later");
    });
    await Promise.resolve();

    expect(order).toEqual(["reader:start"]);
    releaseReader?.();
    await Promise.all([reader, writer, laterReader]);
    expect(order).toEqual([
      "reader:start",
      "reader:end",
      "writer",
      "reader:later",
    ]);
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
      await fake.emit("session_start", {
        reason: index === 0 ? "startup" : "reload",
      });
    }
    expect(FakeEngine.constructed).toHaveLength(1);
  });

  test("requires a restart when reload changes Engine options", async () => {
    const first = fakePi();
    await setupHearthTools(first.pi, {
      loadModule: async () => ({ HearthEngine: FakeEngine as never }),
      getAgentDir: () => "/agent",
      loadConfig: () => ({ ...DEFAULT_HEARTH_TOOLS_CONFIG }),
      createSettings: (() => settings) as never,
      fatal: (message) => {
        throw new Error(message);
      },
    });
    await first.emit("session_start", { reason: "startup" });

    const reloaded = fakePi();
    await setupHearthTools(reloaded.pi, {
      loadModule: async () => ({ HearthEngine: FakeEngine as never }),
      getAgentDir: () => "/agent",
      loadConfig: () => ({
        ...DEFAULT_HEARTH_TOOLS_CONFIG,
        trustCache: false,
      }),
      createSettings: (() => settings) as never,
      fatal: (message) => {
        throw new Error(message);
      },
    });
    await expect(
      reloaded.emit("session_start", { reason: "reload" }),
    ).rejects.toThrow(RESTART_ERROR);
    expect(FakeEngine.constructed).toHaveLength(1);
  });

  test("fails boundedly for invalid config and an effective override", async () => {
    const invalid = fakePi();
    await setupHearthTools(invalid.pi, {
      loadModule: async () => ({ HearthEngine: FakeEngine as never }),
      getAgentDir: () => "/agent",
      loadConfig: () => {
        throw new Error("sensitive parser detail");
      },
      createSettings: (() => settings) as never,
      fatal: (message) => {
        throw new Error(message);
      },
    });
    await expect(
      invalid.emit("session_start", { reason: "startup" }),
    ).rejects.toThrow(CONFIG_ERROR);

    const collision = fakePi("read");
    await setupHearthTools(collision.pi, {
      loadModule: async () => ({ HearthEngine: FakeEngine as never }),
      getAgentDir: () => "/agent",
      loadConfig: () => ({ ...DEFAULT_HEARTH_TOOLS_CONFIG }),
      createSettings: (() => settings) as never,
      fatal: (message) => {
        throw new Error(message);
      },
    });
    await expect(
      collision.emit("session_start", { reason: "startup" }),
    ).rejects.toThrow(COLLISION_ERROR);
  });

  test("clears caches after mutation hooks and child completion", async () => {
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
    await fake.emit("session_start", { reason: "startup" });

    await fake.emit("message_end", {
      message: { role: "toolResult", toolName: "edit" },
    });
    expect(FakeEngine.clearCount).toBe(1);

    await fake.emit("message_start", {
      message: {
        role: "custom",
        customType: "pi-harness/child-run-completion",
      },
    });
    expect(FakeEngine.clearCount).toBe(2);
  });
});
