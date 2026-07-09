// セッション別 JSONL 追記ライタ。
// - dir 0700 / file 0600
// - セッション単位の直列キュー（数MB行の混線を防ぐ。O_APPEND のアトミック性は不十分）
// - bounded queue（disk 詰まり時に無制限に積まず drop してカウント）
// - fail-open（記録失敗は転送に影響させない。writeXxx は決して reject しない）
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type {
  LogRecord,
  NowFn,
  RequestRecord,
  ResponseRecord,
} from "./types.js";

const DEFAULT_MAX_QUEUE = 1000;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface LogWriter {
  writeRequest(rec: RequestRecord): Promise<void>;
  writeResponse(rec: ResponseRecord): Promise<void>;
  /** 現在キューに積まれた書込の完了を待つ（継続利用可）。 */
  flush(): Promise<void>;
  close(): Promise<void>;
  droppedCount(): number;
  /** 書込 in-flight のセッション集合（sweeper が gzip 回避に使う）。 */
  pendingSessions(): ReadonlySet<string>;
}

type WriteLineFn = (sessionId: string, line: string) => Promise<void>;

interface LogWriterOptions {
  baseDir: string;
  now?: NowFn;
  maxQueue?: number;
  /** テスト用: 実ディスク書込を差し替える。 */
  writeLine?: WriteLineFn;
}

const sanitize = (sid: string): string => sid.replace(/[^A-Za-z0-9._-]/g, "_");

export const createLogWriter = (opts: LogWriterOptions): LogWriter => {
  const { baseDir } = opts;
  const maxQueue = opts.maxQueue ?? DEFAULT_MAX_QUEUE;

  let dropped = 0;
  let pending = 0;
  const chains = new Map<string, Promise<void>>();
  const pendingPerSession = new Map<string, number>();

  let ensureDirPromise: Promise<void> | undefined;
  const ensureDir = (): Promise<void> => {
    if (!ensureDirPromise) {
      ensureDirPromise = (async () => {
        await fs.mkdir(baseDir, { recursive: true, mode: DIR_MODE });
        await fs.chmod(baseDir, DIR_MODE); // mkdir mode は umask でマスクされるため明示
      })();
    }
    return ensureDirPromise;
  };

  const diskWriteLine: WriteLineFn = async (sessionId, line) => {
    await ensureDir();
    const filePath = join(baseDir, `${sanitize(sessionId)}.jsonl`);
    let isNew = false;
    try {
      await fs.access(filePath);
    } catch {
      isNew = true;
    }
    await fs.appendFile(filePath, line, { mode: FILE_MODE });
    if (isNew) await fs.chmod(filePath, FILE_MODE);
  };

  const writeLine = opts.writeLine ?? diskWriteLine;

  const enqueue = (rec: LogRecord): Promise<void> => {
    const sid = rec.session_id;
    if (pending >= maxQueue) {
      dropped++;
      return Promise.resolve();
    }
    pending++;
    pendingPerSession.set(sid, (pendingPerSession.get(sid) ?? 0) + 1);
    const line = `${JSON.stringify(rec)}\n`;
    const prev = chains.get(sid) ?? Promise.resolve();
    const task = prev
      .then(() => writeLine(sid, line))
      .catch(() => {
        // fail-open: 記録失敗は握りつぶす
      })
      .finally(() => {
        pending--;
        const n = (pendingPerSession.get(sid) ?? 1) - 1;
        if (n <= 0) pendingPerSession.delete(sid);
        else pendingPerSession.set(sid, n);
      });
    chains.set(sid, task);
    return task;
  };

  const drain = async (): Promise<void> => {
    await Promise.allSettled(chains.values());
  };

  return {
    writeRequest: (rec) => enqueue(rec),
    writeResponse: (rec) => enqueue(rec),
    flush: drain,
    close: drain,
    droppedCount: () => dropped,
    pendingSessions: () => new Set(pendingPerSession.keys()),
  };
};
