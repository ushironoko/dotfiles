import { randomBytes, createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import {
  BoundedCommandError,
  runBoundedCommand,
  type BoundedCommandResult,
  type RunBoundedCommand,
} from "../../lib/bounded-process";
import { sanitizeChildEnv } from "../../lib/child-env";
import type { TrustConfig } from "../../lib/trust";
import {
  decodeMemoryRecord,
  gitBlobOid,
  makeMemoryRecord,
  MEMORY_AGGREGATE_TIMEOUT_MS,
  MEMORY_COMMAND_LIMIT,
  MEMORY_COMMAND_TIMEOUT_MS,
  MEMORY_OBJECT_LIMIT,
  MEMORY_RECORD_MAX_BYTES,
  MEMORY_REF_LIMIT,
  MEMORY_REF_PREFIX,
  MEMORY_STDERR_MAX_BYTES,
  memoryTargetBytes,
  memoryWriterRef,
  mergeMemoryRecords,
  nextMemoryTimestamp,
  parseManagedMemoryRef,
  serializeMemoryRecord,
  validateMemoryContent,
  validateMemoryDescription,
  validateMemoryPath,
  type ManagedMemoryRef,
  type MergedMemory,
  type SourcedMemoryRecord,
} from "./model";
import {
  MemoryRepositoryError,
  resolveMemoryRepository,
  type MemoryRepository,
  type RepositoryCommandResult,
} from "./repository";

const REF_LIST_MAX_BYTES = 16 * 1024;
const NOTE_LIST_MAX_BYTES = 128 * 1024;
const SMALL_OUTPUT_MAX_BYTES = 4 * 1024;
const CAT_FILE_MAX_BYTES =
  MEMORY_OBJECT_LIMIT * (MEMORY_RECORD_MAX_BYTES + 128);
const SESSION_ID_MAX_BYTES = 4 * 1024;
const CAPABILITY_REF = `${MEMORY_REF_PREFIX}/capability-probe`;
const fatalDecoder = new TextDecoder(undefined, { fatal: true });

export type AgentMemoryFailureKind =
  | "aborted"
  | "command-failed"
  | "invalid-data"
  | "missing-bit"
  | "missing-git"
  | "non-git"
  | "oversize"
  | "timeout"
  | "unsupported"
  | "untrusted";

export class AgentMemoryCliError extends Error {
  constructor(
    readonly kind: AgentMemoryFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "AgentMemoryCliError";
  }
}

export interface MemoryAggregate {
  readonly repository: MemoryRepository;
  readonly merged: MergedMemory;
  readonly refs: readonly ManagedMemoryRef[];
  readonly diagnostics: readonly string[];
  readonly truncated: boolean;
}

export type MemoryUpdateResult =
  | { readonly status: "unchanged"; readonly path: string }
  | {
      readonly status: "written";
      readonly path: string;
      readonly sourceRef: string;
      readonly deleted: boolean;
      readonly updatedAt: string;
    };

export interface AgentMemoryCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly runCommand?: RunBoundedCommand;
  readonly realpath?: (path: string) => Promise<string>;
  readonly now?: () => number;
  readonly writerKey?: string;
}

interface ListedNote {
  readonly sourceRef: string;
  readonly noteOid: string;
  readonly targetOid: string;
}

interface BatchObjectSelection {
  readonly readableOids: readonly string[];
  readonly rejectedOids: ReadonlyMap<string, "invalid" | "oversize">;
}

class AggregateBudget {
  private commandCount = 0;
  private readonly deadline: number;

  constructor(
    private readonly invoke: RunBoundedCommand,
    private readonly now: () => number,
  ) {
    this.deadline = now() + MEMORY_AGGREGATE_TIMEOUT_MS;
  }

  async run(
    command: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      signal?: AbortSignal;
      stdoutMaxBytes: number;
      stdin?: Uint8Array | string;
      stdinMaxBytes?: number;
    },
  ): Promise<BoundedCommandResult> {
    this.commandCount += 1;
    const remaining = this.deadline - this.now();
    if (this.commandCount > MEMORY_COMMAND_LIMIT || remaining <= 0) {
      throw new AgentMemoryCliError(
        "timeout",
        "project memory aggregate command budget exhausted",
      );
    }
    try {
      return await this.invoke(command, args, {
        ...options,
        timeoutMs: Math.max(1, Math.min(MEMORY_COMMAND_TIMEOUT_MS, remaining)),
        stderrMaxBytes: MEMORY_STDERR_MAX_BYTES,
      });
    } catch (error) {
      throw mapCommandError(error, command === "bit" ? "bit" : "git");
    }
  }
}

const mapCommandError = (
  error: unknown,
  command: "bit" | "git",
): AgentMemoryCliError => {
  if (error instanceof AgentMemoryCliError) return error;
  if (error instanceof MemoryRepositoryError) {
    return new AgentMemoryCliError(error.kind, error.message);
  }
  if (!(error instanceof BoundedCommandError)) {
    return new AgentMemoryCliError(
      "command-failed",
      `${command} command failed`,
    );
  }
  if (error.kind === "missing") {
    return new AgentMemoryCliError(
      command === "bit" ? "missing-bit" : "missing-git",
      `${command} executable is unavailable`,
    );
  }
  if (error.kind === "timeout" || error.kind === "aborted") {
    return new AgentMemoryCliError(error.kind, error.message);
  }
  if (error.kind === "oversize") {
    return new AgentMemoryCliError("oversize", error.message);
  }
  return new AgentMemoryCliError(
    "command-failed",
    `${command} command could not start`,
  );
};

const decodeUtf8 = (bytes: Uint8Array, label: string): string => {
  try {
    return fatalDecoder.decode(bytes);
  } catch {
    throw new AgentMemoryCliError(
      "invalid-data",
      `${label} is not valid UTF-8`,
    );
  }
};

const ensureSuccess = (
  result: BoundedCommandResult,
  description: string,
): void => {
  if (result.exitCode !== 0) {
    throw new AgentMemoryCliError(
      "command-failed",
      `${description} failed with exit code ${result.exitCode}`,
    );
  }
};

const parseOid = (value: string, length: number): string | undefined =>
  new RegExp(`^[0-9a-f]{${length}}$`).test(value) ? value : undefined;

const parseNoteList = (
  output: Uint8Array,
  sourceRef: string,
  oidLength: number,
): ListedNote[] => {
  const text = decodeUtf8(output, "bit notes list output");
  if (text.trim() === "") return [];
  return text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) => {
      const [note, target, extra] = line.split(" ");
      const noteOid =
        note === undefined ? undefined : parseOid(note, oidLength);
      const targetOid =
        target === undefined ? undefined : parseOid(target, oidLength);
      if (
        noteOid === undefined ||
        targetOid === undefined ||
        extra !== undefined
      ) {
        throw new AgentMemoryCliError(
          "invalid-data",
          `bit notes list returned malformed data for ${sourceRef}`,
        );
      }
      return { sourceRef, noteOid, targetOid };
    });
};

const parseBatchObjectMetadata = (
  output: Uint8Array,
  expectedOids: readonly string[],
): BatchObjectSelection => {
  const text = decodeUtf8(output, "git cat-file batch-check output");
  const lines = text.trimEnd().split(/\r?\n/);
  if (lines.length !== expectedOids.length) {
    throw new AgentMemoryCliError(
      "invalid-data",
      "git cat-file batch-check returned an unexpected object count",
    );
  }

  const readableOids: string[] = [];
  const rejectedOids = new Map<string, "invalid" | "oversize">();
  for (const [index, expectedOid] of expectedOids.entries()) {
    const line = lines[index];
    const match = /^([0-9a-f]+) ([^ ]+)(?: ([0-9]+))?$/.exec(line ?? "");
    if (match?.[1] !== expectedOid || match[2] === undefined) {
      throw new AgentMemoryCliError(
        "invalid-data",
        "git cat-file batch-check returned an unexpected object",
      );
    }
    if (match[2] !== "blob" || match[3] === undefined) {
      rejectedOids.set(expectedOid, "invalid");
      continue;
    }
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size) || size < 0) {
      rejectedOids.set(expectedOid, "invalid");
    } else if (size > MEMORY_RECORD_MAX_BYTES) {
      rejectedOids.set(expectedOid, "oversize");
    } else {
      readableOids.push(expectedOid);
    }
  }
  return { readableOids, rejectedOids };
};

const parseBatchObjects = (
  output: Uint8Array,
  expectedOids: readonly string[],
): ReadonlyMap<string, Uint8Array> => {
  const bytes = Buffer.from(output);
  const objects = new Map<string, Uint8Array>();
  let offset = 0;
  for (const expectedOid of expectedOids) {
    const newline = bytes.indexOf(10, offset);
    if (newline === -1) {
      throw new AgentMemoryCliError(
        "invalid-data",
        "bit cat-file batch header is incomplete",
      );
    }
    const header = bytes.subarray(offset, newline).toString("ascii");
    const match = /^([0-9a-f]+) blob ([0-9]+)$/.exec(header);
    if (match?.[1] !== expectedOid || match[2] === undefined) {
      throw new AgentMemoryCliError(
        "invalid-data",
        "bit cat-file batch returned an unexpected object",
      );
    }
    const size = Number(match[2]);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MEMORY_RECORD_MAX_BYTES
    ) {
      throw new AgentMemoryCliError(
        "oversize",
        "project memory note exceeds the record byte limit",
      );
    }
    const start = newline + 1;
    const end = start + size;
    if (end >= bytes.byteLength || bytes[end] !== 10) {
      throw new AgentMemoryCliError(
        "invalid-data",
        "bit cat-file batch body is incomplete",
      );
    }
    objects.set(expectedOid, bytes.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== bytes.byteLength) {
    throw new AgentMemoryCliError(
      "invalid-data",
      "bit cat-file batch returned trailing data",
    );
  }
  return objects;
};

const parseJsonRecord = (bytes: Uint8Array, nowMs: number) => {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes, "project memory note"));
  } catch (error) {
    if (error instanceof AgentMemoryCliError) throw error;
    throw new AgentMemoryCliError(
      "invalid-data",
      "project memory note is not valid JSON",
    );
  }
  try {
    return decodeMemoryRecord(value, nowMs);
  } catch {
    throw new AgentMemoryCliError(
      "invalid-data",
      "project memory note record is invalid",
    );
  }
};

const sessionKeyFor = (sessionId: string): string =>
  createHash("sha256").update(sessionId, "utf8").digest("hex");

const validSessionId = (sessionId: string): boolean =>
  sessionId.length > 0 &&
  Buffer.byteLength(sessionId, "utf8") <= SESSION_ID_MAX_BYTES &&
  ![...sessionId].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  });

export class AgentMemoryCli {
  private readonly env: NodeJS.ProcessEnv;
  private readonly invoke: RunBoundedCommand;
  private readonly resolveRealpath: (path: string) => Promise<string>;
  private readonly now: () => number;
  private readonly writerKey: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: AgentMemoryCliOptions = {}) {
    this.env = options.env ?? process.env;
    this.invoke = options.runCommand ?? runBoundedCommand;
    this.resolveRealpath = options.realpath ?? realpath;
    this.now = options.now ?? Date.now;
    this.writerKey = options.writerKey ?? randomBytes(32).toString("hex");
    if (!/^[0-9a-f]{64}$/.test(this.writerKey)) {
      throw new AgentMemoryCliError(
        "invalid-data",
        "memory writer key is invalid",
      );
    }
  }

  async aggregate(
    cwd: string,
    trust: TrustConfig,
    signal?: AbortSignal,
  ): Promise<MemoryAggregate> {
    const budget = new AggregateBudget(this.invoke, this.now);
    const runGit = async (
      commandCwd: string,
      args: readonly string[],
      commandSignal?: AbortSignal,
    ): Promise<RepositoryCommandResult> =>
      budget.run("git", args, {
        cwd: commandCwd,
        env: sanitizeChildEnv(this.env, {}, { cwd: commandCwd }),
        signal: commandSignal,
        stdoutMaxBytes: NOTE_LIST_MAX_BYTES,
      });

    let repository: MemoryRepository;
    try {
      repository = await resolveMemoryRepository(
        cwd,
        trust,
        { runGit, realpath: this.resolveRealpath },
        signal,
      );
    } catch (error) {
      throw mapCommandError(error, "git");
    }

    const runBit = (
      args: readonly string[],
      stdoutMaxBytes: number,
      stdin?: Uint8Array | string,
      stdinMaxBytes?: number,
    ): Promise<BoundedCommandResult> =>
      budget.run("bit", args, {
        cwd: repository.cwd,
        env: sanitizeChildEnv(
          this.env,
          { GIT_DIR: repository.commonDir },
          { cwd: repository.cwd },
        ),
        signal,
        stdoutMaxBytes,
        ...(stdin === undefined ? {} : { stdin, stdinMaxBytes }),
      });

    // Non-mutating behavior probes for the exact read capabilities. An absent
    // notes ref and empty batch-check stdin are both expected to succeed.
    const notesProbe = await runBit(
      ["notes", `--ref=${CAPABILITY_REF}`, "list"],
      SMALL_OUTPUT_MAX_BYTES,
    );
    ensureSuccess(notesProbe, "bit notes capability probe");
    const batchProbe = await budget.run("git", ["cat-file", "--batch-check"], {
      cwd: repository.cwd,
      env: sanitizeChildEnv(
        this.env,
        { GIT_DIR: repository.commonDir },
        { cwd: repository.cwd },
      ),
      signal,
      stdoutMaxBytes: SMALL_OUTPUT_MAX_BYTES,
      stdin: Buffer.alloc(0),
      stdinMaxBytes: 0,
    });
    ensureSuccess(batchProbe, "git cat-file capability probe");

    const refsResult = await budget.run(
      "git",
      [
        "for-each-ref",
        `--count=${MEMORY_REF_LIMIT + 1}`,
        "--format=%(refname)",
        MEMORY_REF_PREFIX,
      ],
      {
        cwd: repository.cwd,
        env: sanitizeChildEnv(this.env, {}, { cwd: repository.cwd }),
        signal,
        stdoutMaxBytes: REF_LIST_MAX_BYTES,
      },
    );
    ensureSuccess(refsResult, "Git memory ref enumeration");
    const rawRefs = decodeUtf8(refsResult.stdout, "Git memory ref list")
      .trimEnd()
      .split(/\r?\n/)
      .filter(Boolean);
    const diagnostics: string[] = [];
    const managedRefs: ManagedMemoryRef[] = [];
    for (const rawRef of rawRefs) {
      const parsed = parseManagedMemoryRef(rawRef);
      if (parsed === undefined) {
        diagnostics.push(`${rawRef}: invalid managed memory ref ignored`);
        continue;
      }
      managedRefs.push(parsed);
    }
    managedRefs.sort((left, right) => left.ref.localeCompare(right.ref));
    let truncated =
      rawRefs.length > MEMORY_REF_LIMIT ||
      managedRefs.length > MEMORY_REF_LIMIT;
    const selectedRefs = managedRefs.slice(0, MEMORY_REF_LIMIT);

    const listedNotes: ListedNote[] = [];
    const oidLength = repository.objectFormat === "sha1" ? 40 : 64;
    for (const [refIndex, managed] of selectedRefs.entries()) {
      let parsed: ListedNote[];
      try {
        const result = await runBit(
          ["notes", `--ref=${managed.ref}`, "list"],
          NOTE_LIST_MAX_BYTES,
        );
        ensureSuccess(result, "bit notes list");
        parsed = parseNoteList(result.stdout, managed.ref, oidLength);
      } catch (error) {
        if (
          error instanceof AgentMemoryCliError &&
          (error.kind === "invalid-data" || error.kind === "oversize")
        ) {
          if (error.kind === "oversize") truncated = true;
          diagnostics.push(`${managed.ref}: unreadable note list ignored`);
          continue;
        }
        throw error;
      }
      const remaining = MEMORY_OBJECT_LIMIT - listedNotes.length;
      if (parsed.length > remaining) truncated = true;
      listedNotes.push(...parsed.slice(0, Math.max(0, remaining)));
      if (listedNotes.length >= MEMORY_OBJECT_LIMIT) {
        if (refIndex < selectedRefs.length - 1) truncated = true;
        break;
      }
    }

    if (listedNotes.length === 0) {
      return {
        repository,
        merged: mergeMemoryRecords([]),
        refs: selectedRefs,
        diagnostics: diagnostics.slice(0, 20),
        truncated,
      };
    }

    const noteOids = [...new Set(listedNotes.map((note) => note.noteOid))];
    const metadataInput = Buffer.from(`${noteOids.join("\n")}\n`, "ascii");
    const batchEnv = sanitizeChildEnv(
      this.env,
      { GIT_DIR: repository.commonDir },
      { cwd: repository.cwd },
    );
    const metadataResult = await budget.run(
      "git",
      ["cat-file", "--batch-check"],
      {
        cwd: repository.cwd,
        env: batchEnv,
        signal,
        stdoutMaxBytes: NOTE_LIST_MAX_BYTES,
        stdin: metadataInput,
        stdinMaxBytes: metadataInput.byteLength,
      },
    );
    ensureSuccess(metadataResult, "git cat-file batch-check");
    const metadata = parseBatchObjectMetadata(metadataResult.stdout, noteOids);

    let bodies: ReadonlyMap<string, Uint8Array> = new Map();
    if (metadata.readableOids.length > 0) {
      const batchInput = Buffer.from(
        `${metadata.readableOids.join("\n")}\n`,
        "ascii",
      );
      const batch = await budget.run("git", ["cat-file", "--batch"], {
        cwd: repository.cwd,
        env: batchEnv,
        signal,
        stdoutMaxBytes: Math.min(
          CAT_FILE_MAX_BYTES,
          metadata.readableOids.length * (MEMORY_RECORD_MAX_BYTES + 128),
        ),
        stdin: batchInput,
        stdinMaxBytes: batchInput.byteLength,
      });
      ensureSuccess(batch, "git cat-file batch read");
      bodies = parseBatchObjects(batch.stdout, metadata.readableOids);
    }

    const nowMs = this.now();
    const recordsByKey = new Map<string, SourcedMemoryRecord>();
    const duplicateRefPaths = new Set<string>();
    for (const listed of listedNotes) {
      const rejected = metadata.rejectedOids.get(listed.noteOid);
      if (rejected !== undefined) {
        diagnostics.push(
          `${listed.sourceRef}: ${rejected} memory note ignored`,
        );
        continue;
      }
      const body = bodies.get(listed.noteOid);
      if (body === undefined) {
        diagnostics.push(`${listed.sourceRef}: missing note object`);
        continue;
      }
      try {
        const record = parseJsonRecord(body, nowMs);
        const expectedTarget = gitBlobOid(
          memoryTargetBytes(record.path),
          repository.objectFormat,
        );
        if (expectedTarget !== listed.targetOid) {
          throw new AgentMemoryCliError(
            "invalid-data",
            "memory path does not match its annotated object",
          );
        }
        const duplicateKey = `${listed.sourceRef}\0${record.path}`;
        if (duplicateRefPaths.has(duplicateKey)) {
          diagnostics.push(
            `${listed.sourceRef}: duplicate memory path ignored`,
          );
          continue;
        }
        if (recordsByKey.has(duplicateKey)) {
          recordsByKey.delete(duplicateKey);
          duplicateRefPaths.add(duplicateKey);
          diagnostics.push(
            `${listed.sourceRef}: duplicate memory path ignored`,
          );
          continue;
        }
        recordsByKey.set(duplicateKey, {
          record,
          sourceRef: listed.sourceRef,
          targetOid: listed.targetOid,
        });
      } catch {
        diagnostics.push(`${listed.sourceRef}: invalid memory note ignored`);
      }
    }

    const validRecords = [...recordsByKey.values()];
    return {
      repository,
      merged: mergeMemoryRecords(validRecords),
      refs: selectedRefs,
      diagnostics: diagnostics.slice(0, 20),
      truncated,
    };
  }

  update(
    cwd: string,
    trust: TrustConfig,
    sessionId: string,
    input:
      | {
          readonly action: "put";
          readonly path: string;
          readonly description: string;
          readonly content: string;
        }
      | { readonly action: "remove"; readonly path: string },
    signal?: AbortSignal,
  ): Promise<MemoryUpdateResult> {
    const operation = this.mutationTail.then(async () => {
      if (!validSessionId(sessionId)) {
        throw new AgentMemoryCliError(
          "invalid-data",
          "memory update requires a valid physical pi session id",
        );
      }
      const path = validateMemoryPath(input.path);
      const description =
        input.action === "put"
          ? validateMemoryDescription(input.description)
          : undefined;
      const content =
        input.action === "put"
          ? validateMemoryContent(input.content)
          : undefined;
      const aggregate = await this.aggregate(cwd, trust, signal);
      if (aggregate.truncated) {
        throw new AgentMemoryCliError(
          "oversize",
          "project memory aggregate is truncated; refusing a potentially stale update",
        );
      }
      const active = aggregate.merged.entries.get(path);
      const deleted = aggregate.merged.deleted.get(path);
      const latest = active ?? deleted;
      if (
        input.action === "put" &&
        active !== undefined &&
        active.record.description === description &&
        active.record.content === content
      ) {
        return { status: "unchanged" as const, path };
      }
      if (input.action === "remove" && active === undefined) {
        return { status: "unchanged" as const, path };
      }

      const mutationNow = this.now();
      const updatedAt = nextMemoryTimestamp(latest, mutationNow);
      const record = makeMemoryRecord(
        {
          path,
          deleted: input.action === "remove",
          updatedAt,
          ...(description === undefined ? {} : { description }),
          ...(content === undefined ? {} : { content }),
        },
        mutationNow,
      );
      const targetBytes = memoryTargetBytes(path);
      const expectedTarget = gitBlobOid(
        targetBytes,
        aggregate.repository.objectFormat,
      );
      const budget = new AggregateBudget(this.invoke, this.now);
      const env = sanitizeChildEnv(
        this.env,
        { GIT_DIR: aggregate.repository.commonDir },
        { cwd: aggregate.repository.cwd },
      );
      // bit v0.45.3 delegates hash-object but consumes a programmatic pipe as
      // empty input under Bun. Use Git plumbing directly for the target object;
      // project-memory content itself still goes through bit notes below.
      const hashResult = await budget.run(
        "git",
        ["hash-object", "-w", "--stdin"],
        {
          cwd: aggregate.repository.cwd,
          env,
          signal,
          stdoutMaxBytes: SMALL_OUTPUT_MAX_BYTES,
          stdin: targetBytes,
          stdinMaxBytes: targetBytes.byteLength,
        },
      );
      ensureSuccess(hashResult, "bit hash-object write");
      const returnedTarget = decodeUtf8(
        hashResult.stdout,
        "bit hash-object output",
      ).trim();
      if (returnedTarget !== expectedTarget) {
        throw new AgentMemoryCliError(
          "unsupported",
          `git hash-object returned ${returnedTarget || "(empty)"}; expected ${expectedTarget}`,
        );
      }

      const sourceRef = memoryWriterRef(
        sessionKeyFor(sessionId),
        this.writerKey,
      );
      const body = serializeMemoryRecord(record);
      // Current bit notes accepts only -m (not Git's -F -). Keep the JSON as
      // one bounded argv value and spawn bit directly: no shell interpolation,
      // temporary file, or command logging is involved.
      const writeResult = await budget.run(
        "bit",
        [
          "notes",
          `--ref=${sourceRef}`,
          "add",
          "-f",
          "-m",
          decodeUtf8(body, "serialized memory record"),
          expectedTarget,
        ],
        {
          cwd: aggregate.repository.cwd,
          env,
          signal,
          stdoutMaxBytes: SMALL_OUTPUT_MAX_BYTES,
        },
      );
      ensureSuccess(writeResult, "bit notes write");
      return {
        status: "written" as const,
        path,
        sourceRef,
        deleted: record.deleted,
        updatedAt,
      };
    });
    this.mutationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}
