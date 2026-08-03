import { createHash } from "node:crypto";
import type { GitObjectFormat } from "./repository";

export const MEMORY_REF_PREFIX = "refs/notes/pi-agent-memory/sessions";
export const MEMORY_RECORD_VERSION = 1;
export const MEMORY_TARGET_DOMAIN = "pi-agent-memory-target-v1\0";
export const MEMORY_PATH_MAX_BYTES = 256;
export const MEMORY_DESCRIPTION_MAX_BYTES = 512;
export const MEMORY_CONTENT_MAX_BYTES = 32 * 1024;
// Covers the worst-case JSON escaping of 32 KiB content plus metadata.
export const MEMORY_RECORD_MAX_BYTES = 70 * 1024;
export const MEMORY_REF_LIMIT = 64;
export const MEMORY_OBJECT_LIMIT = 512;
export const MEMORY_COMMAND_LIMIT = 96;
export const MEMORY_AGGREGATE_TIMEOUT_MS = 5_000;
export const MEMORY_COMMAND_TIMEOUT_MS = 2_000;
export const MEMORY_STDERR_MAX_BYTES = 16 * 1024;
export const MEMORY_INDEX_ITEM_LIMIT = 50;
export const MEMORY_INDEX_MAX_BYTES = 16 * 1024;
export const MEMORY_SHOW_MAX_BYTES = 72 * 1024;
export const MEMORY_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const EARLIEST_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const MANAGED_REF = new RegExp(
  `^${MEMORY_REF_PREFIX}/([0-9a-f]{64})/writers/([0-9a-f]{64})$`,
);
const MEMORY_PATH =
  /^(project|feedback|reference)\/[a-z0-9][a-z0-9._-]{0,127}\.md$/;

export interface MemoryRecord {
  readonly version: 1;
  readonly path: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly deleted: boolean;
  readonly content: string;
}

export interface SourcedMemoryRecord {
  readonly record: MemoryRecord;
  readonly sourceRef: string;
  readonly targetOid: string;
}

export interface ManagedMemoryRef {
  readonly ref: string;
  readonly sessionKey: string;
  readonly writerKey: string;
}

export interface MergedMemory {
  readonly entries: ReadonlyMap<string, SourcedMemoryRecord>;
  readonly deleted: ReadonlyMap<string, SourcedMemoryRecord>;
}

export class MemoryModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryModelError";
  }
}

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
};

const hasUnsafeControl = (value: string, multiline: boolean): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0);
    if (code === undefined) return true;
    if (multiline && (code === 9 || code === 10)) return false;
    return code <= 31 || code === 127;
  });

export const validateMemoryPath = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    byteLength(value) > MEMORY_PATH_MAX_BYTES ||
    !MEMORY_PATH.test(value) ||
    value.includes("..")
  ) {
    throw new MemoryModelError(
      "memory path must match project|feedback|reference/<slug>.md",
    );
  }
  return value;
};

export const validateMemoryDescription = (
  value: unknown,
  allowEmpty = false,
): string => {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    byteLength(value) > MEMORY_DESCRIPTION_MAX_BYTES ||
    hasUnsafeControl(value, false)
  ) {
    throw new MemoryModelError("memory description is invalid");
  }
  return value;
};

export const validateMemoryContent = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    byteLength(value) > MEMORY_CONTENT_MAX_BYTES ||
    hasUnsafeControl(value, true)
  ) {
    throw new MemoryModelError("memory content is invalid or too large");
  }
  return value;
};

export const parseManagedMemoryRef = (
  value: string,
): ManagedMemoryRef | undefined => {
  const match = MANAGED_REF.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { ref: value, sessionKey: match[1], writerKey: match[2] };
};

export const memoryWriterRef = (
  sessionKey: string,
  writerKey: string,
): string => {
  if (!/^[0-9a-f]{64}$/.test(sessionKey) || !/^[0-9a-f]{64}$/.test(writerKey)) {
    throw new MemoryModelError("memory session or writer key is invalid");
  }
  return `${MEMORY_REF_PREFIX}/${sessionKey}/writers/${writerKey}`;
};

export const memoryTargetBytes = (path: string): Buffer => {
  const validPath = validateMemoryPath(path);
  return Buffer.from(`${MEMORY_TARGET_DOMAIN}${validPath}\n`, "utf8");
};

export const gitBlobOid = (
  bytes: Uint8Array,
  objectFormat: GitObjectFormat,
): string => {
  const body = Buffer.from(bytes);
  const header = Buffer.from(`blob ${body.byteLength}\0`, "utf8");
  return createHash(objectFormat).update(header).update(body).digest("hex");
};

const parseTimestamp = (value: unknown, nowMs: number): string => {
  if (typeof value !== "string") {
    throw new MemoryModelError("memory timestamp is invalid");
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value ||
    milliseconds < EARLIEST_TIMESTAMP_MS ||
    milliseconds > nowMs + MEMORY_CLOCK_SKEW_MS
  ) {
    throw new MemoryModelError("memory timestamp is outside the valid window");
  }
  return value;
};

export const decodeMemoryRecord = (
  value: unknown,
  nowMs: number = Date.now(),
): MemoryRecord => {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "content",
      "deleted",
      "description",
      "path",
      "updatedAt",
      "version",
    ]) ||
    value.version !== MEMORY_RECORD_VERSION ||
    typeof value.deleted !== "boolean"
  ) {
    throw new MemoryModelError("memory record shape is invalid");
  }
  const path = validateMemoryPath(value.path);
  const { deleted } = value;
  const description = validateMemoryDescription(value.description, deleted);
  const content = validateMemoryContent(value.content);
  if (deleted && (description !== "" || content !== "")) {
    throw new MemoryModelError("memory tombstone must not contain content");
  }
  return {
    version: 1,
    path,
    description,
    updatedAt: parseTimestamp(value.updatedAt, nowMs),
    deleted,
    content,
  };
};

export const makeMemoryRecord = (
  input: {
    path: string;
    description?: string;
    content?: string;
    deleted: boolean;
    updatedAt: string;
  },
  nowMs: number = Date.now(),
): MemoryRecord =>
  decodeMemoryRecord(
    {
      version: 1,
      path: input.path,
      description: input.deleted ? "" : input.description,
      content: input.deleted ? "" : input.content,
      deleted: input.deleted,
      updatedAt: input.updatedAt,
    },
    nowMs,
  );

const newerRecord = (
  left: SourcedMemoryRecord,
  right: SourcedMemoryRecord,
): SourcedMemoryRecord => {
  const leftTime = Date.parse(left.record.updatedAt);
  const rightTime = Date.parse(right.record.updatedAt);
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right;
  return left.sourceRef >= right.sourceRef ? left : right;
};

export const mergeMemoryRecords = (
  records: readonly SourcedMemoryRecord[],
): MergedMemory => {
  const winners = new Map<string, SourcedMemoryRecord>();
  for (const sourced of records) {
    const current = winners.get(sourced.record.path);
    winners.set(
      sourced.record.path,
      current === undefined ? sourced : newerRecord(current, sourced),
    );
  }
  const entries = new Map<string, SourcedMemoryRecord>();
  const deleted = new Map<string, SourcedMemoryRecord>();
  for (const [path, winner] of winners) {
    (winner.record.deleted ? deleted : entries).set(path, winner);
  }
  return { entries, deleted };
};

export const nextMemoryTimestamp = (
  latest: SourcedMemoryRecord | undefined,
  nowMs: number = Date.now(),
): string => {
  const latestMs =
    latest === undefined ? 0 : Date.parse(latest.record.updatedAt);
  const candidate = Math.max(nowMs, latestMs + 1);
  if (candidate > nowMs + MEMORY_CLOCK_SKEW_MS) {
    throw new MemoryModelError(
      "latest memory timestamp is too far ahead; retry after clock skew clears",
    );
  }
  return new Date(candidate).toISOString();
};

export const serializeMemoryRecord = (record: MemoryRecord): Buffer => {
  const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  if (bytes.byteLength > MEMORY_RECORD_MAX_BYTES) {
    throw new MemoryModelError("serialized memory record is too large");
  }
  return bytes;
};
