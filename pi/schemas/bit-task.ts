/**
 * tskm source-of-truth for the bit-task tools' parameter schemas
 * (worktree_create / worktree_remove / task_completed).
 *
 * Compiled ahead-of-time by scripts/gen-pi-schemas.ts into
 * pi/extensions/pi-harness/features/bit-task/parameters.generated.ts. See
 * pi/schemas/subagent.ts for the passthrough / optional-outermost conventions.
 */
import {
  boolean,
  description,
  object,
  optional,
  pipe,
  string,
} from "@tskm/core";

const passthrough = { rest: "passthrough" } as const;

export const WorktreeCreateParameters = object(
  {
    name: pipe(string(), description("Branch name for the new worktree")),
  },
  passthrough,
);

export const WorktreeRemoveParameters = object(
  {
    path: pipe(string(), description("Absolute path of the linked worktree")),
    confirmed: pipe(
      boolean(),
      description("True only after the user explicitly approved removal"),
    ),
  },
  passthrough,
);

export const TaskCompletedParameters = object(
  {
    task_id: pipe(string(), description("Stable task compatibility id")),
    task_subject: optional(
      pipe(string(), description("Human-readable completed task subject")),
    ),
  },
  passthrough,
);
