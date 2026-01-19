import type {
  OperationPattern,
  PatternContext,
  PatternDetectionOptions,
} from "../types/analysis.js";
import type { ToolUsage } from "./log-parser.js";

// パターン出現の内部型
interface PatternOccurrence {
  startIndex: number;
  timestamp: string;
  surroundingTools: string[];
  // 拡張: コンテキスト情報
  bashCommands: string[];
  filePaths: string[];
  bashCategories: string[];
}

// 内部用の拡張ToolUsage
interface EnrichedToolSequenceItem {
  name: string;
  timestamp: string;
  bashCommand?: string;
  bashCategory?: string;
  filePath?: string;
}

// 周辺のツールを取得
const getSurroundingTools = (
  sequence: EnrichedToolSequenceItem[],
  startIndex: number,
  length: number,
): string[] => {
  const context: string[] = [];
  const CONTEXT_SIZE = 2;

  // 前のツール
  for (let i = Math.max(0, startIndex - CONTEXT_SIZE); i < startIndex; i++) {
    context.push(sequence[i].name);
  }

  // 後のツール
  for (
    let i = startIndex + length;
    i < Math.min(sequence.length, startIndex + length + CONTEXT_SIZE);
    i++
  ) {
    context.push(sequence[i].name);
  }

  return context;
};

// 配列から上位N件を取得（重複カウント）
const getTopItems = (items: string[], limit: number): string[] => {
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([item]) => item);
};

// 最も頻繁な要素を取得
const getMostFrequent = (items: string[]): string | undefined => {
  if (items.length === 0) return undefined;

  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }

  let maxCount = 0;
  let mostFrequent: string | undefined;
  for (const [item, count] of counts) {
    if (count > maxCount) {
      maxCount = count;
      mostFrequent = item;
    }
  }

  return mostFrequent;
};

// パターン内のコンテキスト情報を抽出
const extractPatternContext = (
  sequence: EnrichedToolSequenceItem[],
  startIndex: number,
  length: number,
): {
  bashCommands: string[];
  filePaths: string[];
  bashCategories: string[];
} => {
  const bashCommands: string[] = [];
  const filePaths: string[] = [];
  const bashCategories: string[] = [];

  for (
    let i = startIndex;
    i < startIndex + length && i < sequence.length;
    i++
  ) {
    const item = sequence[i];
    if (item.bashCommand) {
      bashCommands.push(item.bashCommand);
    }
    if (item.bashCategory) {
      bashCategories.push(item.bashCategory);
    }
    if (item.filePath) {
      filePaths.push(item.filePath);
    }
  }

  return { bashCommands, filePaths, bashCategories };
};

// N-gramベースのパターン検出
const detectPatterns = (
  toolUsages: ToolUsage[],
  options: PatternDetectionOptions,
): OperationPattern[] => {
  const { minFrequency, maxSequenceLength, minSequenceLength, excludeTools } =
    options;

  // ツール名のシーケンスを抽出（拡張情報付き）
  const toolSequence: EnrichedToolSequenceItem[] = toolUsages
    .filter((u) => !excludeTools?.includes(u.toolName))
    .map((u) => ({
      name: u.toolName,
      timestamp: u.timestamp,
      bashCommand: u.bashCommand,
      bashCategory: u.bashCategory,
      filePath: u.filePath,
    }));

  if (toolSequence.length < minSequenceLength) {
    return [];
  }

  // N-gramカウント
  const patternCounts = new Map<string, PatternOccurrence[]>();

  for (let n = minSequenceLength; n <= maxSequenceLength; n++) {
    for (let i = 0; i <= toolSequence.length - n; i++) {
      const sequence = toolSequence.slice(i, i + n);
      const key = sequence.map((s) => s.name).join("|");

      // コンテキスト情報を抽出
      const context = extractPatternContext(toolSequence, i, n);

      const occurrence: PatternOccurrence = {
        startIndex: i,
        timestamp: sequence[0].timestamp,
        surroundingTools: getSurroundingTools(toolSequence, i, n),
        bashCommands: context.bashCommands,
        filePaths: context.filePaths,
        bashCategories: context.bashCategories,
      };

      const existing = patternCounts.get(key);
      if (existing) {
        existing.push(occurrence);
      } else {
        patternCounts.set(key, [occurrence]);
      }
    }
  }

  // 頻度でフィルタリングしてパターンを生成
  const patterns: OperationPattern[] = [];
  let patternId = 0;

  for (const [key, occurrences] of patternCounts) {
    if (occurrences.length >= minFrequency) {
      const sequence = key.split("|");

      // サブパターンに含まれるものは除外（より長いパターンを優先）
      const isSubpattern = [...patternCounts.keys()].some(
        (otherKey) =>
          otherKey !== key &&
          otherKey.includes(key) &&
          (patternCounts.get(otherKey)?.length ?? 0) >= minFrequency,
      );

      if (isSubpattern) {
        continue;
      }

      const timestamps = occurrences.map((o) => o.timestamp);
      const sortedTimestamps = [...timestamps].sort();

      // 成功率の計算（簡易版：ここではtool_resultの情報がないため100%とする）
      const successRate = 1;

      // コンテキスト情報を含めてPatternContextを生成
      const contexts: PatternContext[] = occurrences.map((o) => ({
        sessionId: "aggregate",
        timestamp: o.timestamp,
        surroundingTools: o.surroundingTools,
        bashCommands: o.bashCommands.length > 0 ? o.bashCommands : undefined,
        filePaths: o.filePaths.length > 0 ? o.filePaths : undefined,
      }));

      // 全occurrenceから共通コマンド・ファイルパスを集計
      const allBashCommands = occurrences.flatMap((o) => o.bashCommands);
      const allFilePaths = occurrences.flatMap((o) => o.filePaths);
      const allBashCategories = occurrences.flatMap((o) => o.bashCategories);

      // よく使われるコマンドとファイルパスを抽出
      const commonCommands = getTopItems(allBashCommands, 5);
      const commonFilePaths = getTopItems(allFilePaths, 5);

      // パターンのカテゴリを決定（最も頻繁なBashカテゴリ）
      const category = getMostFrequent(allBashCategories);

      patterns.push({
        id: `pattern-${++patternId}`,
        sequence,
        frequency: occurrences.length,
        contexts,
        firstSeen: sortedTimestamps[0],
        lastSeen: sortedTimestamps[sortedTimestamps.length - 1],
        successRate,
        category,
        commonCommands: commonCommands.length > 0 ? commonCommands : undefined,
        commonFilePaths:
          commonFilePaths.length > 0 ? commonFilePaths : undefined,
      });
    }
  }

  // 頻度でソート
  return patterns.sort((a, b) => b.frequency - a.frequency);
};

// パターンのマージ（セッション横断で使用）
const mergePatterns = (
  patternSets: OperationPattern[][],
): OperationPattern[] => {
  const mergedMap = new Map<string, OperationPattern>();

  for (const patterns of patternSets) {
    for (const pattern of patterns) {
      const key = pattern.sequence.join("|");
      const existing = mergedMap.get(key);

      if (existing) {
        existing.frequency += pattern.frequency;
        existing.contexts.push(...pattern.contexts);

        if (pattern.firstSeen < existing.firstSeen) {
          existing.firstSeen = pattern.firstSeen;
        }
        if (pattern.lastSeen > existing.lastSeen) {
          existing.lastSeen = pattern.lastSeen;
        }
      } else {
        mergedMap.set(key, { ...pattern });
      }
    }
  }

  return [...mergedMap.values()].sort((a, b) => b.frequency - a.frequency);
};

// 特定のパターンを検索
const findPattern = (
  toolUsages: ToolUsage[],
  targetSequence: string[],
): { startIndex: number; timestamp: string }[] => {
  const matches: { startIndex: number; timestamp: string }[] = [];

  for (let i = 0; i <= toolUsages.length - targetSequence.length; i++) {
    let isMatch = true;
    for (let j = 0; j < targetSequence.length; j++) {
      if (toolUsages[i + j].toolName !== targetSequence[j]) {
        isMatch = false;
        break;
      }
    }

    if (isMatch) {
      matches.push({
        startIndex: i,
        timestamp: toolUsages[i].timestamp,
      });
    }
  }

  return matches;
};

// パターンの統計情報を計算
const calculatePatternStats = (
  patterns: OperationPattern[],
): {
  totalPatterns: number;
  averageFrequency: number;
  averageSequenceLength: number;
  mostCommonTool: string | undefined;
} => {
  if (patterns.length === 0) {
    return {
      totalPatterns: 0,
      averageFrequency: 0,
      averageSequenceLength: 0,
      mostCommonTool: undefined,
    };
  }

  const totalFrequency = patterns.reduce((sum, p) => sum + p.frequency, 0);
  const totalSequenceLength = patterns.reduce(
    (sum, p) => sum + p.sequence.length,
    0,
  );

  // 最も共通するツール
  const toolCounts = new Map<string, number>();
  for (const pattern of patterns) {
    for (const tool of pattern.sequence) {
      toolCounts.set(tool, (toolCounts.get(tool) || 0) + pattern.frequency);
    }
  }

  let mostCommonTool: string | undefined;
  let maxCount = 0;
  for (const [tool, count] of toolCounts) {
    if (count > maxCount) {
      maxCount = count;
      mostCommonTool = tool;
    }
  }

  return {
    totalPatterns: patterns.length,
    averageFrequency: totalFrequency / patterns.length,
    averageSequenceLength: totalSequenceLength / patterns.length,
    mostCommonTool,
  };
};

export { detectPatterns, mergePatterns, findPattern, calculatePatternStats };
