import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PiLike } from "../../lib/pi-like";

export interface UltracodeSettingState {
  autoInjectContext: boolean;
  error?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isMissingFile = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

const readConfig = (
  configFile: string,
): { root: Record<string, unknown>; raw: string | undefined } => {
  let raw: string;
  try {
    raw = readFileSync(configFile, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return { root: {}, raw: undefined };
    throw error;
  }

  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error("pi-harness.local.json must contain an object");
  }
  return { root: parsed, raw };
};

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
    const { root } = readConfig(configFile);
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

const writableConfigPath = (configFile: string): string => {
  let symbolicLink: boolean;
  try {
    symbolicLink = lstatSync(configFile).isSymbolicLink();
  } catch (error) {
    if (isMissingFile(error)) return configFile;
    throw error;
  }
  // Resolve an existing link outside the ENOENT fallback so a dangling link
  // fails instead of being silently replaced by a regular config file.
  return symbolicLink ? realpathSync(configFile) : configFile;
};

const currentRaw = (configFile: string): string | undefined => {
  try {
    return readFileSync(configFile, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
};

export const writeUltracodeSetting = (
  configFile: string,
  autoInjectContext: boolean,
): void => {
  const target = writableConfigPath(configFile);
  const { root, raw } = readConfig(target);
  const existing = root.ultracode;
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error("ultracode must contain an object");
  }
  root.ultracode = {
    ...existing,
    autoInjectContext,
  };

  const directory = dirname(target);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(
    directory,
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let mode = 0o600;
  try {
    mode = statSync(target).mode & 0o777;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }

  const removeTemporary = (): void => {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup: never mask the original write failure.
    }
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(root, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    if (currentRaw(target) !== raw) {
      throw new Error(
        "pi-harness.local.json changed concurrently; retry the command",
      );
    }
    renameSync(temporary, target);
  } catch (error) {
    removeTemporary();
    throw error;
  }
  removeTemporary();
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
