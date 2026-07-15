/**
 * Contract guard for the typebox → tskm AOT schema migration.
 *
 * The tool parameter schemas moved from inline typebox to plain JSON Schema
 * objects compiled ahead-of-time from pi/schemas/. These tests pin the
 * model-facing contract so a regenerate can never silently drop a description,
 * change a required-key set, lose a maxItems bound, or close an object.
 *
 * Three layers:
 *  1. Equivalence to the pre-migration typebox output (golden baseline) modulo
 *     documented, behaviorally-benign representation differences.
 *  2. The exact registered schema shape (inline snapshot).
 *  3. Acceptance/rejection through pi's REAL validator (validateToolArguments),
 *     so we test what pi actually enforces, not a re-implementation. This
 *     imports pi-ai's validator; it is version-coupled to the pinned pi
 *     (0.80.6, drift-checked) by design.
 */
import { describe, expect, test } from "bun:test";
// pi's own tool-argument validator (the plain-JSON-Schema coercion path, since
// the generated schemas carry no TypeBox Kind symbol).
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import setupBitTask from "../../pi/extensions/pi-harness/features/bit-task/index";
import setupSubagent from "../../pi/extensions/pi-harness/features/subagent/index";
import setupWorkflow from "../../pi/extensions/pi-harness/features/workflow/index";
import setupAskUserQuestion from "../../pi/extensions/pi-harness/features/ask-user-question/index";
import type { ToolDefLike } from "../../pi/extensions/pi-harness/lib/pi-like";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi } from "./fake-pi";
import typeboxBaseline from "./__fixtures__/typebox-baseline.json";

const makeConfig = (): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": true,
    subagent: true,
    workflow: true,
    "bit-task": true,
    statusline: true,
    "provider-log": false,
    "asuku-notify": true,
    "ask-user-question": true,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths("/tmp/pi-schema-contract-home"),
});

/** Registered tools by name, captured through the real registration path. */
const registeredTools = (): Map<string, ToolDefLike> => {
  const pi = createFakePi();
  setupSubagent(pi, makeConfig());
  setupBitTask(pi, makeConfig());
  setupWorkflow(pi, makeConfig());
  setupAskUserQuestion(pi);
  return new Map(pi.tools.map((tool) => [tool.name, tool]));
};

const parametersOf = (name: string): unknown => {
  const tool = registeredTools().get(name);
  if (tool === undefined) throw new Error(`tool not registered: ${name}`);
  return tool.parameters;
};

/**
 * Canonicalize away the three documented, behaviorally-benign differences
 * between the old typebox JSON output and the tskm emitter output, so the rest
 * of the contract (descriptions, required sets, maxItems, nesting) can be
 * compared exactly:
 *  - N1: tskm passthrough emits `additionalProperties: true`; typebox omits it.
 *        Both keep the object OPEN under pi's validator, so drop the key.
 *  - N2: tskm emits `required: []` for all-optional objects; typebox omits it.
 *  - N3: tskm literal members are `{const}`; typebox is `{type:"string",const}`.
 *        Drop `type` on const-bearing nodes.
 */
const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (key === "additionalProperties") continue;
      if (
        key === "required" &&
        Array.isArray(source[key]) &&
        (source[key] as unknown[]).length === 0
      ) {
        continue;
      }
      if (key === "type" && "const" in source) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
};

const baseline = typeboxBaseline as Record<string, unknown>;

describe("schema contract: equivalence to typebox baseline", () => {
  for (const toolName of Object.keys(baseline)) {
    test(`${toolName} matches the pre-migration schema (modulo N1/N2/N3)`, () => {
      expect(canonicalize(parametersOf(toolName))).toEqual(
        canonicalize(baseline[toolName]),
      );
    });
  }

  test("every field description survives the migration", () => {
    // Collect all description strings from a schema tree.
    const descriptions = (value: unknown): string[] => {
      if (Array.isArray(value)) return value.flatMap(descriptions);
      if (value !== null && typeof value === "object") {
        const source = value as Record<string, unknown>;
        const here =
          typeof source.description === "string" ? [source.description] : [];
        return here.concat(Object.values(source).flatMap(descriptions));
      }
      return [];
    };
    for (const toolName of Object.keys(baseline)) {
      const expected = descriptions(baseline[toolName]).sort();
      const actual = descriptions(parametersOf(toolName)).sort();
      expect(actual).toEqual(expected);
    }
  });
});

describe("schema contract: registered shape (snapshot)", () => {
  test("worktree_remove parameters", () => {
    expect(parametersOf("worktree_remove")).toMatchInlineSnapshot(`
      {
        "additionalProperties": true,
        "properties": {
          "confirmed": {
            "description": "True only after the user explicitly approved removal",
            "type": "boolean",
          },
          "path": {
            "description": "Absolute path of the linked worktree",
            "type": "string",
          },
        },
        "required": [
          "path",
          "confirmed",
        ],
        "type": "object",
      }
    `);
  });

  test("AskUserQuestion preserves Claude cardinalities and optional preview", () => {
    expect(parametersOf("AskUserQuestion")).toMatchInlineSnapshot(`
      {
        "additionalProperties": true,
        "properties": {
          "questions": {
            "description": "One to four questions to ask in a single call",
            "items": {
              "additionalProperties": true,
              "properties": {
                "header": {
                  "description": "Short label for the question",
                  "type": "string",
                },
                "multiSelect": {
                  "description": "Whether the user may select multiple options",
                  "type": "boolean",
                },
                "options": {
                  "description": "Choices presented to the user; Other is added automatically",
                  "items": {
                    "additionalProperties": true,
                    "properties": {
                      "description": {
                        "description": "Explanation shown alongside the option",
                        "type": "string",
                      },
                      "label": {
                        "description": "Display label for the option",
                        "type": "string",
                      },
                      "preview": {
                        "description": "Optional preview associated with selecting the option",
                        "type": "string",
                      },
                    },
                    "required": [
                      "label",
                      "description",
                    ],
                    "type": "object",
                  },
                  "maxItems": 4,
                  "minItems": 2,
                  "type": "array",
                },
                "question": {
                  "description": "The complete question to ask",
                  "type": "string",
                },
              },
              "required": [
                "question",
                "header",
                "multiSelect",
                "options",
              ],
              "type": "object",
            },
            "maxItems": 4,
            "minItems": 1,
            "type": "array",
          },
        },
        "required": [
          "questions",
        ],
        "type": "object",
      }
    `);
  });

  test("workflow stage mode is an anyOf of const literals", () => {
    const params = parametersOf("workflow") as Record<string, unknown>;
    const stages = (params.properties as Record<string, unknown>)
      .stages as Record<string, unknown>;
    const items = stages.items as Record<string, unknown>;
    const mode = (items.properties as Record<string, unknown>).mode;
    expect(mode).toMatchInlineSnapshot(`
      {
        "anyOf": [
          {
            "const": "fanout",
          },
          {
            "const": "single",
          },
        ],
      }
    `);
  });
});

describe("schema contract: pi validator accepts/rejects (real path)", () => {
  // pi's validator is typed for TypeBox schemas; the generated schemas are
  // plain JSON Schema objects it also supports at runtime, so cast to the
  // validator's own parameter types rather than couple to TypeBox internals.
  type ValidateArgs = Parameters<typeof validateToolArguments>;
  const validate = (name: string, args: unknown): unknown =>
    validateToolArguments(
      {
        name,
        description: "",
        parameters: parametersOf(name),
      } as ValidateArgs[0],
      { name, arguments: args } as ValidateArgs[1],
    );

  test("accepts valid arguments", () => {
    expect(validate("worktree_create", { name: "feat/x" })).toMatchObject({
      name: "feat/x",
    });
  });

  test("rejects missing required arguments", () => {
    expect(() => validate("worktree_create", {})).toThrow();
    expect(() => validate("worktree_remove", { path: "/a" })).toThrow();
    expect(() => validate("workflow", {})).toThrow();
  });

  test("accepts extra keys at root and nested levels (passthrough keeps objects open)", () => {
    expect(() =>
      validate("worktree_create", { name: "feat/x", stray: 1 }),
    ).not.toThrow();
    expect(() =>
      validate("workflow", {
        stages: [{ mode: "fanout", tasks: [{ task: "t", extra: true }] }],
      }),
    ).not.toThrow();
  });

  test("preserves the boolean the worktree_remove security gate depends on", () => {
    // The handler gates removal on `params.confirmed === true` (strict), so the
    // validator must return confirmed as a real boolean, not coerce it away.
    const result = validate("worktree_remove", {
      path: "/abs/wt",
      confirmed: true,
    }) as Record<string, unknown>;
    expect(result.confirmed).toBe(true);
  });

  test("enforces the stage-task maxItems bound", () => {
    const tooMany = Array.from({ length: 9 }, () => ({ task: "t" }));
    expect(() =>
      validate("workflow", { stages: [{ mode: "fanout", tasks: tooMany }] }),
    ).toThrow();
  });

  test("validates the AskUserQuestion compatibility contract", () => {
    const option = { label: "A", description: "first", preview: "preview" };
    const validQuestion = {
      question: "Choose?",
      header: "a header longer than twelve characters",
      multiSelect: false,
      options: [option, { label: "B", description: "second" }],
      futureQuestionField: true,
    };

    expect(() =>
      validate("AskUserQuestion", {
        questions: [validQuestion],
        futureRootField: true,
      }),
    ).not.toThrow();
    expect(() => validate("AskUserQuestion", { questions: [] })).toThrow();
    expect(() =>
      validate("AskUserQuestion", {
        questions: Array.from({ length: 5 }, () => validQuestion),
      }),
    ).toThrow();
    expect(() =>
      validate("AskUserQuestion", {
        questions: [{ ...validQuestion, options: [option] }],
      }),
    ).toThrow();
    expect(() =>
      validate("AskUserQuestion", {
        questions: [
          {
            ...validQuestion,
            options: Array.from({ length: 5 }, () => option),
          },
        ],
      }),
    ).toThrow();
  });
});
