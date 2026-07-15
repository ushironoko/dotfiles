/**
 * tskm source-of-truth for the subagent tool's parameter schema.
 *
 * Compiled to JSON Schema ahead-of-time by scripts/gen-pi-schemas.ts and
 * committed as pi/extensions/pi-harness/features/subagent/parameters.generated.ts
 * (the extension imports the generated plain object, never tskm at runtime).
 *
 * Conventions that must hold for JSON-Schema parity with the previous typebox
 * definitions (see plans/wobbly-waddling-volcano.md):
 * - every object uses `{ rest: "passthrough" }` so it stays OPEN
 *   (additionalProperties: true) — models may send extra keys, as before.
 * - `optional(...)` is the OUTERMOST wrapper; tskm only drops a key from
 *   `required` when the entry's own top-level kind is optional. Writing
 *   `pipe(optional(string()), ...)` would silently make the field required.
 * - array bounds come from the shared limit module, never copied literals.
 */
import {
  array,
  description,
  maxLength,
  object,
  optional,
  pipe,
  string,
} from "@tskm/core";
import {
  MAX_CHAIN_DEPTH,
  MAX_PARALLEL_TASKS,
} from "../extensions/pi-harness/features/subagent/limits";

const passthrough = { rest: "passthrough" } as const;

const TaskItemSchema = object(
  {
    agent: pipe(string(), description("Name of the agent to invoke")),
    task: pipe(string(), description("Task to delegate to the agent")),
    cwd: optional(
      pipe(string(), description("Working directory for the agent process")),
    ),
  },
  passthrough,
);

const ChainItemSchema = object(
  {
    agent: pipe(string(), description("Name of the agent to invoke")),
    task: pipe(
      string(),
      description("Task with an optional {previous} placeholder"),
    ),
    cwd: optional(
      pipe(string(), description("Working directory for the agent process")),
    ),
  },
  passthrough,
);

export const SubagentParameters = object(
  {
    agent: optional(
      pipe(string(), description("Name of the agent for single mode")),
    ),
    task: optional(
      pipe(string(), description("Task to delegate for single mode")),
    ),
    tasks: optional(
      pipe(
        array(TaskItemSchema),
        maxLength(MAX_PARALLEL_TASKS),
        description("Tasks to run in parallel"),
      ),
    ),
    chain: optional(
      pipe(
        array(ChainItemSchema),
        maxLength(MAX_CHAIN_DEPTH),
        description("Tasks to run sequentially"),
      ),
    ),
    cwd: optional(
      pipe(string(), description("Working directory for single mode")),
    ),
  },
  passthrough,
);
