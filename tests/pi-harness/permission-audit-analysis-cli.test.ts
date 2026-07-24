import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  buildPermissionCommand,
  buildPermissionDecisionRecord,
  type PermissionAuditStage,
  type PermissionDecisionRecordInput,
} from "../../pi/extensions/pi-harness/features/permission-audit/model";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";

const SCRIPT = join(
  import.meta.dir,
  "../../pi/skills/permission-audit-analysis/scripts/analyze.ts",
);
const WRITER_ID = "123e4567-e89b-42d3-a456-426614174000";
const LINEAGE_ID = "223e4567-e89b-42d3-a456-426614174000";
const CANARY = "private-command-CANARY";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupTestDirectory));
});

const tempRoot = async (): Promise<string> => {
  const root = await setupTestDirectory("permission-audit-analysis-cli");
  roots.push(root);
  return root;
};

const recordInput = (
  decisionId: string,
  sequence: number,
  command: string,
  stages: readonly PermissionAuditStage[],
  boundaryDisposition: "release" | "block",
): PermissionDecisionRecordInput => ({
  timestamp: `2026-07-24T00:00:0${sequence}.000Z`,
  decisionId,
  writerInstanceId: WRITER_ID,
  sequence,
  pid: 123,
  isChild: false,
  lineage: { lineageId: LINEAGE_ID, source: "generated" },
  sessionId: "session-1",
  toolCallId: `tool-${sequence}`,
  command: buildPermissionCommand(command),
  cwd: "/private/project",
  task: {
    correlation: "task",
    task: {
      text: `Handle ${CANARY}`,
      source: "interactive",
      fingerprint: `task-${sequence}`,
    },
  },
  stages,
  boundaryDisposition,
  terminalReasonCode:
    boundaryDisposition === "release"
      ? "permission-chain-released"
      : "confirmation-rejected",
});

const deterministicAllow: PermissionAuditStage = {
  type: "deterministic",
  phase: "initial",
  verdict: "allow",
  basis: "configured-allow",
  reasonCode: "configured-allow",
};

const askStages = (status: "accepted" | "rejected"): PermissionAuditStage[] => [
  {
    type: "deterministic",
    phase: "initial",
    verdict: "ask",
    basis: "configured-ask",
    reasonCode: "configured-ask",
  },
  {
    type: "confirmation",
    phase: "permission-policy",
    challengeSource: "deterministic-policy",
    status,
    reasonCode: "configured-ask",
  },
];

const writeFixture = async (root: string) => {
  const logDir = join(root, "logs");
  await fs.mkdir(logDir, { recursive: true, mode: 0o700 });
  const command = `printf '%s' ${CANARY}`;
  const allow = buildPermissionDecisionRecord(
    recordInput(
      "323e4567-e89b-42d3-a456-426614174000",
      1,
      "bun test",
      [deterministicAllow],
      "release",
    ),
  );
  const askAccepted = buildPermissionDecisionRecord(
    recordInput(
      "423e4567-e89b-42d3-a456-426614174000",
      2,
      command,
      askStages("accepted"),
      "release",
    ),
  );
  const askRejected = buildPermissionDecisionRecord(
    recordInput(
      "523e4567-e89b-42d3-a456-426614174000",
      3,
      command,
      askStages("rejected"),
      "block",
    ),
  );
  const mismatchedCommandHash = {
    ...askAccepted,
    timestamp: "2026-07-24T00:00:04.000Z",
    decisionId: "623e4567-e89b-42d3-a456-426614174000",
    sequence: 4,
    toolCallId: "tool-4",
    command: { ...askAccepted.command, text: `${command} altered` },
  };
  await fs.writeFile(
    join(logDir, `permission-2026-07-24-${WRITER_ID}.jsonl`),
    `${[allow, askAccepted, askRejected, mismatchedCommandHash]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n{"schema":`,
    { mode: 0o600 },
  );
  return { logDir, commandHash: askAccepted.command.sha256, askAccepted };
};

const runFrom = async (script: string, ...args: string[]) => {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const run = (...args: string[]) => runFrom(SCRIPT, ...args);

describe("permission audit analysis CLI", () => {
  test("resolves extension imports through the installed skill symlink", async () => {
    const root = await tempRoot();
    const { logDir } = await writeFixture(root);
    const installed = join(
      root,
      "agent",
      "skills",
      "permission-audit-analysis",
    );
    await fs.mkdir(join(root, "agent", "skills"), { recursive: true });
    await fs.symlink(join(SCRIPT, "../.."), installed);

    const result = await runFrom(
      join(installed, "scripts", "analyze.ts"),
      "summary",
      "--log-dir",
      logDir,
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ records: 3 });
  });
  test("summary and top-ask remain body-free while reporting diagnostics", async () => {
    const root = await tempRoot();
    const { logDir, commandHash } = await writeFixture(root);

    const summary = await run("summary", "--log-dir", logDir);
    expect(summary.exitCode).toBe(0);
    expect(`${summary.stdout}${summary.stderr}`).not.toContain(CANARY);
    const summaryJson = JSON.parse(summary.stdout);
    expect(summaryJson).toMatchObject({
      schema: "pi-harness/permission-audit-analysis",
      version: 1,
      files: 1,
      records: 3,
      diagnostics: {
        "command-hash-mismatch": 1,
        "truncated-tail": 1,
      },
      summary: {
        total: 3,
        byDecision: { allow: 1, ask: 2 },
        byDisposition: { release: 2, block: 1 },
      },
    });
    expect(summaryJson.summary).not.toHaveProperty("byCommand");

    const topAsk = await run("top-ask", "--log-dir", logDir, "--limit", "10");
    expect(topAsk.exitCode).toBe(0);
    expect(`${topAsk.stdout}${topAsk.stderr}`).not.toContain(CANARY);
    expect(JSON.parse(topAsk.stdout)).toEqual({
      schema: "pi-harness/permission-audit-top-ask",
      version: 1,
      scope: {
        recordWindow: { kind: "all-retained" },
        fileDiagnostics: { kind: "all-retained-files" },
      },
      commands: [
        {
          sha256: commandHash,
          count: 2,
          release: 1,
          block: 1,
          confirmations: { accepted: 1, rejected: 1 },
          reasons: { "configured-ask": 4 },
        },
      ],
    });

    const windowed = await run(
      "summary",
      "--log-dir",
      logDir,
      "--since",
      "2026-07-24T00:00:03.000Z",
    );
    expect(windowed.exitCode).toBe(0);
    expect(`${windowed.stdout}${windowed.stderr}`).not.toContain(CANARY);
    expect(JSON.parse(windowed.stdout)).toMatchObject({
      records: 1,
      window: { since: "2026-07-24T00:00:03.000Z" },
      scope: {
        recordWindow: {
          kind: "since",
          since: "2026-07-24T00:00:03.000Z",
        },
        fileDiagnostics: { kind: "all-retained-files" },
      },
      diagnostics: {
        "command-hash-mismatch": 1,
        "truncated-tail": 1,
      },
      summary: { byDecision: { ask: 1 }, byDisposition: { block: 1 } },
    });

    for (const invalid of [
      "recently",
      "2026-02-31",
      "2026-02-31T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:00:00+14:01",
    ]) {
      const invalidWindow = await run(
        "summary",
        "--log-dir",
        logDir,
        "--since",
        invalid,
      );
      expect(invalidWindow.exitCode).not.toBe(0);
      expect(`${invalidWindow.stdout}${invalidWindow.stderr}`).not.toContain(
        CANARY,
      );
    }
  });

  test("locates body-free IDs and inspects exactly one approved record", async () => {
    const root = await tempRoot();
    const { logDir, commandHash, askAccepted } = await writeFixture(root);

    const located = await run(
      "locate",
      "--log-dir",
      logDir,
      "--hash",
      commandHash,
    );
    expect(located.exitCode).toBe(0);
    expect(`${located.stdout}${located.stderr}`).not.toContain(CANARY);
    const locatedJson = JSON.parse(located.stdout);
    expect(locatedJson).toMatchObject({ matchCount: 2 });
    expect(locatedJson.matches).toHaveLength(2);
    const selected = locatedJson.matches.find(
      (match: { decisionId: string }) =>
        match.decisionId === askAccepted.decisionId,
    );
    expect(selected.recordSha256).toMatch(/^[0-9a-f]{64}$/);

    const refused = await run(
      "inspect",
      "--log-dir",
      logDir,
      "--hash",
      commandHash,
      "--decision-id",
      askAccepted.decisionId,
    );
    expect(refused.exitCode).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).not.toContain(CANARY);

    const missingId = await run(
      "inspect",
      "--log-dir",
      logDir,
      "--hash",
      commandHash,
      "--match-count",
      "2",
      "--record-sha256",
      selected.recordSha256,
      "--show-sensitive",
    );
    expect(missingId.exitCode).not.toBe(0);
    expect(`${missingId.stdout}${missingId.stderr}`).not.toContain(CANARY);

    const staleSelection = await run(
      "inspect",
      "--log-dir",
      logDir,
      "--hash",
      commandHash,
      "--decision-id",
      askAccepted.decisionId,
      "--match-count",
      "1",
      "--record-sha256",
      selected.recordSha256,
      "--show-sensitive",
    );
    expect(staleSelection.exitCode).not.toBe(0);
    expect(`${staleSelection.stdout}${staleSelection.stderr}`).not.toContain(
      CANARY,
    );

    const staleRecord = await run(
      "inspect",
      "--log-dir",
      logDir,
      "--hash",
      commandHash,
      "--decision-id",
      askAccepted.decisionId,
      "--match-count",
      "2",
      "--record-sha256",
      "f".repeat(64),
      "--show-sensitive",
    );
    expect(staleRecord.exitCode).not.toBe(0);
    expect(`${staleRecord.stdout}${staleRecord.stderr}`).not.toContain(CANARY);

    const inspected = await run(
      "inspect",
      "--log-dir",
      logDir,
      "--hash",
      commandHash,
      "--decision-id",
      askAccepted.decisionId,
      "--match-count",
      "2",
      "--record-sha256",
      selected.recordSha256,
      "--show-sensitive",
    );
    expect(inspected.exitCode).toBe(0);
    expect(inspected.stdout).toContain(CANARY);
    expect(JSON.parse(inspected.stdout).record.decisionId).toBe(
      askAccepted.decisionId,
    );
  });

  test("exports private unlabeled ASK candidates without overwriting", async () => {
    const root = await tempRoot();
    const { logDir } = await writeFixture(root);
    const output = join(root, "private-export", "candidates.jsonl");

    const refused = await run(
      "candidates",
      "--log-dir",
      logDir,
      "--output",
      output,
    );
    expect(refused.exitCode).not.toBe(0);
    await expect(fs.access(output)).rejects.toThrow();

    const exported = await run(
      "candidates",
      "--log-dir",
      logDir,
      "--output",
      output,
      "--include-sensitive",
    );
    expect(exported.exitCode).toBe(0);
    expect(`${exported.stdout}${exported.stderr}`).not.toContain(CANARY);
    expect(JSON.parse(exported.stdout)).toMatchObject({
      records: 2,
      candidateSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    const exportDirectoryStats = await fs.stat(join(root, "private-export"));
    const outputStats = await fs.stat(output);
    const candidateText = await fs.readFile(output, "utf8");
    expect(exportDirectoryStats.mode & 0o777).toBe(0o700);
    expect(outputStats.mode & 0o777).toBe(0o600);
    const candidates = candidateText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(candidates).toHaveLength(2);
    expect(JSON.stringify(candidates)).toContain(CANARY);
    expect(candidates.every((candidate) => !("expected" in candidate))).toBe(
      true,
    );

    const overwrite = await run(
      "candidates",
      "--log-dir",
      logDir,
      "--output",
      output,
      "--include-sensitive",
    );
    expect(overwrite.exitCode).not.toBe(0);
  });

  test("builds reviewed corpus only from explicit human labels", async () => {
    const root = await tempRoot();
    const { logDir, askAccepted } = await writeFixture(root);
    const candidates = join(root, "candidate-export", "candidates.jsonl");
    const labels = join(root, "labels.json");
    const reviewed = join(root, "reviewed-export", "reviewed.jsonl");
    const labelsLink = join(root, "labels-link.json");
    const symlinkOutput = join(root, "reviewed-symlink", "reviewed.jsonl");
    const unsafeLabelsOutput = join(
      root,
      "reviewed-unsafe-labels",
      "reviewed.jsonl",
    );
    const unsafeLabelsParentOutput = join(
      root,
      "reviewed-unsafe-label-parent",
      "reviewed.jsonl",
    );
    const duplicateCandidateOutput = join(
      root,
      "reviewed-duplicate-candidate",
      "reviewed.jsonl",
    );
    const hashMismatchOutput = join(
      root,
      "reviewed-hash-mismatch",
      "reviewed.jsonl",
    );
    const digestMismatchOutput = join(
      root,
      "reviewed-mismatch",
      "reviewed.jsonl",
    );
    const candidateExport = await run(
      "candidates",
      "--log-dir",
      logDir,
      "--output",
      candidates,
      "--include-sensitive",
    );
    expect(candidateExport.exitCode).toBe(0);
    const candidateSha256 = JSON.parse(candidateExport.stdout)
      .candidateSha256 as string;
    expect(candidateSha256).toMatch(/^[0-9a-f]{64}$/);
    await fs.writeFile(
      labels,
      JSON.stringify([
        { decisionId: askAccepted.decisionId, expected: "allow" },
      ]),
    );
    await fs.chmod(labels, 0o644);
    const unsafeLabels = await run(
      "review",
      "--candidate-file",
      candidates,
      "--candidate-sha256",
      candidateSha256,
      "--labels",
      labels,
      "--output",
      unsafeLabelsOutput,
      "--confirm-human-labels",
    );
    expect(unsafeLabels.exitCode).not.toBe(0);
    await expect(fs.access(unsafeLabelsOutput)).rejects.toThrow();
    await fs.chmod(labels, 0o600);
    await fs.chmod(root, 0o755);
    const unsafeLabelsParent = await run(
      "review",
      "--candidate-file",
      candidates,
      "--candidate-sha256",
      candidateSha256,
      "--labels",
      labels,
      "--output",
      unsafeLabelsParentOutput,
      "--confirm-human-labels",
    );
    expect(unsafeLabelsParent.exitCode).not.toBe(0);
    await expect(fs.access(unsafeLabelsParentOutput)).rejects.toThrow();
    await fs.chmod(root, 0o700);
    await fs.symlink(labels, labelsLink);
    const symlinkedLabels = await run(
      "review",
      "--candidate-file",
      candidates,
      "--candidate-sha256",
      candidateSha256,
      "--labels",
      labelsLink,
      "--output",
      symlinkOutput,
      "--confirm-human-labels",
    );
    expect(symlinkedLabels.exitCode).not.toBe(0);
    await expect(fs.access(symlinkOutput)).rejects.toThrow();

    const reviewedCandidateText = await fs.readFile(candidates, "utf8");
    const [firstCandidate] = reviewedCandidateText.trim().split("\n");
    const duplicatedCandidateText = `${reviewedCandidateText}${firstCandidate}\n`;
    const duplicatedCandidateSha256 = createHash("sha256")
      .update(duplicatedCandidateText, "utf8")
      .digest("hex");
    await fs.writeFile(candidates, duplicatedCandidateText);
    const duplicateCandidate = await run(
      "review",
      "--candidate-file",
      candidates,
      "--candidate-sha256",
      duplicatedCandidateSha256,
      "--labels",
      labels,
      "--output",
      duplicateCandidateOutput,
      "--confirm-human-labels",
    );
    expect(duplicateCandidate.exitCode).not.toBe(0);
    await expect(fs.access(duplicateCandidateOutput)).rejects.toThrow();

    const candidateLines = reviewedCandidateText.trim().split("\n");
    const tamperedCandidate = JSON.parse(candidateLines[0] ?? "{}");
    tamperedCandidate.command = `${tamperedCandidate.command} changed`;
    const hashMismatchText = `${[
      JSON.stringify(tamperedCandidate),
      ...candidateLines.slice(1),
    ].join("\n")}\n`;
    const hashMismatchSha256 = createHash("sha256")
      .update(hashMismatchText, "utf8")
      .digest("hex");
    await fs.writeFile(candidates, hashMismatchText);
    const hashMismatch = await run(
      "review",
      "--candidate-file",
      candidates,
      "--candidate-sha256",
      hashMismatchSha256,
      "--labels",
      labels,
      "--output",
      hashMismatchOutput,
      "--confirm-human-labels",
    );
    expect(hashMismatch.exitCode).not.toBe(0);
    await expect(fs.access(hashMismatchOutput)).rejects.toThrow();
    await fs.writeFile(candidates, reviewedCandidateText);

    await fs.appendFile(candidates, "\n");
    const digestMismatch = await run(
      "review",
      "--candidate-file",
      candidates,
      "--candidate-sha256",
      candidateSha256,
      "--labels",
      labels,
      "--output",
      digestMismatchOutput,
      "--confirm-human-labels",
    );
    expect(digestMismatch.exitCode).not.toBe(0);
    await expect(fs.access(digestMismatchOutput)).rejects.toThrow();
    await fs.writeFile(candidates, reviewedCandidateText);

    const refused = await run(
      "review",
      "--candidate-file",
      candidates,
      "--candidate-sha256",
      candidateSha256,
      "--labels",
      labels,
      "--output",
      reviewed,
    );
    expect(refused.exitCode).not.toBe(0);
    await expect(fs.access(reviewed)).rejects.toThrow();

    const result = await run(
      "review",
      "--candidate-file",
      candidates,
      "--candidate-sha256",
      candidateSha256,
      "--labels",
      labels,
      "--output",
      reviewed,
      "--confirm-human-labels",
    );
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(CANARY);
    const reviewedStats = await fs.stat(reviewed);
    const reviewedText = await fs.readFile(reviewed, "utf8");
    expect(reviewedStats.mode & 0o777).toBe(0o600);
    const corpus = reviewedText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(corpus).toHaveLength(1);
    expect(corpus[0]).toMatchObject({
      schema: "pi-harness/permission-qualification-reviewed",
      version: 1,
      decisionId: askAccepted.decisionId,
      observedDecision: "ask",
      expected: "allow",
      labelSource: "human-review",
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ candidateSha256 });
  });
});
