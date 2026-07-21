import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { sanitizeChildEnv } from "../../lib/child-env";
import { isPathWithin } from "../../lib/trust";

const MAX_TASK_TEXT_BYTES = 1_024;
const MAX_PENDING_TASKS = 8;
const MAX_GIT_OUTPUT_BYTES = 64 * 1_024;
const MAX_DISCOVERED_WORKTREES = 128;
const MAX_DISCOVERED_PATH_BYTES = 1_024;
const MAX_VISIBLE_WORKTREES = 16;
const MAX_VISIBLE_PATH_BYTES = 512;
const MAX_VISIBLE_PROJECT_BYTES = 2_048;
const DEFAULT_GIT_TIMEOUT_MS = 250;

const fingerprint = (...parts: readonly string[]): string => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex");
};

const truncateUtf8 = (value: string, maxBytes: number): string => {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maxBytes) return value;
  const marker = Buffer.from("…", "utf8");
  let end = Math.max(0, maxBytes - marker.byteLength);
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) {
    end -= 1;
  }
  return `${encoded.subarray(0, end).toString("utf8")}${marker.toString("utf8")}`;
};

const isControlCharacter = (character: string): boolean => {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) ||
      codePoint === 0x7f)
  );
};

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });

const sanitizeTaskText = (text: string): string =>
  [...text.replace(/\r\n?/g, "\n")]
    .map((character) => (isControlCharacter(character) ? " " : character))
    .join("")
    .trim();

export type PermissionTaskSource = "interactive" | "rpc" | "extension";

export interface BoundedTaskContext {
  readonly text: string;
  readonly source: PermissionTaskSource;
  /** Hash of the complete raw input, including bytes omitted from text. */
  readonly fingerprint: string;
}

export const boundTaskContext = (
  rawText: string,
  source: PermissionTaskSource,
): BoundedTaskContext | undefined => {
  const text = truncateUtf8(sanitizeTaskText(rawText), MAX_TASK_TEXT_BYTES);
  if (text === "") return undefined;
  return {
    text,
    source,
    fingerprint: fingerprint("task-v1", source, rawText),
  };
};

export type PermissionStreamingBehavior = "steer" | "followUp";

export interface PermissionTaskTracker {
  capture(input: {
    text: string;
    source: PermissionTaskSource;
    streamingBehavior?: PermissionStreamingBehavior;
  }): void;
  activate(agentPrompt: string): void;
  activateFromMessages(messages: readonly unknown[]): void;
  current(): BoundedTaskContext | undefined;
  settle(): void;
  clear(): void;
}

const isExpandableInvocation = (task: BoundedTaskContext): boolean =>
  /^\/[^\s]+(?:\s|$)/.test(task.text);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const userMessageText = (message: unknown): string | undefined => {
  if (!isRecord(message) || message.role !== "user") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const text: string[] = [];
  for (const block of message.content) {
    if (
      isRecord(block) &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      text.push(block.text);
    }
  }
  return text.length === 0 ? undefined : text.join("");
};

interface PendingTaskContext {
  readonly task: BoundedTaskContext;
  readonly queued: boolean;
}

interface UserContextObservation {
  readonly count: number;
}

export const createPermissionTaskTracker = (): PermissionTaskTracker => {
  const pending: PendingTaskContext[] = [];
  let active: BoundedTaskContext | undefined;
  let lastUserContext: UserContextObservation | undefined;

  const exactMatchIndex = (text: string): number => {
    const fingerprintBySource = new Map<PermissionTaskSource, string>([
      ["interactive", fingerprint("task-v1", "interactive", text)],
      ["rpc", fingerprint("task-v1", "rpc", text)],
      ["extension", fingerprint("task-v1", "extension", text)],
    ]);
    return pending.findIndex(
      ({ task }) => fingerprintBySource.get(task.source) === task.fingerprint,
    );
  };
  const promote = (index: number): void => {
    active = pending[index]?.task;
    pending.splice(0, index + 1);
  };

  return {
    capture(input) {
      const task = boundTaskContext(input.text, input.source);
      if (task === undefined) return;
      pending.push({
        task,
        queued: input.streamingBehavior !== undefined,
      });
      if (pending.length > MAX_PENDING_TASKS) pending.shift();
    },
    activate(agentPrompt) {
      // Automatic retries/compaction can begin another agent run without a
      // new input event. Preserve the current task until agent_settled; only a
      // pending new input is allowed to replace or invalidate it.
      if (pending.length === 0) return;
      active = undefined;
      const matchIndex = exactMatchIndex(agentPrompt);
      if (matchIndex !== -1) {
        promote(matchIndex);
        return;
      }
      const [firstPending] = pending;
      if (
        firstPending !== undefined &&
        isExpandableInvocation(firstPending.task)
      ) {
        // Pi expands both `/skill:name` and prompt-template `/name`
        // invocations after the raw input event. before_agent_start proves the
        // corresponding run has begun, so retain the raw invocation only.
        promote(0);
        return;
      }
      pending.length = 0;
    },
    activateFromMessages(messages) {
      let latestUserText: string | undefined;
      let userMessageCount = 0;
      for (const message of messages) {
        const text = userMessageText(message);
        if (text !== undefined) {
          latestUserText = text;
          userMessageCount += 1;
        }
      }
      const previousContext = lastUserContext;
      lastUserContext = { count: userMessageCount };
      if (pending.length === 0 || latestUserText === undefined) return;

      const matchIndex = exactMatchIndex(latestUserText);
      if (matchIndex !== -1) {
        promote(matchIndex);
        return;
      }

      const deliveredNewUserMessage =
        previousContext !== undefined &&
        userMessageCount > previousContext.count;
      const [firstPending] = pending;
      if (
        deliveredNewUserMessage &&
        firstPending?.queued === true &&
        isExpandableInvocation(firstPending.task)
      ) {
        // A queued skill/template reaches context already expanded. Promote it
        // only after a new user message is observable, never on an earlier tool
        // loop that still ends with the previous task.
        promote(0);
      }
    },
    current() {
      return active;
    },
    settle() {
      active = undefined;
      pending.length = 0;
    },
    clear() {
      active = undefined;
      pending.length = 0;
      lastUserContext = undefined;
    },
  };
};

export type GitWorktreeListResult =
  | { readonly kind: "ok"; readonly stdout: Uint8Array }
  | { readonly kind: "non-git" }
  | { readonly kind: "unavailable"; readonly reason: string };

interface GitRunnerOptions {
  readonly gitExecutable?: string;
  readonly timeoutMs?: number;
}

const decoder = new TextDecoder(undefined, {
  fatal: true,
  ignoreBOM: true,
});

interface ActiveAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

const isAbortSignal = (
  value: AbortSignal | undefined,
): value is AbortSignal & ActiveAbortSignal =>
  value !== undefined &&
  typeof value === "object" &&
  "aborted" in value &&
  typeof value.aborted === "boolean" &&
  "addEventListener" in value &&
  typeof value.addEventListener === "function" &&
  "removeEventListener" in value &&
  typeof value.removeEventListener === "function";

interface AbortControllerLike {
  readonly signal: AbortSignal & ActiveAbortSignal;
  abort(): void;
}

const createAbortController = (): AbortControllerLike => {
  const value: unknown = new AbortController();
  if (
    typeof value !== "object" ||
    value === null ||
    !("abort" in value) ||
    typeof value.abort !== "function" ||
    !("signal" in value) ||
    !isAbortSignal(value.signal as AbortSignal | undefined)
  ) {
    throw new Error("AbortController is unavailable");
  }
  const { abort, signal } = value;
  return {
    signal: signal as AbortSignal & ActiveAbortSignal,
    abort: () => Reflect.apply(abort, value, []),
  };
};

export const runGitWorktreeList = (
  cwd: string,
  signal?: AbortSignal,
  options: GitRunnerOptions = {},
): Promise<GitWorktreeListResult> => {
  const activeSignal = isAbortSignal(signal) ? signal : undefined;
  if (activeSignal?.aborted === true) {
    return Promise.resolve({
      kind: "unavailable",
      reason: "project discovery was cancelled",
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof execFile> | undefined;
    const finish = (result: GitWorktreeListResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeSignal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      child?.kill("SIGKILL");
      finish({
        kind: "unavailable",
        reason: "project discovery was cancelled",
      });
    };
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
      finish({
        kind: "unavailable",
        reason: "git worktree discovery timed out",
      });
    }, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);

    try {
      child = execFile(
        options.gitExecutable ?? "git",
        ["worktree", "list", "--porcelain", "-z"],
        {
          cwd,
          encoding: "buffer",
          maxBuffer: MAX_GIT_OUTPUT_BYTES,
          env: sanitizeChildEnv(
            process.env,
            {
              GIT_OPTIONAL_LOCKS: "0",
              LANG: "C",
              LC_ALL: "C",
            },
            { cwd },
          ),
        },
        (error, stdout, stderr) => {
          if (settled) return;
          if (activeSignal?.aborted === true) {
            finish({
              kind: "unavailable",
              reason: "project discovery was cancelled",
            });
            return;
          }
          const stdoutBytes = Buffer.isBuffer(stdout)
            ? stdout
            : Buffer.from(stdout);
          const stderrBytes = Buffer.isBuffer(stderr)
            ? stderr
            : Buffer.from(stderr);
          if (error !== null) {
            const stderrText = stderrBytes.toString("utf8");
            if (stderrText.includes("not a git repository")) {
              finish({ kind: "non-git" });
              return;
            }
            finish({
              kind: "unavailable",
              reason:
                stdoutBytes.byteLength >= MAX_GIT_OUTPUT_BYTES ||
                stderrBytes.byteLength >= MAX_GIT_OUTPUT_BYTES
                  ? "git worktree discovery exceeded the output limit"
                  : "git worktree discovery failed",
            });
            return;
          }
          if (stdoutBytes.byteLength > MAX_GIT_OUTPUT_BYTES) {
            finish({
              kind: "unavailable",
              reason: "git worktree discovery exceeded the output limit",
            });
            return;
          }
          finish({ kind: "ok", stdout: stdoutBytes });
        },
      );
      activeSignal?.addEventListener("abort", onAbort, { once: true });
      if (activeSignal?.aborted === true) onAbort();
    } catch {
      finish({
        kind: "unavailable",
        reason: "git worktree discovery failed",
      });
    }
  });
};

export type PermissionProjectContext =
  | {
      readonly kind: "git";
      readonly name?: string;
      readonly cwd: string;
      readonly activeWorktree: string;
      readonly worktrees: readonly string[];
      readonly fingerprint: string;
    }
  | {
      readonly kind: "non-git";
      readonly cwd: string;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "unavailable";
      readonly cwd?: string;
      readonly reason: string;
      readonly fingerprint: string;
    };

interface ProjectContextOptions {
  readonly runGit?: (
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<GitWorktreeListResult>;
  readonly canonicalizeDirectory?: (
    path: string,
  ) => Promise<string | undefined>;
  readonly timeoutMs?: number;
}

interface ParsedWorktreeRecord {
  readonly path: string;
  readonly prunable: boolean;
  readonly bare: boolean;
}

const parseWorktreeRecords = (
  stdout: Uint8Array,
): readonly ParsedWorktreeRecord[] | undefined => {
  if (stdout.byteLength === 0 || stdout.byteLength > MAX_GIT_OUTPUT_BYTES) {
    return undefined;
  }
  let text: string;
  try {
    text = decoder.decode(stdout);
  } catch {
    return undefined;
  }
  if (!text.endsWith("\0\0")) return undefined;

  const records: ParsedWorktreeRecord[] = [];
  let fields: string[] = [];
  const consume = (): boolean => {
    if (fields.length === 0) return true;
    const worktreeFields = fields.filter((field) =>
      field.startsWith("worktree "),
    );
    const [worktreeField] = worktreeFields;
    const [firstField] = fields;
    if (
      worktreeFields.length !== 1 ||
      worktreeField === undefined ||
      worktreeField !== firstField
    ) {
      return false;
    }
    const path = worktreeField.slice("worktree ".length);
    if (
      path === "" ||
      Buffer.byteLength(path, "utf8") > MAX_DISCOVERED_PATH_BYTES ||
      hasControlCharacter(path)
    ) {
      return false;
    }
    records.push({
      path,
      prunable: fields.some(
        (field) => field === "prunable" || field.startsWith("prunable "),
      ),
      bare: fields.includes("bare"),
    });
    return records.length <= MAX_DISCOVERED_WORKTREES;
  };

  for (const field of text.split("\0")) {
    if (field !== "") {
      fields.push(field);
      continue;
    }
    if (!consume()) return undefined;
    fields = [];
  }
  if (fields.length !== 0 || records.length === 0) return undefined;
  return records;
};

const unavailableProject = (
  cwd: string | undefined,
  reason: string,
): PermissionProjectContext => ({
  kind: "unavailable",
  ...(cwd === undefined ? {} : { cwd }),
  reason,
  fingerprint: fingerprint("project-v1", "unavailable", cwd ?? "", reason),
});

const safeCanonicalDirectory = async (
  path: string,
): Promise<string | undefined> => {
  try {
    const canonical = await realpath(path);
    const stats = await stat(canonical);
    if (!stats.isDirectory()) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
};

const visibleWorktrees = (
  active: string,
  main: string,
  all: readonly string[],
): readonly string[] | undefined => {
  const ordered = [active, main, ...[...all].sort()];
  const visible: string[] = [];
  let totalBytes = 0;
  for (const path of ordered) {
    if (visible.includes(path)) continue;
    const pathBytes = Buffer.byteLength(path, "utf8");
    if (pathBytes > MAX_VISIBLE_PATH_BYTES) {
      if (path === active || path === main) return undefined;
      continue;
    }
    if (
      visible.length >= MAX_VISIBLE_WORKTREES ||
      totalBytes + pathBytes > MAX_VISIBLE_PROJECT_BYTES
    ) {
      continue;
    }
    visible.push(path);
    totalBytes += pathBytes;
  }
  return visible;
};

const discoverProjectContextUnbounded = async (
  cwd: string,
  options: ProjectContextOptions,
  signal: AbortSignal & ActiveAbortSignal,
): Promise<PermissionProjectContext> => {
  const canonicalize = options.canonicalizeDirectory ?? safeCanonicalDirectory;
  const canonicalCwd = await canonicalize(cwd);
  if (canonicalCwd === undefined) {
    return unavailableProject(
      undefined,
      "current working directory did not resolve",
    );
  }
  if (signal.aborted) {
    return unavailableProject(canonicalCwd, "project discovery was cancelled");
  }

  const result = await (options.runGit ?? runGitWorktreeList)(
    canonicalCwd,
    signal,
  );
  if (signal.aborted) {
    return unavailableProject(canonicalCwd, "project discovery was cancelled");
  }
  if (result.kind === "non-git") {
    return {
      kind: "non-git",
      cwd: canonicalCwd,
      fingerprint: fingerprint("project-v1", "non-git", canonicalCwd),
    };
  }
  if (result.kind === "unavailable") {
    return unavailableProject(canonicalCwd, result.reason);
  }

  const records = parseWorktreeRecords(result.stdout);
  if (records === undefined) {
    return unavailableProject(
      canonicalCwd,
      "git returned malformed worktree data",
    );
  }

  const canonicalRecords: { path: string; bare: boolean }[] = [];
  const canonicalWorktrees: string[] = [];
  let canonicalProjectRoot: string | undefined;
  for (const [index, record] of records.entries()) {
    const canonical = await canonicalize(record.path);
    if (signal.aborted) {
      return unavailableProject(
        canonicalCwd,
        "project discovery was cancelled",
      );
    }
    if (canonical === undefined) {
      if (record.prunable) continue;
      return unavailableProject(
        canonicalCwd,
        "git returned an unresolved worktree path",
      );
    }
    if (hasControlCharacter(canonical)) {
      return unavailableProject(
        canonicalCwd,
        "git returned an unsafe worktree path",
      );
    }
    if (index === 0) canonicalProjectRoot = canonical;
    if (
      !canonicalRecords.some(
        (item) => item.path === canonical && item.bare === record.bare,
      )
    ) {
      canonicalRecords.push({ path: canonical, bare: record.bare });
    }
    if (!record.bare && !canonicalWorktrees.includes(canonical)) {
      canonicalWorktrees.push(canonical);
    }
  }
  if (canonicalProjectRoot === undefined || canonicalWorktrees.length === 0) {
    return unavailableProject(
      canonicalCwd,
      "git returned no navigable worktrees",
    );
  }

  const activeWorktree = [...canonicalWorktrees]
    .sort((left, right) => right.length - left.length)
    .find((root) => isPathWithin(canonicalCwd, root));
  if (activeWorktree === undefined) {
    return unavailableProject(
      canonicalCwd,
      "current working directory was not inside a listed worktree",
    );
  }
  const [primaryWorktree] = canonicalWorktrees;
  if (primaryWorktree === undefined) {
    return unavailableProject(
      canonicalCwd,
      "git returned no navigable worktrees",
    );
  }
  const worktrees = visibleWorktrees(
    activeWorktree,
    primaryWorktree,
    canonicalWorktrees,
  );
  if (worktrees === undefined) {
    return unavailableProject(
      canonicalCwd,
      "project paths exceeded the context limit",
    );
  }

  const completeRoots = [...canonicalRecords].sort((left, right) =>
    left.path === right.path
      ? Number(left.bare) - Number(right.bare)
      : left.path.localeCompare(right.path),
  );
  const projectName = truncateUtf8(basename(canonicalProjectRoot), 128);
  return {
    kind: "git",
    ...(projectName === "" ? {} : { name: projectName }),
    cwd: canonicalCwd,
    activeWorktree,
    worktrees,
    fingerprint: fingerprint(
      "project-v2",
      canonicalCwd,
      canonicalProjectRoot,
      ...completeRoots.flatMap(({ path, bare }) => [
        bare ? "bare" : "worktree",
        path,
      ]),
    ),
  };
};

export const discoverProjectContext = async (
  cwd: string,
  options: ProjectContextOptions = {},
  signal?: AbortSignal,
): Promise<PermissionProjectContext> => {
  const parentSignal = isAbortSignal(signal) ? signal : undefined;
  if (parentSignal?.aborted === true) {
    return unavailableProject(undefined, "project discovery was cancelled");
  }

  const controller = createAbortController();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (context: PermissionProjectContext): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
      resolve(context);
    };
    const onParentAbort = (): void => {
      controller.abort();
      finish(unavailableProject(undefined, "project discovery was cancelled"));
    };
    const timer = setTimeout(
      () => {
        controller.abort();
        finish(unavailableProject(undefined, "project discovery timed out"));
      },
      Math.max(1, options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS),
    );

    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (parentSignal?.aborted === true) {
      onParentAbort();
      return;
    }
    void discoverProjectContextUnbounded(cwd, options, controller.signal).then(
      finish,
      () => finish(unavailableProject(undefined, "project discovery failed")),
    );
  });
};
