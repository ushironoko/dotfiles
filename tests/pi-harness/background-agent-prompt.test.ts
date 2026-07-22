import { describe, expect, test } from "bun:test";
import setupChildRuns from "../../pi/extensions/pi-harness/features/child-runs/index";
import type { PiLike } from "../../pi/extensions/pi-harness/lib/pi-like";

type RuntimeHandler = (
  event: unknown,
  ctx: unknown,
) => unknown | Promise<unknown>;

const createRuntime = (background: boolean) => {
  const handlers = new Map<string, RuntimeHandler[]>();
  const runtime = {
    on(event: string, handler: RuntimeHandler) {
      const registered = handlers.get(event) ?? [];
      registered.push(handler);
      handlers.set(event, registered);
    },
    registerCommand() {},
    registerShortcut() {},
    ...(background
      ? {
          appendEntry() {},
          sendMessage() {},
        }
      : {}),
  };

  return {
    pi: runtime as unknown as PiLike,
    async emit(event: string, payload: unknown): Promise<unknown> {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        const next = await handler(payload, {});
        if (next !== undefined) result = next;
      }
      return result;
    },
  };
};

describe("background-agent system prompt", () => {
  test("forbids active waiting when automatic completion delivery is available", async () => {
    const runtime = createRuntime(true);
    setupChildRuns(runtime.pi);

    const result = await runtime.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: "Base system prompt.",
    });

    const systemPrompt = (result as { systemPrompt?: unknown }).systemPrompt;
    expect(typeof systemPrompt).toBe("string");
    if (typeof systemPrompt !== "string") {
      throw new Error("background guidance did not return a system prompt");
    }
    expect(systemPrompt).toStartWith(
      "Base system prompt.\n\n## Background agent completion",
    );
    expect(systemPrompt).toContain("never use sleep");
    expect(systemPrompt).toContain(
      "Pi delivers completion automatically as a new message",
    );
    expect(systemPrompt).toContain("return control to Pi");

    await runtime.emit("session_shutdown", { type: "session_shutdown" });
  });

  test("omits asynchronous guidance for the synchronous fallback", async () => {
    const runtime = createRuntime(false);
    setupChildRuns(runtime.pi);

    const result = await runtime.emit("before_agent_start", {
      type: "before_agent_start",
      systemPrompt: "Base system prompt.",
    });

    expect(result).toBeUndefined();
    await runtime.emit("session_shutdown", { type: "session_shutdown" });
  });
});
