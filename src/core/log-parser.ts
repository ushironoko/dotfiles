import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../types/analysis.js";

// Bashコマンドのカテゴリ
export type BashCommandCategory =
  | "test"
  | "lint"
  | "format"
  | "build"
  | "git"
  | "install"
  | "typecheck"
  | "run"
  | "other";

// 型定義
export interface ToolUsage {
  timestamp: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  duration?: number;
  success: boolean;
  error?: string;
  // 拡張: コンテキスト情報
  bashCommand?: string;
  bashCategory?: BashCommandCategory;
  filePath?: string;
}

export interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

export interface HookEvent {
  timestamp: string;
  eventType: string;
  matcher?: string;
  hookCommand?: string;
  exitCode?: number;
  matchedCount?: number;
  commands?: HookCommand[];
}

export interface SessionInfo {
  id: string;
  path: string;
  startTime: string;
  project: string;
}

export interface SessionTitle {
  summary?: string;
  slug?: string;
  firstUserMessage?: string;
}

// Bashコマンドをカテゴリに分類
export const categorizeBashCommand = (command: string): BashCommandCategory => {
  const normalizedCommand = command.toLowerCase().trim();

  // テスト
  if (
    normalizedCommand.includes("test") ||
    normalizedCommand.includes("vitest") ||
    normalizedCommand.includes("jest") ||
    normalizedCommand.includes("pytest") ||
    normalizedCommand.includes("bun test")
  ) {
    return "test";
  }

  // Lint
  if (
    normalizedCommand.includes("lint") ||
    normalizedCommand.includes("eslint") ||
    normalizedCommand.includes("biome check") ||
    normalizedCommand.includes("oxlint")
  ) {
    return "lint";
  }

  // Format
  if (
    normalizedCommand.includes("format") ||
    normalizedCommand.includes("prettier") ||
    normalizedCommand.includes("biome format")
  ) {
    return "format";
  }

  // Build
  if (
    normalizedCommand.includes("build") ||
    normalizedCommand.includes("compile") ||
    normalizedCommand.includes("webpack") ||
    normalizedCommand.includes("vite build") ||
    normalizedCommand.includes("tsc ") ||
    normalizedCommand.includes("cargo build")
  ) {
    return "build";
  }

  // Git
  if (
    normalizedCommand.startsWith("git ") ||
    normalizedCommand.startsWith("gh ")
  ) {
    return "git";
  }

  // Install
  if (
    normalizedCommand.includes("install") ||
    normalizedCommand.includes("npm i") ||
    normalizedCommand.includes("pnpm add") ||
    normalizedCommand.includes("bun add") ||
    normalizedCommand.includes("cargo add")
  ) {
    return "install";
  }

  // Type check
  if (
    normalizedCommand.includes("tsc --noEmit") ||
    normalizedCommand.includes("tsc -noEmit") ||
    normalizedCommand.includes("run tsc") ||
    normalizedCommand.includes("type-check") ||
    normalizedCommand.includes("typecheck")
  ) {
    return "typecheck";
  }

  // Run / Execute
  if (
    normalizedCommand.startsWith("bun run ") ||
    normalizedCommand.startsWith("npm run ") ||
    normalizedCommand.startsWith("pnpm run ") ||
    normalizedCommand.startsWith("node ") ||
    normalizedCommand.startsWith("python ")
  ) {
    return "run";
  }

  return "other";
};

// ファイルパスを抽出（Read, Edit, Write, Glob等から）
const extractFilePath = (
  toolName: string,
  toolInput: Record<string, unknown>,
): string | undefined => {
  if (toolName === "Read" || toolName === "Edit" || toolName === "Write") {
    return toolInput.file_path as string | undefined;
  }
  if (toolName === "Glob") {
    return toolInput.path as string | undefined;
  }
  if (toolName === "Grep") {
    return toolInput.path as string | undefined;
  }
  return undefined;
};

// セッションログからツール呼び出しを抽出
export const parseToolUsage = (sessionPath: string): ToolUsage[] => {
  if (!existsSync(sessionPath)) {
    return [];
  }

  const content = readFileSync(sessionPath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());
  const toolUsages: ToolUsage[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // assistant メッセージの tool_use を探す
      if (entry.type === "assistant" && entry.message?.content) {
        const timestamp = entry.timestamp || new Date().toISOString();

        for (const content of entry.message.content) {
          if (content.type === "tool_use") {
            const toolName = content.name;
            const toolInput = content.input || {};

            // Bashコマンドのコンテキスト情報を抽出
            let bashCommand: string | undefined;
            let bashCategory: BashCommandCategory | undefined;
            const command = toolInput.command;
            if (toolName === "Bash" && typeof command === "string") {
              bashCommand = command;
              bashCategory = categorizeBashCommand(command);
            }

            // ファイルパス情報を抽出
            const filePath = extractFilePath(toolName, toolInput);

            toolUsages.push({
              timestamp,
              toolName,
              toolInput,
              success: true, // tool_result から判定する必要があるが簡易実装
              error: undefined,
              bashCommand,
              bashCategory,
              filePath,
            });
          }
        }
      }
    } catch {
      // パースエラーは無視
      continue;
    }
  }

  return toolUsages;
};

// settings.jsonからフック設定を読み込む
interface HookConfig {
  matcher: string;
  hooks: HookCommand[];
}

interface HooksSettings {
  [eventType: string]: HookConfig[];
}

const loadHooksSettings = (): HooksSettings => {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    return {};
  }

  try {
    const content = readFileSync(settingsPath, "utf8");
    const settings = JSON.parse(content);
    return settings.hooks || {};
  } catch {
    return {};
  }
};

// マッチャーパターンに一致するフック設定を取得
const findMatchingHooks = (
  hooksSettings: HooksSettings,
  eventType: string,
  query: string,
): HookCommand[] => {
  const eventHooks = hooksSettings[eventType];
  if (!eventHooks) {
    return [];
  }

  const matchedCommands: HookCommand[] = [];
  for (const config of eventHooks) {
    try {
      const regex = new RegExp(config.matcher, "i");
      if (regex.test(query)) {
        matchedCommands.push(...config.hooks);
      }
    } catch {
      // 無効な正規表現は無視
    }
  }

  return matchedCommands;
};

// デバッグログからフック発火を抽出
export const parseHookEvents = (debugPath: string): HookEvent[] => {
  if (!existsSync(debugPath)) {
    return [];
  }

  const content = readFileSync(debugPath, "utf8");
  const lines = content.split("\n");
  const hookEvents: HookEvent[] = [];
  const hooksSettings = loadHooksSettings();

  // マッチ数を追跡するためのマップ（タイムスタンプ + イベントタイプ → マッチ数）
  const matchCounts = new Map<string, number>();

  // 最初のパスでマッチ数を収集
  for (const line of lines) {
    const matchedMatch = line.match(
      /(\d{4}-\d{2}-\d{2}T[\d:.]+Z).*Matched (\d+) unique hooks for query/,
    );
    if (matchedMatch) {
      // 直前のイベントにマッチ数を紐付けるためにタイムスタンプをキーにする
      const [, timestamp, countStr] = matchedMatch;
      const count = Number.parseInt(countStr, 10);
      matchCounts.set(timestamp, count);
    }
  }

  for (const line of lines) {
    // フック関連のログを抽出
    // 例: 2026-01-11T07:02:16.456Z [DEBUG] Getting matching hook commands for SessionStart with query: startup
    const hookMatch = line.match(
      /(\d{4}-\d{2}-\d{2}T[\d:.]+Z).*Getting matching hook commands for (\w+) with query: (.+)/,
    );

    if (hookMatch) {
      const [, timestamp, eventType, query] = hookMatch;

      // settings.jsonから対応するコマンドを取得
      const commands = findMatchingHooks(hooksSettings, eventType, query);

      hookEvents.push({
        timestamp,
        eventType,
        matcher: query,
        hookCommand: commands.length > 0 ? commands[0].command : undefined,
        exitCode: 0,
        matchedCount: commands.length,
        commands: commands.length > 0 ? commands : undefined,
      });
    }
  }

  return hookEvents;
};

// 最新セッションのパスを取得
export const getLatestSession = (projectPath?: string): string | undefined => {
  const sessions = listSessions(projectPath);
  if (sessions.length === 0) {
    return undefined;
  }

  // startTimeでソートして最新を取得
  sessions.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );
  return sessions[0].path;
};

// セッション一覧を取得
export const listSessions = (projectPath?: string): SessionInfo[] => {
  const claudeDir = join(homedir(), ".claude", "projects");

  if (!existsSync(claudeDir)) {
    return [];
  }

  const sessions: SessionInfo[] = [];
  const projectDirs = readdirSync(claudeDir);

  for (const projectDir of projectDirs) {
    const projectFullPath = join(claudeDir, projectDir);

    if (!statSync(projectFullPath).isDirectory()) {
      continue;
    }

    // プロジェクトパスでフィルタリング
    if (projectPath && !projectDir.includes(projectPath)) {
      continue;
    }

    const sessionFiles = readdirSync(projectFullPath).filter((file) =>
      file.endsWith(".jsonl"),
    );

    for (const sessionFile of sessionFiles) {
      const sessionId = sessionFile.replace(".jsonl", "");
      const sessionPath = join(projectFullPath, sessionFile);
      const stats = statSync(sessionPath);

      sessions.push({
        id: sessionId,
        path: sessionPath,
        startTime: stats.mtime.toISOString(),
        project: projectDir,
      });
    }
  }

  return sessions;
};

// デバッグログのパスを取得
export const getDebugLogPath = (sessionId: string): string | undefined => {
  const debugDir = join(homedir(), ".claude", "debug");
  const debugPath = join(debugDir, `${sessionId}.txt`);

  if (existsSync(debugPath)) {
    return debugPath;
  }

  return undefined;
};

// セッションのタイトル情報を取得
export const getSessionTitle = (sessionPath: string): SessionTitle => {
  if (!existsSync(sessionPath)) {
    return {};
  }

  const content = readFileSync(sessionPath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());

  const result: SessionTitle = {};

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // summaryを取得（最初に見つかったもの）
      if (!result.summary && entry.type === "summary" && entry.summary) {
        result.summary = entry.summary;
      }

      // slugを取得（最初に見つかったもの）
      if (!result.slug && entry.slug) {
        result.slug = entry.slug;
      }

      // 最初のユーザーメッセージを取得
      if (
        !result.firstUserMessage &&
        entry.type === "user" &&
        entry.message?.content
      ) {
        const content = String(entry.message.content);
        result.firstUserMessage =
          content.slice(0, 50) + (content.length > 50 ? "..." : "");
      }

      // すべて取得できたら終了
      if (result.summary && result.slug && result.firstUserMessage) {
        break;
      }
    } catch {
      continue;
    }
  }

  return result;
};

// tool_resultを抽出（エラー情報含む）
export const parseToolResults = (sessionPath: string): ToolResult[] => {
  if (!existsSync(sessionPath)) {
    return [];
  }

  const content = readFileSync(sessionPath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());
  const toolResults: ToolResult[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // user メッセージの tool_result を探す
      if (entry.type === "user" && entry.message?.content) {
        const timestamp = entry.timestamp || new Date().toISOString();
        const contents = Array.isArray(entry.message.content)
          ? entry.message.content
          : [entry.message.content];

        for (const content of contents) {
          if (content.type === "tool_result") {
            const isError = content.is_error === true;
            let errorMessage: string | undefined;

            if (isError && content.content) {
              // エラーメッセージを抽出
              if (typeof content.content === "string") {
                errorMessage = content.content;
              } else if (Array.isArray(content.content)) {
                const textContent = content.content.find(
                  (c: { type: string }) => c.type === "text",
                );
                if (textContent?.text) {
                  errorMessage = textContent.text;
                }
              }
            }

            toolResults.push({
              timestamp,
              toolUseId: content.tool_use_id || "",
              toolName: content.name || "unknown",
              isError,
              errorMessage,
              content: isError ? undefined : content.content,
            });
          }
        }
      }
    } catch {
      // パースエラーは無視
      continue;
    }
  }

  return toolResults;
};

// セッションの時間範囲を取得
export const getSessionTimeRange = (
  sessionPath: string,
): { startTime: string; endTime: string } | undefined => {
  if (!existsSync(sessionPath)) {
    return undefined;
  }

  const content = readFileSync(sessionPath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());

  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        if (!firstTimestamp) {
          firstTimestamp = entry.timestamp;
        }
        lastTimestamp = entry.timestamp;
      }
    } catch {
      continue;
    }
  }

  if (!firstTimestamp || !lastTimestamp) {
    // ファイルのタイムスタンプにフォールバック
    const stats = statSync(sessionPath);
    return {
      startTime: stats.birthtime.toISOString(),
      endTime: stats.mtime.toISOString(),
    };
  }

  return { startTime: firstTimestamp, endTime: lastTimestamp };
};

// ユーザーメッセージ数をカウント
export const countUserMessages = (sessionPath: string): number => {
  if (!existsSync(sessionPath)) {
    return 0;
  }

  const content = readFileSync(sessionPath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());
  let count = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      // tool_resultを含まない純粋なユーザーメッセージをカウント
      if (entry.type === "user" && entry.message?.content) {
        const contents = Array.isArray(entry.message.content)
          ? entry.message.content
          : [entry.message.content];

        const hasToolResult = contents.some(
          (c: { type: string }) => c.type === "tool_result",
        );
        if (!hasToolResult) {
          count++;
        }
      }
    } catch {
      continue;
    }
  }

  return count;
};

// アシスタントメッセージ数をカウント
export const countAssistantMessages = (sessionPath: string): number => {
  if (!existsSync(sessionPath)) {
    return 0;
  }

  const content = readFileSync(sessionPath, "utf8");
  const lines = content.split("\n").filter((line) => line.trim());
  let count = 0;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "assistant") {
        count++;
      }
    } catch {
      continue;
    }
  }

  return count;
};

// 指定期間内のセッション一覧を取得
export const listSessionsInPeriod = (
  days: number,
  projectPath?: string,
): SessionInfo[] => {
  const sessions = listSessions(projectPath);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  return sessions.filter((session) => {
    const sessionDate = new Date(session.startTime);
    return sessionDate >= cutoffDate;
  });
};
