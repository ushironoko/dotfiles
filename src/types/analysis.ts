// ログ分析用の型定義

// ツール実行結果
export interface ToolResult {
  timestamp: string;
  toolUseId: string;
  toolName: string;
  isError: boolean;
  errorMessage?: string;
  content?: unknown;
}

// セッションメトリクス
export interface SessionMetrics {
  sessionId: string;
  sessionPath: string;
  projectName: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  totalToolCalls: number;
  errorCount: number;
  errorRate: number;
  uniqueToolsUsed: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolBreakdown: Record<string, number>;
}

// 操作パターン
export interface OperationPattern {
  id: string;
  sequence: string[];
  frequency: number;
  contexts: PatternContext[];
  firstSeen: string;
  lastSeen: string;
  successRate: number;
}

// パターンのコンテキスト情報
export interface PatternContext {
  sessionId: string;
  timestamp: string;
  surroundingTools: string[];
  userIntent?: string;
}

// 効率性評価
export interface EfficiencyEvaluation {
  overallScore: number;
  metrics: {
    errorRate: number;
    retryRate: number;
    toolDiversity: number;
    averageToolsPerTask: number;
  };
  issues: EfficiencyIssue[];
  recommendations: Recommendation[];
}

// 効率性の問題
export interface EfficiencyIssue {
  type:
    | "high_error_rate"
    | "excessive_retries"
    | "inefficient_pattern"
    | "underutilized_tool";
  severity: "low" | "medium" | "high";
  description: string;
  affectedSessions: string[];
  suggestedFix?: string;
}

// 推奨事項
export interface Recommendation {
  id: string;
  type:
    | "pattern_optimization"
    | "tool_suggestion"
    | "workflow_improvement"
    | "skill_candidate";
  priority: "low" | "medium" | "high";
  title: string;
  description: string;
  expectedBenefit: string;
  relatedPatterns?: string[];
}

// Skill候補
export interface SkillCandidate {
  id: string;
  name: string;
  description: string;
  triggerConditions: string[];
  steps: SkillStep[];
  expectedFrequency: number;
  estimatedTimeSaved: string;
  sourcePatterns: string[];
}

// Skillのステップ
export interface SkillStep {
  order: number;
  action: string;
  toolName?: string;
  parameters?: Record<string, unknown>;
  conditional?: string;
}

// 分析結果の集約
export interface AggregatedAnalysis {
  analyzedPeriod: {
    start: string;
    end: string;
    totalSessions: number;
  };
  sessionMetrics: SessionMetrics[];
  patterns: OperationPattern[];
  efficiency: EfficiencyEvaluation;
  skillCandidates: SkillCandidate[];
  summary: AnalysisSummary;
}

// 分析サマリー
export interface AnalysisSummary {
  totalToolCalls: number;
  totalErrors: number;
  overallErrorRate: number;
  mostUsedTools: { name: string; count: number }[];
  mostFrequentPatterns: { sequence: string[]; frequency: number }[];
  topRecommendations: Recommendation[];
}

// 分析オプション
export interface AnalyzeOptions {
  sessionId?: string;
  days?: number;
  format?: "text" | "json" | "markdown";
  verbose?: boolean;
  includePatterns?: boolean;
  patternMinFrequency?: number;
  patternMaxLength?: number;
}

// パターン検出オプション
export interface PatternDetectionOptions {
  minFrequency: number;
  maxSequenceLength: number;
  minSequenceLength: number;
  excludeTools?: string[];
}
