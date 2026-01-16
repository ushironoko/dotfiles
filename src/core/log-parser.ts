import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 型定義
export interface ToolUsage {
  timestamp: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  duration?: number;
  success: boolean;
  error?: string;
}

export interface HookEvent {
  timestamp: string;
  eventType: string;
  matcher?: string;
  hookCommand?: string;
  exitCode?: number;
}

export interface SessionInfo {
  id: string;
  path: string;
  startTime: string;
  project: string;
}

// セッションログからツール呼び出しを抽出
export function parseToolUsage(sessionPath: string): ToolUsage[] {
  if (!existsSync(sessionPath)) {
    return [];
  }

  const content = readFileSync(sessionPath, "utf-8");
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
            toolUsages.push({
              timestamp,
              toolName: content.name,
              toolInput: content.input || {},
              success: true, // tool_result から判定する必要があるが簡易実装
              error: undefined,
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
}

// デバッグログからフック発火を抽出
export function parseHookEvents(debugPath: string): HookEvent[] {
  if (!existsSync(debugPath)) {
    return [];
  }

  const content = readFileSync(debugPath, "utf-8");
  const lines = content.split("\n");
  const hookEvents: HookEvent[] = [];

  for (const line of lines) {
    // フック関連のログを抽出
    // 例: 2026-01-11T07:02:16.456Z [DEBUG] Getting matching hook commands for SessionStart with query: startup
    const hookMatch = line.match(
      /(\d{4}-\d{2}-\d{2}T[\d:.]+Z).*Getting matching hook commands for (\w+) with query: (.+)/,
    );

    if (hookMatch) {
      hookEvents.push({
        timestamp: hookMatch[1],
        eventType: hookMatch[2],
        matcher: hookMatch[3],
        hookCommand: undefined,
        exitCode: 0,
      });
    }
  }

  return hookEvents;
}

// 最新セッションのパスを取得
export function getLatestSession(projectPath?: string): string | null {
  const sessions = listSessions(projectPath);
  if (sessions.length === 0) {
    return null;
  }

  // startTimeでソートして最新を取得
  sessions.sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime(),
  );
  return sessions[0].path;
}

// セッション一覧を取得
export function listSessions(projectPath?: string): SessionInfo[] {
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
}

// デバッグログのパスを取得
export function getDebugLogPath(sessionId: string): string | null {
  const debugDir = join(homedir(), ".claude", "debug");
  const debugPath = join(debugDir, `${sessionId}.txt`);

  if (existsSync(debugPath)) {
    return debugPath;
  }

  return null;
}
