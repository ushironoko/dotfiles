import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_MAX_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CommandResult {
  argv: string[];
  exitCode: number | null;
  signal?: NodeJS.Signals;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type CommandRunner = (
  argv: string[],
  options?: RunCommandOptions,
) => Promise<CommandResult>;

const appendBounded = (
  current: string,
  chunk: string,
  maxBytes: number,
): { value: string; truncated: boolean } => {
  const combined = `${current}${chunk}`;
  if (Buffer.byteLength(combined) <= maxBytes) {
    return { value: combined, truncated: false };
  }
  const bytes = Buffer.from(combined);
  return {
    value: bytes.subarray(0, maxBytes).toString("utf8"),
    truncated: true,
  };
};

export const runCommand: CommandRunner = async (argv, options = {}) => {
  if (argv.length === 0) throw new Error("command argv must not be empty");
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const child = spawn(argv[0] ?? "", argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let truncated = false;
  child.stdout.on("data", (chunk: Buffer | string) => {
    const next = appendBounded(stdout, String(chunk), maxOutputBytes);
    stdout = next.value;
    truncated ||= next.truncated;
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    const next = appendBounded(stderr, String(chunk), maxOutputBytes);
    stderr = next.value;
    truncated ||= next.truncated;
  });

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child.pid, "SIGTERM");
    killTimer = setTimeout(
      () => terminateProcessGroup(child.pid, "SIGKILL"),
      2_000,
    );
    killTimer.unref?.();
  }, timeoutMs);
  timeout.unref?.();

  const result = await new Promise<{
    exitCode: number | null;
    signal?: NodeJS.Signals;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) =>
      resolve({ exitCode, signal: signal ?? undefined }),
    );
  }).finally(() => {
    clearTimeout(timeout);
    if (killTimer !== undefined) clearTimeout(killTimer);
  });

  return {
    argv: [...argv],
    ...result,
    stdout,
    stderr,
    timedOut,
    truncated,
  };
};

export interface JsonlDecoderOptions {
  maxLineBytes?: number;
  maxRecords?: number;
}

/** Strict LF-only streaming JSONL decoder for pi RPC. */
export class StrictJsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxLineBytes: number;
  private readonly maxRecords: number;
  private buffer = "";
  private records = 0;

  constructor(options: JsonlDecoderOptions = {}) {
    this.maxLineBytes = options.maxLineBytes ?? 256 * 1024;
    this.maxRecords = options.maxRecords ?? 2_000;
  }

  push(chunk: Uint8Array | string): unknown[] {
    this.buffer +=
      typeof chunk === "string"
        ? chunk
        : this.decoder.write(Buffer.from(chunk));
    return this.drain(false);
  }

  finish(): unknown[] {
    this.buffer += this.decoder.end();
    return this.drain(true);
  }

  private drain(final: boolean): unknown[] {
    const output: unknown[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") continue;
      output.push(this.parseLine(line));
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes) {
      throw new Error("RPC JSONL record exceeds byte limit");
    }
    if (final && this.buffer !== "") {
      throw new Error("RPC JSONL ended with an incomplete record");
    }
    return output;
  }

  private parseLine(line: string): unknown {
    if (Buffer.byteLength(line) > this.maxLineBytes) {
      throw new Error("RPC JSONL record exceeds byte limit");
    }
    this.records += 1;
    if (this.records > this.maxRecords) {
      throw new Error("RPC JSONL record count exceeds limit");
    }
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new Error("RPC emitted malformed JSONL");
    }
  }
}

export const terminateProcessGroup = (
  pid: number | undefined,
  signal: NodeJS.Signals,
): void => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      try {
        process.kill(pid, signal);
      } catch {
        // The child already exited.
      }
    }
  }
};
