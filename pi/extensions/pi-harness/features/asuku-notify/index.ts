/**
 * asuku-notify feature — bridges pi's confirmations and completion state to
 * the asuku desktop app. Permission requests keep pi's original TUI dialog
 * visible while asuku handles the same request; the first explicit decision
 * wins. Completion notifications remain detached and best-effort.
 */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { HarnessConfig } from "../../config";
import { launchDetached, type DetachedSpawnFunction } from "../../lib/detached";
import { sanitizeChildEnv } from "../../lib/child-env";
import type {
  CtxLike,
  DialogOptionsLike,
  PiLike,
  UiLike,
} from "../../lib/pi-like";

const ASUKU_BINARY = "/Applications/asuku.app/Contents/MacOS/asuku-hook";
const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;
const PERMISSION_TERM_GRACE_MS = 1_000;
const MAX_PERMISSION_OUTPUT_BYTES = 64 * 1024;

interface AsukuPermissionPayload {
  session_id: string;
  hook_event_name: "PermissionRequest";
  tool_name: "PiConfirm";
  tool_input: {
    title: string;
    message: string;
  };
  cwd: string;
  permission_mode: "default";
}

interface PermissionRequestOptions {
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
}

export type PermissionRequestRunner = (
  binary: string,
  payload: AsukuPermissionPayload,
  options: PermissionRequestOptions,
) => Promise<boolean | undefined>;

interface AsukuNotifyDeps {
  binaryPath?: string;
  spawnDetached?: DetachedSpawnFunction;
  requestPermission?: PermissionRequestRunner;
  now?: () => number;
}

interface CodexRateLimitWindow {
  usedPercentage: number;
  windowMinutes?: number;
  resetsAt?: number;
}

export interface CodexRateLimitSnapshot {
  primary?: CodexRateLimitWindow;
  secondary?: CodexRateLimitWindow;
  status?: number;
}

const CONFIRM_BRIDGE_KEY = Symbol.for("pi-harness.asuku-confirm-bridge");

type ConfirmFunction = UiLike["confirm"];
type BridgeUi = UiLike & { [key: symbol]: unknown };

interface ConfirmBridgeRegistration {
  owner: symbol;
  originalConfirm: ConfirmFunction;
  bridgedConfirm: ConfirmFunction;
  ctx: CtxLike;
}

interface ActiveAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

interface AbortControllerLike {
  readonly signal: ActiveAbortSignal;
  abort(): void;
}

const isActiveAbortSignal = (value: unknown): value is ActiveAbortSignal =>
  typeof value === "object" &&
  value !== null &&
  "aborted" in value &&
  typeof value.aborted === "boolean" &&
  "addEventListener" in value &&
  typeof value.addEventListener === "function" &&
  "removeEventListener" in value &&
  typeof value.removeEventListener === "function";

const createAbortController = (): AbortControllerLike | undefined => {
  let value: unknown;
  try {
    value = new AbortController();
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("abort" in value) ||
    typeof value.abort !== "function" ||
    !("signal" in value) ||
    !isActiveAbortSignal(value.signal)
  ) {
    return undefined;
  }
  const { abort, signal } = value;
  return {
    signal,
    abort: () => Reflect.apply(abort, value, []),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const bridgeRegistration = (
  ui: UiLike,
): ConfirmBridgeRegistration | undefined => {
  const candidate = (ui as BridgeUi)[CONFIRM_BRIDGE_KEY];
  if (
    !isRecord(candidate) ||
    typeof candidate.owner !== "symbol" ||
    typeof candidate.originalConfirm !== "function" ||
    typeof candidate.bridgedConfirm !== "function" ||
    !isRecord(candidate.ctx)
  ) {
    return undefined;
  }
  return candidate as unknown as ConfirmBridgeRegistration;
};

const clearConfirmBridge = (ui: UiLike, owner?: symbol): boolean => {
  const registration = bridgeRegistration(ui);
  if (
    registration === undefined ||
    (owner !== undefined && registration.owner !== owner) ||
    ui.confirm !== registration.bridgedConfirm
  ) {
    return false;
  }
  const bridgeUi = ui as BridgeUi;
  try {
    ui.confirm = registration.originalConfirm;
    delete bridgeUi[CONFIRM_BRIDGE_KEY];
    return true;
  } catch {
    return false;
  }
};

const executable = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const permissionDecision = (stdout: string): boolean | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) return undefined;
    const specific = parsed.hookSpecificOutput;
    if (!isRecord(specific)) return undefined;
    const { decision } = specific;
    if (!isRecord(decision)) return undefined;
    if (decision.behavior === "allow") return true;
    if (decision.behavior === "deny") return false;
    return undefined;
  } catch {
    return undefined;
  }
};

export const runPermissionRequest: PermissionRequestRunner = (
  binary,
  payload,
  options,
) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(binary, ["permission-request"], {
        cwd: options.cwd,
        env: sanitizeChildEnv(process.env, undefined, { cwd: options.cwd }),
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve(undefined);
      return;
    }

    let stdout = "";
    let stdoutBytes = 0;
    let settled = false;
    let terminating = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const signalAborted = (): boolean =>
      options.signal !== undefined &&
      "aborted" in options.signal &&
      options.signal.aborted === true;
    const removeAbortListener = (): void => {
      if (
        options.signal !== undefined &&
        "removeEventListener" in options.signal &&
        typeof options.signal.removeEventListener === "function"
      ) {
        options.signal.removeEventListener("abort", abort);
      }
    };
    const settle = (decision: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      removeAbortListener();
      resolve(decision);
    };
    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // The hook already exited.
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The hook exited during the grace period.
        }
      }, PERMISSION_TERM_GRACE_MS);
      if (typeof forceKillTimer === "object" && "unref" in forceKillTimer) {
        forceKillTimer.unref();
      }
    };
    const abort = (): void => {
      terminate();
      settle(undefined);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_PERMISSION_OUTPUT_BYTES) {
        terminate();
        settle(undefined);
        return;
      }
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => settle(undefined));
    child.on("close", (code) => {
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      settle(code === 0 ? permissionDecision(stdout) : undefined);
    });
    child.stdin.on("error", () => {
      // The hook may fail before reading stdin; close/error handles fallback.
    });

    if (
      options.signal !== undefined &&
      "addEventListener" in options.signal &&
      typeof options.signal.addEventListener === "function"
    ) {
      options.signal.addEventListener("abort", abort, { once: true });
    }
    if (signalAborted()) {
      abort();
      return;
    }
    timer = setTimeout(abort, options.timeoutMs);
    child.stdin.end(JSON.stringify(payload));
  });

const responseContainer = (event: unknown): Record<string, unknown> => {
  if (!isRecord(event)) return {};
  return isRecord(event.response) ? event.response : event;
};

const normalizedHeaders = (event: unknown): Map<string, string> => {
  const { headers } = responseContainer(event);
  const normalized = new Map<string, string>();
  if (!isRecord(headers)) return normalized;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string" || typeof value === "number") {
      normalized.set(name.toLowerCase(), String(value));
    }
  }
  return normalized;
};

const finiteHeader = (
  headers: ReadonlyMap<string, string>,
  name: string,
): number | undefined => {
  const raw = headers.get(name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
};

const rateLimitWindow = (
  headers: ReadonlyMap<string, string>,
  name: "primary" | "secondary",
): CodexRateLimitWindow | undefined => {
  const prefix = `x-codex-${name}`;
  const usedPercentage = finiteHeader(headers, `${prefix}-used-percent`);
  if (usedPercentage === undefined) return undefined;
  const windowMinutes = finiteHeader(headers, `${prefix}-window-minutes`);
  const resetsAt = finiteHeader(headers, `${prefix}-reset-at`);
  return {
    usedPercentage,
    ...(windowMinutes === undefined ? {} : { windowMinutes }),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
};

export const parseCodexRateLimits = (
  event: unknown,
  allowStatusOnly429 = false,
): CodexRateLimitSnapshot | undefined => {
  const container = responseContainer(event);
  const headers = normalizedHeaders(event);
  const status =
    typeof container.status === "number" ? container.status : undefined;
  const hasCodexHeaders = [...headers.keys()].some((name) =>
    name.startsWith("x-codex-"),
  );
  if (!hasCodexHeaders && !(allowStatusOnly429 && status === 429)) {
    return undefined;
  }

  const primary = rateLimitWindow(headers, "primary");
  const secondary = rateLimitWindow(headers, "secondary");
  if (primary === undefined && secondary === undefined && status !== 429) {
    return undefined;
  }
  return {
    ...(primary === undefined ? {} : { primary }),
    ...(secondary === undefined ? {} : { secondary }),
    ...(status === undefined ? {} : { status }),
  };
};

const compactNumber = (value: number): string =>
  Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));

const windowLabel = (
  window: CodexRateLimitWindow,
  fallback: "primary" | "secondary",
): string => {
  const minutes = window.windowMinutes;
  if (minutes === undefined) return fallback;
  if (minutes % (7 * 24 * 60) === 0) {
    return `${compactNumber(minutes / (24 * 60))}d`;
  }
  if (minutes % 60 === 0) return `${compactNumber(minutes / 60)}h`;
  return `${compactNumber(minutes)}m`;
};

const resetSuffix = (resetsAt: number | undefined): string => {
  if (resetsAt === undefined) return "";
  const reset = new Date(resetsAt * 1_000);
  return Number.isFinite(reset.getTime())
    ? `, reset ${reset.toISOString()}`
    : "";
};

export const formatCodexRateLimits = (
  snapshot: CodexRateLimitSnapshot,
): string => {
  const windows: string[] = [];
  if (snapshot.primary !== undefined) {
    windows.push(
      `${windowLabel(snapshot.primary, "primary")} ${compactNumber(snapshot.primary.usedPercentage)}% used${resetSuffix(snapshot.primary.resetsAt)}`,
    );
  }
  if (snapshot.secondary !== undefined) {
    windows.push(
      `${windowLabel(snapshot.secondary, "secondary")} ${compactNumber(snapshot.secondary.usedPercentage)}% used${resetSuffix(snapshot.secondary.resetsAt)}`,
    );
  }
  const prefix =
    snapshot.status === 429
      ? "Codex rate limited (HTTP 429)"
      : "Codex rate limits";
  return windows.length === 0 ? prefix : `${prefix}: ${windows.join("; ")}`;
};

const sessionId = (ctx: CtxLike): string =>
  ctx.sessionManager?.getSessionId?.() ?? "pi-harness";

export default function setupAsukuNotify(
  pi: PiLike,
  config: HarnessConfig,
  deps: AsukuNotifyDeps = {},
): void {
  const owner = Symbol("asuku-confirm-owner");
  const cleanupBridge = (ctx: CtxLike): void => {
    clearConfirmBridge(ctx.ui);
  };

  // setupHarness invokes this feature even while disabled so a /reload that
  // flips the toggle off can remove the previous instance's UI wrapper.
  if (!config.features["asuku-notify"]) {
    pi.on("session_start", (_event, ctx) => cleanupBridge(ctx));
    pi.on("before_agent_start", (_event, ctx) => cleanupBridge(ctx));
    pi.on("tool_call", (_event, ctx) => cleanupBridge(ctx));
    pi.on("session_shutdown", (_event, ctx) => cleanupBridge(ctx));
    return;
  }

  const binary = deps.binaryPath ?? ASUKU_BINARY;
  const spawnDetached = deps.spawnDetached ?? launchDetached;
  const requestPermission = deps.requestPermission ?? runPermissionRequest;
  const now = deps.now ?? Date.now;
  let latestRateLimits: CodexRateLimitSnapshot | undefined;

  const installConfirmBridge = (ctx: CtxLike): void => {
    if (!ctx.hasUI) return;
    const { ui } = ctx;
    const existing = bridgeRegistration(ui);
    if (existing?.owner === owner) {
      existing.ctx = ctx;
      return;
    }
    if (existing !== undefined && !clearConfirmBridge(ui)) {
      // Another adapter replaced our predecessor; do not wrap an unknown
      // chain or restore a function we no longer own.
      return;
    }

    const originalConfirm = ui.confirm;
    let registration: ConfirmBridgeRegistration;
    let nativeConfirmationQueue = Promise.resolve();
    const runConfirm = async (
      title: string,
      message: string,
      dialogOptions: DialogOptionsLike | undefined,
      startedAt: number,
    ): Promise<boolean> => {
      const activeCtx = registration.ctx;
      if (!activeCtx.hasUI) {
        return originalConfirm.call(ui, title, message, dialogOptions);
      }

      const configuredTimeout =
        dialogOptions?.timeout !== undefined &&
        Number.isFinite(dialogOptions.timeout) &&
        dialogOptions.timeout > 0
          ? dialogOptions.timeout
          : undefined;
      const remainingTimeout = (): number | undefined => {
        if (configuredTimeout === undefined) return undefined;
        return Math.max(0, configuredTimeout - Math.max(0, now() - startedAt));
      };
      const openNativeConfirm = (
        options: DialogOptionsLike | undefined,
      ): Promise<boolean> => {
        try {
          return Promise.resolve(
            originalConfirm.call(ui, title, message, options),
          ).catch(() => false);
        } catch {
          return Promise.resolve(false);
        }
      };
      const bridgeAvailable = await executable(binary);
      const remaining = remainingTimeout();
      const nativeOptions =
        remaining === undefined
          ? dialogOptions
          : { ...dialogOptions, timeout: remaining };

      if (remaining !== undefined && remaining <= 0) return false;
      if (!bridgeAvailable) return openNativeConfirm(nativeOptions);

      const cwd = activeCtx.cwd ?? process.cwd();
      const payload: AsukuPermissionPayload = {
        session_id: sessionId(activeCtx),
        hook_event_name: "PermissionRequest",
        tool_name: "PiConfirm",
        tool_input: { title, message },
        cwd,
        permission_mode: "default",
      };
      const bridgeTimeout = remaining ?? DEFAULT_PERMISSION_TIMEOUT_MS;
      const callerSignal = isActiveAbortSignal(dialogOptions?.signal)
        ? dialogOptions.signal
        : undefined;
      if (callerSignal?.aborted === true) return false;

      // RPC clients have no cancellation event for an extension_ui_request.
      // Keep the native/asuku race TUI-only so an asuku-first decision cannot
      // leave a stale confirmation visible in an RPC client.
      if (activeCtx.mode !== "tui") {
        try {
          const decision = await requestPermission(binary, payload, {
            cwd,
            ...(callerSignal === undefined ? {} : { signal: callerSignal }),
            timeoutMs: bridgeTimeout,
          });
          return decision ?? openNativeConfirm(nativeOptions);
        } catch {
          return openNativeConfirm(nativeOptions);
        }
      }

      const bridgeAbort = createAbortController();
      if (bridgeAbort === undefined) return openNativeConfirm(nativeOptions);

      let callerAbortListener: (() => void) | undefined;
      const noDecision = new Promise<boolean>(() => {});
      const callerAbortDecision =
        callerSignal === undefined
          ? noDecision
          : new Promise<boolean>((resolve) => {
              callerAbortListener = () => {
                bridgeAbort.abort();
                resolve(false);
              };
              callerSignal.addEventListener("abort", callerAbortListener, {
                once: true,
              });
            });
      const sharedDialogOptions: DialogOptionsLike = {
        ...nativeOptions,
        signal: bridgeAbort.signal,
      };
      const asukuDecision = (async (): Promise<boolean> => {
        try {
          const decision = await requestPermission(binary, payload, {
            cwd,
            signal: bridgeAbort.signal,
            timeoutMs: bridgeTimeout,
          });
          return decision ?? noDecision;
        } catch {
          return noDecision;
        }
      })();
      const nativeDecision = openNativeConfirm(sharedDialogOptions);

      try {
        return await Promise.race([
          nativeDecision,
          asukuDecision,
          callerAbortDecision,
        ]);
      } finally {
        bridgeAbort.abort();
        if (callerSignal !== undefined && callerAbortListener !== undefined) {
          callerSignal.removeEventListener("abort", callerAbortListener);
        }
      }
    };
    const bridgedConfirm: ConfirmFunction = (title, message, dialogOptions) => {
      const startedAt = now();
      if (registration.ctx.mode !== "tui") {
        return runConfirm(title, message, dialogOptions, startedAt);
      }

      const result = nativeConfirmationQueue.then(() =>
        runConfirm(title, message, dialogOptions, startedAt),
      );
      nativeConfirmationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    };
    registration = {
      owner,
      originalConfirm,
      bridgedConfirm,
      ctx,
    };

    const bridgeUi = ui as BridgeUi;
    try {
      bridgeUi[CONFIRM_BRIDGE_KEY] = registration;
      ui.confirm = bridgedConfirm;
    } catch {
      if (ui.confirm === bridgedConfirm) ui.confirm = originalConfirm;
      if (bridgeUi[CONFIRM_BRIDGE_KEY] === registration) {
        delete bridgeUi[CONFIRM_BRIDGE_KEY];
      }
    }
  };

  pi.on("session_start", (_event, ctx) => {
    latestRateLimits = undefined;
    installConfirmBridge(ctx);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    latestRateLimits = undefined;
    installConfirmBridge(ctx);
  });
  pi.on("tool_call", (_event, ctx) => installConfirmBridge(ctx));
  pi.on("after_provider_response", (event, ctx) => {
    const snapshot = parseCodexRateLimits(
      event,
      ctx.model?.provider === "openai-codex",
    );
    if (snapshot !== undefined) latestRateLimits = snapshot;
  });
  pi.on("session_shutdown", (_event, ctx) => {
    clearConfirmBridge(ctx.ui, owner);
    latestRateLimits = undefined;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!(await executable(binary))) return;
    const cwd = ctx.cwd ?? process.cwd();
    const rateLimitMessage =
      latestRateLimits === undefined
        ? ""
        : `\n${formatCodexRateLimits(latestRateLimits)}`;
    const payload = JSON.stringify({
      hook_event_name: "Notification",
      session_id: sessionId(ctx),
      cwd,
      title: "pi",
      message: `pi agent finished its turn${rateLimitMessage}`,
    });
    spawnDetached(binary, ["notification"], { cwd, stdin: payload });
  });
}
