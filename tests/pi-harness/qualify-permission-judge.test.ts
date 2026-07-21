import { describe, expect, test } from "bun:test";
import type {
  JudgeOutcome,
  PermissionJudge,
} from "../../pi/extensions/pi-harness/features/permission-policy/judge";
import {
  assessQualification,
  main,
  QUALIFICATION_CORPUS,
} from "../../scripts/qualify-permission-judge";

const outcomeFor = (command: string): JudgeOutcome => {
  const sample = QUALIFICATION_CORPUS.find(
    (candidate) => candidate.command === command,
  );
  if (sample === undefined) {
    return { kind: "unavailable", reason: "unknown qualification sample" };
  }
  return sample.expected === "ask"
    ? { kind: "ask", reason: "requires confirmation" }
    : { kind: "allow", cached: false };
};

const judgeFrom = (
  classify: (command: string) => JudgeOutcome,
): PermissionJudge => ({
  judge: async (command) => classify(command),
  clear: () => {},
});

describe("permission judge qualification", () => {
  test("requires every contextual sample to match its exact verdict", () => {
    const outcomes = QUALIFICATION_CORPUS.map((sample) =>
      outcomeFor(sample.command),
    );
    const report = assessQualification(QUALIFICATION_CORPUS, outcomes);

    expect(report.qualified).toBe(true);
    expect(report.liveVerdicts).toBe(true);
    expect(report.expectedAllowCount).toBe(13);
    expect(report.allowMatchCount).toBe(13);
  });

  test("rejects a risky ALLOW, a required-safe ASK, or a non-live outcome", () => {
    const exactOutcomes = QUALIFICATION_CORPUS.map((sample) =>
      outcomeFor(sample.command),
    );
    const riskyIndex = QUALIFICATION_CORPUS.findIndex(
      (sample) => sample.expected === "ask",
    );
    const riskyAllow = [...exactOutcomes];
    riskyAllow[riskyIndex] = { kind: "allow", cached: false };
    expect(
      assessQualification(QUALIFICATION_CORPUS, riskyAllow).qualified,
    ).toBe(false);

    const safeIndex = QUALIFICATION_CORPUS.findIndex(
      (sample) => sample.expected === "allow",
    );
    const safeAsk = [...exactOutcomes];
    safeAsk[safeIndex] = { kind: "ask", reason: "too conservative" };
    const safeAskReport = assessQualification(QUALIFICATION_CORPUS, safeAsk);
    expect(safeAskReport.qualified).toBe(false);
    expect(safeAskReport.allowMatchCount).toBe(12);

    const unavailable = [...exactOutcomes];
    unavailable[0] = { kind: "timeout", reason: "timed out" };
    const unavailableReport = assessQualification(
      QUALIFICATION_CORPUS,
      unavailable,
    );
    expect(unavailableReport.qualified).toBe(false);
    expect(unavailableReport.liveVerdicts).toBe(false);
  });

  test("main emits an auditable contextual report and returns the process status", async () => {
    const output: string[] = [];
    const code = await main({
      createJudge: () => judgeFrom(outcomeFor),
      readVersion: async () => "0.test.0",
      now: () => new Date("2026-07-21T00:00:00.000Z"),
      write: (text) => output.push(text),
    });

    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      qualified: true,
      qualifiedAt: "2026-07-21T00:00:00.000Z",
      ollamaVersion: "0.test.0",
      expectedAllowCount: 13,
      allowMatchCount: 13,
      liveVerdicts: true,
    });
  });

  test("main returns non-zero when version capture fails", async () => {
    const output: string[] = [];
    const code = await main({
      createJudge: () => judgeFrom(outcomeFor),
      readVersion: async () => {
        throw new Error("version unavailable");
      },
      write: (text) => output.push(text),
    });

    expect(code).toBe(1);
    expect(JSON.parse(output[0] ?? "")).toEqual({
      qualified: false,
      error: "version unavailable",
    });
  });
});
