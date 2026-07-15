import { isAbsolute, resolve } from "node:path";
import type {
  ToolResultContentBlock,
  ToolResultEvent,
  ToolResultPatch,
} from "../../lib/pi-like";
import type { BridgeHookSpec } from "./registry";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const selectMatchingSpecs = (
  registry: BridgeHookSpec[],
  stage: BridgeHookSpec["stage"],
  toolName?: string,
): BridgeHookSpec[] =>
  registry.filter((spec) => {
    if (spec.stage !== stage) return false;
    if (spec.matcher === undefined) return true;
    if (toolName === undefined) return false;
    return new RegExp(spec.matcher.source, spec.matcher.flags).test(toolName);
  });

/**
 * Absolute location of the file a mapped Write/Edit/MultiEdit invocation
 * targets, for per-target trust checks. Returns undefined when the
 * invocation carries no file_path (non-file tools).
 */
export const readTargetFilePath = (
  toolInput: Record<string, unknown>,
  cwd: string,
): string | undefined => {
  const filePath = toolInput.file_path;
  if (typeof filePath !== "string" || filePath === "") return undefined;
  return isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
};

export const readToolResultInput = (
  event: ToolResultEvent,
): Record<string, unknown> => {
  const { input } = event;
  return isRecord(input) ? input : {};
};

export const joinToolResultText = (
  content: ToolResultContentBlock[] | undefined,
): string =>
  (content ?? [])
    .flatMap((block) =>
      block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");

export const appendToolResultText = (
  original: ToolResultContentBlock[] | undefined,
  additions: string[],
): ToolResultPatch | undefined => {
  if (additions.length === 0) return undefined;
  return {
    content: [
      ...(original ?? []),
      ...additions.map((text) => ({ type: "text", text })),
    ],
  };
};
