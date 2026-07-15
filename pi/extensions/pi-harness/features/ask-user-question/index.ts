import type { CtxLike, PiLike } from "../../lib/pi-like";
import { AskUserQuestionParameters } from "./parameters.generated";

interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
  [key: string]: unknown;
}

interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
  [key: string]: unknown;
}

interface AskUserQuestionInput {
  questions: Question[];
  [key: string]: unknown;
}

interface QuestionAnswer {
  value: string;
  labels: string[];
  preview?: string;
  notes?: string;
}

interface AnswerAnnotation {
  preview?: string;
  notes?: string;
}

interface OtherInputResult {
  submitted: boolean;
  value?: string;
}

interface AbortEventSignal {
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

type MultiSelectAction = "submit" | "other" | "cancel" | "aborted";

interface MultiSelectState {
  selectedIndices: Set<number>;
  cursorIndex: number;
  otherText?: string;
}

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

interface TuiLike {
  readonly terminal?: { readonly rows: number };
  requestRender(): void;
}

interface ThemeLike {
  fg(
    color: "accent" | "success" | "error" | "warning" | "muted" | "dim",
    text: string,
  ): string;
}

interface CustomComponentLike {
  render(width: number): string[];
  invalidate(): void;
  handleInput?(data: string): void;
  dispose?(): void;
}

type CustomUiFactory<T> = (
  tui: TuiLike,
  theme: ThemeLike,
  keybindings: KeybindingsLike,
  done: (result: T) => void,
) => CustomComponentLike | Promise<CustomComponentLike>;

type AskUiLike = CtxLike["ui"] & {
  custom?<T>(factory: CustomUiFactory<T>): Promise<T>;
};

interface AskCtxLike extends CtxLike {
  mode?: "tui" | "rpc" | "json" | "print";
  ui: AskUiLike;
}

const OTHER_ACTION =
  "Other — type, edit, or submit empty text to clear a custom answer";
const DONE_ACTION = "Done — submit these selections";
const KITTY_CODEPOINT_PATTERN =
  /^\[(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::(\d+))?u$/;
const KITTY_ARROW_PATTERN = /^\[1;(\d+)(?::(\d+))?([AB])$/;
const KITTY_LOCK_MODIFIER_MASK = 64 | 128;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asAbortEventSignal = (
  signal: AbortSignal | undefined,
): AbortEventSignal | undefined => {
  if (!isRecord(signal)) return undefined;
  const add = signal.addEventListener;
  const remove = signal.removeEventListener;
  return typeof add === "function" && typeof remove === "function"
    ? (signal as unknown as AbortEventSignal)
    : undefined;
};

const requireParameters = (params: unknown): AskUserQuestionInput => {
  if (!isRecord(params) || !Array.isArray(params.questions)) {
    throw new Error("AskUserQuestion requires a questions array");
  }
  if (params.questions.length < 1 || params.questions.length > 4) {
    throw new Error("AskUserQuestion requires between one and four questions");
  }

  for (const [questionIndex, rawQuestion] of params.questions.entries()) {
    if (
      !isRecord(rawQuestion) ||
      typeof rawQuestion.question !== "string" ||
      typeof rawQuestion.header !== "string" ||
      typeof rawQuestion.multiSelect !== "boolean" ||
      !Array.isArray(rawQuestion.options)
    ) {
      throw new Error(
        `AskUserQuestion question ${questionIndex + 1} has invalid fields`,
      );
    }
    if (rawQuestion.options.length < 2 || rawQuestion.options.length > 4) {
      throw new Error(
        `AskUserQuestion question ${questionIndex + 1} requires two to four options`,
      );
    }
    const labels = new Set<string>();
    for (const [optionIndex, rawOption] of rawQuestion.options.entries()) {
      if (
        !isRecord(rawOption) ||
        typeof rawOption.label !== "string" ||
        typeof rawOption.description !== "string" ||
        (rawOption.preview !== undefined &&
          typeof rawOption.preview !== "string")
      ) {
        throw new Error(
          `AskUserQuestion question ${questionIndex + 1} option ${optionIndex + 1} has invalid fields`,
        );
      }
      if (labels.has(rawOption.label)) {
        throw new Error(
          `AskUserQuestion question ${questionIndex + 1} has duplicate option label: ${sanitizeForMenu(rawOption.label)}`,
        );
      }
      labels.add(rawOption.label);
    }
  }

  return params as AskUserQuestionInput;
};

const ensureNotAborted = (signal: AbortSignal | undefined): void => {
  if (signal !== undefined && "aborted" in signal && signal.aborted === true) {
    throw new Error("AskUserQuestion aborted");
  }
};

const consumeCsi = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 64 && code <= 126) return index + 1;
  }
  return value.length;
};

const consumeControlString = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 7 || code === 156) return index + 1;
    if (
      value[index] === "\u001b" &&
      index + 1 < value.length &&
      value[index + 1] === "\\"
    ) {
      return index + 2;
    }
  }
  return value.length;
};

const stripTerminalControls = (
  value: string,
  lineFeedReplacement: string,
): string => {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (value[index] === "\u001b") {
      const next = value[index + 1];
      if (next === "[") {
        index = consumeCsi(value, index + 2);
      } else if (
        next === "]" ||
        next === "P" ||
        next === "X" ||
        next === "^" ||
        next === "_"
      ) {
        index = consumeControlString(value, index + 2);
      } else {
        index += index + 1 < value.length ? 2 : 1;
      }
      continue;
    }
    if (code === 155) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (
      code === 157 ||
      code === 144 ||
      code === 152 ||
      code === 158 ||
      code === 159
    ) {
      index = consumeControlString(value, index + 1);
      continue;
    }
    if (value[index] === "\n") {
      output += lineFeedReplacement;
      index += 1;
      continue;
    }
    if (code <= 31 || (code >= 127 && code <= 159)) {
      index += 1;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return output;
};

const sanitizeForMenu = (value: string): string =>
  stripTerminalControls(value, " / ").trim();

const sanitizeForResult = (value: string): string =>
  stripTerminalControls(value, "\n");

const hasOnlyKittyLockModifiers = (encodedModifier: number): boolean =>
  ((encodedModifier - 1) & ~KITTY_LOCK_MODIFIER_MASK) === 0;

const isKittyCodepoint = (data: string, expectedCodepoint: number): boolean => {
  if (!data.startsWith("\u001b")) return false;
  const match = KITTY_CODEPOINT_PATTERN.exec(data.slice(1));
  if (match === null) return false;
  const encodedModifier = match[2] === undefined ? 1 : Number(match[2]);
  const event = match[3] === undefined ? 1 : Number(match[3]);
  return (
    hasOnlyKittyLockModifiers(encodedModifier) &&
    event !== 3 &&
    Number(match[1]) === expectedCodepoint
  );
};

const isArrowKey = (data: string, direction: "up" | "down"): boolean => {
  const final = direction === "up" ? "A" : "B";
  const keypadCodepoint = direction === "up" ? 57_419 : 57_420;
  if (data === `\u001b[${final}` || data === `\u001bO${final}`) return true;
  const match = data.startsWith("\u001b")
    ? KITTY_ARROW_PATTERN.exec(data.slice(1))
    : null;
  if (match !== null) {
    const event = match[2] === undefined ? 1 : Number(match[2]);
    return (
      hasOnlyKittyLockModifiers(Number(match[1])) &&
      event !== 3 &&
      match[3] === final
    );
  }
  return isKittyCodepoint(data, keypadCodepoint);
};

const isSpaceKey = (data: string): boolean =>
  data === " " || isKittyCodepoint(data, 32);

const isEnterKey = (data: string): boolean =>
  data === "\r" ||
  data === "\n" ||
  data === "\u001bOM" ||
  isKittyCodepoint(data, 13) ||
  isKittyCodepoint(data, 57_414);

const isEscapeKey = (data: string): boolean =>
  data === "\u001b" || data === "\u0003" || isKittyCodepoint(data, 27);

const terminalCellWidth = (character: string): number => {
  const codepoint = character.codePointAt(0) ?? 0;
  if (
    (codepoint >= 768 && codepoint <= 879) ||
    (codepoint >= 65_024 && codepoint <= 65_039)
  ) {
    return 0;
  }
  return codepoint <= 126 ? 1 : 2;
};

const wrapForWidth = (value: string, width: number): string[] => {
  if (width <= 0) return [""];
  const lines: string[] = [];
  let current = "";
  let used = 0;
  for (const character of value) {
    const characterWidth = terminalCellWidth(character);
    if (used + characterWidth > width && current !== "") {
      lines.push(current);
      current = "";
      used = 0;
    }
    if (characterWidth <= width) {
      current += character;
      used += characterWidth;
    }
  }
  lines.push(current);
  return lines;
};

const optionLine = (
  option: QuestionOption,
  index: number,
  selected: boolean | undefined,
): string => {
  let mark = "";
  if (selected !== undefined) mark = selected ? "[x] " : "[ ] ";
  const label = sanitizeForMenu(option.label);
  const description = sanitizeForMenu(option.description);
  const preview =
    option.preview === undefined
      ? ""
      : ` | Preview: ${sanitizeForMenu(option.preview)}`;
  return `${mark}${index + 1}. ${label} — ${description}${preview}`;
};

const questionTitle = (question: Question): string =>
  `${sanitizeForMenu(question.header)}: ${sanitizeForMenu(question.question)}`;

const usesPreviewMode = (question: Question): boolean =>
  question.options.some((option) => option.preview !== undefined);

const askForOther = async (
  question: Question,
  signal: AbortSignal | undefined,
  ctx: CtxLike,
): Promise<OtherInputResult> => {
  ensureNotAborted(signal);
  const answer = await ctx.ui.input(
    `${sanitizeForMenu(question.header)}: Other`,
    "Type your answer or notes; submit empty text to clear",
    { signal },
  );
  ensureNotAborted(signal);
  if (answer === undefined) return { submitted: false };
  const value = answer.trim();
  return value === "" ? { submitted: true } : { submitted: true, value };
};

const askSingle = async (
  question: Question,
  signal: AbortSignal | undefined,
  ctx: CtxLike,
): Promise<QuestionAnswer> => {
  const choices = [
    ...question.options.map((option, index) =>
      optionLine(option, index, undefined),
    ),
    OTHER_ACTION,
  ];

  while (true) {
    ensureNotAborted(signal);
    const selected = await ctx.ui.select(questionTitle(question), choices, {
      signal,
    });
    ensureNotAborted(signal);
    if (selected === undefined) {
      throw new Error("AskUserQuestion cancelled by the user");
    }

    const selectedIndex = choices.indexOf(selected);
    if (selectedIndex === -1) {
      throw new Error("AskUserQuestion received an unknown selection");
    }
    if (selectedIndex < question.options.length) {
      const option = question.options[selectedIndex];
      return {
        value: option.label,
        labels: [option.label],
        preview: option.preview,
      };
    }

    const other = await askForOther(question, signal, ctx);
    if (!other.submitted || other.value === undefined) continue;
    if (usesPreviewMode(question)) {
      return { value: "(notes only)", labels: [], notes: other.value };
    }
    return { value: other.value, labels: [other.value] };
  }
};

const buildMultipleAnswer = (
  question: Question,
  selectedIndices: ReadonlySet<number>,
  otherText: string | undefined,
): QuestionAnswer => {
  const orderedOptions = question.options.filter((_option, index) =>
    selectedIndices.has(index),
  );
  const labels = orderedOptions.map((option) => option.label);
  const previewMode = usesPreviewMode(question);
  if (!previewMode && otherText !== undefined) labels.push(otherText);
  const previews = orderedOptions
    .map((option) => option.preview)
    .filter((preview): preview is string => preview !== undefined);
  return {
    value: labels.length === 0 ? "(notes only)" : labels.join(", "),
    labels,
    preview: previews.length === 0 ? undefined : previews.join("\n\n"),
    notes: previewMode ? otherText : undefined,
  };
};

const askMultipleWithDialogs = async (
  question: Question,
  signal: AbortSignal | undefined,
  ctx: CtxLike,
): Promise<QuestionAnswer> => {
  const selectedIndices = new Set<number>();
  let otherText: string | undefined;

  while (true) {
    ensureNotAborted(signal);
    const canSubmit = selectedIndices.size > 0 || otherText !== undefined;
    const choices = [
      ...question.options.map((option, index) =>
        optionLine(option, index, selectedIndices.has(index)),
      ),
      OTHER_ACTION,
      ...(canSubmit ? [DONE_ACTION] : []),
    ];
    const selected = await ctx.ui.select(
      `${questionTitle(question)} (select all that apply)`,
      choices,
      { signal },
    );
    ensureNotAborted(signal);
    if (selected === undefined) {
      throw new Error("AskUserQuestion cancelled by the user");
    }

    const selectedIndex = choices.indexOf(selected);
    if (selectedIndex === -1) {
      throw new Error("AskUserQuestion received an unknown selection");
    }
    if (selectedIndex < question.options.length) {
      if (selectedIndices.has(selectedIndex)) {
        selectedIndices.delete(selectedIndex);
      } else {
        selectedIndices.add(selectedIndex);
      }
      continue;
    }
    if (selectedIndex === question.options.length) {
      const other = await askForOther(question, signal, ctx);
      if (other.submitted) otherText = other.value;
      continue;
    }
    if (canSubmit && selectedIndex === question.options.length + 1) {
      return buildMultipleAnswer(question, selectedIndices, otherText);
    }
    throw new Error("AskUserQuestion received an unknown selection");
  }
};

const showTuiMultiSelect = async (
  question: Question,
  state: MultiSelectState,
  signal: AbortSignal | undefined,
  ctx: AskCtxLike,
): Promise<MultiSelectAction> => {
  if (ctx.ui.custom === undefined) {
    throw new Error("AskUserQuestion multi-select TUI is unavailable");
  }

  return ctx.ui.custom<MultiSelectAction>((tui, theme, keybindings, done) => {
    const eventSignal = asAbortEventSignal(signal);
    let settled = false;
    let cachedWidth: number | undefined;
    let cachedRows: number | undefined;
    let cachedLines: string[] | undefined;
    let manualViewportStart: number | undefined;
    let lastViewportStart = 0;
    let lastContentRows = 1;

    const finish = (action: MultiSelectAction): void => {
      if (settled) return;
      settled = true;
      eventSignal?.removeEventListener("abort", abort);
      done(action);
    };
    const abort = (): void => finish("aborted");
    eventSignal?.addEventListener("abort", abort, { once: true });

    const refresh = (): void => {
      cachedWidth = undefined;
      cachedRows = undefined;
      cachedLines = undefined;
      tui.requestRender();
    };

    const handleInput = (data: string): void => {
      const optionCount = question.options.length;
      const itemCount = optionCount + 1;
      if (isSpaceKey(data)) {
        if (state.cursorIndex === optionCount) {
          finish("other");
          return;
        }
        if (state.selectedIndices.has(state.cursorIndex)) {
          state.selectedIndices.delete(state.cursorIndex);
        } else {
          state.selectedIndices.add(state.cursorIndex);
        }
        refresh();
        return;
      }
      if (isEnterKey(data)) {
        if (state.selectedIndices.size > 0 || state.otherText !== undefined) {
          finish("submit");
        }
        return;
      }
      if (isEscapeKey(data)) {
        finish("cancel");
        return;
      }
      if (
        isArrowKey(data, "up") ||
        keybindings.matches(data, "tui.select.up")
      ) {
        state.cursorIndex = Math.max(0, state.cursorIndex - 1);
        manualViewportStart = undefined;
        refresh();
        return;
      }
      if (
        isArrowKey(data, "down") ||
        keybindings.matches(data, "tui.select.down")
      ) {
        state.cursorIndex = Math.min(itemCount - 1, state.cursorIndex + 1);
        manualViewportStart = undefined;
        refresh();
        return;
      }
      if (keybindings.matches(data, "tui.select.pageUp")) {
        manualViewportStart = Math.max(0, lastViewportStart - lastContentRows);
        refresh();
        return;
      }
      if (keybindings.matches(data, "tui.select.pageDown")) {
        manualViewportStart = lastViewportStart + lastContentRows;
        refresh();
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm")) {
        if (state.selectedIndices.size > 0 || state.otherText !== undefined) {
          finish("submit");
        }
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) {
        finish("cancel");
      }
    };

    const render = (width: number): string[] => {
      const terminalRows = tui.terminal?.rows ?? 24;
      if (
        cachedWidth === width &&
        cachedRows === terminalRows &&
        cachedLines !== undefined
      ) {
        return cachedLines;
      }
      const contentLines = wrapForWidth(
        `${questionTitle(question)} (select all that apply)`,
        width,
      ).map((line) => theme.fg("accent", line));
      contentLines.push("");
      let activeLine = contentLines.length;
      for (const [index, option] of question.options.entries()) {
        const cursor = state.cursorIndex === index ? "> " : "  ";
        const content = `${cursor}${optionLine(
          option,
          index,
          state.selectedIndices.has(index),
        )}`;
        if (state.cursorIndex === index) activeLine = contentLines.length;
        contentLines.push(
          ...wrapForWidth(content, width).map((line) =>
            state.cursorIndex === index ? theme.fg("accent", line) : line,
          ),
        );
      }
      const otherSelected = state.otherText !== undefined;
      const otherCursor = state.cursorIndex === question.options.length;
      const otherContent = `${otherCursor ? "> " : "  "}${
        otherSelected ? "[x]" : "[ ]"
      } ${OTHER_ACTION}${otherSelected ? " (set)" : ""}`;
      if (otherCursor) activeLine = contentLines.length;
      contentLines.push(
        ...wrapForWidth(otherContent, width).map((line) =>
          otherCursor ? theme.fg("accent", line) : line,
        ),
      );

      const maxRows = Math.max(1, terminalRows - 2);
      const allHelpLines = wrapForWidth(
        "↑↓ move • Space toggle/edit • Enter done • Esc cancel • PgUp/PgDn scroll",
        width,
      ).map((line) => theme.fg("dim", line));
      const helpRows =
        maxRows < 3
          ? 0
          : Math.min(allHelpLines.length, Math.max(1, Math.floor(maxRows / 3)));
      const helpLines = allHelpLines.slice(0, helpRows);
      const separatorRows = helpRows > 0 && maxRows - helpRows > 1 ? 1 : 0;
      const contentRows = Math.max(1, maxRows - helpRows - separatorRows);
      const maxStart = Math.max(0, contentLines.length - contentRows);
      const automaticStart = Math.min(
        maxStart,
        Math.max(0, activeLine - Math.floor(contentRows / 2)),
      );
      const viewportStart = Math.min(
        maxStart,
        Math.max(0, manualViewportStart ?? automaticStart),
      );
      lastViewportStart = viewportStart;
      lastContentRows = contentRows;
      const lines = contentLines.slice(
        viewportStart,
        viewportStart + contentRows,
      );
      if (separatorRows > 0) lines.push("");
      lines.push(...helpLines);
      cachedWidth = width;
      cachedRows = terminalRows;
      cachedLines = lines;
      return lines;
    };

    return {
      render,
      handleInput,
      invalidate: () => {
        cachedWidth = undefined;
        cachedRows = undefined;
        cachedLines = undefined;
      },
      dispose: () => eventSignal?.removeEventListener("abort", abort),
    };
  });
};

const askMultipleInTui = async (
  question: Question,
  signal: AbortSignal | undefined,
  ctx: AskCtxLike,
): Promise<QuestionAnswer> => {
  const state: MultiSelectState = {
    selectedIndices: new Set<number>(),
    cursorIndex: 0,
  };

  while (true) {
    ensureNotAborted(signal);
    const action = await showTuiMultiSelect(question, state, signal, ctx);
    ensureNotAborted(signal);
    if (action === "cancel") {
      throw new Error("AskUserQuestion cancelled by the user");
    }
    if (action === "aborted") {
      throw new Error("AskUserQuestion aborted");
    }
    if (action === "other") {
      const other = await askForOther(question, signal, ctx);
      if (other.submitted) state.otherText = other.value;
      continue;
    }
    return buildMultipleAnswer(
      question,
      state.selectedIndices,
      state.otherText,
    );
  }
};

const askMultiple = async (
  question: Question,
  signal: AbortSignal | undefined,
  ctx: AskCtxLike,
): Promise<QuestionAnswer> =>
  ctx.mode === "tui"
    ? askMultipleInTui(question, signal, ctx)
    : askMultipleWithDialogs(question, signal, ctx);

const annotationFor = (
  answer: QuestionAnswer,
): AnswerAnnotation | undefined => {
  const annotation: AnswerAnnotation = {};
  if (answer.preview !== undefined) annotation.preview = answer.preview;
  if (answer.notes !== undefined) annotation.notes = answer.notes;
  return Object.keys(annotation).length === 0 ? undefined : annotation;
};

const resultSegment = (question: Question, answer: QuestionAnswer): string => {
  const safeQuestion = sanitizeForResult(question.question);
  const safeValue = sanitizeForResult(answer.value);
  let segment =
    answer.labels.length === 0
      ? `"${safeQuestion}"=(no option selected)`
      : `"${safeQuestion}"="${safeValue}"`;
  if (answer.preview !== undefined) {
    segment += ` selected preview:\n${sanitizeForResult(answer.preview)}`;
  }
  if (answer.notes !== undefined) {
    segment += ` notes: ${sanitizeForResult(answer.notes)}`;
  }
  return segment;
};

const setupAskUserQuestion = (pi: PiLike): void => {
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask User Question",
    description:
      "Ask the user one to four blocking questions with single- or multi-select options. Call this tool alone and wait for its result before generating dependent tool calls.",
    promptSnippet:
      "Ask one to four blocking questions with Claude-compatible options",
    promptGuidelines: [
      "Always call AskUserQuestion alone; wait for the answers before generating any dependent tool calls.",
      "Use AskUserQuestion when a skill explicitly requests it or a blocking choice cannot be inferred from the repository.",
    ],
    executionMode: "sequential",
    parameters: AskUserQuestionParameters,
    async execute(
      _toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: CtxLike,
    ) {
      const input = requireParameters(params);
      ensureNotAborted(signal);
      if (!ctx.hasUI) {
        throw new Error(
          "AskUserQuestion interactive UI is unavailable; ask the user directly in conversation instead",
        );
      }

      const seen = new Set<string>();
      for (const item of input.questions) {
        if (seen.has(item.question)) {
          throw new Error(
            `AskUserQuestion duplicate question text cannot be represented in answers: ${sanitizeForMenu(item.question)}`,
          );
        }
        seen.add(item.question);
      }

      const answered: { question: Question; answer: QuestionAnswer }[] = [];
      for (const item of input.questions) {
        const answer = item.multiSelect
          ? await askMultiple(item, signal, ctx as AskCtxLike)
          : await askSingle(item, signal, ctx);
        answered.push({ question: item, answer });
      }

      const answers = Object.fromEntries(
        answered.map(({ question: item, answer }) => [
          item.question,
          answer.value,
        ]),
      );
      const annotations = Object.fromEntries(
        answered.flatMap(({ question: item, answer }) => {
          const annotation = annotationFor(answer);
          return annotation === undefined
            ? []
            : ([[item.question, annotation]] as const);
        }),
      );
      const summary = answered
        .map(({ question: item, answer }) => resultSegment(item, answer))
        .join(", ");

      return {
        content: [
          {
            type: "text",
            text: `Your questions have been answered: ${summary}. You can now continue with these answers in mind.`,
          },
        ],
        details: {
          questions: input.questions,
          answers,
          annotations,
        },
      };
    },
  });
};

export default setupAskUserQuestion;
