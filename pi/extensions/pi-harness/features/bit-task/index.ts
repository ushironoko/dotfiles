import { spawn } from "node:child_process";
import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { HarnessConfig } from "../../config";
import { sanitizeChildEnv } from "../../lib/child-env";
import type { CtxLike, PiLike } from "../../lib/pi-like";
import { runHook as defaultRunHook } from "../../lib/run-hook";
import {
  PROCESS_FORCE_SETTLE_MS,
  WORKTREE_CREATE_TERM_GRACE_MS,
} from "../../lib/termination";
import {
  buildTaskCompletedArgs,
  buildWorktreeCreatePayload,
  buildWorktreeRemovePayload,
  matchesTaskMarker,
} from "./lifecycle";
import {
  TaskCompletedParameters,
  WorktreeCreateParameters,
  WorktreeRemoveParameters,
} from "./parameters.generated";

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface RunCommandOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

type RunCommand = (
  command: string,
  args: string[],
  options: RunCommandOptions,
) => Promise<CommandResult>;

interface BitTaskDeps {
  runHook?: typeof defaultRunHook;
  runCommand?: RunCommand;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_TERM_GRACE_MS = 2_000;
const HOOK_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 65_536;
const ERROR_TAIL_LENGTH = 4_096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireString = (
  params: unknown,
  key: string,
  toolName: string,
): string => {
  if (!isRecord(params) || typeof params[key] !== "string") {
    throw new Error(`${toolName} requires a string parameter: ${key}`);
  }
  const value = params[key];
  if (value.length === 0) {
    throw new Error(`${toolName} requires a non-empty parameter: ${key}`);
  }
  return value;
};

const optionalString = (
  params: unknown,
  key: string,
  toolName: string,
): string | undefined => {
  if (!isRecord(params)) throw new Error(`${toolName} parameters are invalid`);
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${toolName} requires a string parameter: ${key}`);
  }
  return value;
};

const appendCapped = (current: string, chunk: string): string =>
  (current + chunk).slice(0, MAX_OUTPUT_BYTES);

const killGroup = (pid: number, signal: NodeJS.Signals): void => {
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group may already have exited.
  }
};

const runCommand: RunCommand = (command, args, options) =>
  new Promise((resolve, reject) => {
    const signalAborted = (): boolean =>
      options.signal !== undefined &&
      "aborted" in options.signal &&
      options.signal.aborted === true;
    if (signalAborted()) {
      resolve({ exitCode: 130, stdout: "", stderr: "Command aborted." });
      return;
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: sanitizeChildEnv(process.env, options.env, { cwd: options.cwd }),
      stdio: ["ignore", "pipe", "pipe"],
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

    const removeAbortListener = (): void => {
      if (
        options.signal !== undefined &&
        "removeEventListener" in options.signal &&
        typeof options.signal.removeEventListener === "function"
      ) {
        options.signal.removeEventListener("abort", onAbort);
      }
    };
    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
      removeAbortListener();
      let exitCode = code ?? 1;
      let finalStderr = stderr;
      if (timedOut) {
        exitCode = 124;
        finalStderr = `${stderr}\nCommand timed out.`;
      } else if (aborted) {
        exitCode = 130;
        finalStderr = `${stderr}\nCommand aborted.`;
      }
      resolve({ exitCode, stdout, stderr: finalStderr });
    };
    const terminate = (): void => {
      if (terminating || settled) return;
      terminating = true;
      if (child.pid === undefined) {
        if (!settled) settle(null);
        return;
      }
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => {
        if (child.pid !== undefined) killGroup(child.pid, "SIGKILL");
        forceSettleTimer = setTimeout(
          () => settle(null),
          PROCESS_FORCE_SETTLE_MS,
        );
        if (
          typeof forceSettleTimer === "object" &&
          "unref" in forceSettleTimer
        ) {
          forceSettleTimer.unref();
        }
      }, COMMAND_TERM_GRACE_MS);
    };
    const onAbort = (): void => {
      if (aborted || settled) return;
      aborted = true;
      clearTimeout(timer);
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (forceSettleTimer !== undefined) clearTimeout(forceSettleTimer);
      removeAbortListener();
      reject(error);
    });
    child.on("close", (code) => settle(code));

    if (
      options.signal !== undefined &&
      "addEventListener" in options.signal &&
      typeof options.signal.addEventListener === "function"
    ) {
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    if (signalAborted()) onAbort();
  });

const outputTail = (output: string): string => {
  const trimmed = output.trim();
  return trimmed === ""
    ? "(no stderr output)"
    : trimmed.slice(-ERROR_TAIL_LENGTH);
};

const hookFailure = (
  toolName: string,
  result: Awaited<ReturnType<typeof defaultRunHook>>,
): Error => {
  const status = result.timedOut
    ? "timed out"
    : `exited with code ${String(result.exitCode)}`;
  return new Error(`${toolName} ${status}: ${outputTail(result.stderr)}`);
};

const commandFailure = (description: string, result: CommandResult): Error =>
  new Error(
    `${description} exited with code ${result.exitCode}: ${outputTail(result.stderr)}`,
  );

const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

const verificationSkipped = (taskId: string, reason: string) =>
  textResult(`Task ${taskId} completed; verification skipped: ${reason}`);

const isEnoent = (error: unknown): boolean =>
  isRecord(error) && error.code === "ENOENT";

const worktreePaths = (porcelain: string): string[] =>
  porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isSignalAborted = (signal: AbortSignal | undefined): boolean =>
  signal !== undefined && "aborted" in signal && signal.aborted === true;

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (isSignalAborted(signal)) {
    throw new Error("Worktree creation was aborted");
  }
};

const validateReturnedWorktreePath = async (
  stdout: string,
): Promise<string> => {
  const outputLines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const returnedPath = outputLines[0] ?? "";
  if (returnedPath === "") {
    throw new Error(
      "worktree_create postcondition failed: hook returned an empty path",
    );
  }
  if (outputLines.some((line) => line !== returnedPath)) {
    throw new Error(
      "worktree_create postcondition failed: hook returned multiple paths",
    );
  }
  if (!isAbsolute(returnedPath)) {
    throw new Error(
      `worktree_create postcondition failed: hook returned a non-absolute path: ${returnedPath}`,
    );
  }
  try {
    const canonicalPath = await realpath(returnedPath);
    const pathStat = await stat(canonicalPath);
    if (!pathStat.isDirectory()) {
      throw new Error("returned path is not a directory");
    }
    return canonicalPath;
  } catch (error) {
    throw new Error(
      `worktree_create postcondition failed: could not validate returned directory ${returnedPath}: ${errorMessage(error)}`,
    );
  }
};

/**
 * Dependencies for creating a validated worktree outside the tool boundary.
 * The workflow feature reuses this to provision isolated worktrees for
 * codex-poc tasks with the exact same postconditions as the
 * worktree_create tool (S1).
 */
export interface WorktreeCreator {
  createScript: string;
  invokeHook: typeof defaultRunHook;
  invokeCommand: RunCommand;
  env: (
    additional?: Record<string, string | undefined>,
  ) => Record<string, string | undefined>;
}

export const makeWorktreeCreator = (
  config: HarnessConfig,
  deps: BitTaskDeps = {},
): WorktreeCreator => ({
  createScript: join(config.paths.codexHooksDir, "worktree/create.sh"),
  invokeHook: deps.runHook ?? defaultRunHook,
  invokeCommand: deps.runCommand ?? runCommand,
  env: (additional = {}) => ({
    ...deps.env,
    ...additional,
    PI_HARNESS_CHILD: "1",
  }),
});

export const createValidatedWorktree = async (
  creator: WorktreeCreator,
  cwd: string,
  name: string,
  signal?: AbortSignal,
  onCreated?: (path: string) => void,
): Promise<string> => {
  throwIfAborted(signal);
  const result = await creator.invokeHook(
    creator.createScript,
    buildWorktreeCreatePayload(name),
    {
      cwd,
      env: creator.env(),
      timeoutMs: HOOK_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      termGraceMs: WORKTREE_CREATE_TERM_GRACE_MS,
      signal,
    },
  );
  if (result.exitCode !== 0 || result.timedOut) {
    // The create hook prints only after atomically publishing its removal
    // marker. Cancellation and timeout both terminate it with SIGTERM, so
    // retain any validated published identity even when the process is nonzero.
    if (result.stdout.trim() !== "") {
      try {
        onCreated?.(await validateReturnedWorktreePath(result.stdout));
      } catch {
        // An interrupted hook may also print immediately before rolling back.
        // Never publish a path that no longer validates locally.
      }
    }
    throwIfAborted(signal);
    throw hookFailure("worktree_create", result);
  }

  const canonicalPath = await validateReturnedWorktreePath(result.stdout);
  // The hook may have created the worktree immediately before cancellation.
  // Publish its canonical identity after local filesystem validation but
  // before honoring that abort, so background persistence can report the
  // resource left behind without accepting an unvalidated hook path.
  onCreated?.(canonicalPath);
  throwIfAborted(signal);

  let listResult: CommandResult;
  try {
    listResult = await creator.invokeCommand(
      "git",
      ["worktree", "list", "--porcelain"],
      {
        cwd,
        env: creator.env(),
        timeoutMs: COMMAND_TIMEOUT_MS,
        signal,
      },
    );
  } catch (error) {
    throw new Error(
      `worktree_create postcondition failed: could not list current repository worktrees: ${errorMessage(error)}`,
    );
  }
  throwIfAborted(signal);
  if (listResult.exitCode !== 0) {
    throw new Error(
      `worktree_create postcondition failed: ${commandFailure("could not list current repository worktrees", listResult).message}`,
    );
  }
  if (!worktreePaths(listResult.stdout).includes(canonicalPath)) {
    throw new Error(
      `worktree_create postcondition failed: worktree is not registered in the current repository: ${canonicalPath}`,
    );
  }

  // Registration + directory existence alone can be satisfied by a stale
  // worktree entry whose path was recreated as a plain directory. Ask the
  // created path itself which repository it belongs to and require
  // common-dir identity with the current repo (re-review finding).
  const commonDirOf = async (target?: string): Promise<string> => {
    const args = [
      ...(target === undefined ? [] : ["-C", target]),
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ];
    const commonDirResult = await creator.invokeCommand("git", args, {
      cwd,
      env: creator.env(),
      timeoutMs: COMMAND_TIMEOUT_MS,
      signal,
    });
    throwIfAborted(signal);
    const rawPath = commonDirResult.stdout.trim();
    if (commonDirResult.exitCode !== 0 || rawPath === "") {
      throw new Error(
        `worktree_create postcondition failed: ${commandFailure("could not resolve Git common directory", commonDirResult).message}`,
      );
    }
    return realpath(rawPath);
  };
  const [repoCommonDir, createdCommonDir] = [
    await commonDirOf(),
    await commonDirOf(canonicalPath),
  ];
  throwIfAborted(signal);
  if (repoCommonDir !== createdCommonDir) {
    throw new Error(
      `worktree_create postcondition failed: created path belongs to a different repository (common-dir ${createdCommonDir} != ${repoCommonDir})`,
    );
  }
  return canonicalPath;
};

export default function setupBitTask(
  pi: PiLike,
  config: HarnessConfig,
  deps: BitTaskDeps = {},
): void {
  const invokeHook = deps.runHook ?? defaultRunHook;
  const invokeCommand = deps.runCommand ?? runCommand;
  const childEnv = (
    additional: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> => ({
    ...deps.env,
    ...additional,
    PI_HARNESS_CHILD: "1",
  });
  const creator = makeWorktreeCreator(config, deps);
  const removeScript = join(config.paths.codexHooksDir, "worktree/remove.sh");
  const taskCompletedScript = join(
    config.paths.codexHooksDir,
    "task_completed/bit_issue_update.sh",
  );

  pi.registerTool({
    name: "worktree_create",
    label: "Create Worktree",
    description:
      "Create a validated linked Git worktree for an explicitly named branch.",
    parameters: WorktreeCreateParameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: CtxLike,
    ) {
      const cwd = deps.cwd ?? ctx.cwd ?? process.cwd();
      const name = requireString(params, "name", "worktree_create");
      let createdPath: string | undefined;
      try {
        return textResult(
          await createValidatedWorktree(creator, cwd, name, signal, (path) => {
            createdPath = path;
          }),
        );
      } catch (error) {
        if (createdPath === undefined) throw error;
        throw new Error(
          `${errorMessage(error)}\n\nA worktree was left in place at: ${createdPath}\nIt can be removed with the user-approved worktree_remove tool.`,
        );
      }
    },
  });

  pi.registerTool({
    name: "worktree_remove",
    label: "Remove Worktree",
    description:
      "Remove a clean harness-created linked worktree after explicit user approval.",
    parameters: WorktreeRemoveParameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: CtxLike,
    ) {
      const cwd = deps.cwd ?? ctx.cwd ?? process.cwd();
      if (!isRecord(params) || params.confirmed !== true) {
        throw new Error(
          "worktree_remove requires user approval; set confirmed:true only after the USER explicitly approved the removal.",
        );
      }
      const requestedPath = requireString(params, "path", "worktree_remove");
      if (!isAbsolute(requestedPath)) {
        throw new Error(
          `worktree_remove requires an absolute path: ${requestedPath}`,
        );
      }

      let canonicalPath: string;
      try {
        canonicalPath = await realpath(requestedPath);
      } catch (error) {
        throw new Error(
          `worktree_remove could not canonicalize path ${requestedPath}: ${errorMessage(error)}`,
        );
      }

      const resolveCommonDir = async (
        target: string | undefined,
        phase: string,
      ): Promise<string> => {
        const args = [
          ...(target === undefined ? [] : ["-C", target]),
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ];
        let result: CommandResult;
        try {
          result = await invokeCommand("git", args, {
            cwd,
            env: childEnv(),
            timeoutMs: COMMAND_TIMEOUT_MS,
          });
        } catch (error) {
          throw new Error(
            `worktree_remove ${phase} failed: could not start Git common directory resolution: ${errorMessage(error)}`,
          );
        }
        const rawPath = result.stdout.trim();
        if (result.exitCode !== 0 || rawPath === "") {
          throw new Error(
            `worktree_remove ${phase} failed: ${commandFailure("could not resolve Git common directory", result).message}`,
          );
        }
        try {
          return await realpath(rawPath);
        } catch (error) {
          throw new Error(
            `worktree_remove ${phase} failed: could not canonicalize Git common directory ${rawPath}: ${errorMessage(error)}`,
          );
        }
      };

      // The top-level of the SESSION cwd: if the caller is running inside the
      // worktree it asked to remove, this equals canonicalPath and the removal
      // would delete the running checkout out from under itself. Guarding only
      // registeredPaths[0] (the main checkout) misses this when the session is
      // itself in a linked worktree (review finding).
      const resolveTopLevel = async (phase: string): Promise<string> => {
        let result: CommandResult;
        try {
          result = await invokeCommand(
            "git",
            ["rev-parse", "--path-format=absolute", "--show-toplevel"],
            { cwd, env: childEnv(), timeoutMs: COMMAND_TIMEOUT_MS },
          );
        } catch (error) {
          throw new Error(
            `worktree_remove ${phase} failed: could not start Git top-level resolution: ${errorMessage(error)}`,
          );
        }
        const rawPath = result.stdout.trim();
        if (result.exitCode !== 0 || rawPath === "") {
          throw new Error(
            `worktree_remove ${phase} failed: ${commandFailure("could not resolve Git top-level", result).message}`,
          );
        }
        try {
          return await realpath(rawPath);
        } catch (error) {
          throw new Error(
            `worktree_remove ${phase} failed: could not canonicalize Git top-level ${rawPath}: ${errorMessage(error)}`,
          );
        }
      };

      const currentCommonDir = await resolveCommonDir(undefined, "validation");
      const targetCommonDir = await resolveCommonDir(
        canonicalPath,
        "validation",
      );
      if (targetCommonDir !== currentCommonDir) {
        throw new Error(
          `worktree_remove refuses a linked worktree from another repository: ${canonicalPath}`,
        );
      }

      let listResult: CommandResult;
      try {
        listResult = await invokeCommand(
          "git",
          ["worktree", "list", "--porcelain"],
          { cwd, env: childEnv(), timeoutMs: COMMAND_TIMEOUT_MS },
        );
      } catch (error) {
        throw new Error(
          `worktree_remove validation failed: could not list current repository worktrees: ${errorMessage(error)}`,
        );
      }
      if (listResult.exitCode !== 0) {
        throw new Error(
          `worktree_remove validation failed: ${commandFailure("could not list current repository worktrees", listResult).message}`,
        );
      }
      const registeredPaths = worktreePaths(listResult.stdout);
      const [mainCheckout] = registeredPaths;
      if (canonicalPath === mainCheckout) {
        throw new Error(
          `worktree_remove refuses to remove the current repository checkout: ${canonicalPath}`,
        );
      }
      const currentTopLevel = await resolveTopLevel("validation");
      if (canonicalPath === currentTopLevel) {
        throw new Error(
          `worktree_remove refuses to remove the worktree containing the current session checkout: ${canonicalPath}`,
        );
      }
      if (!registeredPaths.includes(canonicalPath)) {
        throw new Error(
          `worktree_remove requires a registered linked worktree of the current repository: ${canonicalPath}`,
        );
      }

      let recheckedPath: string;
      try {
        recheckedPath = await realpath(requestedPath);
      } catch (error) {
        throw new Error(
          `worktree_remove pre-spawn verification failed: could not re-canonicalize ${requestedPath}: ${errorMessage(error)}`,
        );
      }
      if (recheckedPath !== canonicalPath) {
        throw new Error(
          `worktree_remove pre-spawn verification failed: path changed from ${canonicalPath} to ${recheckedPath}`,
        );
      }
      const recheckedCurrentCommonDir = await resolveCommonDir(
        undefined,
        "pre-spawn verification",
      );
      const recheckedTargetCommonDir = await resolveCommonDir(
        canonicalPath,
        "pre-spawn verification",
      );
      if (
        recheckedCurrentCommonDir !== currentCommonDir ||
        recheckedTargetCommonDir !== recheckedCurrentCommonDir
      ) {
        throw new Error(
          `worktree_remove pre-spawn verification failed: Git common directory identity changed for ${canonicalPath}`,
        );
      }
      const recheckedTopLevel = await resolveTopLevel("pre-spawn verification");
      if (
        recheckedTopLevel === canonicalPath ||
        recheckedTopLevel !== currentTopLevel
      ) {
        throw new Error(
          `worktree_remove pre-spawn verification failed: the current session checkout resolves to ${recheckedTopLevel}`,
        );
      }

      const result = await invokeHook(
        removeScript,
        buildWorktreeRemovePayload(canonicalPath),
        {
          cwd,
          env: childEnv(),
          timeoutMs: HOOK_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        throw hookFailure("worktree_remove", result);
      }

      let postListResult: CommandResult;
      try {
        postListResult = await invokeCommand(
          "git",
          ["worktree", "list", "--porcelain"],
          { cwd, env: childEnv(), timeoutMs: COMMAND_TIMEOUT_MS },
        );
      } catch (error) {
        throw new Error(
          `worktree_remove postcondition failed: could not list current repository worktrees: ${errorMessage(error)}`,
        );
      }
      if (postListResult.exitCode !== 0) {
        throw new Error(
          `worktree_remove postcondition failed: ${commandFailure("could not verify worktree removal", postListResult).message}`,
        );
      }
      if (worktreePaths(postListResult.stdout).includes(canonicalPath)) {
        throw new Error(
          `worktree_remove postcondition failed; worktree is still registered: ${canonicalPath}`,
        );
      }

      try {
        await lstat(canonicalPath);
      } catch (error) {
        if (isEnoent(error)) {
          return textResult(`Removed worktree: ${canonicalPath}`);
        }
        throw new Error(
          `worktree_remove postcondition failed; could not verify directory removal: ${errorMessage(error)}`,
        );
      }
      throw new Error(
        `worktree_remove postcondition failed; directory still exists: ${canonicalPath}`,
      );
    },
  });

  pi.registerTool({
    name: "task_completed",
    label: "Complete Task",
    description:
      "Close the local bit issue for a task after its completion was verified.",
    parameters: TaskCompletedParameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: CtxLike,
    ) {
      const cwd = deps.cwd ?? ctx.cwd ?? process.cwd();
      const taskId = requireString(params, "task_id", "task_completed");
      const taskSubject = optionalString(
        params,
        "task_subject",
        "task_completed",
      );
      let completed: CommandResult;
      try {
        completed = await invokeCommand(
          "bash",
          [taskCompletedScript, ...buildTaskCompletedArgs(taskId, taskSubject)],
          { cwd, env: childEnv(), timeoutMs: HOOK_TIMEOUT_MS },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`task_completed could not start: ${message}`);
      }
      if (completed.exitCode !== 0) {
        throw commandFailure("task_completed", completed);
      }

      // Verification is fail-closed; only an unavailable `bit` executable may
      // skip it. Git failures and all other bit failures are hard errors.
      let branchResult: CommandResult;
      try {
        branchResult = await invokeCommand(
          "git",
          ["branch", "--show-current"],
          { cwd, env: childEnv(), timeoutMs: COMMAND_TIMEOUT_MS },
        );
      } catch (error) {
        throw new Error(
          `task_completed verification failed: could not resolve current branch: ${errorMessage(error)}`,
        );
      }
      const branch = branchResult.stdout.trim();
      if (branchResult.exitCode !== 0 || branch === "") {
        throw new Error(
          `task_completed verification failed: current branch unavailable (exit code ${branchResult.exitCode})`,
        );
      }

      let commonDirResult: CommandResult;
      try {
        commonDirResult = await invokeCommand(
          "git",
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          { cwd, env: childEnv(), timeoutMs: COMMAND_TIMEOUT_MS },
        );
      } catch (error) {
        throw new Error(
          `task_completed verification failed: could not resolve Git common directory: ${errorMessage(error)}`,
        );
      }
      const commonDir = commonDirResult.stdout.trim();
      if (commonDirResult.exitCode !== 0 || commonDir === "") {
        throw new Error(
          `task_completed verification failed: Git common directory unavailable (exit code ${commonDirResult.exitCode})`,
        );
      }

      let openResult: CommandResult;
      try {
        openResult = await invokeCommand("bit", ["issue", "list", "--open"], {
          cwd,
          env: childEnv({ GIT_DIR: commonDir }),
          timeoutMs: COMMAND_TIMEOUT_MS,
        });
      } catch (error) {
        if (isEnoent(error)) {
          return verificationSkipped(taskId, "bit executable unavailable");
        }
        throw new Error(
          `task_completed verification failed: could not start bit issue list: ${errorMessage(error)}`,
        );
      }
      // bit is spawned directly, so a missing executable surfaces as ENOENT
      // above; exit 127 means something DID run and failed — that is
      // verifiable and must fail closed, not skip (re-review finding).
      if (openResult.exitCode !== 0) {
        throw new Error(
          `task_completed verification failed: bit issue list exited with code ${openResult.exitCode}: ${outputTail(openResult.stderr)}`,
        );
      }
      const stillOpen = openResult.stdout
        .split(/\r?\n/)
        .some((line) => matchesTaskMarker(line, branch, taskId));
      if (stillOpen) {
        throw new Error(
          `task_completed postcondition failed; task marker remains open for ${taskId}`,
        );
      }

      return textResult(`Task completed and verified: ${taskId}`);
    },
  });
}
