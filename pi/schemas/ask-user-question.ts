/**
 * tskm source-of-truth for the Claude-compatible AskUserQuestion parameters.
 *
 * Compiled ahead-of-time by scripts/gen-pi-schemas.ts. Every object remains
 * open so newer Claude fields can pass through without making pi-harness
 * unusable; the fields implemented by the adapter are described explicitly.
 */
import {
  array,
  boolean,
  description,
  maxLength,
  minLength,
  object,
  optional,
  pipe,
  string,
} from "@tskm/core";

const passthrough = { rest: "passthrough" } as const;

const QuestionOptionParameters = object(
  {
    label: pipe(string(), description("Display label for the option")),
    description: pipe(
      string(),
      description("Explanation shown alongside the option"),
    ),
    preview: optional(
      pipe(
        string(),
        description("Optional preview associated with selecting the option"),
      ),
    ),
  },
  passthrough,
);

const QuestionParameters = object(
  {
    question: pipe(string(), description("The complete question to ask")),
    header: pipe(string(), description("Short label for the question")),
    multiSelect: pipe(
      boolean(),
      description("Whether the user may select multiple options"),
    ),
    options: pipe(
      array(QuestionOptionParameters),
      minLength(2),
      maxLength(4),
      description(
        "Choices presented to the user; Other is added automatically",
      ),
    ),
  },
  passthrough,
);

export const AskUserQuestionParameters = object(
  {
    questions: pipe(
      array(QuestionParameters),
      minLength(1),
      maxLength(4),
      description("One to four questions to ask in a single call"),
    ),
  },
  passthrough,
);
