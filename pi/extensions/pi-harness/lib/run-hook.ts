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
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        killGroup(child.pid, "SIGTERM");
        killTimer = setTimeout(() => {
          if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
        }, termGraceMs);
      }
    }, timeoutMs);

    const appendCapped = (current: string, chunk: string): string => {
      if (current.length >= maxOutputBytes) return current;
      return (current + chunk).slice(0, maxOutputBytes);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({ exitCode, timedOut, stdout, stderr });
    };

    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));

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
