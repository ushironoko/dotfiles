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
import { ChildRunRegistry } from "../../pi/extensions/pi-harness/features/child-runs/registry";
import { setupChildRunStatusTool } from "../../pi/extensions/pi-harness/features/child-runs/status-tool";
import setupSubagent from "../../pi/extensions/pi-harness/features/subagent/index";
import { MAX_PARALLEL_TASKS } from "../../pi/extensions/pi-harness/features/subagent/limits";
import setupWorkflow from "../../pi/extensions/pi-harness/features/workflow/index";
import {
  MAX_STAGE_TASKS,
  MAX_WORKFLOW_TASKS,
} from "../../pi/extensions/pi-harness/features/workflow/plan";
import setupAskUserQuestion from "../../pi/extensions/pi-harness/features/ask-user-question/index";
import setupAgentMemory from "../../pi/extensions/pi-harness/features/agent-memory/index";
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
  setupChildRunStatusTool(pi, new ChildRunRegistry());
  setupBitTask(pi, makeConfig());
  setupWorkflow(pi, makeConfig());
  setupAskUserQuestion(pi);
  setupAgentMemory(pi, makeConfig());
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
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const canonicalize = (
  value: unknown,
  context: "schema" | "schema-map" | "literal" = "schema",
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, context));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value);
    if (
      typeof value.description === "string" &&
      !keys.includes("description")
    ) {
      keys.push("description");
    }
    for (const key of keys.sort()) {
      if (context === "schema") {
        if (
          key === "additionalProperties" &&
          value.type === "object" &&
          value[key] === true
        ) {
          continue;
        }
        if (
          key === "required" &&
          Array.isArray(value[key]) &&
          value[key].length === 0
        ) {
          continue;
        }
        if (
          key === "type" &&
          value.type === "string" &&
          typeof value.const === "string"
        ) {
          continue;
        }
      }
      let childContext: typeof context = "literal";
      if (context === "schema-map") {
        childContext = "schema";
      } else if (context === "schema") {
        if (
          [
            "properties",
            "patternProperties",
            "$defs",
            "definitions",
            "dependentSchemas",
          ].includes(key)
        ) {
          childContext = "schema-map";
        } else if (
          [
            "items",
            "prefixItems",
            "additionalItems",
            "additionalProperties",
            "unevaluatedItems",
            "unevaluatedProperties",
            "contains",
            "propertyNames",
            "anyOf",
            "allOf",
            "oneOf",
            "not",
            "if",
            "then",
            "else",
            "contentSchema",
          ].includes(key)
        ) {
          childContext = "schema";
        }
      }
      Object.defineProperty(out, key, {
        value: canonicalize(value[key], childContext),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return value;
};

describe("schema contract: local comparison oracle qualification", () => {
  test("preserves inherited string descriptions", () => {
    const input = {
      __proto__: { description: "inherited description" },
      type: "string",
    };
    expect(canonicalize(input)).toEqual({
      type: "string",
      description: "inherited description",
    });
  });

  test("preserves non-enumerable own string descriptions", () => {
    const input = Object.defineProperty({ type: "string" }, "description", {
      value: "non-enumerable description",
      enumerable: false,
    });
    expect(canonicalize(input)).toEqual({
      type: "string",
      description: "non-enumerable description",
    });
  });

  test("preserves own __proto__ schema-map properties", () => {
    const actual = canonicalize({
      type: "object",
      properties: {
        ["__proto__"]: {
          type: "string",
          const: "special",
          description: "special property",
        },
      },
    });
    expect(actual).toEqual({
      type: "object",
      properties: {
        ["__proto__"]: { const: "special", description: "special property" },
      },
    });
    if (!isRecord(actual) || !isRecord(actual.properties)) {
      throw new Error("canonical properties are not an object");
    }
    expect(
      Object.getOwnPropertyDescriptor(actual.properties, "__proto__"),
    ).toEqual({
      value: { const: "special", description: "special property" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.getPrototypeOf(actual.properties)).toBe(Object.prototype);
  });

  test("preserves own __proto__ literal data", () => {
    const actual = canonicalize({
      const: {
        ["__proto__"]: {
          type: "string",
          const: "special",
          additionalProperties: true,
          required: [],
        },
      },
    });
    expect(actual).toEqual({
      const: {
        ["__proto__"]: {
          type: "string",
          const: "special",
          additionalProperties: true,
          required: [],
        },
      },
    });
    if (!isRecord(actual) || !isRecord(actual.const)) {
      throw new Error("canonical const is not an object");
    }
    expect(Object.getOwnPropertyDescriptor(actual.const, "__proto__")).toEqual({
      value: {
        type: "string",
        const: "special",
        additionalProperties: true,
        required: [],
      },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.getPrototypeOf(actual.const)).toBe(Object.prototype);
  });

  test.each([
    {
      name: "documented equivalents at nested schema paths",
      input: {
        type: "object",
        additionalProperties: true,
        required: [],
        properties: {
          mode: { type: "string", const: "single", description: "mode" },
          nested: { type: "object", additionalProperties: true, required: [] },
        },
      },
      expected: {
        type: "object",
        properties: {
          mode: { const: "single", description: "mode" },
          nested: { type: "object" },
        },
      },
    },
    {
      name: "already omitted equivalents",
      input: { type: "object", properties: { mode: { const: "single" } } },
      expected: { type: "object", properties: { mode: { const: "single" } } },
    },
    {
      name: "keyword-named real properties",
      input: {
        type: "object",
        properties: {
          type: { type: "string" },
          const: { type: "string" },
          additionalProperties: { type: "boolean" },
          required: { type: "array", items: { type: "string" } },
        },
      },
      expected: {
        type: "object",
        properties: {
          type: { type: "string" },
          const: { type: "string" },
          additionalProperties: { type: "boolean" },
          required: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "schema-map names and literal object values",
      input: {
        $defs: {
          type: { type: "string", const: "x" },
          const: { type: "number" },
        },
        patternProperties: { additionalProperties: { type: "string" } },
        const: {
          type: "string",
          const: "x",
          additionalProperties: true,
          required: [],
        },
      },
      expected: {
        $defs: { type: { const: "x" }, const: { type: "number" } },
        patternProperties: { additionalProperties: { type: "string" } },
        const: {
          type: "string",
          const: "x",
          additionalProperties: true,
          required: [],
        },
      },
    },
    {
      name: "openness outside an object schema",
      input: { additionalProperties: true },
      expected: { additionalProperties: true },
    },
  ])("preserves $name", ({ input, expected }) => {
    expect(canonicalize(input)).toEqual(expected);
  });

  test.each([
    {
      name: "nested description moved to its parent",
      input: { type: "array", description: "item", items: { type: "string" } },
      expected: {
        type: "array",
        items: { type: "string", description: "item" },
      },
    },
    {
      name: "same-multiset sibling descriptions swapped",
      input: {
        type: "object",
        properties: { a: { description: "B" }, b: { description: "A" } },
      },
      expected: {
        type: "object",
        properties: { a: { description: "A" }, b: { description: "B" } },
      },
    },
    {
      name: "enum order changed",
      input: { enum: ["b", "a"] },
      expected: { enum: ["a", "b"] },
    },
    {
      name: "required order changed",
      input: { type: "object", required: ["b", "a"] },
      expected: { type: "object", required: ["a", "b"] },
    },
    {
      name: "nested schema array order changed",
      input: {
        type: "array",
        items: { anyOf: [{ const: "b" }, { const: "a" }] },
      },
      expected: {
        type: "array",
        items: { anyOf: [{ const: "a" }, { const: "b" }] },
      },
    },
    {
      name: "nested literal array order changed",
      input: {
        const: [
          [1, 2],
          [4, 3],
        ],
      },
      expected: {
        const: [
          [1, 2],
          [3, 4],
        ],
      },
    },
    {
      name: "closed root object",
      input: { type: "object", additionalProperties: false },
      expected: { type: "object" },
    },
    {
      name: "closed nested object",
      input: {
        type: "array",
        items: { type: "object", additionalProperties: false },
      },
      expected: { type: "array", items: { type: "object" } },
    },
    {
      name: "schema-valued openness",
      input: { type: "object", additionalProperties: { type: "string" } },
      expected: { type: "object" },
    },
    {
      name: "incompatible type with a string const",
      input: { type: "number", const: "single" },
      expected: { const: "single" },
    },
    {
      name: "string type with a non-string const",
      input: { type: "string", const: 1 },
      expected: { const: 1 },
    },
    {
      name: "undocumented numeric literal normalization",
      input: { type: "number", const: 1 },
      expected: { const: 1 },
    },
    {
      name: "nested cardinality changed",
      input: { type: "array", items: { type: "array", maxItems: 2 } },
      expected: { type: "array", items: { type: "array", maxItems: 3 } },
    },
  ])("distinguishes $name", ({ input, expected }) => {
    expect(canonicalize(input)).not.toEqual(expected);
  });
});

const baseline = typeboxBaseline as Record<string, unknown>;

// Keep the migration golden intact, then overlay intentional post-migration
// contract changes. This makes changed bounds explicit without weakening the
// exact comparison for every unaffected field.
const expectedSchemas = structuredClone(baseline);
const objectAt = (root: unknown, path: string[]): Record<string, unknown> => {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      throw new Error(
        `schema fixture path is not an object: ${path.join(".")}`,
      );
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === null || typeof current !== "object") {
    throw new Error(`schema fixture path is not an object: ${path.join(".")}`);
  }
  return current as Record<string, unknown>;
};
objectAt(expectedSchemas, ["subagent", "properties", "tasks"]).maxItems =
  MAX_PARALLEL_TASKS;
const expectedWorkflowStages = objectAt(expectedSchemas, [
  "workflow",
  "properties",
  "stages",
]);
expectedWorkflowStages.description = `Stages executed sequentially; at most ${MAX_WORKFLOW_TASKS} tasks in total`;
objectAt(expectedWorkflowStages, ["items", "properties", "tasks"]).maxItems =
  MAX_STAGE_TASKS;

describe("schema contract: equivalence to typebox baseline", () => {
  for (const toolName of Object.keys(expectedSchemas)) {
    test(`${toolName} matches the pre-migration schema (modulo N1/N2/N3)`, () => {
      expect(canonicalize(parametersOf(toolName))).toEqual(
        canonicalize(expectedSchemas[toolName]),
      );
    });
  }
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

  test("agent memory schemas preserve action boundaries and bounded fields", () => {
    expect(parametersOf("memory_recall")).toMatchInlineSnapshot(`
      {
        "additionalProperties": true,
        "properties": {
          "action": {
            "anyOf": [
              {
                "const": "list",
              },
              {
                "const": "show",
              },
              {
                "const": "sessions",
              },
            ],
            "description": "Aggregated read operation",
          },
          "path": {
            "description": "Logical project-memory path required by show",
            "maxLength": 256,
            "type": "string",
          },
        },
        "required": [
          "action",
        ],
        "type": "object",
      }
    `);
    const update = parametersOf("memory_update") as Record<string, unknown>;
    const properties = update.properties as Record<
      string,
      Record<string, unknown>
    >;
    expect(properties.path?.maxLength).toBe(256);
    expect(properties.description?.maxLength).toBe(512);
    expect(properties.content?.maxLength).toBe(32 * 1024);
  });

  test("subagent_status requires the invocation returned by an orchestrator", () => {
    expect(parametersOf("subagent_status")).toMatchInlineSnapshot(`
      {
        "additionalProperties": true,
        "properties": {
          "invocationId": {
            "description": "Invocation ID returned by subagent or workflow",
            "type": "string",
          },
        },
        "required": [
          "invocationId",
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
    const { mode } = items.properties as Record<string, unknown>;
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
    expect(() => validate("subagent_status", {})).toThrow();
    expect(() => validate("memory_recall", {})).toThrow();
    expect(() => validate("memory_update", { action: "put" })).toThrow();
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

  test("validates project-memory action literals and path bounds", () => {
    expect(
      validate("memory_recall", {
        action: "show",
        path: "project/architecture.md",
      }),
    ).toMatchObject({ action: "show" });
    expect(() => validate("memory_recall", { action: "search" })).toThrow();
    expect(() =>
      validate("memory_update", {
        action: "put",
        path: "x".repeat(257),
      }),
    ).toThrow();
  });

  test("accepts the invocation ID used by subagent_status", () => {
    expect(
      validate("subagent_status", { invocationId: "invocation-123" }),
    ).toMatchObject({ invocationId: "invocation-123" });
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

  test("accepts 30+ stage tasks and enforces the enlarged maxItems bound", () => {
    const largeFanout = Array.from({ length: 33 }, () => ({ task: "t" }));
    expect(() =>
      validate("workflow", {
        stages: [{ mode: "fanout", tasks: largeFanout }],
      }),
    ).not.toThrow();

    const tooMany = Array.from({ length: MAX_STAGE_TASKS + 1 }, () => ({
      task: "t",
    }));
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
