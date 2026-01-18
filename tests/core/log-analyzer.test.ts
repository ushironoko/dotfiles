import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  calculateSessionMetrics,
  evaluateEfficiency,
  aggregateAnalysis,
} from "../../src/core/log-analyzer";
import type { SessionInfo, ToolUsage } from "../../src/core/log-parser";
import type { ToolResult } from "../../src/types/analysis";

describe("log-analyzer", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `log-analyzer-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("calculateSessionMetrics", () => {
    it("should calculate metrics for a session with tool usages", async () => {
      // Create a test session file
      const sessionPath = join(testDir, "test-session.jsonl");
      const sessionData = [
        {
          type: "user",
          timestamp: "2025-01-18T10:00:00Z",
          message: { content: "Hello" },
        },
        {
          type: "assistant",
          timestamp: "2025-01-18T10:00:05Z",
          message: {
            content: [{ type: "tool_use", name: "Read", input: {} }],
          },
        },
        {
          type: "user",
          timestamp: "2025-01-18T10:00:10Z",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "1", is_error: false },
            ],
          },
        },
        {
          type: "assistant",
          timestamp: "2025-01-18T10:01:00Z",
          message: {
            content: [{ type: "tool_use", name: "Edit", input: {} }],
          },
        },
      ];
      await fs.writeFile(
        sessionPath,
        sessionData.map((d) => JSON.stringify(d)).join("\n"),
      );

      const sessionInfo: SessionInfo = {
        id: "test-session",
        path: sessionPath,
        startTime: "2025-01-18T10:00:00Z",
        project: "test-project",
      };

      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:05Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:01:00Z",
          toolName: "Edit",
          toolInput: {},
          success: true,
        },
      ];

      const toolResults: ToolResult[] = [
        {
          timestamp: "2025-01-18T10:00:10Z",
          toolUseId: "1",
          toolName: "Read",
          isError: false,
        },
      ];

      const metrics = calculateSessionMetrics(
        sessionInfo,
        toolUsages,
        toolResults,
      );

      expect(metrics.sessionId).toBe("test-session");
      expect(metrics.projectName).toBe("test-project");
      expect(metrics.totalToolCalls).toBe(2);
      expect(metrics.errorCount).toBe(0);
      expect(metrics.errorRate).toBe(0);
      expect(metrics.uniqueToolsUsed).toBe(2);
      expect(metrics.toolBreakdown).toEqual({ Read: 1, Edit: 1 });
    });

    it("should calculate error rate correctly", async () => {
      const sessionPath = join(testDir, "error-session.jsonl");
      const sessionData = [
        {
          type: "user",
          timestamp: "2025-01-18T10:00:00Z",
          message: { content: "test" },
        },
      ];
      await fs.writeFile(
        sessionPath,
        sessionData.map((d) => JSON.stringify(d)).join("\n"),
      );

      const sessionInfo: SessionInfo = {
        id: "error-session",
        path: sessionPath,
        startTime: "2025-01-18T10:00:00Z",
        project: "test",
      };

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
          success: false,
        },
      ];

      const toolResults: ToolResult[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolUseId: "1",
          toolName: "Read",
          isError: false,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolUseId: "2",
          toolName: "Edit",
          isError: true,
          errorMessage: "Failed",
        },
      ];

      const metrics = calculateSessionMetrics(
        sessionInfo,
        toolUsages,
        toolResults,
      );

      expect(metrics.errorCount).toBe(1);
      expect(metrics.errorRate).toBe(0.5);
    });
  });

  describe("evaluateEfficiency", () => {
    it("should evaluate efficiency with no issues for low error rate", () => {
      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Read",
          toolInput: {},
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolName: "Glob",
          toolInput: {},
          success: true,
        },
      ];

      const toolResults: ToolResult[] = [];

      const sessionMetrics = [
        {
          sessionId: "session1",
          sessionPath: "/path/to/session",
          projectName: "test",
          startTime: "2025-01-18T10:00:00Z",
          endTime: "2025-01-18T10:10:00Z",
          durationMinutes: 10,
          totalToolCalls: 2,
          errorCount: 0,
          errorRate: 0,
          uniqueToolsUsed: 2,
          userMessageCount: 1,
          assistantMessageCount: 2,
          toolBreakdown: { Read: 1, Glob: 1 },
        },
      ];

      const efficiency = evaluateEfficiency(
        toolUsages,
        toolResults,
        sessionMetrics,
      );

      expect(efficiency.overallScore).toBeGreaterThan(90);
      expect(efficiency.metrics.errorRate).toBe(0);
      expect(efficiency.issues.length).toBe(0);
    });

    it("should detect high error rate issue", () => {
      const toolUsages: ToolUsage[] = [];
      const toolResults: ToolResult[] = [];

      const sessionMetrics = [
        {
          sessionId: "session1",
          sessionPath: "/path/to/session",
          projectName: "test",
          startTime: "2025-01-18T10:00:00Z",
          endTime: "2025-01-18T10:10:00Z",
          durationMinutes: 10,
          totalToolCalls: 10,
          errorCount: 3,
          errorRate: 0.3,
          uniqueToolsUsed: 3,
          userMessageCount: 2,
          assistantMessageCount: 5,
          toolBreakdown: { Read: 5, Edit: 3, Bash: 2 },
        },
      ];

      const efficiency = evaluateEfficiency(
        toolUsages,
        toolResults,
        sessionMetrics,
      );

      expect(efficiency.metrics.errorRate).toBe(0.3);
      expect(efficiency.issues.some((i) => i.type === "high_error_rate")).toBe(
        true,
      );
    });

    it("should detect excessive retries", () => {
      const toolUsages: ToolUsage[] = [
        {
          timestamp: "2025-01-18T10:00:01Z",
          toolName: "Edit",
          toolInput: { file_path: "/test.ts" },
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:02Z",
          toolName: "Edit",
          toolInput: { file_path: "/test.ts" },
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:03Z",
          toolName: "Edit",
          toolInput: { file_path: "/test.ts" },
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:04Z",
          toolName: "Read",
          toolInput: { file_path: "/other.ts" },
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:05Z",
          toolName: "Edit",
          toolInput: { file_path: "/other.ts" },
          success: true,
        },
        {
          timestamp: "2025-01-18T10:00:06Z",
          toolName: "Edit",
          toolInput: { file_path: "/other.ts" },
          success: true,
        },
      ];

      const toolResults: ToolResult[] = [];

      const sessionMetrics = [
        {
          sessionId: "session1",
          sessionPath: "/path/to/session",
          projectName: "test",
          startTime: "2025-01-18T10:00:00Z",
          endTime: "2025-01-18T10:10:00Z",
          durationMinutes: 10,
          totalToolCalls: 6,
          errorCount: 0,
          errorRate: 0,
          uniqueToolsUsed: 2,
          userMessageCount: 1,
          assistantMessageCount: 3,
          toolBreakdown: { Edit: 5, Read: 1 },
        },
      ];

      const efficiency = evaluateEfficiency(
        toolUsages,
        toolResults,
        sessionMetrics,
      );

      expect(efficiency.metrics.retryRate).toBeGreaterThan(0);
    });
  });

  describe("aggregateAnalysis", () => {
    it("should aggregate analysis from multiple sessions", async () => {
      // Create test session files
      const session1Path = join(testDir, "session1.jsonl");
      const session2Path = join(testDir, "session2.jsonl");

      const session1Data = [
        {
          type: "user",
          timestamp: "2025-01-17T10:00:00Z",
          message: { content: "Task 1" },
        },
        {
          type: "assistant",
          timestamp: "2025-01-17T10:00:05Z",
          message: { content: [{ type: "tool_use", name: "Read", input: {} }] },
        },
      ];

      const session2Data = [
        {
          type: "user",
          timestamp: "2025-01-18T10:00:00Z",
          message: { content: "Task 2" },
        },
        {
          type: "assistant",
          timestamp: "2025-01-18T10:00:05Z",
          message: { content: [{ type: "tool_use", name: "Edit", input: {} }] },
        },
      ];

      await fs.writeFile(
        session1Path,
        session1Data.map((d) => JSON.stringify(d)).join("\n"),
      );
      await fs.writeFile(
        session2Path,
        session2Data.map((d) => JSON.stringify(d)).join("\n"),
      );

      const sessions: SessionInfo[] = [
        {
          id: "session1",
          path: session1Path,
          startTime: "2025-01-17T10:00:00Z",
          project: "test",
        },
        {
          id: "session2",
          path: session2Path,
          startTime: "2025-01-18T10:00:00Z",
          project: "test",
        },
      ];

      const analysis = aggregateAnalysis(sessions, { includePatterns: false });

      expect(analysis.analyzedPeriod.totalSessions).toBe(2);
      expect(analysis.sessionMetrics.length).toBe(2);
      expect(analysis.summary.totalToolCalls).toBe(2);
    });

    it("should return empty analysis for no sessions", () => {
      const analysis = aggregateAnalysis([]);

      expect(analysis.analyzedPeriod.totalSessions).toBe(0);
      expect(analysis.sessionMetrics.length).toBe(0);
      expect(analysis.summary.totalToolCalls).toBe(0);
    });
  });
});
