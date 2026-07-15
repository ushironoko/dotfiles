import { capUtf8, stripTerminalControls } from "../../lib/terminal-text";
import {
  MAX_ASSISTANT_ITEM_BYTES,
  MAX_LIVE_DRAFT_BYTES,
  type ChildObservation,
} from "./model";

export interface LegacyMessageProjection {
  text?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface ChildProtocolParser {
  processLine(line: string): LegacyMessageProjection | undefined;
  oversizedLine(): void;
}

interface ProtocolOptions {
  observe?: (observation: ChildObservation) => void;
  now?: () => number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getString = (
  primary: Record<string, unknown>,
  secondary: Record<string, unknown> | undefined,
  key: string,
): string | undefined => {
  const primaryValue = primary[key];
  if (typeof primaryValue === "string") return primaryValue;
  const secondaryValue = secondary?.[key];
  return typeof secondaryValue === "string" ? secondaryValue : undefined;
};

const textParts = (message: Record<string, unknown> | undefined): string[] => {
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((part) => {
    if (
      !isRecord(part) ||
      part.type !== "text" ||
      typeof part.text !== "string"
    ) {
      return [];
    }
    return [part.text];
  });
};

/**
 * Normalize the child JSON stream at its trust boundary. Raw events, raw tool
 * ids, thinking blocks, arguments and tool-result bodies never leave here.
 */
export const createChildProtocolParser = (
  options: ProtocolOptions = {},
): ChildProtocolParser => {
  const now = options.now ?? Date.now;
  const toolIds = new Map<string, { localId: number; name: string }>();
  let nextToolId = 1;

  const observe = (observation: ChildObservation): void => {
    try {
      options.observe?.(observation);
    } catch {
      // Observability must never change child execution behavior.
    }
  };

  const localTool = (rawId: unknown, rawName: unknown) => {
    const key = typeof rawId === "string" ? rawId : `anonymous-${nextToolId}`;
    const existing = toolIds.get(key);
    if (existing !== undefined) return existing;
    const item = {
      localId: nextToolId++,
      name: capUtf8(
        stripTerminalControls(
          typeof rawName === "string" ? rawName : "unknown-tool",
          " ",
        ),
        256,
      ),
    };
    toolIds.set(key, item);
    return item;
  };

  return {
    processLine(line) {
      if (line.trim() === "") return undefined;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        observe({ type: "protocol_warning", code: "malformed" });
        return undefined;
      }
      if (!isRecord(value) || typeof value.type !== "string") {
        observe({ type: "protocol_warning", code: "malformed" });
        return undefined;
      }

      if (value.type === "message_update") {
        const message = isRecord(value.message) ? value.message : undefined;
        if (message?.role === "assistant") {
          const draft = textParts(message).join("\n");
          if (draft !== "") {
            observe({
              type: "assistant_draft",
              text: capUtf8(stripTerminalControls(draft), MAX_LIVE_DRAFT_BYTES),
            });
          }
        }
        return undefined;
      }

      if (value.type === "tool_execution_start") {
        const tool = localTool(value.toolCallId, value.toolName);
        observe({ type: "tool_started", ...tool, at: now() });
        return undefined;
      }

      if (value.type === "tool_execution_end") {
        const tool = localTool(value.toolCallId, value.toolName);
        observe({
          type: "tool_finished",
          ...tool,
          failed: value.isError === true,
          at: now(),
        });
        return undefined;
      }

      if (value.type !== "message_end") return undefined;
      const message = isRecord(value.message) ? value.message : undefined;
      const projection: LegacyMessageProjection = {
        stopReason: getString(value, message, "stopReason"),
        errorMessage: getString(value, message, "errorMessage"),
      };

      if (message?.role !== "assistant") return projection;
      const parts = textParts(message);
      if (parts.length > 0) {
        // Preserve the legacy contract: latest assistant message, first block.
        projection.text = parts[0];
        const transcriptText = stripTerminalControls(parts.join("\n"));
        if (transcriptText !== "") {
          observe({
            type: "assistant_final",
            text: capUtf8(transcriptText, MAX_ASSISTANT_ITEM_BYTES),
            at: now(),
            model:
              typeof message.model === "string"
                ? capUtf8(stripTerminalControls(message.model, " "), 256)
                : undefined,
            stopReason: projection.stopReason,
          });
        }
      }
      return projection;
    },
    oversizedLine() {
      observe({ type: "protocol_warning", code: "oversized" });
    },
  };
};
