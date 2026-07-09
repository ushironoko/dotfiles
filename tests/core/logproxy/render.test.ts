import { describe, it, expect } from "bun:test";
import {
  renderContext,
  selectRequestTurn,
} from "../../../src/core/logproxy/render";
import type {
  RequestRecord,
  ResponseRecord,
} from "../../../src/core/logproxy/types";

const mkReq = (over?: Partial<RequestRecord>): RequestRecord => ({
  kind: "request",
  record_id: "rid-1",
  ts: "2026-07-09T00:00:00.000Z",
  session_id: "sess-1",
  endpoint: "/v1/messages",
  model: "claude-opus-4-8",
  body_sha256: "sha",
  params: { max_tokens: 1024, stream: true },
  stats: { num_tools: 1, num_messages: 2, system_chars: 20, approx_bytes: 100 },
  system: [
    { type: "text", text: "SYS ONE" },
    { type: "text", text: "SYS TWO" },
  ],
  tools: [{ name: "read_file", description: "Read a file from disk" }],
  messages: [
    { role: "user", content: "hello there" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "sure" },
        {
          type: "tool_use",
          id: "tu1",
          name: "read_file",
          input: { path: "/x" },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu1", content: "file body" },
      ],
    },
  ],
  ...over,
});

const mkRes = (): ResponseRecord => ({
  kind: "response",
  record_id: "rid-1",
  ts: "2026-07-09T00:00:01.000Z",
  session_id: "sess-1",
  endpoint: "/v1/messages",
  status: 200,
  duration_ms: 1000,
  aborted: false,
  stream: true,
  usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3 },
  stop_reason: "end_turn",
});

describe("selectRequestTurn", () => {
  const reqs = [
    mkReq({ record_id: "a" }),
    mkReq({ record_id: "b" }),
    mkReq({ record_id: "c" }),
  ];
  it("turn 未指定は最後のターン", () => {
    expect(selectRequestTurn(reqs)?.record_id).toBe("c");
  });
  it("turn=1 は最初のターン（1-based）", () => {
    expect(selectRequestTurn(reqs, 1)?.record_id).toBe("a");
  });
  it("範囲外は undefined", () => {
    expect(selectRequestTurn(reqs, 99)).toBeUndefined();
    expect(selectRequestTurn([], 1)).toBeUndefined();
  });
});

describe("renderContext — text", () => {
  const out = renderContext(mkReq(), mkRes(), "text");
  it("メタ情報を含む", () => {
    expect(out).toContain("sess-1");
    expect(out).toContain("claude-opus-4-8");
  });
  it("system 全文（配列ブロック連結）を含む", () => {
    expect(out).toContain("SYS ONE");
    expect(out).toContain("SYS TWO");
  });
  it("ツール名と説明を含む", () => {
    expect(out).toContain("read_file");
    expect(out).toContain("Read a file from disk");
  });
  it("messages の text と tool_use / tool_result を整形して含む", () => {
    expect(out).toContain("hello there");
    expect(out).toContain("sure");
    expect(out).toContain("tool_use");
    expect(out).toContain("read_file");
    expect(out).toContain("tool_result");
    expect(out).toContain("file body");
  });
  it("応答 usage / stop_reason を含む", () => {
    expect(out).toContain("end_turn");
    expect(out).toContain("20"); // output_tokens
  });
  it("system が string でも表示できる", () => {
    const s = renderContext(mkReq({ system: "PLAIN SYS" }), undefined, "text");
    expect(s).toContain("PLAIN SYS");
  });
});

describe("renderContext — json", () => {
  it("request レコードそのものを整形 JSON で返す", () => {
    const req = mkReq();
    const out = renderContext(req, mkRes(), "json");
    const parsed = JSON.parse(out);
    expect(parsed.record_id).toBe(req.record_id);
    expect(parsed.system).toEqual(req.system);
    expect(parsed.tools).toEqual(req.tools);
  });
});

describe("renderContext — md", () => {
  const out = renderContext(mkReq(), mkRes(), "md");
  it("markdown 見出しと本文を含む", () => {
    expect(out).toContain("# ");
    expect(out).toContain("System");
    expect(out).toContain("Tools");
    expect(out).toContain("Messages");
    expect(out).toContain("SYS ONE");
  });
});
