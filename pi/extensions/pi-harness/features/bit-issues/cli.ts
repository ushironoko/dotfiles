import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { sanitizeChildEnv } from "../../lib/child-env";
import { capUtf8, stripTerminalControls } from "../../lib/terminal-text";
import {
  BIT_ISSUE_COMMAND_TIMEOUT_MS,
  BIT_ISSUE_COMMENT_MAX_BYTES,
  BIT_ISSUE_DETAIL_MAX_BYTES,
  BIT_ISSUE_LIST_MAX_BYTES,
  BIT_ISSUE_LIST_SENTINEL_LIMIT,
  BIT_ISSUE_STDERR_MAX_BYTES,
  BitIssueCliError,
  decodeBitIssueDetail,
  decodeOpenBitIssueList,
  type BitIssueComments,
  type BitIssueDetailResult,
  type BitIssueFailureKind,
  type BitIssueListResult,
} from "./model";

const PROCESS_TERM_GRACE_MS = 250;
const PROCESS_FORCE_SETTLE_MS = 250;
const GIT_STDOUT_MAX_BYTES = 64 * 1024;

export interface BoundedCommandOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly stdoutMaxBytes: number;
  readonly stderrMaxBytes: number;
  readonly allowStdoutTruncation?: boolean;
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

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        detached: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
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
        reject(failure);
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

export interface BitIssueCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: RunBoundedCommand;
  readonly realpath?: (path: string) => Promise<string>;
}

const fatalDecoder = new TextDecoder(undefined, { fatal: true });
const lossyDecoder = new TextDecoder();

const decodeFatal = (bytes: Uint8Array, label: string): string => {
  try {
    return fatalDecoder.decode(bytes);
  } catch {
    throw new BitIssueCliError("invalid-data", `${label} is not valid UTF-8`);
  }
};

const parseJson = (bytes: Uint8Array, label: string): unknown => {
  try {
    return JSON.parse(decodeFatal(bytes, label));
  } catch (error) {
    if (error instanceof BitIssueCliError) throw error;
    throw new BitIssueCliError("invalid-data", `${label} is not valid JSON`);
  }
};

const failureMessage = (result: BoundedCommandResult): string => {
  const stderr = stripTerminalControls(lossyDecoder.decode(result.stderr), " ")
    .replace(/\s+/g, " ")
    .trim();
  return capUtf8(
    stderr === "" ? `exit code ${result.exitCode}` : stderr,
    4 * 1024,
  );
};

const mapCommandError = (
  error: unknown,
  command: "bit" | "git",
): BitIssueCliError => {
  if (error instanceof BitIssueCliError) return error;
  if (!(error instanceof BoundedCommandError)) {
    return new BitIssueCliError(
      "command-failed",
      `${command} command failed: ${String(error)}`,
    );
  }
  let kind: BitIssueFailureKind;
  if (error.kind === "missing")
    kind = command === "bit" ? "missing-bit" : "missing-git";
  else if (error.kind === "timeout") kind = "timeout";
  else if (error.kind === "aborted") kind = "aborted";
  else if (error.kind === "oversize") kind = "oversize";
  else kind = "command-failed";
  return new BitIssueCliError(kind, error.message);
};

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });

export class BitIssueCli {
  private readonly env: NodeJS.ProcessEnv;
  private readonly runCommand: RunBoundedCommand;
  private readonly resolveRealpath: (path: string) => Promise<string>;

  constructor(options: BitIssueCliOptions = {}) {
    this.env = options.env ?? process.env;
    this.runCommand = options.runCommand ?? runBoundedCommand;
    this.resolveRealpath = options.realpath ?? realpath;
  }

  async listOpen(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<BitIssueListResult> {
    const commonDir = await this.gitCommonDir(cwd, signal);
    const result = await this.runBit(
      cwd,
      commonDir,
      [
        "issue",
        "list",
        "--open",
        "--all",
        "--limit",
        String(BIT_ISSUE_LIST_SENTINEL_LIMIT),
        "--format",
        "json",
      ],
      BIT_ISSUE_LIST_MAX_BYTES,
      signal,
    );
    if (result.exitCode !== 0) {
      throw new BitIssueCliError(
        "command-failed",
        `bit issue list failed: ${failureMessage(result)}`,
      );
    }
    return decodeOpenBitIssueList(
      parseJson(result.stdout, "bit issue list output"),
    );
  }

  async getDetail(
    cwd: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<BitIssueDetailResult> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new BitIssueCliError("invalid-data", "bit issue id is invalid");
    }
    const commonDir = await this.gitCommonDir(cwd, signal);
    const issueResult = await this.runBit(
      cwd,
      commonDir,
      ["issue", "get", id, "--format", "json"],
      BIT_ISSUE_DETAIL_MAX_BYTES,
      signal,
    );
    if (issueResult.exitCode !== 0) {
      throw new BitIssueCliError(
        "command-failed",
        `bit issue get failed: ${failureMessage(issueResult)}`,
      );
    }
    const issue = decodeBitIssueDetail(
      parseJson(issueResult.stdout, "bit issue detail output"),
    );
    if (issue.id !== id) {
      throw new BitIssueCliError(
        "invalid-data",
        "bit issue detail id does not match the requested id",
      );
    }
    let comments: BitIssueComments;
    try {
      const commentResult = await this.runBit(
        cwd,
        commonDir,
        ["issue", "comment", "list", id],
        BIT_ISSUE_COMMENT_MAX_BYTES,
        signal,
        true,
      );
      if (commentResult.exitCode !== 0 && !commentResult.stdoutTruncated) {
        comments = {
          status: "error",
          message: `bit issue comments failed: ${failureMessage(commentResult)}`,
        };
      } else {
        const decoded = commentResult.stdoutTruncated
          ? lossyDecoder.decode(commentResult.stdout)
          : decodeFatal(commentResult.stdout, "bit issue comment output");
        const raw = stripTerminalControls(decoded);
        if (raw.trim() === "No comments" || raw.trim() === "") {
          comments = { status: "none" };
        } else {
          comments = {
            status: "ready",
            text: commentResult.stdoutTruncated
              ? `${raw}\n\n… comments truncated at ${BIT_ISSUE_COMMENT_MAX_BYTES} bytes`
              : raw,
            truncated: commentResult.stdoutTruncated,
          };
        }
      }
    } catch (error) {
      const mapped = mapCommandError(error, "bit");
      if (mapped.kind === "aborted") throw mapped;
      comments = { status: "error", message: mapped.message };
    }
    return { issue, comments };
  }

  private async gitCommonDir(
    cwd: string,
    signal?: AbortSignal,
  ): Promise<string> {
    let result: BoundedCommandResult;
    try {
      result = await this.runCommand(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        {
          cwd,
          env: sanitizeChildEnv(this.env, {}, { cwd }),
          signal,
          timeoutMs: BIT_ISSUE_COMMAND_TIMEOUT_MS,
          stdoutMaxBytes: GIT_STDOUT_MAX_BYTES,
          stderrMaxBytes: BIT_ISSUE_STDERR_MAX_BYTES,
        },
      );
    } catch (error) {
      throw mapCommandError(error, "git");
    }
    if (result.exitCode !== 0) {
      throw new BitIssueCliError(
        "non-git",
        `Git repository unavailable: ${failureMessage(result)}`,
      );
    }
    const output = decodeFatal(result.stdout, "git common-dir output");
    const match = /^([^\r\n]+)(?:\r?\n)?$/.exec(output);
    const commonDir = match?.[1];
    if (
      commonDir === undefined ||
      !isAbsolute(commonDir) ||
      hasControlCharacter(commonDir)
    ) {
      throw new BitIssueCliError("non-git", "Git common directory is invalid");
    }
    try {
      const canonical = await this.resolveRealpath(commonDir);
      if (!isAbsolute(canonical) || hasControlCharacter(canonical)) {
        throw new Error("invalid canonical common directory");
      }
      return canonical;
    } catch {
      throw new BitIssueCliError(
        "non-git",
        "Git common directory does not resolve",
      );
    }
  }

  private async runBit(
    cwd: string,
    commonDir: string,
    args: readonly string[],
    stdoutMaxBytes: number,
    signal?: AbortSignal,
    allowStdoutTruncation = false,
  ): Promise<BoundedCommandResult> {
    try {
      return await this.runCommand("bit", args, {
        cwd,
        env: sanitizeChildEnv(this.env, { GIT_DIR: commonDir }, { cwd }),
        signal,
        timeoutMs: BIT_ISSUE_COMMAND_TIMEOUT_MS,
        stdoutMaxBytes,
        stderrMaxBytes: BIT_ISSUE_STDERR_MAX_BYTES,
        allowStdoutTruncation,
      });
    } catch (error) {
      throw mapCommandError(error, "bit");
    }
  }
}
