import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  type FileHandle,
  type FileHandle as NodeFileHandle,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  MAX_PERMISSION_AUDIT_RECORD_BYTES,
  type PermissionDecisionRecordV1,
} from "./model";

const DEFAULT_RETENTION_DAYS = 90;
const WRITER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PERMISSION_LOG_PATTERN =
  /^permission-(\d{4})-(\d{2})-(\d{2})-([0-9a-f-]{36})\.jsonl$/i;

interface FileStatsLike {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly mode: number;
  readonly nlink: number;
  readonly uid: number;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink?(): boolean;
}

export interface PermissionAuditFileHandle {
  stat(): Promise<FileStatsLike>;
  chmod(mode: number): Promise<void>;
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>;
  truncate(length: number): Promise<void>;
  close(): Promise<void>;
}

export interface PermissionAuditWriterDependencies {
  readonly mkdir: typeof mkdir;
  readonly open: (
    path: string,
    flags: number,
    mode?: number,
  ) => Promise<PermissionAuditFileHandle>;
  readonly readdir: typeof readdir;
  readonly lstat: typeof lstat;
  readonly rm: typeof rm;
  readonly now: () => Date;
  readonly randomUUID: () => string;
  readonly getuid?: () => number;
  readonly constants: Pick<
    typeof constants,
    | "O_RDONLY"
    | "O_WRONLY"
    | "O_CREAT"
    | "O_EXCL"
    | "O_DIRECTORY"
    | "O_NOFOLLOW"
  >;
}

const defaultDependencies = (): PermissionAuditWriterDependencies => ({
  mkdir,
  open: (path, flags, mode) =>
    open(
      path,
      flags,
      mode,
    ) as Promise<NodeFileHandle> as Promise<PermissionAuditFileHandle>,
  readdir,
  lstat,
  rm,
  now: () => new Date(),
  randomUUID,
  ...(typeof process.getuid === "function" ? { getuid: process.getuid } : {}),
  constants,
});

export interface PermissionAuditAppendIdentity {
  readonly writerInstanceId: string;
  readonly sequence: number;
  readonly timestamp: string;
}

export type PermissionAuditRecordFactory = (
  identity: PermissionAuditAppendIdentity,
) => PermissionDecisionRecordV1;

export interface PermissionAuditWriter {
  readonly writerInstanceId: string;
  append(
    build: PermissionAuditRecordFactory,
  ): Promise<PermissionDecisionRecordV1>;
  close(): Promise<void>;
}

export interface PermissionAuditWriterOptions {
  readonly isChild: boolean;
  readonly retentionDays?: number;
  readonly writerInstanceId?: string;
  readonly dependencies?: Partial<PermissionAuditWriterDependencies>;
}

const exactMode = (stats: FileStatsLike): number => stats.mode & 0o777;

const sameIdentity = (left: FileStatsLike, right: FileStatsLike): boolean =>
  String(left.dev) === String(right.dev) &&
  String(left.ino) === String(right.ino);

const assertOwner = (
  stats: FileStatsLike,
  getuid: (() => number) | undefined,
  target: string,
): void => {
  if (getuid !== undefined && stats.uid !== getuid()) {
    throw new Error(`${target} is not owned by the current user`);
  }
};

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

const validDatedName = (name: string): { readonly day: string } | undefined => {
  const match = PERMISSION_LOG_PATTERN.exec(name);
  if (match === null || !WRITER_ID_PATTERN.test(match[4] ?? "")) {
    return undefined;
  }
  const text = `${match[1]}-${match[2]}-${match[3]}`;
  const stamp = Date.parse(`${text}T00:00:00.000Z`);
  if (
    !Number.isFinite(stamp) ||
    new Date(stamp).toISOString().slice(0, 10) !== text
  ) {
    return undefined;
  }
  return { day: text };
};

const writeFully = async (
  handle: PermissionAuditFileHandle,
  data: Uint8Array,
  start: number,
): Promise<void> => {
  let written = 0;
  while (written < data.byteLength) {
    const result = await handle.write(
      data,
      written,
      data.byteLength - written,
      start + written,
    );
    if (
      !Number.isSafeInteger(result.bytesWritten) ||
      result.bytesWritten <= 0
    ) {
      throw new Error("permission audit write made no progress");
    }
    written += result.bytesWritten;
  }
};

export const createPermissionAuditWriter = (
  logDir: string,
  options: PermissionAuditWriterOptions,
): PermissionAuditWriter => {
  const defaults = defaultDependencies();
  const deps: PermissionAuditWriterDependencies = {
    ...defaults,
    ...options.dependencies,
    constants: {
      ...defaults.constants,
      ...options.dependencies?.constants,
    },
  };
  const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error(
      "permission audit retentionDays must be a positive integer",
    );
  }
  const writerInstanceId = options.writerInstanceId ?? deps.randomUUID();
  if (!WRITER_ID_PATTERN.test(writerInstanceId)) {
    throw new Error("permission audit writer id must be a UUID");
  }
  if (
    typeof deps.constants.O_NOFOLLOW !== "number" ||
    deps.constants.O_NOFOLLOW === 0 ||
    typeof deps.constants.O_DIRECTORY !== "number" ||
    deps.constants.O_DIRECTORY === 0
  ) {
    throw new Error("permission audit requires O_NOFOLLOW and O_DIRECTORY");
  }

  let sequence = 0;
  let activeDay: string | undefined;
  let activeHandle: PermissionAuditFileHandle | undefined;
  let poisoned = false;
  let closing = false;
  let closed = false;
  let retentionDay: string | undefined;
  let operation: Promise<void> = Promise.resolve();

  const openVerifiedDirectory = async (): Promise<{
    handle: PermissionAuditFileHandle;
    stats: FileStatsLike;
  }> => {
    const handle = await deps.open(
      logDir,
      deps.constants.O_RDONLY |
        deps.constants.O_DIRECTORY |
        deps.constants.O_NOFOLLOW,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isDirectory())
        throw new Error("permission audit path is not a directory");
      assertOwner(stats, deps.getuid, "permission audit directory");
      if (exactMode(stats) !== 0o700) await handle.chmod(0o700);
      return { handle, stats };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  };

  const ensureDirectory = async (): Promise<FileStatsLike> => {
    await deps.mkdir(logDir, { recursive: true, mode: 0o700 });
    const verified = await openVerifiedDirectory();
    await verified.handle.close();
    return verified.stats;
  };

  const applyRetention = async (day: string, now: Date): Promise<void> => {
    if (options.isChild || retentionDay === day) return;
    retentionDay = day;
    let names: string[];
    try {
      names = await deps.readdir(logDir);
    } catch {
      return;
    }
    // Filenames carry only a UTC date, not a record timestamp. Keep the whole
    // cutoff day so a file created late that day never expires early.
    const cutoffDay = utcDay(
      new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000),
    );
    for (const name of names) {
      const dated = validDatedName(name);
      if (dated === undefined || dated.day >= cutoffDay) continue;
      const path = join(logDir, name);
      try {
        const stats = (await deps.lstat(path)) as unknown as FileStatsLike;
        if (
          !stats.isFile() ||
          stats.isSymbolicLink?.() === true ||
          stats.nlink !== 1 ||
          exactMode(stats) !== 0o600
        ) {
          continue;
        }
        assertOwner(stats, deps.getuid, "permission audit retention file");
        await deps.rm(path);
      } catch {
        // Retention is best-effort and never changes the current decision.
      }
    }
  };

  const closeActive = async (): Promise<void> => {
    const handle = activeHandle;
    activeHandle = undefined;
    activeDay = undefined;
    if (handle !== undefined) await handle.close();
  };

  const openForDay = async (
    day: string,
    now: Date,
  ): Promise<PermissionAuditFileHandle> => {
    if (activeHandle !== undefined && activeDay === day) return activeHandle;
    await closeActive();
    const directoryBefore = await ensureDirectory();
    await applyRetention(day, now);
    const path = join(logDir, `permission-${day}-${writerInstanceId}.jsonl`);
    const handle = await deps.open(
      path,
      deps.constants.O_WRONLY |
        deps.constants.O_CREAT |
        deps.constants.O_EXCL |
        deps.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error("permission audit file is not a private regular file");
      }
      assertOwner(stats, deps.getuid, "permission audit file");
      if (exactMode(stats) !== 0o600) await handle.chmod(0o600);
      const directoryAfter = await openVerifiedDirectory();
      try {
        if (!sameIdentity(directoryBefore, directoryAfter.stats)) {
          throw new Error("permission audit directory identity changed");
        }
      } finally {
        await directoryAfter.handle.close();
      }
      activeDay = day;
      activeHandle = handle;
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  };

  const appendOne = async (
    build: PermissionAuditRecordFactory,
  ): Promise<PermissionDecisionRecordV1> => {
    if (closed) throw new Error("permission audit writer is closed");
    if (poisoned) throw new Error("permission audit writer is poisoned");
    const now = deps.now();
    const day = utcDay(now);
    const identity = {
      writerInstanceId,
      sequence: ++sequence,
      timestamp: now.toISOString(),
    };
    const record = build(identity);
    if (
      record.writerInstanceId !== writerInstanceId ||
      record.sequence !== identity.sequence ||
      record.timestamp !== identity.timestamp
    ) {
      throw new Error("permission audit record identity mismatch");
    }
    const line = `${JSON.stringify(record)}\n`;
    if (
      Buffer.byteLength(line, "utf8") >
      MAX_PERMISSION_AUDIT_RECORD_BYTES + 1
    ) {
      throw new Error("permission audit record exceeds the size limit");
    }
    const handle = await openForDay(day, now);
    const before = await handle.stat();
    const offset = Number(
      (before as FileStatsLike & { size?: number | bigint }).size ?? 0,
    );
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error("permission audit file size is invalid");
    }
    try {
      await writeFully(handle, Buffer.from(line), offset);
      return record;
    } catch (error) {
      try {
        await handle.truncate(offset);
      } catch {
        poisoned = true;
        await closeActive().catch(() => {});
      }
      throw error;
    }
  };

  return {
    writerInstanceId,
    append(build) {
      if (closing || closed) {
        return Promise.reject(new Error("permission audit writer is closing"));
      }
      let result: PermissionDecisionRecordV1 | undefined;
      const queued = operation.then(async () => {
        result = await appendOne(build);
      });
      operation = queued.catch(() => {});
      return queued.then(() => {
        if (result === undefined)
          throw new Error("permission audit append produced no record");
        return result;
      });
    },
    async close() {
      if (closed) return;
      closing = true;
      await operation;
      closed = true;
      await closeActive();
    },
  };
};

export const permissionAuditLogFileName = (
  date: Date,
  writerInstanceId: string,
): string => `permission-${utcDay(date)}-${writerInstanceId}.jsonl`;

export { DEFAULT_RETENTION_DAYS, PERMISSION_LOG_PATTERN };
