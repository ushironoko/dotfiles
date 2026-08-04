import { readLocalConfig, updateLocalConfig } from "../../lib/local-config";
import type { PiLike } from "../../lib/pi-like";

export interface UltracodeSettingState {
  autoInjectContext: boolean;
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const configErrorMessage = (error: unknown): string => {
  if (error instanceof SyntaxError) {
    return "pi-harness.local.json could not be parsed";
  }
  return error instanceof Error ? error.message : String(error);
};

export const readUltracodeSetting = (
  configFile: string,
): UltracodeSettingState => {
  try {
    const { root } = readLocalConfig(configFile);
    const { ultracode } = root;
    if (ultracode === undefined) return { autoInjectContext: false };
    if (!isRecord(ultracode)) {
      return {
        autoInjectContext: false,
        error: "ultracode must contain an object",
      };
    }
    const { autoInjectContext } = ultracode;
    if (autoInjectContext === undefined) return { autoInjectContext: false };
    if (typeof autoInjectContext !== "boolean") {
      return {
        autoInjectContext: false,
        error: "ultracode.autoInjectContext must be a boolean",
      };
    }
    return { autoInjectContext };
  } catch (error) {
    return {
      autoInjectContext: false,
      error: configErrorMessage(error),
    };
  }
};

export const writeUltracodeSetting = (
  configFile: string,
  autoInjectContext: boolean,
): void => {
  updateLocalConfig(configFile, (root) => {
    const existing = root.ultracode;
    if (existing !== undefined && !isRecord(existing)) {
      throw new Error("ultracode must contain an object");
    }
    root.ultracode = {
      ...existing,
      autoInjectContext,
    };
    return { changed: true, value: undefined };
  });
};

const usage = "Usage: /settings ultracode on|off|status";

export default function setupUltracodeSettings(
  pi: PiLike,
  configFile: string,
): void {
  // Pi does not expose an API for extending the built-in /settings selector.
  // Intercept only our namespaced form instead of registering a conflicting
  // extension command named "settings"; bare /settings remains built-in.
  pi.on("input", (event, ctx) => {
    const parts = event.text.trim().split(/\s+/).filter(Boolean);
    if (
      parts[0]?.toLowerCase() !== "/settings" ||
      parts[1]?.toLowerCase() !== "ultracode"
    ) {
      return undefined;
    }

    const action = parts[2]?.toLowerCase() ?? "status";
    if (parts.length > 3 || !["on", "off", "status"].includes(action)) {
      ctx.ui.notify(usage, "warning");
      return { action: "handled" };
    }
    if (action === "status") {
      const state = readUltracodeSetting(configFile);
      if (state.error !== undefined) {
        ctx.ui.notify(`Ultracode setting error: ${state.error}`, "error");
      } else {
        ctx.ui.notify(
          `Ultracode context auto-injection: ${state.autoInjectContext ? "on" : "off"}`,
          "info",
        );
      }
      return { action: "handled" };
    }

    const enabled = action === "on";
    try {
      writeUltracodeSetting(configFile, enabled);
      ctx.ui.notify(
        `Ultracode context auto-injection: ${enabled ? "on" : "off"}`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(
        `Could not update the ultracode setting: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
    return { action: "handled" };
  });
}
