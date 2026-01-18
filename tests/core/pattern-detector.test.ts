import { describe, expect, it } from "bun:test";
import {
  detectPatterns,
  mergePatterns,
  findPattern,
  calculatePatternStats,
} from "../../src/core/pattern-detector";
import type { ToolUsage } from "../../src/core/log-parser";
import type { OperationPattern } from "../../src/types/analysis";

describe("pattern-detector", () => {
  describe("detectPatterns", () => {
    it("should detect repeated tool sequences", () => {
      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:03Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:04Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:05Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:06Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:07Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:08Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:09Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
      ];

      const patterns = detectPatterns(toolUsages, {
        minFrequency: 2,
        maxSequenceLength: 3,
        minSequenceLength: 2,
      });

      expect(patterns.length).toBeGreaterThan(0);

      // Check for Glob -> Read pattern
      const globReadPattern = patterns.find(
        (p) => p.sequence[0] === "Glob" && p.sequence[1] === "Read",
      );
      expect(globReadPattern).toBeDefined();
      expect(globReadPattern?.frequency).toBeGreaterThanOrEqual(2);
    });

    it("should respect minFrequency option", () => {
      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:03Z",
          toolName: "Bash",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:04Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
      ];

      const patterns = detectPatterns(toolUsages, {
        minFrequency: 3,
        maxSequenceLength: 3,
        minSequenceLength: 2,
      });

      expect(patterns.length).toBe(0);
    });

    it("should exclude specified tools", () => {
      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:03Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:04Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
      ];

      const patterns = detectPatterns(toolUsages, {
        minFrequency: 2,
        maxSequenceLength: 3,
        minSequenceLength: 2,
        excludeTools: ["Glob"],
      });

      // Should not find Glob patterns
      const hasGlobPattern = patterns.some((p) => p.sequence.includes("Glob"));
      expect(hasGlobPattern).toBe(false);
    });

    it("should return empty array for insufficient data", () => {
      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
      ];

      const patterns = detectPatterns(toolUsages, {
        minFrequency: 2,
        maxSequenceLength: 3,
        minSequenceLength: 2,
      });

      expect(patterns.length).toBe(0);
    });

    it("should sort patterns by frequency", () => {
      const toolUsages: ToolUsage[] = [
        // Pattern A (3 times)
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:03Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:04Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:05Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:06Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
        // Pattern B (2 times)
        {
          timestamp: "2025-01-18T10:00:07Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:08Z",
          toolName: "Bash",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:09Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:10Z",
          toolName: "Bash",
          toolInput: {},
          success: true,
        },
      ];

      const patterns = detectPatterns(toolUsages, {
        minFrequency: 2,
        maxSequenceLength: 2,
        minSequenceLength: 2,
      });

      if (patterns.length >= 2) {
        expect(patterns[0].frequency).toBeGreaterThanOrEqual(
          patterns[1].frequency,
        );
      }
    });
  });

  describe("mergePatterns", () => {
    it("should merge patterns from multiple sets", () => {
      const patternSet1: OperationPattern[] = [
        {
          id: "pattern-1",
          sequence: ["Read", "Edit"],
          frequency: 3,
          contexts: [],
          firstSeen: "2025-01-17T10:00:00Z",
          lastSeen: "2025-01-17T12:00:00Z",
          successRate: 1,
        },
      ];

      const patternSet2: OperationPattern[] = [
        {
          id: "pattern-2",
          sequence: ["Read", "Edit"],
          frequency: 2,
          contexts: [],
          firstSeen: "2025-01-18T10:00:00Z",
          lastSeen: "2025-01-18T12:00:00Z",
          successRate: 1,
        },
      ];

      const merged = mergePatterns([patternSet1, patternSet2]);

      expect(merged.length).toBe(1);
      expect(merged[0].frequency).toBe(5);
      expect(merged[0].firstSeen).toBe("2025-01-17T10:00:00Z");
      expect(merged[0].lastSeen).toBe("2025-01-18T12:00:00Z");
    });

    it("should keep distinct patterns separate", () => {
      const patternSet1: OperationPattern[] = [
        {
          id: "pattern-1",
          sequence: ["Read", "Edit"],
          frequency: 3,
          contexts: [],
          firstSeen: "2025-01-17T10:00:00Z",
          lastSeen: "2025-01-17T12:00:00Z",
          successRate: 1,
        },
      ];

      const patternSet2: OperationPattern[] = [
        {
          id: "pattern-2",
          sequence: ["Glob", "Read"],
          frequency: 2,
          contexts: [],
          firstSeen: "2025-01-18T10:00:00Z",
          lastSeen: "2025-01-18T12:00:00Z",
          successRate: 1,
        },
      ];

      const merged = mergePatterns([patternSet1, patternSet2]);

      expect(merged.length).toBe(2);
    });
  });

  describe("findPattern", () => {
    it("should find specific pattern occurrences", () => {
      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:03Z",
          toolName: "Bash",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:04Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:05Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
      ];

      const matches = findPattern(toolUsages, ["Read", "Edit"]);

      expect(matches.length).toBe(2);
      expect(matches[0].startIndex).toBe(0);
      expect(matches[1].startIndex).toBe(3);
    });

    it("should return empty array when pattern not found", () => {
      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolName: "Bash",
          toolInput: {},
          success: true,
        },
      ];

      const matches = findPattern(toolUsages, ["Edit", "Write"]);

      expect(matches.length).toBe(0);
    });
  });

  describe("calculatePatternStats", () => {
    it("should calculate statistics for patterns", () => {
      const patterns: OperationPattern[] = [
        {
          id: "pattern-1",
          sequence: ["Read", "Edit"],
          frequency: 10,
          contexts: [],
          firstSeen: "2025-01-17T10:00:00Z",
          lastSeen: "2025-01-18T12:00:00Z",
          successRate: 1,
        },
        {
          id: "pattern-2",
          sequence: ["Glob", "Read", "Edit"],
          frequency: 5,
          contexts: [],
          firstSeen: "2025-01-17T10:00:00Z",
          lastSeen: "2025-01-18T12:00:00Z",
          successRate: 1,
        },
      ];

      const stats = calculatePatternStats(patterns);

      expect(stats.totalPatterns).toBe(2);
      expect(stats.averageFrequency).toBe(7.5);
      expect(stats.averageSequenceLength).toBe(2.5);
      expect(stats.mostCommonTool).toBeDefined();
    });

    it("should handle empty patterns array", () => {
      const stats = calculatePatternStats([]);

      expect(stats.totalPatterns).toBe(0);
      expect(stats.averageFrequency).toBe(0);
      expect(stats.averageSequenceLength).toBe(0);
      expect(stats.mostCommonTool).toBeUndefined();
    });
  });
});
