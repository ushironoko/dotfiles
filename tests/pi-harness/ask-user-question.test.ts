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

const tempDirectories: string[] = [];

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

const setup = (options: { hasUI?: boolean } = {}): FakePi => {
  const pi = createFakePi(options);
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

  test("toggles multi-select choices collision-safely and emits schema order", async () => {
    const pi = setup();
    // Select option label "Done", then option label "Other", deselect "Done",
    // then select the adapter's Done action.
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
    expect(pi.selectDialogs[0]?.options).toHaveLength(3);
    expect(pi.selectDialogs.at(-1)?.options).toHaveLength(4);
  });

  test("combines selected multi options with a custom Other answer", async () => {
    const pi = setup();
    pi.queueSelectIndex(0);
    pi.queueSelectIndex(2);
    pi.queueInput("Keep logs for 30 days");
    pi.queueSelectIndex(3);

    const result = await execute(pi, [question({ multiSelect: true })]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Safe, Keep logs for 30 days",
    });
    expect(result.details.annotations).toEqual({});
    expect(result.content[0]?.text).toContain(
      '"Which path should we take?"="Safe, Keep logs for 30 days"',
    );
  });

  test("emits multi-select labels and previews in schema order", async () => {
    const pi = setup();
    pi.queueSelectIndex(2);
    pi.queueSelectIndex(0);
    pi.queueSelectIndex(4);
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
    pi.queueSelectIndex(2);
    pi.queueInput("temporary note");
    pi.queueSelectIndex(2);
    pi.queueInput("   ");
    pi.queueSelectIndex(0);
    pi.queueSelectIndex(3);

    const result = await execute(pi, [question({ multiSelect: true })]);

    expect(result.details.answers).toEqual({
      "Which path should we take?": "Safe",
    });
    expect(result.details.annotations).toEqual({});
    expect(pi.selectDialogs[2]?.options).toHaveLength(3);
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
