import { Box, Text } from "ink";
import React from "react";
import type { HookEvent } from "../core/log-parser.js";

interface HookListProps {
  hooks: HookEvent[];
  selectedIndex: number;
  scrollOffset: number;
  viewportHeight: number;
}

export const HookList = ({
  hooks,
  selectedIndex,
  scrollOffset,
  viewportHeight,
}: HookListProps) => {
  if (hooks.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>No hook events found</Text>
        <Text dimColor>
          (Hooks are only recorded when running with --debug flag)
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Box width={18}>
          <Text bold>TIME</Text>
        </Box>
        <Box width={20}>
          <Text bold>EVENT</Text>
        </Box>
        <Box width={40}>
          <Text bold>MATCHER</Text>
        </Box>
        <Box width={8}>
          <Text bold>STATUS</Text>
        </Box>
      </Box>

      <Box>
        <Text>
          ────────────────────────────────────────────────────────────────────────
        </Text>
      </Box>

      {/* Hook list (viewport only, newest first) */}
      {[...hooks]
        .reverse()
        .slice(scrollOffset, scrollOffset + viewportHeight)
        .map((hook, viewIndex) => {
          const actualIndex = scrollOffset + viewIndex;
          const isSelected = actualIndex === selectedIndex;
          const date = new Date(hook.timestamp);
          const time = `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")} ${date.toLocaleTimeString("en-US", { hour12: false })}`;

          return (
            <Box key={`${hook.timestamp}-${actualIndex}`}>
              <Text color={isSelected ? "cyan" : undefined}>
                {isSelected ? "> " : "  "}
              </Text>
              <Box width={18}>
                <Text>{time}</Text>
              </Box>
              <Box width={20}>
                <Text color={isSelected ? "cyan" : undefined}>
                  {hook.eventType}
                </Text>
              </Box>
              <Box width={40}>
                <Text dimColor>{hook.matcher || "N/A"}</Text>
              </Box>
              <Box width={8}>
                <Text color="green">✓</Text>
              </Box>
            </Box>
          );
        })}

      <Box marginTop={1}>
        <Text dimColor>Total: {hooks.length} hooks</Text>
      </Box>
    </Box>
  );
};
