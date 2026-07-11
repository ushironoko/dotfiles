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
import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
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

  const flush = async (): Promise<void> => {
    if (queue.length === 0 && dropped === 0) return;
    const lines = queue.splice(0);
    if (dropped > 0) {
      lines.push(
        JSON.stringify({
          ts: now().toISOString(),
          kind: "drops",
          count: dropped,
        }),
      );
      dropped = 0;
    }
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    await applyRetention();
    await appendFile(
      join(logDir, logFileName(now())),
      `${lines.join("\n")}\n`,
      {
        mode: 0o600,
      },
    );
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
