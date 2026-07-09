import { describe, it, expect } from "bun:test";
import { wrapWithUsage } from "../../../src/core/logproxy/proxy";

const enc = new TextEncoder();
const SSE_CT = "text/event-stream";

const START = `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 1, output_tokens: 1 } } })}\n\n`;
const DELTA = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 }, delta: { stop_reason: "end_turn" } })}\n\n`;

// pull ベース: 各 chunk を消費させてから最後に close または error にする
// （start 内で enqueue 直後に error するとキュー済み chunk が破棄されるため）
const sourceOf = (
  chunks: string[],
  errorAtEnd = false,
): ReadableStream<Uint8Array> => {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]!));
        return;
      }
      if (errorAtEnd) controller.error(new Error("boom"));
      else controller.close();
    },
  });
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out;
};

describe("wrapWithUsage", () => {
  it("正常完了: クライアントへ無改変で流し、usage 全部・aborted:false", async () => {
    const { stream, done } = wrapWithUsage(sourceOf([START, DELTA]), SSE_CT);
    const text = await drain(stream);
    expect(text).toBe(START + DELTA);
    const { result, aborted } = await done;
    expect(aborted).toBe(false);
    expect(result.usage?.input_tokens).toBe(3);
    expect(result.usage?.output_tokens).toBe(42);
    expect(result.stop_reason).toBe("end_turn");
  });

  it("上流エラー: crash せず aborted:true・message_start までの usage は残る", async () => {
    const { stream, done } = wrapWithUsage(sourceOf([START], true), SSE_CT);
    let threw = false;
    try {
      await drain(stream);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const { result, aborted } = await done;
    expect(aborted).toBe(true);
    expect(result.usage?.input_tokens).toBe(3);
    expect(result.usage?.output_tokens).toBeUndefined();
  });

  it("consumer キャンセル: aborted:true で done が解決する", async () => {
    const { stream, done } = wrapWithUsage(sourceOf([START, DELTA]), SSE_CT);
    const reader = stream.getReader();
    await reader.read(); // 最初のチャンクだけ受け取る
    await reader.cancel();
    const { aborted } = await done;
    expect(aborted).toBe(true);
  });
});
