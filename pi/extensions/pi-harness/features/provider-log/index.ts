/**
 * provider-log feature — opt-in (default OFF in config.ts) JSONL logger for
 * provider traffic metadata. Scope per V10: request metadata before send,
 * response status + allowlisted headers before stream consumption; usage
 * tokens and bodies are out of reach by design (documented in pi/README.md).
 *
 * Storage contract: log dir 0700, files 0600, one file per UTC day, expired
 * files removed after RETENTION_DAYS. Writes go through a bounded in-memory
 * queue flushed serially; overflow drops records and the drop count is
 * logged instead of blocking the event loop.
 */
import { constants } from "node:fs";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessConfig } from "../../config";
import type { PiLike } from "../../lib/pi-like";
import {
  buildRequestRecord,
  buildResponseRecord,
  logFileName,
  selectExpiredLogs,
} from "./record";

const MAX_QUEUE = 256;
const RETENTION_DAYS = 14;

// Optional open flags degrade to 0 on platforms that lack them.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
const O_DIRECTORY = constants.O_DIRECTORY ?? 0;
const LOG_OPEN_FLAGS =
  constants.O_CREAT |
  constants.O_WRONLY |
  constants.O_APPEND |
  O_NOFOLLOW |
  O_NONBLOCK;

interface ProviderLogDeps {
  now?: () => Date;
}

export default function setupProviderLog(
  pi: PiLike,
  config: HarnessConfig,
  deps: ProviderLogDeps = {},
): void {
  const now = deps.now ?? (() => new Date());
  const logDir = config.paths.logDir;
  const queue: string[] = [];
  let dropped = 0;
  let retentionDone = false;
  // Single-writer chain: flushes append in order and never overlap.
  let writer: Promise<void> = Promise.resolve();

  const applyRetention = async (): Promise<void> => {
    if (retentionDone) return;
    retentionDone = true;
    let names: string[];
    try {
      names = await readdir(logDir);
    } catch {
      return;
    }
    for (const name of selectExpiredLogs(names, now(), RETENTION_DAYS)) {
      try {
        await rm(join(logDir, name));
      } catch {
        // Retention is best-effort; never disturb the session.
      }
    }
  };

  // Enforce 0700 on the log dir even when it already exists (mkdir's mode only
  // applies on creation), verifying via an fd we own that it is a real
  // directory rather than a swapped-in symlink.
  const ensureLogDir = async (): Promise<boolean> => {
    try {
      await mkdir(logDir, { recursive: true, mode: 0o700 });
    } catch {
      return false;
    }
    let handle;
    try {
      handle = await open(
        logDir,
        constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW,
      );
    } catch {
      return false;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isDirectory()) return false;
      if ((stats.mode & 0o777) !== 0o700) await handle.chmod(0o700);
      return true;
    } catch {
      return false;
    } finally {
      await handle.close();
    }
  };

  // Append through an fd we fstat-verify: O_NOFOLLOW rejects a symlinked final
  // component, O_NONBLOCK avoids blocking forever on a pre-existing FIFO, and the
  // fstat rejects anything that is not a regular file. Enforces exact 0600 even
  // on a pre-existing file. (Full openat/dir-fd binding is unavailable in Node,
  // so a parent-directory swap remains a documented residual for this
  // default-off feature.)
  const writeLogLines = async (data: string): Promise<boolean> => {
    let handle;
    try {
      handle = await open(
        join(logDir, logFileName(now())),
        LOG_OPEN_FLAGS,
        0o600,
      );
    } catch {
      return false;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) return false;
      if ((stats.mode & 0o777) !== 0o600) await handle.chmod(0o600);
      await handle.write(data);
      return true;
    } catch {
      return false;
    } finally {
      await handle.close();
    }
  };

  const flush = async (): Promise<void> => {
    if (queue.length === 0 && dropped === 0) return;
    const records = queue.splice(0);
    const pendingDrops = dropped;
    dropped = 0;
    // Everything lost if this flush cannot write; re-counted as drops so a later
    // flush reports them once the sink is writable again.
    const lostOnFailure = pendingDrops + records.length;
    const payload =
      pendingDrops > 0
        ? [
            ...records,
            JSON.stringify({
              ts: now().toISOString(),
              kind: "drops",
              count: pendingDrops,
            }),
          ]
        : records;

    if (!(await ensureLogDir())) {
      dropped += lostOnFailure;
      return;
    }
    await applyRetention();
    if (!(await writeLogLines(`${payload.join("\n")}\n`))) {
      dropped += lostOnFailure;
    }
  };

  const enqueue = (line: string): void => {
    if (queue.length >= MAX_QUEUE) {
      dropped += 1;
      return;
    }
    queue.push(line);
    writer = writer.then(flush).catch(() => {
      // Logging must never surface as a session error.
    });
  };

  pi.on("before_provider_request", (event) => {
    enqueue(JSON.stringify(buildRequestRecord(event, now())));
  });
  pi.on("after_provider_response", (event) => {
    enqueue(JSON.stringify(buildResponseRecord(event, now())));
  });
  pi.on("session_shutdown", async () => {
    await writer;
    await flush();
  });
}
