/**
 * tskm source-of-truth for the subagent_status tool parameter schema.
 *
 * Compiled to JSON Schema by scripts/gen-pi-schemas.ts. The registered tool
 * imports only the generated plain object so pi-harness has no runtime tskm
 * dependency.
 */
import { description, object, pipe, string } from "@tskm/core";

const passthrough = { rest: "passthrough" } as const;

export const SubagentStatusParameters = object(
  {
    invocationId: pipe(
      string(),
      description("Invocation ID returned by subagent or workflow"),
    ),
  },
  passthrough,
);
