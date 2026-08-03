import { describe, expect, test } from "bun:test";
import {
  createAbortController,
  isAbortSignal,
  tryCreateAbortController,
} from "../../pi/extensions/pi-harness/lib/abort";

const structuralSignal = () => ({
  aborted: false,
  addEventListener: (_type: "abort", _listener: () => void): void => {},
  removeEventListener: (_type: "abort", _listener: () => void): void => {},
});

describe("shared Abort primitives", () => {
  test("accepts native and complete structural signals", () => {
    expect(isAbortSignal(createAbortController().signal)).toBe(true);
    expect(isAbortSignal(structuralSignal())).toBe(true);
  });

  test.each([
    ["undefined", undefined],
    ["null", null],
    ["primitive", false],
    ["missing aborted", { ...structuralSignal(), aborted: undefined }],
    [
      "missing addEventListener",
      { ...structuralSignal(), addEventListener: undefined },
    ],
    [
      "missing removeEventListener",
      { ...structuralSignal(), removeEventListener: undefined },
    ],
  ])("rejects malformed signals: %s", (_label, value) => {
    expect(isAbortSignal(value)).toBe(false);
  });

  test("creates a native controller and emits abort once", () => {
    const controller = createAbortController();
    let aborts = 0;
    controller.signal.addEventListener("abort", () => {
      aborts += 1;
    });

    controller.abort();
    controller.abort();

    expect(controller.signal.aborted).toBe(true);
    expect(aborts).toBe(1);
  });

  test("keeps the raw controller receiver when delegating abort", () => {
    const signal = structuralSignal();
    let rawController: {
      signal: ReturnType<typeof structuralSignal>;
      abort(): void;
    };
    rawController = {
      signal,
      abort() {
        if (this !== rawController) throw new Error("lost abort receiver");
        signal.aborted = true;
      },
    };

    const controller = createAbortController(() => rawController);
    controller.abort();

    expect(signal.aborted).toBe(true);
  });

  test("throws for malformed controllers but offers a graceful variant", () => {
    const malformed = () => ({ abort() {}, signal: {} });
    expect(() => createAbortController(malformed)).toThrow(
      "AbortController is unavailable",
    );
    expect(tryCreateAbortController(malformed)).toBeUndefined();
    expect(
      tryCreateAbortController(() => {
        throw new Error("constructor failed");
      }),
    ).toBeUndefined();
    expect(tryCreateAbortController()).toBeDefined();
  });
});
