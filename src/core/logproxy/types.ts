// logproxy: Claude Code の API リクエスト文脈をセッション単位で構造化ログするための型・定数。

/** metadata.user_id を復号/推定した結果。session_id は必ず入る（不明時は "unknown"）。 */
export interface ParsedUserId {
  session_id: string;
  parent_session_id?: string;
  account_uuid?: string;
  /** base64(JSON) 復号やラベル抽出に失敗したときの相関用フォールバック（user_id のハッシュ）。 */
  raw_user_id_hash?: string;
}

export const UNKNOWN_SESSION = "unknown";

export interface UsageInfo {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface UsageResult {
  usage?: UsageInfo;
  stop_reason?: string | null;
}

/** リクエストボディから抜き出す主要パラメータ（機密の tools/messages 本文とは別に俯瞰しやすくする）。 */
export interface RequestParams {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  thinking?: unknown;
  betas?: unknown;
  tool_choice?: unknown;
  stream?: boolean;
}

export interface RecordStats {
  num_tools: number;
  num_messages: number;
  system_chars: number;
  approx_bytes: number;
}

export interface RequestRecord {
  kind: "request";
  record_id: string;
  ts: string;
  session_id: string;
  parent_session_id?: string;
  /** account_uuid のハッシュ（生値は残さない）。 */
  account_hash?: string;
  raw_user_id_hash?: string;
  endpoint: string;
  model?: string;
  /** SDK retry などで同一ターンが複数記録されたときに分析側で dedupe するための本文ハッシュ。 */
  body_sha256: string;
  params: RequestParams;
  system?: unknown;
  tools?: unknown[];
  messages?: unknown[];
  stats: RecordStats;
  /** env LOGPROXY_DEBUG_USER_ID=1 のときだけ入る、生の metadata.user_id（形式確定用の診断）。 */
  debug_user_id?: string;
}

export interface ResponseRecord {
  kind: "response";
  record_id: string;
  ts: string;
  session_id: string;
  endpoint: string;
  status: number;
  request_id?: string;
  duration_ms: number;
  aborted: boolean;
  stream: boolean;
  usage?: UsageInfo;
  stop_reason?: string | null;
}

export type LogRecord = RequestRecord | ResponseRecord;

/** 現在時刻(ms)を返す関数。テストで注入して時間依存ロジックを決定的にする。 */
export type NowFn = () => number;

// --- 定数 ---

export const DEFAULT_PORT = 8787;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_UPSTREAM = "https://api.anthropic.com";
/** 記録先ディレクトリ（~ は expandPath で展開）。 */
export const DEFAULT_LOG_DIR = "~/.claude/context-logs";
export const LAUNCHD_LABEL = "com.ushironoko.claude-logproxy";

export const HEALTH_PATH = "/__logproxy/health";
export const MESSAGES_PATH = "/v1/messages";
export const COUNT_TOKENS_PATH = "/v1/messages/count_tokens";

export const DEFAULT_KEEP_DAYS = 14;
export const DEFAULT_GZIP_IDLE_MINUTES = 30;

/** 転送時に除去する固定の hop-by-hop ヘッダ（Connection ヘッダで動的に列挙されたものは別途除去）。 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
