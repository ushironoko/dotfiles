import type {
  SessionMetrics,
  EfficiencyEvaluation,
  EfficiencyIssue,
  Recommendation,
  AggregatedAnalysis,
  AnalysisSummary,
  ToolResult,
  OperationPattern,
  SkillCandidate,
  SkillCategory,
} from "../types/analysis.js";
import {
  parseToolUsage,
  parseToolResults,
  getSessionTimeRange,
  countUserMessages,
  countAssistantMessages,
  type ToolUsage,
  type SessionInfo,
} from "./log-parser.js";
import { detectPatterns } from "./pattern-detector.js";

// セッションメトリクスを計算
const calculateSessionMetrics = (
  sessionInfo: SessionInfo,
  toolUsages: ToolUsage[],
  toolResults: ToolResult[],
): SessionMetrics => {
  const timeRange = getSessionTimeRange(sessionInfo.path);
  const userMessageCount = countUserMessages(sessionInfo.path);
  const assistantMessageCount = countAssistantMessages(sessionInfo.path);

  const startTime = timeRange?.startTime || sessionInfo.startTime;
  const endTime = timeRange?.endTime || sessionInfo.startTime;

  const startDate = new Date(startTime);
  const endDate = new Date(endTime);
  const durationMinutes = (endDate.getTime() - startDate.getTime()) / 1000 / 60;

  // エラー数をカウント
  const errorCount = toolResults.filter((r) => r.isError).length;
  const totalToolCalls = toolUsages.length;
  const errorRate = totalToolCalls > 0 ? errorCount / totalToolCalls : 0;

  // ユニークツール数
  const uniqueTools = new Set(toolUsages.map((u) => u.toolName));

  // ツールごとの使用回数
  const toolBreakdown: Record<string, number> = {};
  for (const usage of toolUsages) {
    toolBreakdown[usage.toolName] = (toolBreakdown[usage.toolName] || 0) + 1;
  }

  return {
    sessionId: sessionInfo.id,
    sessionPath: sessionInfo.path,
    projectName: sessionInfo.project,
    startTime,
    endTime,
    durationMinutes,
    totalToolCalls,
    errorCount,
    errorRate,
    uniqueToolsUsed: uniqueTools.size,
    userMessageCount,
    assistantMessageCount,
    toolBreakdown,
  };
};

// リトライ回数をカウント（同一ファイルへの連続操作）
const countRetries = (toolUsages: ToolUsage[]): number => {
  let retryCount = 0;
  let lastEditFile: string | undefined;

  for (const usage of toolUsages) {
    if (usage.toolName === "Edit" || usage.toolName === "Write") {
      const filePath = usage.toolInput.file_path as string | undefined;
      if (filePath && filePath === lastEditFile) {
        retryCount++;
      }
      lastEditFile = filePath;
    } else {
      lastEditFile = undefined;
    }
  }

  return retryCount;
};

// 効率性を評価
const evaluateEfficiency = (
  toolUsages: ToolUsage[],
  _toolResults: ToolResult[],
  sessionMetrics: SessionMetrics[],
): EfficiencyEvaluation => {
  const issues: EfficiencyIssue[] = [];
  const recommendations: Recommendation[] = [];

  // 全体のエラー率
  const totalToolCalls = sessionMetrics.reduce(
    (sum, m) => sum + m.totalToolCalls,
    0,
  );
  const totalErrors = sessionMetrics.reduce((sum, m) => sum + m.errorCount, 0);
  const overallErrorRate =
    totalToolCalls > 0 ? totalErrors / totalToolCalls : 0;

  // 高エラー率の検出 (10%以上)
  const HIGH_ERROR_RATE_THRESHOLD = 0.1;
  if (overallErrorRate > HIGH_ERROR_RATE_THRESHOLD) {
    const highErrorSessions = sessionMetrics
      .filter((m) => m.errorRate > HIGH_ERROR_RATE_THRESHOLD)
      .map((m) => m.sessionId);

    issues.push({
      type: "high_error_rate",
      severity: overallErrorRate > 0.2 ? "high" : "medium",
      description: `Overall error rate is ${(overallErrorRate * 100).toFixed(1)}%`,
      affectedSessions: highErrorSessions,
      suggestedFix:
        "Review error patterns and consider adding validation steps",
    });

    recommendations.push({
      id: "reduce-errors",
      type: "workflow_improvement",
      priority: "high",
      title: "Reduce Tool Execution Errors",
      description:
        "High error rate detected. Consider adding pre-validation steps or error handling patterns.",
      expectedBenefit: "Reduced retry attempts and faster task completion",
    });
  }

  // リトライ率の計算（同一ファイルへの連続Edit）
  const retryCount = countRetries(toolUsages);
  const retryRate = toolUsages.length > 0 ? retryCount / toolUsages.length : 0;

  const EXCESSIVE_RETRY_THRESHOLD = 0.15;
  if (retryRate > EXCESSIVE_RETRY_THRESHOLD) {
    issues.push({
      type: "excessive_retries",
      severity: retryRate > 0.25 ? "high" : "medium",
      description: `Retry rate is ${(retryRate * 100).toFixed(1)}%`,
      affectedSessions: sessionMetrics.map((m) => m.sessionId),
      suggestedFix:
        "Consider reading files before editing to understand context",
    });
  }

  // ツール多様性の計算
  const allTools = new Set(toolUsages.map((u) => u.toolName));
  const toolDiversity = allTools.size;

  // 平均ツール数/タスク
  const totalUserMessages = sessionMetrics.reduce(
    (sum, m) => sum + m.userMessageCount,
    0,
  );
  const averageToolsPerTask =
    totalUserMessages > 0 ? totalToolCalls / totalUserMessages : 0;

  // 効率性スコアの計算 (0-100)
  const errorPenalty = Math.min(overallErrorRate * 100, 30);
  const retryPenalty = Math.min(retryRate * 50, 20);
  const overallScore = Math.max(0, 100 - errorPenalty - retryPenalty);

  return {
    overallScore,
    metrics: {
      errorRate: overallErrorRate,
      retryRate,
      toolDiversity,
      averageToolsPerTask,
    },
    issues,
    recommendations,
  };
};

// パターンからSkillカテゴリを推定
const inferSkillCategory = (pattern: OperationPattern): SkillCategory => {
  // パターンに含まれるBashカテゴリから推定
  if (pattern.category) {
    const bashCategory = pattern.category;
    if (bashCategory === "test") return "tdd";
    if (bashCategory === "lint") return "lint";
    if (bashCategory === "format") return "lint";
    if (bashCategory === "build") return "build";
    if (bashCategory === "git") return "git";
    if (bashCategory === "typecheck") return "build";
  }

  // シーケンスパターンから推定
  const { sequence, commonCommands } = pattern;
  const hasEdit = sequence.includes("Edit");
  const hasRead = sequence.includes("Read");
  const commands = commonCommands || [];

  // コマンド内容を解析してテストコマンドがあるか判定
  const hasTestCommand = commands.some((cmd) => {
    const lowerCmd = cmd.toLowerCase();
    return (
      lowerCmd.includes("test") ||
      lowerCmd.includes("vitest") ||
      lowerCmd.includes("jest") ||
      lowerCmd.includes("pytest") ||
      lowerCmd.includes("cargo test")
    );
  });

  // Read -> Edit + テストコマンドがある場合のみTDD
  if (hasRead && hasEdit && hasTestCommand) {
    const readIdx = sequence.indexOf("Read");
    const editIdx = sequence.indexOf("Edit");
    if (readIdx < editIdx) {
      return "tdd";
    }
  }

  // テストコマンドがあるがTDDパターンでない場合はtest
  if (hasTestCommand) {
    return "test";
  }

  // Edit連続はリファクタリング
  if (sequence.filter((t) => t === "Edit").length >= 3) {
    return "refactoring";
  }

  // コマンドパターンから推定
  for (const cmd of commands) {
    const lowerCmd = cmd.toLowerCase();
    if (lowerCmd.includes("lint") || lowerCmd.includes("biome check")) {
      return "lint";
    }
    if (lowerCmd.includes("git ") || lowerCmd.includes("gh ")) {
      return "git";
    }
    if (lowerCmd.includes("build") || lowerCmd.includes("tsc")) {
      return "build";
    }
  }

  return "other";
};

// Skill名を生成（一意性を保証）
const generateSkillName = (
  pattern: OperationPattern,
  category: SkillCategory,
  existingNames: Set<string>,
): string => {
  const { sequence } = pattern;
  const mainTools = sequence.slice(0, 2);
  const toolPart = mainTools
    .map((t) => t.toLowerCase().replace(/[^a-z]/g, ""))
    .join("-");

  // カテゴリプレフィックス
  const prefix = category !== "other" ? `${category}-` : "auto-";
  let baseName = `${prefix}${toolPart}`;

  // 一意性確保
  let finalName = baseName;
  let counter = 1;
  while (existingNames.has(finalName)) {
    finalName = `${baseName}-${counter++}`;
  }
  existingNames.add(finalName);

  return finalName;
};

// Skillの説明文を生成
const generateSkillDescription = (
  pattern: OperationPattern,
  category: SkillCategory,
): string => {
  const { sequence, commonCommands } = pattern;
  const commands = commonCommands || [];

  // カテゴリに基づいた説明
  const categoryDescriptions: Record<SkillCategory, string> = {
    tdd: "Test-driven development workflow",
    refactoring: "Code refactoring workflow",
    debugging: "Debugging workflow",
    build: "Build and compilation workflow",
    git: "Git operations workflow",
    lint: "Code linting and formatting workflow",
    test: "Test execution workflow",
    docs: "Documentation workflow",
    other: "Automated workflow",
  };

  let description = categoryDescriptions[category];

  // コマンドがあれば追加
  if (commands.length > 0) {
    const shortCommands = commands.slice(0, 3).map((cmd) => {
      // コマンドを短縮
      const parts = cmd.split(" ");
      return parts.slice(0, 3).join(" ") + (parts.length > 3 ? "..." : "");
    });
    description += ` (${shortCommands.join(", ")})`;
  }

  // シーケンス情報を追加
  description += `: ${sequence.join(" -> ")}`;

  return description;
};

// トリガー条件を生成
const generateTriggerConditions = (
  _pattern: OperationPattern,
  category: SkillCategory,
): string[] => {
  const conditions: string[] = [];

  // カテゴリ別のトリガー条件
  switch (category) {
    case "tdd": {
      conditions.push("After editing source files");
      conditions.push("Before committing changes");
      break;
    }
    case "refactoring": {
      conditions.push("When refactoring code across multiple files");
      break;
    }
    case "build": {
      conditions.push("Before deployment");
      conditions.push("After dependency changes");
      break;
    }
    case "git": {
      conditions.push("When managing version control");
      break;
    }
    case "lint": {
      conditions.push("Before committing changes");
      conditions.push("During code review");
      break;
    }
    case "test": {
      conditions.push("After code changes");
      conditions.push("Before merging");
      break;
    }
    default: {
      conditions.push("Manual invocation");
    }
  }

  return conditions;
};

// パターンがSkill化に適しているかを判定
const isValidSkillPattern = (pattern: OperationPattern): boolean => {
  const { sequence, frequency } = pattern;

  // 単一ツールの連続は除外（例: Bash x 5）
  const uniqueTools = new Set(sequence);
  if (uniqueTools.size === 1) {
    return false;
  }

  // 頻度が低すぎるものは除外
  if (frequency < 5) {
    return false;
  }

  // 最低2種類以上のツールが含まれていること
  if (uniqueTools.size < 2) {
    return false;
  }

  // 有意義なパターン（Read/Edit/Bashの組み合わせ）を優先
  const hasRead = sequence.includes("Read");
  const hasEdit = sequence.includes("Edit");
  const hasBash = sequence.includes("Bash");

  // Read -> Edit または Edit -> Bash のパターンは有意義
  if ((hasRead && hasEdit) || (hasEdit && hasBash)) {
    return true;
  }

  // それ以外でも高頻度なら許可
  return frequency >= 10;
};

// サマリーを生成
const generateSummary = (
  sessionMetrics: SessionMetrics[],
  patterns: OperationPattern[],
  efficiency: EfficiencyEvaluation,
): AnalysisSummary => {
  const totalToolCalls = sessionMetrics.reduce(
    (sum, m) => sum + m.totalToolCalls,
    0,
  );
  const totalErrors = sessionMetrics.reduce((sum, m) => sum + m.errorCount, 0);

  // 最も使われたツール
  const toolCounts: Record<string, number> = {};
  for (const metrics of sessionMetrics) {
    for (const [tool, count] of Object.entries(metrics.toolBreakdown)) {
      toolCounts[tool] = (toolCounts[tool] || 0) + count;
    }
  }

  const mostUsedTools = Object.entries(toolCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([name, count]) => ({ name, count }));

  // 最も頻繁なパターン
  const mostFrequentPatterns = patterns
    .sort((a, b) => b.frequency - a.frequency)
    .slice(0, 5)
    .map((p) => ({ sequence: p.sequence, frequency: p.frequency }));

  return {
    totalToolCalls,
    totalErrors,
    overallErrorRate: totalToolCalls > 0 ? totalErrors / totalToolCalls : 0,
    mostUsedTools,
    mostFrequentPatterns,
    topRecommendations: efficiency.recommendations.slice(0, 3),
  };
};

// 分析を集約
const aggregateAnalysis = (
  sessions: SessionInfo[],
  options?: {
    includePatterns?: boolean;
    patternMinFrequency?: number;
    patternMaxLength?: number;
  },
): AggregatedAnalysis => {
  const allToolUsages: ToolUsage[] = [];
  const allToolResults: ToolResult[] = [];
  const sessionMetrics: SessionMetrics[] = [];

  for (const session of sessions) {
    const toolUsages = parseToolUsage(session.path);
    const toolResults = parseToolResults(session.path);

    allToolUsages.push(...toolUsages);
    allToolResults.push(...toolResults);

    const metrics = calculateSessionMetrics(session, toolUsages, toolResults);
    sessionMetrics.push(metrics);
  }

  // 効率性評価
  const efficiency = evaluateEfficiency(
    allToolUsages,
    allToolResults,
    sessionMetrics,
  );

  // パターン検出
  const patterns =
    options?.includePatterns !== false
      ? detectPatterns(allToolUsages, {
          minFrequency: options?.patternMinFrequency ?? 2,
          maxSequenceLength: options?.patternMaxLength ?? 5,
          minSequenceLength: 2,
        })
      : [];

  // Skill候補の生成（改善版）
  const existingNames = new Set<string>();
  const skillCandidates: SkillCandidate[] = patterns
    .filter((p: OperationPattern) => isValidSkillPattern(p))
    .map((p: OperationPattern, index: number) => {
      const category = inferSkillCategory(p);
      const name = generateSkillName(p, category, existingNames);
      const description = generateSkillDescription(p, category);
      const triggerConditions = generateTriggerConditions(p, category);

      return {
        id: `skill-${index + 1}`,
        name,
        description,
        category,
        triggerConditions,
        steps: p.sequence.map((toolName: string, order: number) => ({
          order: order + 1,
          action: `Execute ${toolName}`,
          toolName,
        })),
        expectedFrequency: p.frequency,
        estimatedTimeSaved: `${p.sequence.length * 5} seconds per invocation`,
        sourcePatterns: [p.id],
        relatedFiles: p.commonFilePaths,
        relatedCommands: p.commonCommands,
      };
    });

  // サマリー生成
  const summary = generateSummary(sessionMetrics, patterns, efficiency);

  // 期間の計算
  const sortedSessions = [...sessions].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );

  return {
    analyzedPeriod: {
      start: sortedSessions[0]?.startTime || new Date().toISOString(),
      end:
        sortedSessions[sortedSessions.length - 1]?.startTime ||
        new Date().toISOString(),
      totalSessions: sessions.length,
    },
    sessionMetrics,
    patterns,
    efficiency,
    skillCandidates,
    summary,
  };
};

export { calculateSessionMetrics, evaluateEfficiency, aggregateAnalysis };
