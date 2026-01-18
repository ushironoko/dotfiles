import { colors } from "consola/utils";
import { define } from "../utils/command-helpers.js";
import { listSessionsInPeriod, listSessions } from "../core/log-parser.js";
import { aggregateAnalysis } from "../core/log-analyzer.js";
import type {
  AggregatedAnalysis,
  AnalyzeOptions,
  SessionMetrics,
  OperationPattern,
  EfficiencyEvaluation,
  Recommendation,
} from "../types/analysis.js";

const DEFAULT_DAYS = 7;
const DEFAULT_PATTERN_MIN_FREQUENCY = 2;
const DEFAULT_PATTERN_MAX_LENGTH = 5;

// テキストフォーマットで出力
const formatText = (
  analysis: AggregatedAnalysis,
  options: AnalyzeOptions,
): void => {
  const { summary, efficiency, sessionMetrics, patterns, skillCandidates } =
    analysis;

  console.log(colors.bold(colors.cyan("\n=== Claude Code Log Analysis ===")));
  console.log(colors.gray("─".repeat(50)));

  // 分析期間
  console.log(
    colors.bold("\nAnalyzed Period:"),
    `${analysis.analyzedPeriod.start.slice(0, 10)} - ${analysis.analyzedPeriod.end.slice(0, 10)}`,
  );
  console.log(
    colors.bold("Total Sessions:"),
    analysis.analyzedPeriod.totalSessions,
  );

  // サマリー
  console.log(colors.bold(colors.cyan("\n--- Summary ---")));
  console.log(`Total Tool Calls: ${summary.totalToolCalls}`);
  console.log(`Total Errors: ${summary.totalErrors}`);
  console.log(`Error Rate: ${(summary.overallErrorRate * 100).toFixed(1)}%`);

  // 最も使われたツール
  console.log(colors.bold("\nMost Used Tools:"));
  for (const tool of summary.mostUsedTools.slice(0, 5)) {
    console.log(`  ${colors.cyan(tool.name)}: ${tool.count} calls`);
  }

  // 効率性スコア
  printEfficiencySection(efficiency);

  // パターン
  if (options.includePatterns !== false && patterns.length > 0) {
    printPatternsSection(patterns);
  }

  // セッション詳細（verbose時のみ）
  if (options.verbose) {
    printSessionsDetail(sessionMetrics);
  }

  // Skill候補
  if (skillCandidates.length > 0) {
    console.log(colors.bold(colors.cyan("\n--- Skill Candidates ---")));
    for (const skill of skillCandidates.slice(0, 3)) {
      console.log(`\n${colors.green("*")} ${colors.bold(skill.name)}`);
      console.log(`  ${skill.description}`);
      console.log(`  Frequency: ${skill.expectedFrequency} times`);
      console.log(`  Est. Time Saved: ${skill.estimatedTimeSaved}`);
    }
  }

  // 推奨事項
  if (summary.topRecommendations.length > 0) {
    printRecommendationsSection(summary.topRecommendations);
  }

  console.log(colors.gray(`\n${"─".repeat(50)}`));
};

// スコアに応じた色を取得
const getScoreColor = (score: number): typeof colors.green => {
  if (score >= 80) return colors.green;
  if (score >= 60) return colors.yellow;
  return colors.red;
};

// 重要度に応じたアイコンを取得
const getSeverityIcon = (severity: "low" | "medium" | "high"): string => {
  if (severity === "high") return colors.red("!");
  if (severity === "medium") return colors.yellow("!");
  return colors.gray("!");
};

// 優先度に応じたアイコンを取得
const getPriorityIcon = (priority: "low" | "medium" | "high"): string => {
  if (priority === "high") return colors.red("[HIGH]");
  if (priority === "medium") return colors.yellow("[MED]");
  return colors.gray("[LOW]");
};

// 効率性セクションを出力
const printEfficiencySection = (efficiency: EfficiencyEvaluation): void => {
  console.log(colors.bold(colors.cyan("\n--- Efficiency Score ---")));

  const scoreColor = getScoreColor(efficiency.overallScore);

  console.log(
    `Overall Score: ${scoreColor(`${efficiency.overallScore.toFixed(0)}/100`)}`,
  );
  console.log(
    `  Error Rate: ${(efficiency.metrics.errorRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  Retry Rate: ${(efficiency.metrics.retryRate * 100).toFixed(1)}%`,
  );
  console.log(`  Tool Diversity: ${efficiency.metrics.toolDiversity} tools`);
  console.log(
    `  Avg Tools/Task: ${efficiency.metrics.averageToolsPerTask.toFixed(1)}`,
  );

  if (efficiency.issues.length > 0) {
    console.log(colors.bold("\nIssues:"));
    for (const issue of efficiency.issues) {
      const severityIcon = getSeverityIcon(issue.severity);
      console.log(`  ${severityIcon} ${issue.description}`);
      if (issue.suggestedFix) {
        console.log(`    Fix: ${colors.cyan(issue.suggestedFix)}`);
      }
    }
  }
};

// パターンセクションを出力
const printPatternsSection = (patterns: OperationPattern[]): void => {
  console.log(colors.bold(colors.cyan("\n--- Detected Patterns ---")));
  for (const pattern of patterns.slice(0, 5)) {
    console.log(
      `\n${colors.green("*")} ${pattern.sequence.join(" -> ")} (${pattern.frequency}x)`,
    );
    console.log(`  First seen: ${pattern.firstSeen.slice(0, 10)}`);
    console.log(`  Success rate: ${(pattern.successRate * 100).toFixed(0)}%`);
  }
};

// セッション詳細を出力
const printSessionsDetail = (sessionMetrics: SessionMetrics[]): void => {
  console.log(colors.bold(colors.cyan("\n--- Session Details ---")));
  for (const metrics of sessionMetrics) {
    console.log(
      `\n${colors.bold(metrics.sessionId.slice(0, 8))}... (${metrics.projectName})`,
    );
    console.log(`  Duration: ${metrics.durationMinutes.toFixed(1)} minutes`);
    console.log(`  Tool Calls: ${metrics.totalToolCalls}`);
    console.log(`  Errors: ${metrics.errorCount}`);
    console.log(`  User Messages: ${metrics.userMessageCount}`);
  }
};

// 推奨事項セクションを出力
const printRecommendationsSection = (
  recommendations: Recommendation[],
): void => {
  console.log(colors.bold(colors.cyan("\n--- Recommendations ---")));
  for (const rec of recommendations) {
    const priorityIcon = getPriorityIcon(rec.priority);
    console.log(`\n${priorityIcon} ${colors.bold(rec.title)}`);
    console.log(`  ${rec.description}`);
    console.log(`  Expected: ${colors.green(rec.expectedBenefit)}`);
  }
};

// Markdownフォーマットで出力
const formatMarkdown = (analysis: AggregatedAnalysis): void => {
  const { summary, efficiency, patterns, skillCandidates } = analysis;

  console.log("# Claude Code Log Analysis Report\n");
  console.log(
    `**Period:** ${analysis.analyzedPeriod.start.slice(0, 10)} - ${analysis.analyzedPeriod.end.slice(0, 10)}`,
  );
  console.log(`**Total Sessions:** ${analysis.analyzedPeriod.totalSessions}\n`);

  console.log("## Summary\n");
  console.log(`| Metric | Value |`);
  console.log(`|--------|-------|`);
  console.log(`| Total Tool Calls | ${summary.totalToolCalls} |`);
  console.log(`| Total Errors | ${summary.totalErrors} |`);
  console.log(
    `| Error Rate | ${(summary.overallErrorRate * 100).toFixed(1)}% |`,
  );
  console.log(
    `| Efficiency Score | ${efficiency.overallScore.toFixed(0)}/100 |`,
  );

  console.log("\n## Most Used Tools\n");
  for (const tool of summary.mostUsedTools.slice(0, 10)) {
    console.log(`- **${tool.name}**: ${tool.count} calls`);
  }

  if (patterns.length > 0) {
    console.log("\n## Detected Patterns\n");
    for (const pattern of patterns.slice(0, 10)) {
      console.log(
        `### ${pattern.sequence.join(" → ")} (${pattern.frequency}x)\n`,
      );
      console.log(`- First seen: ${pattern.firstSeen.slice(0, 10)}`);
      console.log(
        `- Success rate: ${(pattern.successRate * 100).toFixed(0)}%\n`,
      );
    }
  }

  if (skillCandidates.length > 0) {
    console.log("\n## Skill Candidates\n");
    for (const skill of skillCandidates) {
      console.log(`### ${skill.name}\n`);
      console.log(`${skill.description}\n`);
      console.log(`- **Frequency:** ${skill.expectedFrequency} times`);
      console.log(`- **Time Saved:** ${skill.estimatedTimeSaved}\n`);
    }
  }

  if (summary.topRecommendations.length > 0) {
    console.log("\n## Recommendations\n");
    for (const rec of summary.topRecommendations) {
      console.log(`### [${rec.priority.toUpperCase()}] ${rec.title}\n`);
      console.log(`${rec.description}\n`);
      console.log(`**Expected Benefit:** ${rec.expectedBenefit}\n`);
    }
  }
};

// JSONフォーマットで出力
const formatJson = (analysis: AggregatedAnalysis): void => {
  console.log(JSON.stringify(analysis, undefined, 2));
};

// メイン分析処理
const runAnalysis = async (options: AnalyzeOptions): Promise<void> => {
  const { sessionId, days = DEFAULT_DAYS, format = "text", verbose } = options;

  // セッション取得
  let sessions;
  if (sessionId) {
    // 特定セッションを指定
    const allSessions = listSessions();
    const targetSession = allSessions.find((s) => s.id === sessionId);
    if (!targetSession) {
      console.error(colors.red(`Session not found: ${sessionId}`));
      process.exit(1);
    }
    sessions = [targetSession];
  } else {
    // 期間内のセッションを取得
    sessions = listSessionsInPeriod(days);
  }

  if (sessions.length === 0) {
    console.log(colors.yellow("No sessions found in the specified period."));
    return;
  }

  if (verbose) {
    console.log(colors.gray(`Found ${sessions.length} sessions to analyze.`));
  }

  // 分析実行
  const analysis = aggregateAnalysis(sessions, {
    includePatterns: options.includePatterns ?? true,
    patternMinFrequency:
      options.patternMinFrequency ?? DEFAULT_PATTERN_MIN_FREQUENCY,
    patternMaxLength: options.patternMaxLength ?? DEFAULT_PATTERN_MAX_LENGTH,
  });

  // 出力
  switch (format) {
    case "json": {
      formatJson(analysis);
      break;
    }
    case "markdown": {
      formatMarkdown(analysis);
      break;
    }
    default: {
      formatText(analysis, options);
    }
  }
};

// コマンド定義
export const analyzeCommand = define({
  name: "analyze",
  description: "Analyze Claude Code operation logs",
  args: {
    verbose: {
      default: false,
      description: "Verbose output with session details",
      short: "v",
      type: "boolean",
    },
    session: {
      description: "Analyze a specific session by ID",
      short: "s",
      type: "string",
    },
    days: {
      default: DEFAULT_DAYS,
      description: "Number of days to analyze (default: 7)",
      short: "d",
      type: "number",
    },
    format: {
      default: "text",
      description: "Output format: text, json, or markdown",
      short: "f",
      type: "string",
    },
    patterns: {
      default: true,
      description: "Include pattern detection in analysis",
      short: "p",
      type: "boolean",
    },
    minFrequency: {
      default: DEFAULT_PATTERN_MIN_FREQUENCY,
      description: "Minimum pattern frequency to report",
      type: "number",
    },
    maxLength: {
      default: DEFAULT_PATTERN_MAX_LENGTH,
      description: "Maximum pattern sequence length",
      type: "number",
    },
  },
  run: async (ctx) => {
    await runAnalysis({
      sessionId: ctx.values.session,
      days: ctx.values.days,
      format: ctx.values.format as "text" | "json" | "markdown",
      verbose: ctx.values.verbose,
      includePatterns: ctx.values.patterns,
      patternMinFrequency: ctx.values.minFrequency,
      patternMaxLength: ctx.values.maxLength,
    });
  },
});
