/**
 * Pure record builders for the opt-in provider logger (V10 scope: request
 * metadata before send; status + headers before the stream is consumed).
 *
 * Privacy contract: the request body is never stored — only its sha256 plus
 * coarse metadata (model, message count, system prompt length). Response
 * headers pass an allowlist so credentials and cookies can never leak into
 * the log.
 */
import { createHash } from "node:crypto";

export interface ProviderRequestRecord {
  ts: string;
  kind: "request";
  bodySha256: string;
  model?: string;
  messageCount?: number;
  systemChars?: number;
}

export interface ProviderResponseRecord {
  ts: string;
  kind: "response";
  status?: number;
  headers: Record<string, string>;
}

const HEADER_ALLOWLIST = new Set([
  "content-type",
  "request-id",
  "x-request-id",
  "retry-after",
]);
const HEADER_ALLOW_PREFIXES = ["anthropic-ratelimit-", "x-ratelimit-"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isAllowedHeader = (name: string): boolean =>
  HEADER_ALLOWLIST.has(name) ||
  HEADER_ALLOW_PREFIXES.some((prefix) => name.startsWith(prefix));

/** The request-ish object inside the event, wherever pi 0.80.x puts it. */
const requestBody = (event: unknown): Record<string, unknown> => {
  if (!isRecord(event)) return {};
  if (isRecord(event.request)) return event.request;
  if (isRecord(event.payload)) return event.payload;
  return event;
};

const stringField = (
  source: Record<string, unknown>,
  key: string,
): string | undefined =>
  typeof source[key] === "string" ? source[key] : undefined;

const systemLength = (source: Record<string, unknown>): number | undefined => {
  const system = source.system;
  if (typeof system === "string") return system.length;
  if (Array.isArray(system)) {
    return system.reduce<number>(
      (total, part) =>
        total +
        (typeof part === "string"
          ? part.length
          : isRecord(part) && typeof part.text === "string"
            ? part.text.length
            : 0),
      0,
    );
  }
  return undefined;
};

export const buildRequestRecord = (
  event: unknown,
  now: Date,
): ProviderRequestRecord => {
  const body = requestBody(event);
  const record: ProviderRequestRecord = {
    ts: now.toISOString(),
    kind: "request",
    bodySha256: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
  const model = stringField(body, "model");
  if (model !== undefined) record.model = model;
  if (Array.isArray(body.messages)) record.messageCount = body.messages.length;
  const systemChars = systemLength(body);
  if (systemChars !== undefined) record.systemChars = systemChars;
  return record;
};

export const buildResponseRecord = (
  event: unknown,
  now: Date,
): ProviderResponseRecord => {
  const source = isRecord(event) ? event : {};
  const container = isRecord(source.response) ? source.response : source;
  const record: ProviderResponseRecord = {
    ts: now.toISOString(),
    kind: "response",
    headers: {},
  };
  if (typeof container.status === "number") record.status = container.status;
  const headers = container.headers;
  if (isRecord(headers)) {
    for (const [name, value] of Object.entries(headers)) {
      const lowered = name.toLowerCase();
      if (isAllowedHeader(lowered) && typeof value === "string") {
        record.headers[lowered] = value;
      }
    }
  }
  return record;
};

const LOG_NAME_PATTERN = /^provider-(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

export const logFileName = (now: Date): string =>
  `provider-${now.toISOString().slice(0, 10)}.jsonl`;

/** Dated log files strictly older than the retention window. */
export const selectExpiredLogs = (
  fileNames: string[],
  now: Date,
  retentionDays: number,
): string[] => {
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return fileNames.filter((name) => {
    const match = LOG_NAME_PATTERN.exec(name);
    if (match === null) return false;
    const stamp = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
    return Number.isFinite(stamp) && stamp < cutoff;
  });
};
