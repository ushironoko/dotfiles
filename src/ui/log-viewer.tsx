import { Box, Text, useApp, useInput } from "ink";
import React, { useState, useEffect } from "react";
import {
  type ToolUsage,
  type HookEvent,
  type SessionTitle,
  parseToolUsage,
  parseHookEvents,
  getLatestSession,
  getDebugLogPath,
  getSessionTitle,
} from "../core/log-parser.js";
import { ToolList } from "./tool-list.js";
import { HookList } from "./hook-list.js";
import { StatsView } from "./stats-view.js";
import { ToolDetail } from "./tool-detail.js";
import { HookDetail } from "./hook-detail.js";

type Tab = "tools" | "hooks" | "stats";
type View = "list" | "tool-detail" | "hook-detail";

interface LogViewerProps {
  sessionId?: string;
}

const VIEWPORT_HEIGHT = 15;

export const LogViewer = ({ sessionId }: LogViewerProps) => {
  const [activeTab, setActiveTab] = useState<Tab>("tools");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [toolUsages, setToolUsages] = useState<ToolUsage[]>([]);
  const [hookEvents, setHookEvents] = useState<HookEvent[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [sessionTitle, setSessionTitle] = useState<SessionTitle>({});
  const [view, setView] = useState<View>("list");
  const [selectedTool, setSelectedTool] = useState<ToolUsage | undefined>(
    undefined,
  );
  const [selectedHook, setSelectedHook] = useState<HookEvent | undefined>(
    undefined,
  );
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

      // セッションタイトルを取得
      const title = getSessionTitle(sessionPath);
      setSessionTitle(title);

      // ツール使用履歴を読み込み（変更がある場合のみ更新）
      const tools = parseToolUsage(sessionPath);
      setToolUsages((prev) => (prev.length !== tools.length ? tools : prev));

      // フック履歴を読み込み（デバッグログがあれば）
      const sessId = sessionPath.split("/").pop()?.replace(".jsonl", "") || "";
      const debugPath = getDebugLogPath(sessId);
      if (debugPath) {
        const hooks = parseHookEvents(debugPath);
        setHookEvents((prev) => (prev.length !== hooks.length ? hooks : prev));
      }
    };

    // 初回読み込み
    loadLogs();

    // ポーリング（2秒間隔でリアルタイム更新）
    const interval = setInterval(loadLogs, 2000);

    // クリーンアップ
    return () => clearInterval(interval);
  }, [sessionId]);

  // 現在のリストの長さを取得
  const currentListLength =
    activeTab === "tools" ? toolUsages.length : hookEvents.length;

  // キーボード入力処理
  useInput((input, key) => {
    // 詳細ページではqキーでリストに戻る
    if (view !== "list") {
      if (input === "q") {
        setView("list");
      }
      return;
    }

    if (input === "q") {
      exit();
    }

    // Enterキーで詳細ページへ遷移
    if (key.return) {
      if (activeTab === "tools" && toolUsages.length > 0) {
        const tool = [...toolUsages].reverse()[selectedIndex];
        setSelectedTool(tool);
        setView("tool-detail");
      } else if (activeTab === "hooks" && hookEvents.length > 0) {
        const hook = [...hookEvents].reverse()[selectedIndex];
        setSelectedHook(hook);
        setView("hook-detail");
      }
      return;
    }

    if (input === "j" || key.downArrow) {
      setSelectedIndex((prev) => {
        const next = Math.min(prev + 1, currentListLength - 1);
        // 選択がビューポート外に出たらスクロール
        if (next >= scrollOffset + VIEWPORT_HEIGHT) {
          setScrollOffset(next - VIEWPORT_HEIGHT + 1);
        }
        return next;
      });
    }

    if (input === "k" || key.upArrow) {
      setSelectedIndex((prev) => {
        const next = Math.max(0, prev - 1);
        // 選択がビューポート上部外に出たらスクロール
        if (next < scrollOffset) {
          setScrollOffset(next);
        }
        return next;
      });
    }

    if (key.tab) {
      setActiveTab((prev) => {
        if (prev === "tools") return "hooks";
        if (prev === "hooks") return "stats";
        return "tools";
      });
      setSelectedIndex(0);
      setScrollOffset(0);
    }
  });

  // 詳細ページの表示
  if (view === "tool-detail" && selectedTool) {
    return <ToolDetail tool={selectedTool} onBack={() => setView("list")} />;
  }

  if (view === "hook-detail" && selectedHook) {
    return <HookDetail hook={selectedHook} onBack={() => setView("list")} />;
  }

  // リスト表示
  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box borderStyle="single" paddingX={1} flexDirection="column">
        <Box>
          <Text bold>Claude Logs Viewer</Text>
        </Box>
        <Box>
          <Text dimColor>ID: </Text>
          <Text>{currentSessionId.slice(0, 8)}</Text>
          {sessionTitle.slug && (
            <>
              <Text dimColor> Slug: </Text>
              <Text>{sessionTitle.slug}</Text>
            </>
          )}
        </Box>
        {sessionTitle.summary && (
          <Box>
            <Text dimColor>Summary: </Text>
            <Text color="cyan">{sessionTitle.summary}</Text>
          </Box>
        )}
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

      {/* Content - 固定高さでターミナルスクロールを防止 */}
      <Box marginTop={1} flexDirection="column" height={VIEWPORT_HEIGHT + 4}>
        {activeTab === "tools" && (
          <ToolList
            tools={toolUsages}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            viewportHeight={VIEWPORT_HEIGHT}
          />
        )}
        {activeTab === "hooks" && (
          <HookList
            hooks={hookEvents}
            selectedIndex={selectedIndex}
            scrollOffset={scrollOffset}
            viewportHeight={VIEWPORT_HEIGHT}
          />
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
        <Text dimColor>↑↓/jk: Navigate Tab: Switch Enter: Detail q: Quit</Text>
      </Box>
    </Box>
  );
};
