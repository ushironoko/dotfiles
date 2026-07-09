import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { createProxyServer } from "../../../src/core/logproxy/proxy";
import {
  createLogWriter,
  type LogWriter,
} from "../../../src/core/logproxy/log-writer";
import type {
  RequestRecord,
  ResponseRecord,
} from "../../../src/core/logproxy/types";
import {
  setupTestDirectory,
  cleanupTestDirectory,
  startMockUpstream,
  type MockUpstream,
} from "../../test-helpers";

const enc = new TextEncoder();
const SESSION = "6b1e0000-0000-4000-8000-000000000001";
const userId = (obj: unknown): string =>
  Buffer.from(JSON.stringify(obj)).toString("base64url");

let root: string;
let baseDir: string;
let writer: LogWriter;
let upstream: MockUpstream;
let proxy: { port: number; url: string; stop: () => Promise<void> };
// テストごとに差し替える上流応答
let respond: (
  req: Request,
  rec: { body: string; path: string },
) => Response | Promise<Response>;

beforeEach(async () => {
  root = await setupTestDirectory("logproxy-proxy");
  baseDir = join(root, "logs");
  writer = createLogWriter({ baseDir });
  respond = () => new Response("ok");
  upstream = await startMockUpstream((req, rec) => respond(req, rec));
  proxy = createProxyServer({ port: 0, upstream: upstream.url, writer });
});
afterEach(async () => {
  await proxy.stop();
  await upstream.close();
  await writer.close();
  await cleanupTestDirectory(root);
});

const readRecords = async (
  sid: string,
): Promise<(RequestRecord | ResponseRecord)[]> => {
  try {
    const content = await fs.readFile(join(baseDir, `${sid}.jsonl`), "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

/** レコードが count 件になるまで（またはタイムアウト）待つ。 */
const waitForRecords = async (
  sid: string,
  count: number,
  timeoutMs = 1500,
): Promise<(RequestRecord | ResponseRecord)[]> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await writer.flush();
    const recs = await readRecords(sid);
    if (recs.length >= count || Date.now() > deadline) return recs;
    await Bun.sleep(10);
  }
};

const messagesBody = (extra?: Record<string, unknown>): string =>
  JSON.stringify({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    stream: true,
    metadata: { user_id: userId({ session_id: SESSION, account_uuid: "acc" }) },
    system: "you are helpful",
    tools: [{ name: "t1", input_schema: { type: "object" } }],
    messages: [{ role: "user", content: "hi" }],
    ...extra,
  });

const sse = (): string =>
  [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 1 } } })}\n\n`,
    `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 }, delta: { stop_reason: "end_turn" } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");

describe("proxy — 透過フォワード", () => {
  it("① 非messagesパスは verbatim 転送され記録されない", async () => {
    respond = () => Response.json({ models: [] });
    const res = await fetch(`${proxy.url}/v1/models?x=1`, {
      method: "GET",
      headers: { "x-custom": "abc" },
    });
    expect(res.status).toBe(200);
    expect(upstream.received.at(-1)?.path).toBe("/v1/models?x=1");
    expect(upstream.received.at(-1)?.headers["x-custom"]).toBe("abc");
    // ログディレクトリすら作られない
    await writer.flush();
    expect(await readRecords("unknown")).toEqual([]);
  });

  it("⑫ 非記録パスの gzip 応答はバイト同一・Content-Encoding 保持で透過", async () => {
    const payload = new Uint8Array(
      enc.encode(JSON.stringify({ hello: "world".repeat(50) })),
    );
    const gz = Bun.gzipSync(payload);
    respond = () =>
      new Response(gz, {
        headers: {
          "content-encoding": "gzip",
          "content-type": "application/json",
        },
      });
    // クライアント側も decompress:false で受け、プロキシが素通しした生バイトを検証
    const res = await fetch(`${proxy.url}/v1/models`, { decompress: false });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const raw = new Uint8Array(await res.arrayBuffer());
    expect([...raw]).toEqual([...gz]); // 二重解凍せずバイト同一
  });

  it("⑥ Authorization / x-api-key は素通し・Connection 列挙の hop-by-hop は除去", async () => {
    respond = () => new Response("ok");
    // Connection: x-hop-demo で列挙したヘッダは転送しない（動的 hop-by-hop 除去）。
    // 注: connection ヘッダ自体はトランスポートが再付与するため検証対象にしない。
    await fetch(`${proxy.url}/v1/models`, {
      headers: {
        authorization: "Bearer secret-token",
        "x-api-key": "sk-xxx",
        "x-hop-demo": "should-be-stripped",
        connection: "x-hop-demo",
      },
    });
    const h = upstream.received.at(-1)!.headers;
    expect(h["authorization"]).toBe("Bearer secret-token");
    expect(h["x-api-key"]).toBe("sk-xxx");
    expect(h["x-hop-demo"]).toBeUndefined();
  });

  it("⑦ 上流障害は 502 を返す（ハングしない）", async () => {
    await upstream.close(); // 上流を落とす
    const res = await fetch(`${proxy.url}/v1/models`);
    expect(res.status).toBe(502);
  });

  it("⑪ redirect は追わず 3xx を素通しする", async () => {
    respond = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/x" },
      });
    const res = await fetch(`${proxy.url}/v1/models`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/x");
  });

  it("⑨ health はローカル応答で上流に届かない", async () => {
    const before = upstream.received.length;
    const res = await fetch(`${proxy.url}/__logproxy/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    expect(upstream.received.length).toBe(before);
  });
});

describe("proxy — /v1/messages 記録", () => {
  it("② request が system/tools/messages/params/stats 付きで記録される", async () => {
    respond = () =>
      new Response(sse(), { headers: { "content-type": "text/event-stream" } });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: messagesBody(),
    });
    await res.text();
    const recs = await waitForRecords(SESSION, 1);
    const req = recs.find((r) => r.kind === "request") as RequestRecord;
    expect(req).toBeTruthy();
    expect(req.system).toBe("you are helpful");
    expect(req.tools?.length).toBe(1);
    expect(req.messages?.length).toBe(1);
    expect(req.params.max_tokens).toBe(1024);
    expect(req.params.stream).toBe(true);
    expect(req.stats.num_tools).toBe(1);
    expect(req.account_hash).toBeTruthy();
    expect(req.body_sha256).toBeTruthy();
  });

  it("③ SSE の usage を採取しつつクライアントには無改変ストリームを返す", async () => {
    const stream = sse();
    respond = () =>
      new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "request-id": "req_123",
        },
      });
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      body: messagesBody(),
    });
    const clientText = await res.text();
    expect(clientText).toBe(stream); // クライアント側は無改変

    const recs = await waitForRecords(SESSION, 2);
    const resp = recs.find((r) => r.kind === "response") as ResponseRecord;
    expect(resp).toBeTruthy();
    expect(resp.usage?.input_tokens).toBe(10);
    expect(resp.usage?.output_tokens).toBe(42);
    expect(resp.stop_reason).toBe("end_turn");
    expect(resp.request_id).toBe("req_123");
    expect(resp.aborted).toBe(false);
  });

  it("④ 非stream JSON 応答でも usage を記録する", async () => {
    respond = () =>
      Response.json(
        {
          type: "message",
          stop_reason: "end_turn",
          usage: { input_tokens: 5, output_tokens: 9 },
        },
        { headers: { "content-type": "application/json" } },
      );
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      body: messagesBody({ stream: false }),
    });
    await res.text();
    const recs = await waitForRecords(SESSION, 2);
    const resp = recs.find((r) => r.kind === "response") as ResponseRecord;
    expect(resp?.usage?.output_tokens).toBe(9);
    expect(resp?.stream).toBe(false);
  });

  it("⑩ count_tokens は request のみ・response 無し", async () => {
    respond = () => Response.json({ input_tokens: 7 });
    const res = await fetch(`${proxy.url}/v1/messages/count_tokens`, {
      method: "POST",
      body: messagesBody(),
    });
    await res.text();
    const recs = await waitForRecords(SESSION, 1);
    expect(recs.filter((r) => r.kind === "request").length).toBe(1);
    expect(recs.filter((r) => r.kind === "response").length).toBe(0);
  });

  it("⑧ 壊れたボディでも 200 転送し unknown バケットに best-effort 記録", async () => {
    respond = () => new Response("ok");
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      body: "this-is-not-json",
    });
    expect(res.status).toBe(200);
    const recs = await waitForRecords("unknown", 1);
    expect(recs.filter((r) => r.kind === "request").length).toBe(1);
  });

  it("⑤ 記録層が壊れていても（書込不能）200 と全body を返す（fail-open）", async () => {
    const ro = join(root, "ro");
    await fs.mkdir(ro);
    await fs.chmod(ro, 0o500);
    const w2 = createLogWriter({ baseDir: join(ro, "logs") });
    const p2 = createProxyServer({
      port: 0,
      upstream: upstream.url,
      writer: w2,
    });
    try {
      respond = () => new Response("hello-body");
      const res = await fetch(`${p2.url}/v1/messages`, {
        method: "POST",
        body: messagesBody(),
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello-body");
    } finally {
      await p2.stop();
      await w2.close();
      await fs.chmod(ro, 0o700);
    }
  });

  it("⑬ 途中で切れる（truncated）SSE でも crash せず部分 usage を記録", async () => {
    // message_start だけ流して閉じる（delta 前に切れる短いストリーム）。
    // aborted 真偽の決定的検証は wrapWithUsage の単体テストで担保。
    respond = () => {
      let sent = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sent) {
            sent = true;
            controller.enqueue(
              enc.encode(
                `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } })}\n\n`,
              ),
            );
            return;
          }
          controller.close();
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const res = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      body: messagesBody(),
    });
    await res.text();
    const recs = await waitForRecords(SESSION, 2);
    const resp = recs.find((r) => r.kind === "response") as
      | ResponseRecord
      | undefined;
    expect(resp).toBeTruthy();
    expect(resp?.usage?.input_tokens).toBe(3);
    expect(resp?.usage?.output_tokens).toBeUndefined();
  });
});
