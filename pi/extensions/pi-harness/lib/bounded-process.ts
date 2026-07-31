import { spawn } from "node:child_process";

const PROCESS_TERM_GRACE_MS = 250;
const PROCESS_FORCE_SETTLE_MS = 250;

export interface BoundedCommandOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly allowStdoutTruncation?: boolean;
  /** Exact bytes written to stdin. No shell is involved. */
  readonly stdin?: string | Uint8Array;
  /** Required whenever stdin is present. */
  readonly stdinMaxBytes?: number;
}

export interface BoundedCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly stdoutTruncated: boolean;
}

export type RunBoundedCommand = (
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions,
) => Promise<BoundedCommandResult>;

type BoundedCommandFailureKind =
  | "aborted"
  | "missing"
  | "oversize"
  | "spawn"
  | "timeout";

export class BoundedCommandError extends Error {
  constructor(
    readonly kind: BoundedCommandFailureKind,
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = "BoundedCommandError";
  }
}

const asBuffer = (chunk: string | Uint8Array): Buffer =>
  typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && "aborted" in signal && signal.aborted === true;

const addAbortListener = (
  signal: AbortSignal | undefined,
  listener: () => void,
): void => {
  if (
    signal !== undefined &&
    "addEventListener" in signal &&
    typeof signal.addEventListener === "function"
  ) {
    signal.addEventListener("abort", listener, { once: true });
  }
};

const removeAbortListener = (
  signal: AbortSignal | undefined,
  listener: () => void,
): void => {
  if (
    signal !== undefined &&
    "removeEventListener" in signal &&
    typeof signal.removeEventListener === "function"
  ) {
    signal.removeEventListener("abort", listener);
  }
};

const killProcessGroup = (
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void => {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group already vanished.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
};

export const runBoundedCommand: RunBoundedCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (isAborted(options.signal)) {
      reject(
        new BoundedCommandError("aborted", command, `${command} was aborted`),
      );
      return;
    }

    const stdin =
      options.stdin === undefined ? undefined : asBuffer(options.stdin);
    if (stdin !== undefined) {
      if (options.stdinMaxBytes === undefined) {
        reject(
          new BoundedCommandError(
            "oversize",
            command,
            `${command} stdin requires an explicit byte limit`,
          ),
        );
        return;
      }
      if (stdin.byteLength > options.stdinMaxBytes) {
        reject(
          new BoundedCommandError(
            "oversize",
            command,
            `${command} stdin exceeded ${options.stdinMaxBytes} bytes`,
          ),
        );
        return;
      }
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        shell: false,
        stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new BoundedCommandError(
          "spawn",
          command,
          `${command} could not start: ${String(error)}`,
        ),
      );
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let settled = false;
    let terminationStarted = false;
    let failure: BoundedCommandError | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;

    const detachAbortListener = (): void => {
      removeAbortListener(options.signal, onAbort);
    };
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      detachAbortListener();
    };
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure !== undefined) {
        reject(failure instanceof Error ? failure : new Error(String(failure)));
        return;
      }
      resolve({
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.concat(stderrChunks, stderrBytes),
        stdoutTruncated,
      });
    };
    const terminate = (): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      killProcessGroup(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessGroup(child, "SIGKILL");
        forceTimer = setTimeout(() => finish(null), PROCESS_FORCE_SETTLE_MS);
        forceTimer.unref?.();
      }, PROCESS_TERM_GRACE_MS);
      killTimer.unref?.();
    };
    const fail = (next: BoundedCommandError): void => {
      if (failure === undefined) failure = next;
      terminate();
    };
    const append = (
      chunks: Buffer[],
      currentBytes: number,
      chunk: Buffer,
      limit: number,
    ): { bytes: number; exceeded: boolean } => {
      const remaining = Math.max(0, limit - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      return {
        bytes: currentBytes + Math.min(remaining, chunk.byteLength),
        exceeded: chunk.byteLength > remaining,
      };
    };
    const onAbort = (): void =>
      fail(
        new BoundedCommandError("aborted", command, `${command} was aborted`),
      );

    child.stdout?.on("data", (raw: string | Uint8Array) => {
      if (settled || stdoutTruncated) return;
      const result = append(
        stdoutChunks,
        stdoutBytes,
        asBuffer(raw),
        options.stdoutMaxBytes,
      );
      stdoutBytes = result.bytes;
      if (!result.exceeded) return;
      if (options.allowStdoutTruncation === true) {
        stdoutTruncated = true;
        terminate();
        return;
      }
      fail(
        new BoundedCommandError(
          "oversize",
          command,
          `${command} stdout exceeded ${options.stdoutMaxBytes} bytes`,
        ),
      );
    });
    child.stderr?.on("data", (raw: string | Uint8Array) => {
      if (settled) return;
      const result = append(
        stderrChunks,
        stderrBytes,
        asBuffer(raw),
        options.stderrMaxBytes,
      );
      stderrBytes = result.bytes;
      if (result.exceeded) {
        fail(
          new BoundedCommandError(
            "oversize",
            command,
            `${command} stderr exceeded ${options.stderrMaxBytes} bytes`,
          ),
        );
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      const kind = error.code === "ENOENT" ? "missing" : "spawn";
      failure ??= new BoundedCommandError(
        kind,
        command,
        `${command} could not start: ${error.message}`,
      );
      finish(null);
    });
    child.once("close", (code) => finish(code));

    // EPIPE means the child exited before consuming all input. Its exit status
    // remains the authoritative failure and the input bytes are never echoed.
    child.stdin?.on("error", () => undefined);
    if (child.stdin !== null && stdin !== undefined) child.stdin.end(stdin);

    const timeoutTimer = setTimeout(() => {
      fail(
        new BoundedCommandError(
          "timeout",
          command,
          `${command} timed out after ${options.timeoutMs}ms`,
        ),
      );
    }, options.timeoutMs);
    timeoutTimer.unref?.();
    addAbortListener(options.signal, onAbort);
    if (isAborted(options.signal)) onAbort();
  });
