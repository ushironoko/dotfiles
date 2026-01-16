import { Box, Text, useApp, useInput } from "ink";
import React, { useState, useEffect } from "react";
import {
  type ToolUsage,
  type HookEvent,
  parseToolUsage,
  parseHookEvents,
  getLatestSession,
  getDebugLogPath,
} from "../core/log-parser.js";
import { ToolList } from "./tool-list.js";
import { HookList } from "./hook-list.js";
import { StatsView } from "./stats-view.js";

type Tab = "tools" | "hooks" | "stats";

interface LogViewerProps {
  sessionId?: string;
}

export const LogViewer = ({ sessionId }: LogViewerProps) => {
  const [activeTab, setActiveTab] = useState<Tab>("tools");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [toolUsages, setToolUsages] = useState<ToolUsage[]>([]);
  const [hookEvents, setHookEvents] = useState<HookEvent[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const { exit } = useApp();

  // セッションログを読み込み（ポーリング方式でリアルタイム更新）
  useEffect(() => {
    const loadLogs = () => {
      const sessionPath = sessionId || getLatestSession() || "";

      if (!sessionPath) {
        return;
      }

      setCurrentSessionId(
        sessionPath.split("/").pop()?.replace(".jsonl", "") || "",
      );

      // ツール使用履歴を読み込み
      const tools = parseToolUsage(sessionPath);
      setToolUsages(tools);

      // フック履歴を読み込み（デバッグログがあれば）
      const sessId = sessionPath.split("/").pop()?.replace(".jsonl", "") || "";
      const debugPath = getDebugLogPath(sessId);
      if (debugPath) {
        const hooks = parseHookEvents(debugPath);
        setHookEvents(hooks);
      }
    };

    // 初回読み込み
    loadLogs();

    // ポーリング（2秒間隔でリアルタイム更新）
    const interval = setInterval(loadLogs, 2000);

    // クリーンアップ
    return () => clearInterval(interval);
  }, [sessionId]);

  // キーボード入力処理
  useInput((input, key) => {
    if (input === "q") {
      exit();
    }

    if (input === "j" || key.downArrow) {
      setSelectedIndex((prev) => prev + 1);
    }

    if (input === "k" || key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    }

    if (key.tab) {
      setActiveTab((prev) => {
        if (prev === "tools") return "hooks";
        if (prev === "hooks") return "stats";
        return "tools";
      });
      setSelectedIndex(0);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="single" paddingX={1}>
        <Text bold>Claude Logs Viewer</Text>
        <Text dimColor> Session: {currentSessionId.slice(0, 8)}...</Text>
      </Box>

      {/* Tab Bar */}
      <Box marginTop={1}>
        <Text>
          {activeTab === "tools" ? "[" : " "}
          <Text bold={activeTab === "tools"}>Tools</Text>
          {activeTab === "tools" ? "]" : " "}
        </Text>
        <Text> </Text>
        <Text>
          {activeTab === "hooks" ? "[" : " "}
          <Text bold={activeTab === "hooks"}>Hooks</Text>
          {activeTab === "hooks" ? "]" : " "}
        </Text>
        <Text> </Text>
        <Text>
          {activeTab === "stats" ? "[" : " "}
          <Text bold={activeTab === "stats"}>Stats</Text>
          {activeTab === "stats" ? "]" : " "}
        </Text>
      </Box>

      {/* Content */}
      <Box marginTop={1} flexDirection="column">
        {activeTab === "tools" && (
          <ToolList tools={toolUsages} selectedIndex={selectedIndex} />
        )}
        {activeTab === "hooks" && (
          <HookList hooks={hookEvents} selectedIndex={selectedIndex} />
        )}
        {activeTab === "stats" && (
          <StatsView
            toolCount={toolUsages.length}
            hookCount={hookEvents.length}
          />
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1} borderStyle="single" paddingX={1}>
        <Text dimColor>↑↓/jk: Navigate Tab: Switch view q: Quit</Text>
      </Box>
    </Box>
  );
};
