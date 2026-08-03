import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
  BoundedCommandError,
  runBoundedCommand,
  type BoundedCommandOptions,
  type BoundedCommandResult,
  type RunBoundedCommand,
} from "../../lib/bounded-process";
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

export {
  BoundedCommandError,
  runBoundedCommand,
  type BoundedCommandOptions,
  type BoundedCommandResult,
  type RunBoundedCommand,
} from "../../lib/bounded-process";

const GIT_STDOUT_MAX_BYTES = 64 * 1024;

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
    return code !== undefined && (code <= 31 || code === 127);
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
