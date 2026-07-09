// リクエストボディから RequestRecord を組み立てる純粋ロジック。
// 非JSON/壊れたボディでも throw せず best-effort（session_id は "unknown"）で記録する。
import { createHash } from "node:crypto";
import { parseUserId, shortHash } from "./user-id.js";
import type { RecordStats, RequestParams, RequestRecord } from "./types.js";

const sha256hex = (buf: Uint8Array): string =>
  createHash("sha256").update(buf).digest("hex");

const PARAM_KEYS: (keyof RequestParams)[] = [
  "max_tokens",
  "temperature",
  "top_p",
  "top_k",
  "thinking",
  "betas",
  "tool_choice",
  "stream",
];

export const pickParams = (body: Record<string, unknown>): RequestParams => {
  const p: RequestParams = {};
  for (const k of PARAM_KEYS) {
    if (body[k] !== undefined) {
      (p as Record<string, unknown>)[k] = body[k];
    }
  }
  return p;
};

export const computeStats = (
  body: Record<string, unknown>,
  byteLength: number,
): RecordStats => {
  const tools = body["tools"];
  const messages = body["messages"];
  const system = body["system"];
  let system_chars = 0;
  if (typeof system === "string") {
    system_chars = system.length;
  } else if (system !== undefined) {
    system_chars = JSON.stringify(system).length;
  }
  return {
    num_tools: Array.isArray(tools) ? tools.length : 0,
    num_messages: Array.isArray(messages) ? messages.length : 0,
    system_chars,
    approx_bytes: byteLength,
  };
};

export const buildRequestRecord = (
  endpoint: string,
  buf: Uint8Array,
  nowMs: number,
): RequestRecord => {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(buf));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // 非JSON/壊れ → unknown バケットへ
  }

  const meta = body["metadata"] as Record<string, unknown> | undefined;
  const userId =
    typeof meta?.["user_id"] === "string" ? (meta["user_id"] as string) : "";
  const parsedId = parseUserId(userId);

  const record: RequestRecord = {
    kind: "request",
    record_id: crypto.randomUUID(),
    ts: new Date(nowMs).toISOString(),
    session_id: parsedId.session_id,
    endpoint,
    body_sha256: sha256hex(buf),
    params: pickParams(body),
    stats: computeStats(body, buf.byteLength),
  };
  if (parsedId.parent_session_id)
    record.parent_session_id = parsedId.parent_session_id;
  if (parsedId.account_uuid)
    record.account_hash = shortHash(parsedId.account_uuid);
  if (parsedId.raw_user_id_hash)
    record.raw_user_id_hash = parsedId.raw_user_id_hash;
  if (typeof body["model"] === "string") record.model = body["model"] as string;
  if (body["system"] !== undefined) record.system = body["system"];
  if (Array.isArray(body["tools"])) record.tools = body["tools"] as unknown[];
  if (Array.isArray(body["messages"]))
    record.messages = body["messages"] as unknown[];
  // 形式確定用の診断: env でオンのときだけ生 user_id を残す（account/device 識別子を含む）
  if (process.env["LOGPROXY_DEBUG_USER_ID"] === "1" && userId) {
    record.debug_user_id = userId;
  }
  return record;
};
