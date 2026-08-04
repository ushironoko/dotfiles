const RESTRICTED_CHILD_TOOLS_ENV = "PI_HARNESS_RESTRICTED_TOOLS";
const RESTRICTED_CHILD_HEARTH_GRAPH_ENV = "PI_HARNESS_RESTRICTED_HEARTH_GRAPH";
const RESTRICTED_CHILD_BUILTINS_ENV = "PI_HARNESS_RESTRICTED_BUILTINS";

const RESTRICTED_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
]);

const usesRestrictedChildTools = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => env[RESTRICTED_CHILD_TOOLS_ENV] === "1";

const restrictedBuiltinTools = (tools: readonly string[] | undefined): string =>
  (tools ?? [])
    .filter((tool) => RESTRICTED_BUILTIN_TOOL_NAMES.has(tool))
    .join(",");

export {
  RESTRICTED_CHILD_BUILTINS_ENV,
  RESTRICTED_CHILD_HEARTH_GRAPH_ENV,
  RESTRICTED_CHILD_TOOLS_ENV,
  restrictedBuiltinTools,
  usesRestrictedChildTools,
};
