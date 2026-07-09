// Claude Code の ANTHROPIC_BASE_URL を受ける透過逆プロキシ。
// - 全パスを上流へ透過フォワード（decompress:false で byte 透過）
// - /v1/messages と /v1/messages/count_tokens だけ request を記録
// - /v1/messages の応答は TransformStream 相当(tee 不使用)で転送しつつ usage 採取
// - fail-open: 記録・parse の失敗は転送に影響させない
import {
  type NowFn,
  type RequestRecord,
  type ResponseRecord,
  type UsageResult,
  COUNT_TOKENS_PATH,
  DEFAULT_HOST,
  HEALTH_PATH,
  HOP_BY_HOP_HEADERS,
  MESSAGES_PATH,
} from "./types.js";
import type { LogWriter } from "./log-writer.js";
import { buildRequestRecord } from "./record.js";
import { createUsageExtractor } from "./usage-extract.js";

export interface ProxyServer {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export interface ProxyOptions {
  port: number;
  host?: string;
  upstream: string;
  writer: LogWriter;
  now?: NowFn;
}

/** hop-by-hop（固定 + Connection トークンで動的指定されたもの）を除いたヘッダを作る。 */
const buildForwardHeaders = (src: Headers): Headers => {
  const connTokens = new Set<string>();
  const conn = src.get("connection");
  if (conn) {
    for (const t of conn.split(",")) connTokens.add(t.trim().toLowerCase());
  }
  const out = new Headers();
  src.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) return;
    if (connTokens.has(lk)) return;
    out.set(k, v);
  });
  return out;
};

export interface WrapResult {
  stream: ReadableStream<Uint8Array>;
  done: Promise<{ result: UsageResult; aborted: boolean }>;
}

/**
 * 上流ストリームを pull ベースで包み、クライアントへ流しつつ usage を採取する。
 * pull ベースなので downstream backpressure がそのまま上流の読み取りを律速する（tee のような無制限バッファを作らない）。
 */
export const wrapWithUsage = (
  source: ReadableStream<Uint8Array>,
  contentType: string,
): WrapResult => {
  const extractor = createUsageExtractor(contentType);
  const reader = source.getReader();
  let settle!: (v: { result: UsageResult; aborted: boolean }) => void;
  const done = new Promise<{ result: UsageResult; aborted: boolean }>((r) => {
    settle = r;
  });
  let aborted = false;
  let settled = false;
  const finish = (): void => {
    if (settled) return;
    settled = true;
    try {
      extractor.end();
    } catch {
      // ignore
    }
    settle({ result: extractor.result(), aborted });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done: d, value } = await reader.read();
        if (d) {
          controller.close();
          finish();
          return;
        }
        try {
          extractor.feed(value);
        } catch {
          // usage 採取失敗は転送に影響させない
        }
        controller.enqueue(value);
      } catch (err) {
        aborted = true;
        try {
          controller.error(err);
        } catch {
          // ignore
        }
        finish();
      }
    },
    cancel(reason) {
      aborted = true;
      try {
        void reader.cancel(reason);
      } catch {
        // ignore
      }
      finish();
    },
  });

  return { stream, done };
};

export const createProxyServer = (opts: ProxyOptions): ProxyServer => {
  const host = opts.host ?? DEFAULT_HOST;
  const nowFn: NowFn = opts.now ?? Date.now;
  const { writer, upstream } = opts;

  const server = Bun.serve({
    hostname: host,
    port: opts.port,
    idleTimeout: 30,
    async fetch(request, srv) {
      const url = new URL(request.url);

      // health はローカルで返し、上流へは流さない
      if (url.pathname === HEALTH_PATH) {
        return Response.json({ ok: true });
      }

      // 長い無音 SSE を切らないよう proxied request の idle タイムアウトを無効化
      srv.timeout(request, 0);

      const pathname = url.pathname;
      const isMessages = pathname === MESSAGES_PATH;
      const isCount = pathname === COUNT_TOKENS_PATH;
      const isLogged = isMessages || isCount;

      const upstreamHeaders = buildForwardHeaders(request.headers);
      // 記録対象は非圧縮にして usage を parse 可能にする
      if (isMessages) upstreamHeaders.set("accept-encoding", "identity");

      const upstreamUrl = upstream + pathname + url.search;
      const startMs = nowFn();

      let record: RequestRecord | undefined;
      let body: Bun.BodyInit | undefined;

      if (isLogged) {
        const buf = new Uint8Array(await request.arrayBuffer());
        body = buf;
        try {
          record = buildRequestRecord(pathname, buf, startMs);
        } catch {
          record = undefined;
        }
        if (record) {
          void writer.writeRequest(record).catch(() => {});
        }
      } else {
        body = request.body ?? undefined;
      }

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(upstreamUrl, {
          method: request.method,
          headers: upstreamHeaders,
          decompress: false,
          signal: request.signal,
          redirect: "manual",
          // body/duplex はボディがあるときだけ付ける（GET 等では付けない）
          ...(body !== undefined ? { body, duplex: "half" } : {}),
        });
      } catch {
        // 上流障害はハングさせず 502 を返し、Claude Code のリトライに委ねる
        return new Response("upstream fetch failed", { status: 502 });
      }

      const outHeaders = buildForwardHeaders(upstreamRes.headers);

      if (record && isMessages && upstreamRes.body) {
        const contentType = upstreamRes.headers.get("content-type") ?? "";
        const isStream = contentType.includes("text/event-stream");
        const { stream, done } = wrapWithUsage(upstreamRes.body, contentType);
        const rec = record;
        const status = upstreamRes.status;
        const requestId =
          upstreamRes.headers.get("request-id") ??
          upstreamRes.headers.get("anthropic-request-id") ??
          undefined;

        void done
          .then(({ result, aborted }) => {
            const resRec: ResponseRecord = {
              kind: "response",
              record_id: rec.record_id,
              ts: new Date(nowFn()).toISOString(),
              session_id: rec.session_id,
              endpoint: rec.endpoint,
              status,
              duration_ms: nowFn() - startMs,
              aborted,
              stream: isStream,
            };
            if (requestId) resRec.request_id = requestId;
            if (result.usage) resRec.usage = result.usage;
            if (result.stop_reason !== undefined)
              resRec.stop_reason = result.stop_reason;
            return writer.writeResponse(resRec);
          })
          .catch(() => {});

        return new Response(stream, {
          status,
          statusText: upstreamRes.statusText,
          headers: outHeaders,
        });
      }

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: outHeaders,
      });
    },
  });

  const port = server.port ?? opts.port;
  return {
    port,
    url: `http://${host}:${port}`,
    stop: async () => {
      await server.stop(true);
    },
  };
};
