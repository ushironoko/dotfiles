/**
 * Process adapter that runs a bash hook script with synthesized stdin.
 *
 * Contract (see plan "プロセス管理契約"):
 * - timeoutMs / maxOutputBytes are injectable per call (tests use short values)
 * - the child gets its own process group; on timeout the whole group receives
 *   SIGTERM, then SIGKILL after a grace period (no orphaned grandchildren)
 * - detached fire-and-forget mode discards output and never blocks the caller
 */
import { spawn } from "node:child_process";
import { sanitizeChildEnv } from "./child-env";
import type { RawHookResult } from "./claude-hook-io";

export interface RunHookOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  termGraceMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const DEFAULT_TERM_GRACE_MS = 2_000;

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone; nothing to clean up.
  }
}

export function runHook(
  scriptPath: string,
  stdinJson: string,
  options: RunHookOptions = {},
): Promise<RawHookResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const termGraceMs = options.termGraceMs ?? DEFAULT_TERM_GRACE_MS;
  const signalAborted = (): boolean =>
    options.signal !== undefined &&
    "aborted" in options.signal &&
    options.signal.aborted === true;

  if (signalAborted()) {
    return Promise.resolve({
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "Hook aborted.",
    });
  }

  return new Promise((resolve) => {
    const child = spawn("bash", [scriptPath], {
      cwd: options.cwd,
      env: sanitizeChildEnv(process.env, options.env, { cwd: options.cwd }),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let terminating = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceSettleTimer: ReturnType<typeof setTimeout> | undefined;

    const appendCapped = (current: string, chunk: string): string => {
      if (current.length >= maxOutputBytes) return current;
      return (current + chunk).slice(0, maxOutputBytes);
    };

    const removeAbortListener = () => {
      if (
        options.signal !== undefined &&
        "removeEventListener" in options.signal &&
        typeof options.signal.removeEventListener === "function"
      ) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
      removeAbortListener();
      resolve({
        exitCode,
        timedOut,
        stdout,
        stderr: aborted ? appendCapped(stderr, "\nHook aborted.") : stderr,
      });
    };

    const terminate = () => {
      if (terminating || settled) return;
      terminating = true;
      if (child.pid === undefined) {
        if (!settled) settle(null);
        return;
      }
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
        forceSettleTimer = setTimeout(() => settle(null), 100);
        if (
          typeof forceSettleTimer === "object" &&
          "unref" in forceSettleTimer
        ) {
          forceSettleTimer.unref();
        }
      }, termGraceMs);
    };

    const onAbort = () => {
      if (aborted || settled) return;
      aborted = true;
      clearTimeout(timeoutTimer);
      terminate();
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });

    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));

    if (
      options.signal !== undefined &&
      "addEventListener" in options.signal &&
      typeof options.signal.addEventListener === "function"
    ) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (signalAborted()) onAbort();

    child.stdin.on("error", () => {
      // The script may exit without reading stdin; ignore EPIPE.
    });
    child.stdin.write(stdinJson);
    child.stdin.end();
  });
}

/**
 * Fire-and-forget variant for async hooks (statusline, notifications).
 * Output is discarded; the caller never waits.
 */
export function fireDetachedHook(
  scriptPath: string,
  stdinJson: string,
  options: Pick<RunHookOptions, "cwd" | "env"> = {},
): void {
  const child = spawn("bash", [scriptPath], {
    cwd: options.cwd,
    env: sanitizeChildEnv(process.env, options.env, { cwd: options.cwd }),
    stdio: ["pipe", "ignore", "ignore"],
    detached: true,
  });
  child.stdin.on("error", () => {
    // Detached hooks may exit before reading stdin; ignore EPIPE.
  });
  child.stdin.write(stdinJson);
  child.stdin.end();
  child.unref();
}
