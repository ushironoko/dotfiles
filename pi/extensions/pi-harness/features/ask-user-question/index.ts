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

const OTHER_ACTION =
  "Other — type, edit, or submit empty text to clear a custom answer";
const DONE_ACTION = "Done — submit these selections";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

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

const askMultiple = async (
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
    }
    throw new Error("AskUserQuestion received an unknown selection");
  }
};

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
          ? await askMultiple(item, signal, ctx)
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
