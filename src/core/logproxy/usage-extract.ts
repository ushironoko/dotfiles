// 応答から token usage / stop_reason を採取する。
// SSE(stream) は message_start(input/cache) と最後の message_delta(output/stop_reason) から、
// JSON(非stream) は完全な body から取る。チャンク境界・マルチバイト・中断に耐える。
import { type UsageInfo, type UsageResult } from "./types.js";

export interface UsageExtractor {
  feed(bytes: Uint8Array): void;
  end(): void;
  result(): UsageResult;
}

const DEFAULT_MAX_JSON_BYTES = 16 * 1024 * 1024;
const DATA_PREFIX = "data:";

const pickUsage = (
  u: unknown,
  out: UsageInfo,
  keys: (keyof UsageInfo)[],
): boolean => {
  if (!u || typeof u !== "object") return false;
  const rec = u as Record<string, unknown>;
  let touched = false;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number") {
      out[k] = v;
      touched = true;
    }
  }
  return touched;
};

const INPUT_KEYS: (keyof UsageInfo)[] = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
];

export const createUsageExtractor = (
  contentType: string,
  opts?: { maxJsonBytes?: number },
): UsageExtractor => {
  const isSse = contentType.includes("text/event-stream");
  const maxJsonBytes = opts?.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES;

  const usage: UsageInfo = {};
  let hasUsage = false;
  let stopReason: string | null | undefined = undefined;

  // --- SSE state ---
  const decoder = new TextDecoder();
  let residual = "";

  const processSseLine = (rawLine: string): void => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.startsWith(DATA_PREFIX)) return;
    const payload = line.slice(DATA_PREFIX.length).trimStart();
    if (!payload || payload[0] !== "{") return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (obj["type"] === "message_start") {
      const msg = obj["message"] as Record<string, unknown> | undefined;
      if (pickUsage(msg?.["usage"], usage, INPUT_KEYS)) hasUsage = true;
    } else if (obj["type"] === "message_delta") {
      // output_tokens は累積なので上書き。input/cache が来れば併せて更新。
      if (pickUsage(obj["usage"], usage, ["output_tokens", ...INPUT_KEYS])) {
        hasUsage = true;
      }
      const delta = obj["delta"] as Record<string, unknown> | undefined;
      if (delta && "stop_reason" in delta) {
        stopReason = delta["stop_reason"] as string | null;
      }
    }
  };

  // --- JSON state ---
  const jsonChunks: Uint8Array[] = [];
  let jsonBytes = 0;
  let jsonOverflow = false;

  const feed = (bytes: Uint8Array): void => {
    if (isSse) {
      residual += decoder.decode(bytes, { stream: true });
      const parts = residual.split("\n");
      residual = parts.pop() ?? "";
      for (const p of parts) processSseLine(p);
      return;
    }
    if (jsonOverflow) return;
    if (jsonBytes + bytes.byteLength > maxJsonBytes) {
      jsonOverflow = true;
      jsonChunks.length = 0;
      return;
    }
    jsonChunks.push(bytes.slice());
    jsonBytes += bytes.byteLength;
  };

  const end = (): void => {
    if (isSse) {
      residual += decoder.decode();
      if (residual.length) processSseLine(residual);
      residual = "";
      return;
    }
    if (jsonOverflow || jsonChunks.length === 0) return;
    try {
      const buf = new Uint8Array(jsonBytes);
      let off = 0;
      for (const c of jsonChunks) {
        buf.set(c, off);
        off += c.byteLength;
      }
      const obj = JSON.parse(new TextDecoder().decode(buf)) as Record<
        string,
        unknown
      >;
      if (pickUsage(obj["usage"], usage, ["output_tokens", ...INPUT_KEYS])) {
        hasUsage = true;
      }
      if ("stop_reason" in obj)
        stopReason = obj["stop_reason"] as string | null;
    } catch {
      // 壊れた/非JSON応答は無視
    }
  };

  const result = (): UsageResult => ({
    usage: hasUsage ? usage : undefined,
    stop_reason: stopReason,
  });

  return { feed, end, result };
};
