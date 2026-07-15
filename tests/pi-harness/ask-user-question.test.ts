import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import {
  loadConfig,
  type HarnessConfig,
} from "../../pi/extensions/pi-harness/config";
import setupAskUserQuestion from "../../pi/extensions/pi-harness/features/ask-user-question/index";
import { setupHarness } from "../../pi/extensions/pi-harness/index";
import type {
  CtxLike,
  ToolDefLike,
} from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi, type FakePi } from "./fake-pi";

interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

interface AskResult {
  content: { type: string; text: string }[];
  details: {
    questions: Question[];
    answers: Record<string, string>;
    annotations: Record<
      string,
      {
        preview?: string;
        notes?: string;
      }
    >;
  };
}

type UiModeLike = "tui" | "rpc" | "json" | "print";
type SelectKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown"
  | "tui.select.confirm"
  | "tui.select.cancel";

interface KeybindingsLike {
  matches(data: string, keybinding: SelectKeybinding): boolean;
}

interface CustomComponentLike {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  dispose?(): void;
}

type CustomUiFactoryLike<T> = (
  tui: {
    terminal?: { rows: number };
    requestRender(): void;
  },
  theme: {
    fg(color: string, text: string): string;
  },
  keybindings: KeybindingsLike,
  done: (result: T) => void,
) => CustomComponentLike | Promise<CustomComponentLike>;

type AskUiLike = CtxLike["ui"] & {
  custom?<T>(factory: CustomUiFactoryLike<T>): Promise<T>;
};

interface AskCtxLike extends CtxLike {
  mode?: UiModeLike;
  ui: AskUiLike;
}

interface CustomDialog {
  keys: string[];
  renders: string[][];
}

type AskFakePi = FakePi & {
  readonly keybindings: KeybindingsLike;
  queueCustomKeys(...keys: string[]): void;
  readonly customDialogs: CustomDialog[];
  readonly ctx: AskCtxLike & { hasUI: boolean };
};

const tempDirectories: string[] = [];
const KEY_UP = "\u001b[A";
const KEY_DOWN = "\u001b[B";
const KEY_SPACE = " ";
const KEY_ENTER = "\r";
const KEY_ESCAPE = "\u001b";

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTestAbortSignal = (value: unknown): value is AbortSignal =>
  isRecord(value) &&
  typeof value.aborted === "boolean" &&
  typeof value.addEventListener === "function" &&
  typeof value.removeEventListener === "function";

const createTestAbortController = (): {
  signal: AbortSignal;
  abort(): void;
} => {
  const controller: unknown = new AbortController();
  if (
    !isRecord(controller) ||
    typeof controller.abort !== "function" ||
    !isTestAbortSignal(controller.signal)
  ) {
    throw new Error("AbortController is unavailable");
  }
  const { abort, signal } = controller;
  return {
    signal,
    abort: () => Reflect.apply(abort, controller, []),
  };
};

const question = (overrides: Partial<Question> = {}): Question => ({
  question: "Which path should we take?",
  header: "Path",
  multiSelect: false,
  options: [
    { label: "Safe", description: "Use the proven path" },
    { label: "Fast", description: "Optimize for speed" },
  ],
  ...overrides,
});

const getTool = (pi: FakePi): ToolDefLike => {
  const tool = pi.tools.find(
    (candidate) => candidate.name === "AskUserQuestion",
  );
  if (tool === undefined) throw new Error("AskUserQuestion was not registered");
  return tool;
};

const execute = async (
  pi: FakePi,
  questions: Question[],
  options: { signal?: AbortSignal; ctx?: CtxLike } = {},
): Promise<AskResult> => {
  const tool = getTool(pi);
  type ValidateArgs = Parameters<typeof validateToolArguments>;
  const validated = validateToolArguments(
    {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    } as ValidateArgs[0],
    {
      name: tool.name,
      arguments: { questions },
    } as unknown as ValidateArgs[1],
  );
  const result = await tool.execute(
    "ask-1",
    validated as never,
    options.signal,
    undefined,
    options.ctx ?? pi.ctx,
  );
  return result as AskResult;
};

const setup = (
  options: {
    hasUI?: boolean;
    mode?: UiModeLike;
    terminalRows?: number;
  } = {},
): AskFakePi => {
  const pi = createFakePi({ hasUI: options.hasUI }) as AskFakePi;
  const customQueue: { keys: string[] }[] = [];
  const customDialogs: CustomDialog[] = [];
  const keybindings: KeybindingsLike = {
    matches: (data, keybinding) => {
      if (keybinding === "tui.select.up") return data === KEY_UP;
      if (keybinding === "tui.select.down") return data === KEY_DOWN;
      if (keybinding === "tui.select.pageUp") return data === "\u001b[5~";
      if (keybinding === "tui.select.pageDown") return data === "\u001b[6~";
      if (keybinding === "tui.select.confirm") return data === KEY_ENTER;
      return data === KEY_ESCAPE || data === "\u0003";
    },
  };
  const tui = {
    terminal: { rows: options.terminalRows ?? 24 },
    requestRender: () => {},
  };
  const theme = { fg: (_color: string, text: string): string => text };

  pi.ctx.mode = options.mode ?? "tui";
  pi.ctx.ui.custom = async <T>(factory: CustomUiFactoryLike<T>): Promise<T> => {
    const queued = customQueue.shift() ?? { keys: [] };
    const dialog: CustomDialog = { keys: [...queued.keys], renders: [] };
    customDialogs.push(dialog);
    let settled = false;
    let result: T | undefined;
    const component = await factory(tui, theme, keybindings, (value) => {
      settled = true;
      result = value;
    });
    dialog.renders.push(component.render(120));
    for (const key of queued.keys) {
      if (settled) break;
      component.handleInput?.(key);
      dialog.renders.push(component.render(120));
    }
    component.dispose?.();
    if (!settled) {
      throw new Error("fake custom dialog did not receive a finishing key");
    }
    return result as T;
  };
  Object.assign(pi, {
    keybindings,
    queueCustomKeys: (...keys: string[]) => customQueue.push({ keys }),
    customDialogs,
  });
  setupAskUserQuestion(pi);
  return pi;
};

const makeConfig = (home: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": false,
    subagent: false,
    workflow: false,
    "bit-task": false,
    statusline: false,
    "provider-log": false,
    "asuku-notify": false,
    "ask-user-question": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(home),
});

describe("pi-harness AskUserQuestion registration", () => {
  test("registers the exact Claude tool name as a sequential call-alone tool", () => {
    const tool = getTool(setup());

    expect(tool.name).toBe("AskUserQuestion");
    expect(tool.executionMode).toBe("sequential");
    expect(tool.promptGuidelines?.join("\n")).toContain(
      "call AskUserQuestion alone",
    );
  });
});

describe("pi-harness AskUserQuestion answers", () => {
  test("returns Claude-compatible text and details for one selection", async () => {
    const pi = setup();
    pi.queueSelectIndex(0);
    const input = question();

    const result = await execute(pi, [input]);

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: 'Your questions have been answered: "Which path should we take?"="Safe". You can now continue with these answers in mind.',
        },
      ],
      details: {
        questions: [input],
        answers: { "Which path should we take?": "Safe" },
        annotations: {},
      },
    });
    expect(pi.selectDialogs[0]?.options[0]).toContain("Safe");
    expect(pi.selectDialogs[0]?.options[0]).toContain("Use the proven path");
  });

  test("preserves a selected preview in annotations and result text", async () => {
    const pi = setup();
    pi.queueSelectIndex(1);
    const input = question({
      options: [
        { label: "Safe", description: "Use the proven path" },
        {
          label: "Fast",
          description: "Optimize for speed",
          preview: "bun test\nbun run tsc",
        },
      ],
    });

    const result = await execute(pi, [input]);

    expect(result.content[0]?.text).toBe(
      'Your questions have been answered: "Which path should we take?"="Fast" selected preview:\nbun test\nbun run tsc. You can now continue with these answers in mind.',
    );
    expect(result.details.annotations).toEqual({
      "Which path should we take?": { preview: "bun test\nbun run tsc" },
    });
    expect(pi.selectDialogs[0]?.options[1]).toContain("bun test / bun run tsc");
  });

  test("strips ANSI, OSC, C0, C1, and DEL controls from every model-facing UI field", async () => {
    const pi = setup();
    pi.queueSelectIndex(0);
    const oscTitle = "\u001b]2;spoofed-title\u0007";
    const csiRed = "\u001b[31m";
    const csiReset = "\u001b[0m";
    const c1Red = "\u009b31m";
    const c1Reset = "\u009b0m";
    const oscLinkStart = "\u001b]8;;https://example.invalid\u001b\\";
    const oscLinkEnd = "\u001b]8;;\u001b\\";
    const input = question({
      question: `${oscTitle}Question\u007f`,
      header: `${c1Red}Header${c1Reset}`,
      options: [
        {
          label: `${csiRed}Label${csiReset}`,
          description: `${oscTitle}Description\u0000`,
          preview: `${oscLinkStart}Preview${oscLinkEnd}`,
        },
        { label: "Other option", description: "plain" },
      ],
    });

    const result = await execute(pi, [input]);

    expect(pi.selectDialogs[0]?.title).toBe("Header: Question");
    expect(pi.selectDialogs[0]?.options[0]).toBe(
      "1. Label — Description | Preview: Preview",
    );
    expect(pi.selectDialogs[0]?.options[1]).toBe("2. Other option — plain");
    expect(result.content[0]?.text).toBe(
      'Your questions have been answered: "Question"="Label" selected preview:\nPreview. You can now continue with these answers in mind.',
    );
    // The compatibility details retain the original model arguments; only
    // terminal-facing strings are sanitized.
    expect(result.details.questions).toEqual([input]);
  });

  test("sanitizes the Other input title and returned custom text", async () => {
    const pi = setup();
    pi.queueSelectIndex(2);
    const hostileAnswer = "\u001b]2;spoofed-title\u0007Safe note";
    pi.queueInput(hostileAnswer);
    const input = question({ header: "\u001b[31mHeader\u001b[0m" });

    const result = await execute(pi, [input]);

    expect(pi.inputDialogs[0]?.title).toBe("Header: Other");
    expect(result.content[0]?.text).toBe(
      'Your questions have been answered: "Which path should we take?"="Safe note". You can now continue with these answers in mind.',
    );
    expect(result.details.answers).toEqual({
      "Which path should we take?": hostileAnswer,
    });
  });

  test("returns Other text as the answer for a question without previews", async () => {
    const pi = setup();
    pi.queueSelectIndex(2);
    pi.queueInput("Use a staged rollout");

    const result = await execute(pi, [question()]);

    expect(result.content[0]?.text).toBe(
      'Your questions have been answered: "Which path should we take?"="Use a staged rollout". You can now continue with these answers in mind.',
    );
    expect(result.details.answers).toEqual({
      "Which path should we take?": "Use a staged rollout",
    });
    expect(result.details.annotations).toEqual({});
  });

  test("returns Other text as Claude-style notes in preview mode", async () => {
    const pi = setup();
    pi.queueSelectIndex(2);
    pi.queueInput("Use a staged rollout");
    const input = question({
      options: [
        {
          label: "Safe",
          description: "Use the proven path",
          preview: "bun test",
        },
        { label: "Fast", description: "Optimize for speed" },
      ],
    });

    const result = await execute(pi, [input]);

    expect(result.content[0]?.text).toBe(
      'Your questions have been answered: "Which path should we take?"=(no option selected) notes: Use a staged rollout. You can now continue with these answers in mind.',
    );
    expect(result.details.answers).toEqual({
      "Which path should we take?": "(notes only)",
    });
    expect(result.details.annotations).toEqual({
      "Which path should we take?": { notes: "Use a staged rollout" },
    });
  });

  test("returns to selection when Other input is cancelled or empty", async () => {
    const pi = setup();
    pi.queueSelectIndex(2);
    pi.queueInput(undefined);
    pi.queueSelectIndex(2);
    pi.queueInput("   ");
    pi.queueSelectIndex(1);

    const result = await execute(pi, [question()]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Fast",
    });
    expect(pi.selectDialogs).toHaveLength(3);
    expect(pi.inputDialogs).toHaveLength(2);
  });

  test("toggles multi-select choices with Space without moving the cursor", async () => {
    const pi = setup();
    pi.queueCustomKeys(
      KEY_DOWN,
      KEY_SPACE,
      KEY_UP,
      KEY_SPACE,
      KEY_DOWN,
      KEY_SPACE,
      KEY_ENTER,
    );
    const input = question({
      multiSelect: true,
      options: [
        { label: "Other", description: "A real option named Other" },
        { label: "Done", description: "A real option named Done" },
      ],
    });

    const result = await execute(pi, [input]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Other",
    });
    expect(pi.selectDialogs).toHaveLength(0);
    expect(pi.customDialogs).toHaveLength(1);
    expect(pi.customDialogs[0]?.renders[2]).toContain(
      "> [x] 2. Done — A real option named Done",
    );
  });

  test("honors remapped selector navigation and confirmation keys", async () => {
    const pi = setup();
    pi.keybindings.matches = (data, keybinding) =>
      (keybinding === "tui.select.down" && data === "j") ||
      (keybinding === "tui.select.confirm" && data === "y") ||
      (keybinding === "tui.select.cancel" && data === "q");
    pi.queueCustomKeys("j", KEY_SPACE, "y");

    const result = await execute(pi, [question({ multiSelect: true })]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Fast",
    });
  });

  test("keeps fixed Space and Enter usable when remapped bindings conflict", async () => {
    const pi = setup();
    pi.keybindings.matches = (data, keybinding) =>
      keybinding === "tui.select.confirm" && data === KEY_SPACE;
    pi.queueCustomKeys(KEY_SPACE, KEY_ENTER);

    const result = await execute(pi, [question({ multiSelect: true })]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Safe",
    });
  });

  test("accepts Kitty navigation, Space, and Enter with lock modifiers", async () => {
    const pi = setup();
    pi.queueCustomKeys("\u001b[1;65B", "\u001b[32;65u", "\u001b[13;65u");

    const result = await execute(pi, [question({ multiSelect: true })]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Fast",
    });
  });

  test("wraps long multi-select content without dropping its tail", async () => {
    const pi = setup();
    pi.queueCustomKeys(KEY_SPACE, KEY_ENTER);
    const tail = "TAIL-MUST-STAY-VISIBLE";
    const input = question({
      multiSelect: true,
      options: [
        {
          label: "Long",
          description: `${"detail ".repeat(30)}${tail}`,
        },
        {
          label: "Huge inactive option",
          description: "offscreen detail ".repeat(500),
        },
      ],
    });

    await execute(pi, [input]);

    const initialRender = pi.customDialogs[0]?.renders[0];
    expect(initialRender?.join("")).toContain(tail);
    expect(
      initialRender?.some((line) => line.startsWith("> [ ] 1. Long —")),
    ).toBe(true);
    expect(initialRender?.length).toBeLessThanOrEqual(22);
  });

  test("keeps the active option visible in a short terminal", async () => {
    const pi = setup({ terminalRows: 5 });
    pi.queueCustomKeys(KEY_SPACE, KEY_ENTER);
    const input = question({
      multiSelect: true,
      options: [
        { label: "Visible", description: "active choice" },
        {
          label: "Huge inactive option",
          description: "offscreen detail ".repeat(500),
        },
      ],
    });

    await execute(pi, [input]);

    const initialRender = pi.customDialogs[0]?.renders[0];
    expect(initialRender?.length).toBeLessThanOrEqual(3);
    expect(
      initialRender?.some((line) => line.startsWith("> [ ] 1. Visible —")),
    ).toBe(true);
  });

  test("combines selected multi options with a custom Other answer", async () => {
    const pi = setup();
    pi.queueCustomKeys(KEY_SPACE, KEY_DOWN, KEY_DOWN, KEY_SPACE);
    pi.queueInput("Keep logs for 30 days");
    pi.queueCustomKeys(KEY_ENTER);

    const result = await execute(pi, [question({ multiSelect: true })]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Safe, Keep logs for 30 days",
    });
    expect(result.details.annotations).toEqual({});
    expect(result.content[0]?.text).toContain(
      '"Which path should we take?"="Safe, Keep logs for 30 days"',
    );
    expect(pi.customDialogs[1]?.renders[0]).toContain(
      "> [x] Other — type, edit, or submit empty text to clear a custom answer (set)",
    );
  });

  test("emits multi-select labels and previews in schema order", async () => {
    const pi = setup();
    pi.queueCustomKeys(
      KEY_DOWN,
      KEY_DOWN,
      KEY_SPACE,
      KEY_UP,
      KEY_UP,
      KEY_SPACE,
      KEY_ENTER,
    );
    const input = question({
      multiSelect: true,
      options: [
        { label: "First", description: "one", preview: "preview one" },
        { label: "Second", description: "two" },
        { label: "Third", description: "three", preview: "preview three" },
      ],
    });

    const result = await execute(pi, [input]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "First, Third",
    });
    expect(result.details.annotations).toEqual({
      "Which path should we take?": {
        preview: "preview one\n\npreview three",
      },
    });
    expect(result.content[0]?.text).toContain(
      '"Which path should we take?"="First, Third" selected preview:\npreview one\n\npreview three',
    );
  });

  test("allows multi-select Other text to be cleared before submission", async () => {
    const pi = setup();
    pi.queueCustomKeys(KEY_DOWN, KEY_DOWN, KEY_SPACE);
    pi.queueInput("temporary note");
    pi.queueCustomKeys(KEY_SPACE);
    pi.queueInput("   ");
    pi.queueCustomKeys(KEY_UP, KEY_UP, KEY_SPACE, KEY_ENTER);

    const result = await execute(pi, [question({ multiSelect: true })]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Safe",
    });
    expect(result.details.annotations).toEqual({});
    expect(pi.customDialogs).toHaveLength(3);
    expect(pi.customDialogs[2]?.renders[0]).toContain(
      "> [ ] Other — type, edit, or submit empty text to clear a custom answer",
    );
  });

  test("keeps the portable selector flow for RPC multi-select", async () => {
    const pi = setup({ mode: "rpc" });
    pi.queueSelectIndex(1);
    pi.queueSelectIndex(0);
    pi.queueSelectIndex(1);
    pi.queueSelectIndex(3);
    const input = question({
      multiSelect: true,
      options: [
        { label: "Other", description: "A real option named Other" },
        { label: "Done", description: "A real option named Done" },
      ],
    });

    const result = await execute(pi, [input]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Other",
    });
    expect(pi.customDialogs).toHaveLength(0);
    expect(pi.selectDialogs[0]?.options).toHaveLength(3);
    expect(pi.selectDialogs.at(-1)?.options).toHaveLength(4);
  });

  test("asks multiple questions sequentially", async () => {
    const pi = setup();
    pi.queueSelectIndex(0);
    pi.queueSelectIndex(1);
    const inputs = [
      question(),
      question({ question: "Which mode?", header: "Mode" }),
    ];

    const result = await execute(pi, inputs);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Safe",
      "Which mode?": "Fast",
    });
    expect(pi.selectDialogs).toHaveLength(2);
  });
});

describe("pi-harness AskUserQuestion termination", () => {
  test("throws on main-selector cancellation and discards partial answers", async () => {
    const pi = setup();
    pi.queueSelectIndex(0);
    pi.queueSelectIndex(undefined);

    await expect(
      execute(pi, [question(), question({ question: "Second?" })]),
    ).rejects.toThrow("cancelled by the user");
  });

  test.each([KEY_ESCAPE, "\u0003"])(
    "cancels a TUI multi-select with a configured cancel key",
    async (key) => {
      const pi = setup();
      pi.queueCustomKeys(key);

      await expect(
        execute(pi, [question({ multiSelect: true })]),
      ).rejects.toThrow("cancelled by the user");
    },
  );

  test("throws before opening UI when already aborted", async () => {
    const pi = setup();
    const controller = createTestAbortController();
    controller.abort();

    await expect(
      execute(pi, [question()], { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(pi.selectDialogs).toHaveLength(0);
  });

  test("passes the signal to dialogs and distinguishes an in-dialog abort", async () => {
    const pi = setup();
    const controller = createTestAbortController();
    let observed: AbortSignal | undefined;
    pi.ctx.ui.select = async (_title, _options, dialogOptions) => {
      observed = dialogOptions?.signal;
      controller.abort();
      return undefined;
    };

    await expect(
      execute(pi, [question()], { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(observed).toBe(controller.signal);
  });

  test("closes a TUI multi-select when its signal aborts", async () => {
    const pi = setup();
    const controller = createTestAbortController();
    pi.ctx.ui.custom = async <T>(
      factory: CustomUiFactoryLike<T>,
    ): Promise<T> => {
      let answer: T | undefined;
      const component = await factory(
        { requestRender: () => {} },
        { fg: (_color, text) => text },
        pi.keybindings,
        (value) => {
          answer = value;
        },
      );
      controller.abort();
      component.dispose?.();
      if (answer === undefined) throw new Error("custom dialog did not close");
      return answer;
    };

    await expect(
      execute(pi, [question({ multiSelect: true })], {
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });

  test("passes the signal to Other input and distinguishes its abort", async () => {
    const pi = setup();
    const controller = createTestAbortController();
    let observed: AbortSignal | undefined;
    pi.queueSelectIndex(2);
    pi.ctx.ui.input = async (_title, _placeholder, dialogOptions) => {
      observed = dialogOptions?.signal;
      controller.abort();
      return undefined;
    };

    await expect(
      execute(pi, [question()], { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(observed).toBe(controller.signal);
  });

  test("throws without opening a dialog when UI is unavailable", async () => {
    const pi = setup({ hasUI: false });

    await expect(execute(pi, [question()])).rejects.toThrow(
      "interactive UI is unavailable",
    );
    expect(pi.selectDialogs).toHaveLength(0);
  });

  test("rejects duplicate question text before opening UI", async () => {
    const pi = setup();

    await expect(execute(pi, [question(), question()])).rejects.toThrow(
      "duplicate question text",
    );
    expect(pi.selectDialogs).toHaveLength(0);
  });

  test.each([false, true])(
    "rejects duplicate option labels before opening UI (multiSelect=%s)",
    async (multiSelect) => {
      const pi = setup();
      const input = question({
        multiSelect,
        options: [
          { label: "Same", description: "first meaning" },
          { label: "Same", description: "second meaning" },
        ],
      });

      await expect(execute(pi, [input])).rejects.toThrow(
        "duplicate option label",
      );
      expect(pi.selectDialogs).toHaveLength(0);
    },
  );

  test("rejects an unknown UI response", async () => {
    const pi = setup();
    pi.ctx.ui.select = async () => "not one of the rendered choices";

    await expect(execute(pi, [question()])).rejects.toThrow(
      "unknown selection",
    );
  });
});

describe("pi-harness AskUserQuestion configuration", () => {
  test("is on for parents, overrideable off, and forced off for children", async () => {
    const home = await mkdtemp(join(tmpdir(), "pi-ask-config-"));
    tempDirectories.push(home);
    const paths = resolvePaths(home);

    expect(loadConfig({}, paths).features["ask-user-question"]).toBe(true);

    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      paths.localConfigFile,
      JSON.stringify({ features: { "ask-user-question": false } }),
    );
    expect(loadConfig({}, paths).features["ask-user-question"]).toBe(false);

    await writeFile(
      paths.localConfigFile,
      JSON.stringify({ features: { "ask-user-question": true } }),
    );
    expect(
      loadConfig({ PI_HARNESS_CHILD: "1" }, paths).features[
        "ask-user-question"
      ],
    ).toBe(false);
  });

  test("umbrella composition follows the feature toggle", () => {
    const enabled = createFakePi();
    setupHarness(enabled, makeConfig("/tmp/pi-ask-enabled"));
    expect(enabled.tools.map((tool) => tool.name)).toEqual(["AskUserQuestion"]);

    const disabled = createFakePi();
    const config = makeConfig("/tmp/pi-ask-disabled");
    config.features["ask-user-question"] = false;
    setupHarness(disabled, config);
    expect(disabled.tools).toHaveLength(0);
  });
});
