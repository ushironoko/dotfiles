import { describe, it, expect } from "bun:test";
import { createUsageExtractor } from "../../../src/core/logproxy/usage-extract";

const enc = new TextEncoder();

const sse = (events: { event: string; data: unknown }[]): string =>
  events
    .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
    .join("");

const MESSAGE_START = {
  event: "message_start",
  data: {
    type: "message_start",
    message: {
      usage: {
        input_tokens: 2679,
        cache_creation_input_tokens: 12,
        cache_read_input_tokens: 34,
        output_tokens: 3,
      },
    },
  },
};
const DELTA = (output: number, stop: string | null) => ({
  event: "message_delta",
  data: {
    type: "message_delta",
    usage: { output_tokens: output },
    delta: { stop_reason: stop },
  },
});

/** バイト列を size ごとに分割して feed する。 */
const feedSplit = (
  extractor: ReturnType<typeof createUsageExtractor>,
  text: string,
  size: number,
) => {
  const bytes = enc.encode(text);
  for (let i = 0; i < bytes.length; i += size) {
    extractor.feed(bytes.subarray(i, i + size));
  }
};

describe("createUsageExtractor — SSE", () => {
  const ct = "text/event-stream";

  it("message_start の input/cache と最後の delta の output/stop_reason を取る", () => {
    const ex = createUsageExtractor(ct);
    ex.feed(
      enc.encode(
        sse([
          MESSAGE_START,
          { event: "ping", data: { type: "ping" } },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              delta: { type: "text_delta", text: "hi" },
            },
          },
          DELTA(510, "end_turn"),
          { event: "message_stop", data: { type: "message_stop" } },
        ]),
      ),
    );
    ex.end();
    expect(ex.result()).toEqual({
      usage: {
        input_tokens: 2679,
        cache_creation_input_tokens: 12,
        cache_read_input_tokens: 34,
        output_tokens: 510,
      },
      stop_reason: "end_turn",
    });
  });

  it("output_tokens は累積＝最後の delta で上書き（加算しない）", () => {
    const ex = createUsageExtractor(ct);
    ex.feed(
      enc.encode(
        sse([MESSAGE_START, DELTA(100, null), DELTA(510, "end_turn")]),
      ),
    );
    ex.end();
    expect(ex.result().usage?.output_tokens).toBe(510);
  });

  it("data 行の途中で分割されても parse できる（1バイトずつ）", () => {
    const ex = createUsageExtractor(ct);
    feedSplit(ex, sse([MESSAGE_START, DELTA(510, "end_turn")]), 1);
    ex.end();
    expect(ex.result().usage?.output_tokens).toBe(510);
    expect(ex.result().usage?.input_tokens).toBe(2679);
  });

  it("マルチバイト UTF-8 の途中で分割されても壊れない", () => {
    const ex = createUsageExtractor(ct);
    const text = sse([
      MESSAGE_START,
      {
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "宇宙🚀テスト" },
        },
      },
      DELTA(510, "end_turn"),
    ]);
    feedSplit(ex, text, 3); // マルチバイト境界をまたぐ
    ex.end();
    expect(ex.result().usage?.output_tokens).toBe(510);
  });

  it("message_start 前に中断すると usage 無し", () => {
    const ex = createUsageExtractor(ct);
    ex.feed(enc.encode('event: ping\ndata: {"type":"ping"}\n\n'));
    ex.end();
    expect(ex.result().usage).toBeUndefined();
    expect(ex.result().stop_reason).toBeUndefined();
  });

  it("message_start 後・delta 前に中断すると input あり・output 無し", () => {
    const ex = createUsageExtractor(ct);
    ex.feed(enc.encode(sse([MESSAGE_START])));
    ex.end();
    expect(ex.result().usage?.input_tokens).toBe(2679);
    expect(ex.result().usage?.output_tokens).toBeUndefined();
    expect(ex.result().stop_reason).toBeUndefined();
  });

  it("error イベントが混ざっても crash しない", () => {
    const ex = createUsageExtractor(ct);
    ex.feed(
      enc.encode(
        sse([
          MESSAGE_START,
          {
            event: "error",
            data: { type: "error", error: { type: "overloaded_error" } },
          },
          DELTA(7, "end_turn"),
        ]),
      ),
    );
    ex.end();
    expect(ex.result().usage?.output_tokens).toBe(7);
  });
});

describe("createUsageExtractor — JSON(非stream)", () => {
  it("完全な JSON body から usage/stop_reason を取る", () => {
    const ex = createUsageExtractor("application/json");
    ex.feed(
      enc.encode(
        JSON.stringify({
          type: "message",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 20,
            cache_read_input_tokens: 5,
          },
        }),
      ),
    );
    ex.end();
    expect(ex.result()).toEqual({
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 5,
      },
      stop_reason: "end_turn",
    });
  });

  it("JSON がチャンク分割されても連結して parse する", () => {
    const ex = createUsageExtractor("application/json");
    feedSplit(
      ex,
      JSON.stringify({
        usage: { input_tokens: 1, output_tokens: 2 },
        stop_reason: "max_tokens",
      }),
      4,
    );
    ex.end();
    expect(ex.result().usage?.output_tokens).toBe(2);
  });

  it("上限を超える JSON body は parse を諦める（crash しない）", () => {
    const ex = createUsageExtractor("application/json", { maxJsonBytes: 8 });
    ex.feed(
      enc.encode(
        JSON.stringify({ usage: { input_tokens: 1, output_tokens: 2 } }),
      ),
    );
    ex.end();
    expect(ex.result().usage).toBeUndefined();
  });
});
