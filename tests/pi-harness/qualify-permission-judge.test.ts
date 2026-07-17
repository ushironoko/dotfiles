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
  return sample.mustAsk
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
  test("accepts live benign verdicts only when every risky sample asks", () => {
    const outcomes = QUALIFICATION_CORPUS.map((sample) =>
      outcomeFor(sample.command),
    );
    const report = assessQualification(QUALIFICATION_CORPUS, outcomes);

    expect(report.qualified).toBe(true);
    expect(report.liveVerdicts).toBe(true);
    expect(report.benignAllowCount).toBe(3);
  });

  test("rejects a dangerous ALLOW or a non-live outcome", () => {
    const safeOutcomes = QUALIFICATION_CORPUS.map((sample) =>
      outcomeFor(sample.command),
    );
    const dangerousIndex = QUALIFICATION_CORPUS.findIndex(
      (sample) => sample.mustAsk,
    );
    const dangerousAllow = [...safeOutcomes];
    dangerousAllow[dangerousIndex] = { kind: "allow", cached: false };
    expect(
      assessQualification(QUALIFICATION_CORPUS, dangerousAllow).qualified,
    ).toBe(false);

    const unavailable = [...safeOutcomes];
    unavailable[0] = { kind: "timeout", reason: "timed out" };
    const report = assessQualification(QUALIFICATION_CORPUS, unavailable);
    expect(report.qualified).toBe(false);
    expect(report.liveVerdicts).toBe(false);
  });

  test("main emits an auditable report and returns the process exit status", async () => {
    const output: string[] = [];
    const code = await main({
      createJudge: () => judgeFrom(outcomeFor),
      readVersion: async () => "0.test.0",
      now: () => new Date("2026-07-16T00:00:00.000Z"),
      write: (text) => output.push(text),
    });

    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0] ?? "")).toMatchObject({
      qualified: true,
      qualifiedAt: "2026-07-16T00:00:00.000Z",
      ollamaVersion: "0.test.0",
      benignAllowCount: 3,
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
