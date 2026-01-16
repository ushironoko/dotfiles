import { Box, Text } from "ink";
import React from "react";

interface StatsViewProps {
  toolCount: number;
  hookCount: number;
}

export const StatsView = ({ toolCount, hookCount }: StatsViewProps) => {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Session Statistics</Text>
      </Box>

      <Box>
        <Text>
          ────────────────────────────────────────────────────────────────────────
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Box width={30}>
            <Text>Total Tool Uses:</Text>
          </Box>
          <Text color="cyan" bold>
            {toolCount}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Box width={30}>
            <Text>Total Hook Events:</Text>
          </Box>
          <Text color="cyan" bold>
            {hookCount}
          </Text>
        </Box>
      </Box>

      <Box marginTop={2}>
        <Text dimColor>
          Note: Hook events are only recorded when Claude Code is run with
          --debug flag
        </Text>
      </Box>
    </Box>
  );
};
