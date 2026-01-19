import { Box, Text, useInput } from "ink";
import React from "react";
import type { ToolUsage } from "../core/log-parser.js";

interface ToolDetailProps {
  tool: ToolUsage;
  onBack: () => void;
}

const formatTime = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const time = date.toLocaleTimeString("en-US", { hour12: false });
  return `${month}/${day} ${time}`;
};

const MAX_VALUE_LENGTH = 500;
const MAX_LINES = 15;

const truncateValue = (value: string): string => {
  const lines = value.split("\n");
  if (lines.length > MAX_LINES) {
    return `${lines.slice(0, MAX_LINES).join("\n")}\n... (${lines.length - MAX_LINES} more lines)`;
  }
  if (value.length > MAX_VALUE_LENGTH) {
    return `${value.slice(0, MAX_VALUE_LENGTH)}... (${value.length - MAX_VALUE_LENGTH} more chars)`;
  }
  return value;
};

const formatValue = (value: unknown): string => {
  if (typeof value === "string") {
    return truncateValue(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const json = JSON.stringify(value, undefined, 2);
  return truncateValue(json);
};

export const ToolDetail = ({ tool, onBack }: ToolDetailProps) => {
  useInput((input) => {
    if (input === "q") {
      onBack();
    }
  });

  const date = new Date(tool.timestamp);
  const time = formatTime(date);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="single" paddingX={1}>
        <Text bold>Tool Detail</Text>
      </Box>

      {/* Basic Info */}
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Box>
          <Text>Tool: </Text>
          <Text bold color="cyan">
            {tool.toolName}
          </Text>
        </Box>
        <Box>
          <Text>Time: </Text>
          <Text>{time}</Text>
        </Box>
        <Box>
          <Text>Status: </Text>
          <Text color={tool.success ? "green" : "red"}>
            {tool.success ? "✓ Success" : "✗ Failed"}
          </Text>
        </Box>
        {tool.duration !== undefined && (
          <Box>
            <Text>Duration: </Text>
            <Text>{tool.duration}ms</Text>
          </Box>
        )}
      </Box>

      {/* Input */}
      <Box flexDirection="column" marginTop={1}>
        <Box borderStyle="single" paddingX={1} flexDirection="column">
          <Text bold>Input:</Text>
          {Object.entries(tool.toolInput).map(([key, value]) => {
            const formattedValue = formatValue(value);
            const isMultiline = formattedValue.includes("\n");

            if (isMultiline) {
              return (
                <Box key={key} flexDirection="column" marginTop={1}>
                  <Text color="yellow">{key}:</Text>
                  <Box marginLeft={2} flexDirection="column">
                    {formattedValue.split("\n").map((line, i) => (
                      <Text key={i}>{line}</Text>
                    ))}
                  </Box>
                </Box>
              );
            }

            return (
              <Box key={key}>
                <Text color="yellow">{key}: </Text>
                <Text>{formattedValue}</Text>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* Error (if any) */}
      {tool.error && (
        <Box marginTop={1} paddingX={1} flexDirection="column">
          <Text bold color="red">
            Error:
          </Text>
          <Box marginLeft={2}>
            <Text color="red">{tool.error}</Text>
          </Box>
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} borderStyle="single" paddingX={1}>
        <Text dimColor>q: Back to list</Text>
      </Box>
    </Box>
  );
};
