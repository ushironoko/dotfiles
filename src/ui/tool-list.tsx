import { Box, Text } from "ink";
import React from "react";
import type { ToolUsage } from "../core/log-parser.js";

interface ToolListProps {
  tools: ToolUsage[];
  selectedIndex: number;
}

export const ToolList = ({ tools, selectedIndex }: ToolListProps) => {
  if (tools.length === 0) {
    return (
      <Box>
        <Text dimColor>No tool usage found</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Box width={12}>
          <Text bold>TIME</Text>
        </Box>
        <Box width={20}>
          <Text bold>TOOL</Text>
        </Box>
        <Box width={40}>
          <Text bold>INPUT</Text>
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

      {/* Tool list */}
      {tools.map((tool, index) => {
        const isSelected = index === selectedIndex;
        const time = new Date(tool.timestamp).toLocaleTimeString("en-US", {
          hour12: false,
        });

        // ツール入力を簡潔に表示
        let inputDisplay = "";
        if (tool.toolName === "Bash" && tool.toolInput.command) {
          inputDisplay = String(tool.toolInput.command).slice(0, 35);
        } else if (tool.toolName === "Read" && tool.toolInput.file_path) {
          inputDisplay = String(tool.toolInput.file_path).slice(0, 35);
        } else if (tool.toolName === "Write" && tool.toolInput.file_path) {
          inputDisplay = String(tool.toolInput.file_path).slice(0, 35);
        } else if (tool.toolName === "Edit" && tool.toolInput.file_path) {
          inputDisplay = String(tool.toolInput.file_path).slice(0, 35);
        } else {
          inputDisplay = JSON.stringify(tool.toolInput).slice(0, 35);
        }

        return (
          <Box key={`${tool.timestamp}-${index}`}>
            <Text color={isSelected ? "cyan" : undefined}>
              {isSelected ? "> " : "  "}
            </Text>
            <Box width={12}>
              <Text>{time}</Text>
            </Box>
            <Box width={20}>
              <Text color={isSelected ? "cyan" : undefined}>
                {tool.toolName}
              </Text>
            </Box>
            <Box width={40}>
              <Text dimColor>{inputDisplay}</Text>
            </Box>
            <Box width={8}>
              <Text color={tool.success ? "green" : "red"}>
                {tool.success ? "✓" : "✗"}
              </Text>
            </Box>
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>Total: {tools.length} tools</Text>
      </Box>
    </Box>
  );
};
