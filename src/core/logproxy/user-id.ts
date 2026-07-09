// metadata.user_id をセッション相関のためにパースする。決して throw しない。
// 形式は Claude Code のバージョンに依存するため、多段フォールバックで防御的に扱う。
//   tier1: 素の JSON もしくは base64(JSON) を復号して {session_id,...} を得る
//   tier2: ラベル付き文字列（..._account_<uuid>_session_<uuid>）から抽出
//   tier3: 取り違えを避けるため裸 UUID 走査には倒さず unknown + user_id ハッシュ
import { createHash } from "node:crypto";
import { type ParsedUserId, UNKNOWN_SESSION } from "./types.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const HASH_LEN = 16;

/** 相関/dedup 用の短い sha256 hex。 */
export const shortHash = (input: string): string =>
  createHash("sha256").update(input).digest("hex").slice(0, HASH_LEN);

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const asObject = (text: string): Record<string, unknown> | undefined => {
  if (!text.trimStart().startsWith("{")) return undefined;
  try {
    const obj: unknown = JSON.parse(text);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch {
    // JSON ではない
  }
  return undefined;
};

/** 素の JSON → base64url → base64 の順で、user_id を JSON オブジェクトとして復号する。 */
const decodeToObject = (
  userId: string,
): Record<string, unknown> | undefined => {
  const direct = asObject(userId);
  if (direct) return direct;
  for (const enc of ["base64url", "base64"] as const) {
    const obj = asObject(Buffer.from(userId, enc).toString("utf8"));
    if (obj) return obj;
  }
  return undefined;
};

const fromObject = (obj: Record<string, unknown>): ParsedUserId | undefined => {
  const session = asString(obj["session_id"]);
  if (!session) return undefined;
  const parsed: ParsedUserId = { session_id: session };
  const parent = asString(obj["parent_session_id"]);
  const account = asString(obj["account_uuid"]);
  if (parent) parsed.parent_session_id = parent;
  if (account) parsed.account_uuid = account;
  return parsed;
};

export const parseUserId = (userId: string): ParsedUserId => {
  if (!userId) return { session_id: UNKNOWN_SESSION };

  // tier1: 素JSON / base64(JSON)
  const obj = decodeToObject(userId);
  if (obj) {
    const fromObj = fromObject(obj);
    if (fromObj) return fromObj;
  }

  // tier2: ラベル付き文字列。parent_session_ を session_ と混同しないよう
  // session は「直前が parent[_-] でない」もののみ採る。
  const parent = userId.match(
    new RegExp(`parent[_-]session[_-](${UUID})`, "i"),
  )?.[1];
  const session = userId.match(
    new RegExp(`(?<!parent[_-])session[_-](${UUID})`, "i"),
  )?.[1];
  const account = userId.match(new RegExp(`account[_-](${UUID})`, "i"))?.[1];
  if (session) {
    const parsed: ParsedUserId = { session_id: session };
    if (parent) parsed.parent_session_id = parent;
    if (account) parsed.account_uuid = account;
    return parsed;
  }

  // tier3: フォールバック（裸 UUID を session と誤認しない）
  return { session_id: UNKNOWN_SESSION, raw_user_id_hash: shortHash(userId) };
};
