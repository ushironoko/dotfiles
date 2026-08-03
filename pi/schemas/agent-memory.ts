import {
  description,
  literal,
  maxLength,
  object,
  optional,
  pipe,
  string,
  union,
} from "@tskm/core";

const passthrough = { rest: "passthrough" } as const;

export const MemoryRecallParameters = object(
  {
    action: pipe(
      union([literal("list"), literal("show"), literal("sessions")]),
      description("Aggregated read operation"),
    ),
    path: optional(
      pipe(
        string(),
        maxLength(256),
        description("Logical project-memory path required by show"),
      ),
    ),
  },
  passthrough,
);

export const MemoryUpdateParameters = object(
  {
    action: pipe(
      union([literal("put"), literal("remove")]),
      description("Session-scoped memory mutation"),
    ),
    path: pipe(
      string(),
      maxLength(256),
      description("Logical project-memory path"),
    ),
    description: optional(
      pipe(
        string(),
        maxLength(512),
        description("One-line index description required by put"),
      ),
    ),
    content: optional(
      pipe(
        string(),
        maxLength(32 * 1024),
        description("Markdown data required by put"),
      ),
    ),
  },
  passthrough,
);
