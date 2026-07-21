import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, resolve as resolvePath } from "node:path";
import { sanitizeChildEnvAsync } from "../../lib/child-env";
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

export type PermissionTaskCorrelation =
  | { readonly correlation: "task"; readonly task: BoundedTaskContext }
  | { readonly correlation: "none" }
  | { readonly correlation: "uncorrelated" };

export interface PermissionTaskTracker {
  capture(input: {
    text: string;
    source: PermissionTaskSource;
    streamingBehavior?: PermissionStreamingBehavior;
  }): void;
  activate(agentPrompt: string): void;
  activateFromMessages(messages: readonly unknown[]): void;
  current(): PermissionTaskCorrelation;
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
  readonly rawText: string;
  readonly behavior?: PermissionStreamingBehavior;
}

interface UserContextObservation {
  readonly count: number;
  readonly chainFingerprint: string;
}

const userContextFingerprint = (
  texts: readonly string[],
  count = texts.length,
): string => fingerprint("user-context-v1", ...texts.slice(0, count));

export const createPermissionTaskTracker = (): PermissionTaskTracker => {
  const pending: PendingTaskContext[] = [];
  let current: PermissionTaskCorrelation = { correlation: "none" };
  let lastUserContext: UserContextObservation | undefined;
  let overflowed = false;
  let correlationHealthy = true;

  const invalidate = (): void => {
    current = { correlation: "uncorrelated" };
    pending.length = 0;
    overflowed = false;
    correlationHealthy = false;
  };
  const promote = (entry: PendingTaskContext): void => {
    current = { correlation: "task", task: entry.task };
  };
  const removeEntries = (entries: readonly PendingTaskContext[]): void => {
    const delivered = new Set(entries);
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index];
      if (entry !== undefined && delivered.has(entry)) pending.splice(index, 1);
    }
  };

  return {
    capture(input) {
      if (!correlationHealthy) return;
      const task = boundTaskContext(input.text, input.source);
      if (task === undefined) return;
      pending.push({
        task,
        rawText: input.text,
        ...(input.streamingBehavior === undefined
          ? {}
          : { behavior: input.streamingBehavior }),
      });
      if (pending.length > MAX_PENDING_TASKS) {
        pending.shift();
        overflowed = true;
      }
    },
    activate(agentPrompt) {
      // Automatic retries/compaction can begin another agent run without a
      // new input event. Preserve the current task until agent_settled.
      if (!correlationHealthy || pending.length === 0) return;
      const idle = pending.filter((entry) => entry.behavior === undefined);
      if (idle.length === 0) return; // queued inputs require provider evidence
      if (overflowed || idle.length !== 1 || idle.length !== pending.length) {
        invalidate();
        return;
      }
      const [entry] = idle;
      if (
        entry === undefined ||
        (entry.rawText !== agentPrompt && !isExpandableInvocation(entry.task))
      ) {
        invalidate();
        return;
      }
      removeEntries([entry]);
      promote(entry);
    },
    activateFromMessages(messages) {
      const texts: string[] = [];
      for (const message of messages) {
        const text = userMessageText(message);
        if (text !== undefined) texts.push(text);
      }
      const observation: UserContextObservation = {
        count: texts.length,
        chainFingerprint: userContextFingerprint(texts),
      };
      const previous = lastUserContext;
      lastUserContext = observation;
      if (!correlationHealthy) return;

      if (previous === undefined) {
        if (pending.some((entry) => entry.behavior !== undefined)) invalidate();
        return;
      }
      const appendOnly =
        texts.length >= previous.count &&
        userContextFingerprint(texts, previous.count) ===
          previous.chainFingerprint;
      if (!appendOnly) {
        // Retry/compaction without a pending delivery preserves the active
        // task. A pending input cannot be correlated across the rewrite.
        if (pending.length > 0) invalidate();
        return;
      }
      const delta = texts.length - previous.count;
      if (pending.length === 0 || delta === 0) return;
      if (overflowed || pending.some((entry) => entry.behavior === undefined)) {
        invalidate();
        return;
      }

      // Pi delivers every steering message before queued follow-ups, with FIFO
      // order inside each behavior queue.
      const expected = [
        ...pending.filter((entry) => entry.behavior === "steer"),
        ...pending.filter((entry) => entry.behavior === "followUp"),
      ];
      if (delta > expected.length) {
        invalidate();
        return;
      }
      const delivered = expected.slice(0, delta);
      const deliveredTexts = texts.slice(previous.count);
      const valid = delivered.every((entry, index) => {
        if (
          expected.filter((candidate) => candidate.rawText === entry.rawText)
            .length !== 1
        ) {
          return false;
        }
        // Queued skill/template invocations expand before provider delivery,
        // but Pi exposes no dequeue/edit event to this tracker. Accepting an
        // arbitrary expanded message would let a removed invocation bind to a
        // later task. Only exact delivery text is therefore correlatable.
        return deliveredTexts[index] === entry.rawText;
      });
      if (!valid) {
        invalidate();
        return;
      }
      const latest = delivered[delivered.length - 1];
      if (latest === undefined) {
        invalidate();
        return;
      }
      removeEntries(delivered);
      promote(latest);
    },
    current() {
      return current;
    },
    settle() {
      current = { correlation: "none" };
      pending.length = 0;
      overflowed = false;
      correlationHealthy = true;
    },
    clear() {
      current = { correlation: "none" };
      pending.length = 0;
      lastUserContext = undefined;
      overflowed = false;
      correlationHealthy = true;
    },
  };
};

export type GitWorktreeListResult =
  | { readonly kind: "ok"; readonly stdout: Uint8Array }
  | { readonly kind: "non-git" }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface GitRunnerOptions {
  readonly gitExecutable?: string;
  readonly timeoutMs?: number;
  readonly buildEnv?: (cwd: string) => Promise<Record<string, string>>;
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

    activeSignal?.addEventListener("abort", onAbort, { once: true });
    const buildEnv =
      options.buildEnv ??
      ((directory: string) =>
        sanitizeChildEnvAsync(
          process.env,
          {
            GIT_OPTIONAL_LOCKS: "0",
            LANG: "C",
            LC_ALL: "C",
          },
          { cwd: directory },
        ));
    void buildEnv(cwd).then(
      (env) => {
        if (settled || activeSignal?.aborted === true) return;
        try {
          child = execFile(
            options.gitExecutable ?? "git",
            ["worktree", "list", "--porcelain", "-z"],
            {
              cwd,
              encoding: "buffer",
              maxBuffer: MAX_GIT_OUTPUT_BYTES,
              env,
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
        } catch {
          finish({
            kind: "unavailable",
            reason: "git worktree discovery failed",
          });
        }
      },
      () =>
        finish({
          kind: "unavailable",
          reason: "git worktree discovery failed",
        }),
    );
    if (activeSignal?.aborted === true) onAbort();
  });
};

export interface PermissionLeadingNavigation {
  readonly scope: "listed-worktree" | "outside-listed-worktrees" | "unverified";
  /** Internal fast-path evidence; never included in the model envelope. */
  readonly sameRepository: boolean;
}

export const runGitCommonDir = (
  cwd: string,
  signal?: AbortSignal,
  options: GitRunnerOptions = {},
): Promise<string | undefined> => {
  const activeSignal = isAbortSignal(signal) ? signal : undefined;
  if (activeSignal?.aborted === true) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    let settled = false;
    let child: ReturnType<typeof execFile> | undefined;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeSignal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => {
      child?.kill("SIGKILL");
      finish(undefined);
    };
    const timer = setTimeout(
      onAbort,
      options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    );
    activeSignal?.addEventListener("abort", onAbort, { once: true });
    const buildEnv =
      options.buildEnv ??
      ((directory: string) =>
        sanitizeChildEnvAsync(
          process.env,
          { GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" },
          { cwd: directory },
        ));
    void buildEnv(cwd).then(
      (env) => {
        if (settled || activeSignal?.aborted === true) return;
        try {
          child = execFile(
            options.gitExecutable ?? "git",
            ["rev-parse", "--path-format=absolute", "--git-common-dir"],
            { cwd, encoding: "buffer", maxBuffer: 4_096, env },
            (error, stdout) => {
              if (settled || error !== null || activeSignal?.aborted === true) {
                finish(undefined);
                return;
              }
              const bytes = Buffer.isBuffer(stdout)
                ? stdout
                : Buffer.from(stdout);
              let text: string;
              try {
                text = decoder.decode(bytes);
              } catch {
                finish(undefined);
                return;
              }
              if (text.endsWith("\n")) text = text.slice(0, -1);
              if (text.endsWith("\r")) text = text.slice(0, -1);
              if (
                text === "" ||
                !isAbsolute(text) ||
                hasControlCharacter(text)
              ) {
                finish(undefined);
                return;
              }
              void realpath(text).then(finish, () => finish(undefined));
            },
          );
        } catch {
          finish(undefined);
        }
      },
      () => finish(undefined),
    );
    if (activeSignal?.aborted === true) onAbort();
  });
};

export type PermissionProjectContext =
  | {
      readonly kind: "git";
      readonly name?: string;
      readonly cwd: string;
      readonly activeWorktree: string;
      /** Complete canonical non-bare roots used for security decisions. */
      readonly navigableRoots: readonly string[];
      /** Bounded display-only subset sent to the local model. */
      readonly worktrees: readonly string[];
      readonly leadingNavigation?: PermissionLeadingNavigation;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "non-git";
      readonly cwd: string;
      readonly leadingNavigation?: PermissionLeadingNavigation;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "unavailable";
      readonly cwd?: string;
      readonly reason: string;
      readonly leadingNavigation?: PermissionLeadingNavigation;
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
  readonly runGitCommonDir?: (
    cwd: string,
    signal?: AbortSignal,
  ) => Promise<string | undefined>;
  readonly leadingCdTarget?: string;
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
  const seenPaths = new Set<string>();
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
      !isAbsolute(path) ||
      Buffer.byteLength(path, "utf8") > MAX_DISCOVERED_PATH_BYTES ||
      hasControlCharacter(path)
    ) {
      return false;
    }
    if (seenPaths.has(path)) return false;
    seenPaths.add(path);
    const seenKinds = new Set<string>();
    for (const field of fields.slice(1)) {
      const kind = field.split(" ", 1)[0];
      if (
        kind === undefined ||
        !["HEAD", "branch", "detached", "bare", "locked", "prunable"].includes(
          kind,
        ) ||
        seenKinds.has(kind)
      ) {
        return false;
      }
      seenKinds.add(kind);
    }
    if (seenKinds.has("branch") && seenKinds.has("detached")) return false;
    records.push({
      path,
      prunable: seenKinds.has("prunable"),
      bare: seenKinds.has("bare"),
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
  leadingCdTarget?: string,
): PermissionProjectContext => ({
  kind: "unavailable",
  ...(cwd === undefined ? {} : { cwd }),
  reason,
  ...(leadingCdTarget === undefined
    ? {}
    : {
        leadingNavigation: {
          scope: "unverified" as const,
          sameRepository: false,
        },
      }),
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
  const unavailable = (resolvedCwd: string | undefined, reason: string) =>
    unavailableProject(resolvedCwd, reason, options.leadingCdTarget);
  const canonicalize = options.canonicalizeDirectory ?? safeCanonicalDirectory;
  const canonicalCwd = await canonicalize(cwd);
  if (canonicalCwd === undefined) {
    return unavailable(undefined, "current working directory did not resolve");
  }
  if (signal.aborted) {
    return unavailable(canonicalCwd, "project discovery was cancelled");
  }

  const result = await (options.runGit ?? runGitWorktreeList)(
    canonicalCwd,
    signal,
  );
  if (signal.aborted) {
    return unavailable(canonicalCwd, "project discovery was cancelled");
  }
  if (result.kind === "non-git") {
    return {
      kind: "non-git",
      cwd: canonicalCwd,
      ...(options.leadingCdTarget === undefined
        ? {}
        : {
            leadingNavigation: {
              scope: "unverified" as const,
              sameRepository: false,
            },
          }),
      fingerprint: fingerprint("project-v1", "non-git", canonicalCwd),
    };
  }
  if (result.kind === "unavailable") {
    return unavailable(canonicalCwd, result.reason);
  }

  const records = parseWorktreeRecords(result.stdout);
  if (records === undefined) {
    return unavailable(canonicalCwd, "git returned malformed worktree data");
  }

  const canonicalRecords: { path: string; bare: boolean }[] = [];
  const canonicalWorktrees: string[] = [];
  let canonicalProjectRoot: string | undefined;
  for (const record of records) {
    if (record.prunable) continue;
    const canonical = await canonicalize(record.path);
    if (signal.aborted) {
      return unavailable(canonicalCwd, "project discovery was cancelled");
    }
    if (canonical === undefined) {
      return unavailable(
        canonicalCwd,
        "git returned an unresolved worktree path",
      );
    }
    if (hasControlCharacter(canonical)) {
      return unavailable(canonicalCwd, "git returned an unsafe worktree path");
    }
    if (canonicalProjectRoot === undefined) canonicalProjectRoot = canonical;
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
    return unavailable(canonicalCwd, "git returned no navigable worktrees");
  }

  const activeWorktree = [...canonicalWorktrees]
    .sort((left, right) => right.length - left.length)
    .find((root) => isPathWithin(canonicalCwd, root));
  if (activeWorktree === undefined) {
    return unavailable(
      canonicalCwd,
      "current working directory was not inside a listed worktree",
    );
  }

  const commonDir = options.runGitCommonDir ?? runGitCommonDir;
  const activeCommonDir = await commonDir(canonicalCwd, signal);
  if (signal.aborted) {
    return unavailable(canonicalCwd, "project discovery was cancelled");
  }
  if (activeCommonDir === undefined) {
    return unavailable(
      canonicalCwd,
      "current Git common directory did not resolve",
    );
  }
  const listedCommonDirs = await Promise.all(
    canonicalWorktrees.map((root) =>
      root === activeWorktree
        ? Promise.resolve(activeCommonDir)
        : commonDir(root, signal),
    ),
  );
  if (signal.aborted) {
    return unavailable(canonicalCwd, "project discovery was cancelled");
  }
  if (listedCommonDirs.some((candidate) => candidate === undefined)) {
    return unavailable(canonicalCwd, "git returned an unverifiable worktree");
  }
  if (listedCommonDirs.some((candidate) => candidate !== activeCommonDir)) {
    return unavailable(
      canonicalCwd,
      "git returned a worktree from a different repository",
    );
  }

  const [primaryWorktree] = canonicalWorktrees;
  if (primaryWorktree === undefined) {
    return unavailable(canonicalCwd, "git returned no navigable worktrees");
  }
  const worktrees = visibleWorktrees(
    activeWorktree,
    primaryWorktree,
    canonicalWorktrees,
  );
  if (worktrees === undefined) {
    return unavailable(
      canonicalCwd,
      "project paths exceeded the context limit",
    );
  }

  const completeRoots = [...canonicalRecords].sort((left, right) =>
    left.path === right.path
      ? Number(left.bare) - Number(right.bare)
      : left.path.localeCompare(right.path),
  );
  const navigableRoots = [...canonicalWorktrees].sort();
  let leadingNavigation: PermissionLeadingNavigation | undefined;
  if (options.leadingCdTarget !== undefined) {
    const canonicalTarget = await canonicalize(options.leadingCdTarget);
    if (signal.aborted) {
      return unavailableProject(
        canonicalCwd,
        "project discovery was cancelled",
        options.leadingCdTarget,
      );
    }
    const targetForContainment =
      canonicalTarget ?? resolvePath(options.leadingCdTarget);
    const insideRegisteredRoot = navigableRoots.some((root) =>
      isPathWithin(targetForContainment, root),
    );
    let sameRepository = false;
    if (insideRegisteredRoot && canonicalTarget !== undefined) {
      const commonDir = options.runGitCommonDir ?? runGitCommonDir;
      const [targetCommon, cwdCommon] = await Promise.all([
        commonDir(canonicalTarget, signal),
        commonDir(canonicalCwd, signal),
      ]);
      if (signal.aborted) {
        return unavailableProject(
          canonicalCwd,
          "project discovery was cancelled",
          options.leadingCdTarget,
        );
      }
      sameRepository =
        targetCommon !== undefined &&
        cwdCommon !== undefined &&
        targetCommon === cwdCommon;
    }
    leadingNavigation = {
      scope: !insideRegisteredRoot
        ? "outside-listed-worktrees"
        : sameRepository
          ? "listed-worktree"
          : "unverified",
      sameRepository,
    };
  }

  const projectName = truncateUtf8(basename(canonicalProjectRoot), 128);
  return {
    kind: "git",
    ...(projectName === "" ? {} : { name: projectName }),
    cwd: canonicalCwd,
    activeWorktree,
    navigableRoots,
    worktrees,
    ...(leadingNavigation === undefined ? {} : { leadingNavigation }),
    fingerprint: fingerprint(
      "project-v3",
      canonicalCwd,
      activeCommonDir,
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
    return unavailableProject(
      undefined,
      "project discovery was cancelled",
      options.leadingCdTarget,
    );
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
      finish(
        unavailableProject(
          undefined,
          "project discovery was cancelled",
          options.leadingCdTarget,
        ),
      );
    };
    const timer = setTimeout(
      () => {
        controller.abort();
        finish(
          unavailableProject(
            undefined,
            "project discovery timed out",
            options.leadingCdTarget,
          ),
        );
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
      () =>
        finish(
          unavailableProject(
            undefined,
            "project discovery failed",
            options.leadingCdTarget,
          ),
        ),
    );
  });
};
