import { describe, expect, test } from "bun:test";
import {
  MAX_ASSISTANT_ITEM_BYTES,
  MAX_RUN_TRANSCRIPT_BYTES,
  MAX_RUN_TRANSCRIPT_ITEMS,
  type ChildObservation,
} from "../../pi/extensions/pi-harness/features/child-runs/model";
import { createChildProtocolParser } from "../../pi/extensions/pi-harness/features/child-runs/protocol";
import {
  capUtf8,
  stripTerminalControls,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "../../pi/extensions/pi-harness/lib/terminal-text";

describe("child JSON protocol normalization", () => {
  test("keeps legacy first-block output while emitting sanitized full assistant text", () => {
    const observations: ChildObservation[] = [];
    const parser = createChildProtocolParser({
      observe: (item) => observations.push(item),
      now: () => 123,
    });
    const line = JSON.stringify({
      type: "message_end",
      responseId: "SECRET_RESPONSE",
      message: {
        role: "assistant",
        model: "model\u001b]2;title\u0007-safe",
        stopReason: "stop",
        content: [
          {
            type: "thinking",
            thinking: "SECRET_THINKING",
            signature: "SECRET_SIGNATURE",
          },
          { type: "text", text: "first\u001b[31m red\u001b[0m" },
          {
            type: "toolCall",
            id: "SECRET_TOOL_ID",
            name: "bash",
            arguments: { command: "SECRET_ARGUMENT" },
          },
          { type: "text", text: "second" },
        ],
      },
    });

    expect(parser.processLine(line)).toEqual({
      text: "first\u001b[31m red\u001b[0m",
      stopReason: "stop",
      errorMessage: undefined,
    });
    expect(observations).toEqual([
      {
        type: "assistant_final",
        text: "first red\nsecond",
        at: 123,
        model: "model-safe",
        stopReason: "stop",
      },
    ]);
    const serialized = JSON.stringify(observations);
    for (const secret of [
      "SECRET_RESPONSE",
      "SECRET_THINKING",
      "SECRET_SIGNATURE",
      "SECRET_TOOL_ID",
      "SECRET_ARGUMENT",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  test("emits only text as a live draft", () => {
    const observations: ChildObservation[] = [];
    const parser = createChildProtocolParser({
      observe: (item) => observations.push(item),
    });

    parser.processLine(
      JSON.stringify({
        type: "message_update",
        assistantMessageEvent: {
          type: "thinking_delta",
          delta: "SECRET_DELTA",
        },
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "SECRET_THINKING" },
            { type: "text", text: "safe draft" },
            {
              type: "toolCall",
              id: "SECRET_ID",
              arguments: { value: "SECRET_ARGS" },
            },
          ],
        },
      }),
    );

    expect(observations).toEqual([
      { type: "assistant_draft", text: "safe draft" },
    ]);
    expect(JSON.stringify(observations)).not.toContain("SECRET");
  });

  test("maps raw tool ids to stable local ordinals and drops payloads", () => {
    const observations: ChildObservation[] = [];
    const parser = createChildProtocolParser({
      observe: (item) => observations.push(item),
      now: () => 9,
    });

    parser.processLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "provider-secret-id",
        toolName: "bash\u001b[31m",
        args: { command: "rm SECRET" },
      }),
    );
    parser.processLine(
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "provider-secret-id",
        toolName: "bash",
        result: { content: [{ type: "text", text: "SECRET_RESULT" }] },
        isError: true,
      }),
    );

    expect(observations).toEqual([
      { type: "tool_started", localId: 1, name: "bash", at: 9 },
      {
        type: "tool_finished",
        localId: 1,
        name: "bash",
        failed: true,
        at: 9,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain("SECRET");
    expect(JSON.stringify(observations)).not.toContain("provider-secret-id");
  });

  test("bounds retained raw tool-id correlations by item count", () => {
    const observations: ChildObservation[] = [];
    const parser = createChildProtocolParser({
      observe: (item) => observations.push(item),
      now: () => 9,
    });

    for (let index = 0; index < MAX_RUN_TRANSCRIPT_ITEMS; index++) {
      parser.processLine(
        JSON.stringify({
          type: "tool_execution_start",
          toolCallId: `tool-${index}`,
          toolName: "bash",
        }),
      );
    }
    parser.processLine(
      JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "overflow-tool",
        toolName: "read",
      }),
    );
    parser.processLine(
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "overflow-tool",
        toolName: "read",
      }),
    );
    parser.processLine(
      JSON.stringify({
        type: "tool_execution_end",
        toolCallId: "tool-0",
        toolName: "bash",
      }),
    );

    expect(observations.at(MAX_RUN_TRANSCRIPT_ITEMS)).toMatchObject({
      type: "tool_started",
      localId: MAX_RUN_TRANSCRIPT_ITEMS + 1,
    });
    expect(observations.at(MAX_RUN_TRANSCRIPT_ITEMS + 1)).toMatchObject({
      type: "tool_finished",
      localId: MAX_RUN_TRANSCRIPT_ITEMS + 2,
    });
    expect(observations.at(MAX_RUN_TRANSCRIPT_ITEMS + 2)).toMatchObject({
      type: "tool_finished",
      localId: 1,
    });
  });

  test("does not retain a raw tool id beyond the byte budget", () => {
    const observations: ChildObservation[] = [];
    const parser = createChildProtocolParser({
      observe: (item) => observations.push(item),
    });
    const oversizedId = `shared-prefix-${"x".repeat(MAX_RUN_TRANSCRIPT_BYTES)}`;

    for (const type of ["tool_execution_start", "tool_execution_end"]) {
      parser.processLine(
        JSON.stringify({
          type,
          toolCallId: oversizedId,
          toolName: "bash",
        }),
      );
    }

    expect(observations).toMatchObject([
      { type: "tool_started", localId: 1 },
      { type: "tool_finished", localId: 2 },
    ]);
  });

  test("reports malformed and oversized input without echoing it", () => {
    const observations: ChildObservation[] = [];
    const parser = createChildProtocolParser({
      observe: (item) => observations.push(item),
    });

    parser.processLine("SECRET malformed {");
    parser.oversizedLine();

    expect(observations).toEqual([
      { type: "protocol_warning", code: "malformed" },
      { type: "protocol_warning", code: "oversized" },
    ]);
    expect(JSON.stringify(observations)).not.toContain("SECRET");
  });

  test("contains observer failures", () => {
    const parser = createChildProtocolParser({
      observe: () => {
        throw new Error("observer failed");
      },
    });
    expect(() =>
      parser.processLine(
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
          },
        }),
      ),
    ).not.toThrow();
  });

  test("caps finalized text by UTF-8 bytes", () => {
    const observations: ChildObservation[] = [];
    const parser = createChildProtocolParser({
      observe: (item) => observations.push(item),
    });
    parser.processLine(
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "界".repeat(10_000) }],
        },
      }),
    );
    const final = observations[0];
    expect(final?.type).toBe("assistant_final");
    if (final?.type === "assistant_final") {
      expect(Buffer.byteLength(final.text, "utf8")).toBeLessThanOrEqual(
        MAX_ASSISTANT_ITEM_BYTES,
      );
      expect(final.text).not.toContain("�");
    }
  });
});

describe("terminal-safe text helpers", () => {
  test("strips ANSI, OSC, C0, C1 and DEL", () => {
    expect(
      stripTerminalControls(
        "\u001b]2;title\u0007a\u001b[31mb\u001b[0m\u0000\u007f\u009b32mc\u009b0m",
      ),
    ).toBe("abc");
  });

  test("keeps byte caps smaller than the truncation suffix", () => {
    expect(capUtf8("abcdef", 1)).toBe("a");
    expect(capUtf8("界", 2)).toBe("");
    for (const maxBytes of [0, 1, 2]) {
      expect(
        Buffer.byteLength(capUtf8("abcdef", maxBytes), "utf8"),
      ).toBeLessThanOrEqual(maxBytes);
    }
  });

  test("caps and wraps CJK and emoji without exceeding width", () => {
    expect(capUtf8("😀😀😀", 8)).toBe("😀…");
    expect(visibleWidth("a界😀")).toBe(5);
    expect(truncateToWidth("a界😀z", 5)).toBe("a界…");
    const wrapped = wrapPlainText("a界😀z", 3);
    expect(wrapped).toEqual(["a界", "😀z"]);
    expect(wrapped.every((line) => visibleWidth(line) <= 3)).toBe(true);
  });
});
