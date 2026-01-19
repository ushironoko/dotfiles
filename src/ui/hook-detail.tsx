import { Box, Text, useInput } from "ink";
import React from "react";
import type { HookEvent } from "../core/log-parser.js";

interface HookDetailProps {
  hook: HookEvent;
  onBack: () => void;
}

const formatTime = (date: Date): string => {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const time = date.toLocaleTimeString("en-US", { hour12: false });
  return `${month}/${day} ${time}`;
};

export const HookDetail = ({ hook, onBack }: HookDetailProps) => {
  useInput((input) => {
    if (input === "q") {
      onBack();
    }
  });

  const date = new Date(hook.timestamp);
  const time = formatTime(date);
  const hasCommands = hook.commands && hook.commands.length > 0;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="single" paddingX={1}>
        <Text bold>Hook Detail</Text>
      </Box>

      {/* Basic Info */}
      <Box flexDirection="column" marginTop={1} paddingX={1}>
        <Box>
          <Text>Event: </Text>
          <Text bold color="cyan">
            {hook.eventType}
          </Text>
        </Box>
        <Box>
          <Text>Time: </Text>
          <Text>{time}</Text>
        </Box>
        <Box>
          <Text>Matcher Query: </Text>
          <Text>{hook.matcher ?? "N/A"}</Text>
        </Box>
        <Box>
          <Text>Matched Hooks: </Text>
          <Text
            color={hook.matchedCount && hook.matchedCount > 0 ? "green" : "dim"}
          >
            {hook.matchedCount ?? 0}
          </Text>
        </Box>
      </Box>

      {/* Commands */}
      {hasCommands ? (
        <Box flexDirection="column" marginTop={1}>
          <Box borderStyle="single" paddingX={1} flexDirection="column">
            <Text bold>Executed Commands:</Text>
            {hook.commands?.map((cmd, index) => (
              <Box
                key={index}
                flexDirection="column"
                marginTop={index > 0 ? 1 : 0}
              >
                <Box>
                  <Text color="yellow">#{index + 1} </Text>
                  <Text dimColor>({cmd.type})</Text>
                </Box>
                <Box marginLeft={2} flexDirection="column">
                  <Text color="green">{cmd.command}</Text>
                  {cmd.timeout && <Text dimColor>timeout: {cmd.timeout}s</Text>}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Box borderStyle="single" paddingX={1} flexDirection="column">
            <Text bold>Commands:</Text>
            <Text dimColor>No hooks matched for this event</Text>
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
