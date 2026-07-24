import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  buildPermissionQualificationCandidates,
  parsePermissionAuditJsonl,
  summarizePermissionAudit,
} from "../../pi/extensions/pi-harness/features/permission-audit/analysis";
import {
  buildPermissionCommand,
  buildPermissionDecisionRecord,
  fitPermissionDecisionRecord,
  MAX_PERMISSION_AUDIT_RECORD_BYTES,
  type PermissionAuditStage,
  type PermissionDecisionRecordInput,
} from "../../pi/extensions/pi-harness/features/permission-audit/model";
import {
  createPermissionAuditWriter,
  permissionAuditLogFileName,
  type PermissionAuditFileHandle,
  type PermissionAuditWriter,
} from "../../pi/extensions/pi-harness/features/permission-audit/writer";
import type { HarnessConfig } from "../../pi/extensions/pi-harness/config";
import {
  PERMISSION_AUDIT_INVOCATION_ENV,
  PERMISSION_AUDIT_LINEAGE_ENV,
  PERMISSION_AUDIT_PARENT_SESSION_ENV,
  PERMISSION_AUDIT_RUN_ENV,
  setupPermissionAudit,
} from "../../pi/extensions/pi-harness/features/permission-audit/index";
import setupPermissionPolicy from "../../pi/extensions/pi-harness/features/permission-policy/index";
import { createPermissionTaskTracker } from "../../pi/extensions/pi-harness/features/permission-policy/context";
import { CHILD_PERMISSION_SIGNAL_ENV } from "../../pi/extensions/pi-harness/features/permission-policy/block";
import { sanitizeChildEnv } from "../../pi/extensions/pi-harness/lib/child-env";
import { resolvePaths } from "../../pi/extensions/pi-harness/lib/paths";
import { createFakePi } from "./fake-pi";
import { cleanupTestDirectory, setupTestDirectory } from "../test-helpers";

const roots: string[] = [];
const WRITER_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_WRITER_ID = "223e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-07-23T12:00:00.000Z");

const tempRoot = async (prefix: string): Promise<string> => {
  const root = await setupTestDirectory(prefix);
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupTestDirectory));
});

const baseInput = (
  stages: readonly PermissionAuditStage[],
  overrides: Partial<PermissionDecisionRecordInput> = {},
): PermissionDecisionRecordInput => ({
  timestamp: NOW.toISOString(),
  decisionId: "323e4567-e89b-42d3-a456-426614174000",
  writerInstanceId: WRITER_ID,
  sequence: 1,
  pid: 123,
  isChild: false,
  lineage: { lineageId: WRITER_ID, source: "generated" },
  sessionId: "session-1",
  toolCallId: "tool-1",
  command: buildPermissionCommand("git status --short"),
  cwd: "/workspace/acme",
  task: {
    correlation: "task",
    task: {
      text: "Inspect the repository",
      source: "interactive",
      fingerprint: "task-fingerprint",
    },
  },
  runEvidence: {
    assistantText: "I will inspect status.",
    priorToolResults: [],
    fingerprint: "run-fingerprint",
  },
  stages,
  boundaryDisposition: "release",
  terminalReasonCode: "permission-chain-released",
  ...overrides,
});

const allowedStage: PermissionAuditStage = {
  type: "deterministic",
  phase: "initial",
  verdict: "allow",
  basis: "configured-allow",
  reasonCode: "configured-allow",
  ruleSource: "Bash(git status:*)",
};

describe("permission audit record model", () => {
  test("derives terminal decisions from challenges rather than intermediate ASK", () => {
    const intermediateAsk: PermissionAuditStage = {
      type: "deterministic",
      phase: "initial",
      verdict: "ask",
      basis: "git-c-unverified",
      reasonCode: "git-c-unverified",
    };
    const verified: PermissionAuditStage = {
      type: "scope",
      phase: "git-c",
      verdict: "allow",
      reasonCode: "git-c-listed-worktree",
    };
    expect(
      buildPermissionDecisionRecord(baseInput([intermediateAsk, verified]))
        .effectiveDecision,
    ).toBe("allow");

    const accepted: PermissionAuditStage = {
      type: "confirmation",
      phase: "judge",
      challengeSource: "local-judge",
      status: "accepted",
      reasonCode: "judge-ask",
    };
    expect(
      buildPermissionDecisionRecord(baseInput([intermediateAsk, accepted]))
        .effectiveDecision,
    ).toBe("ask");

    const denied: PermissionAuditStage = {
      type: "deterministic",
      phase: "initial",
      verdict: "deny",
      basis: "configured-deny",
      reasonCode: "configured-deny",
    };
    expect(
      buildPermissionDecisionRecord(
        baseInput([denied], { boundaryDisposition: "block" }),
      ).effectiveDecision,
    ).toBe("deny");
    expect(
      buildPermissionDecisionRecord(
        baseInput([accepted, denied], { boundaryDisposition: "block" }),
      ).effectiveDecision,
    ).toBe("deny");
  });

  test("retains full corpus canaries and emits a bounded oversized marker", () => {
    const canary = "secret-token-CANARY";
    const record = buildPermissionDecisionRecord(
      baseInput([allowedStage], {
        command: buildPermissionCommand(`printf %s ${canary}`),
        task: {
          correlation: "task",
          task: { text: `task ${canary}`, source: "rpc" },
        },
        runEvidence: {
          assistantText: `assistant ${canary}`,
          priorToolResults: [],
          fingerprint: "canary-run",
        },
      }),
    );
    expect(JSON.stringify(record)).toContain(canary);

    const oversized = fitPermissionDecisionRecord(
      baseInput([allowedStage], {
        command: buildPermissionCommand(
          "x".repeat(MAX_PERMISSION_AUDIT_RECORD_BYTES),
        ),
      }),
    );
    expect(oversized.command.kind).toBe("omitted");
    expect(oversized.boundaryDisposition).toBe("block");
    expect(oversized.terminalReasonCode).toBe("record-too-large");
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(
      MAX_PERMISSION_AUDIT_RECORD_BYTES,
    );

    const oversizedIdentifiers = fitPermissionDecisionRecord(
      baseInput([allowedStage], {
        sessionId: "s".repeat(MAX_PERMISSION_AUDIT_RECORD_BYTES),
        toolCallId: "t".repeat(MAX_PERMISSION_AUDIT_RECORD_BYTES),
      }),
    );
    expect(oversizedIdentifiers).toMatchObject({
      command: { kind: "omitted", reason: "record-too-large" },
      boundaryDisposition: "block",
      terminalReasonCode: "record-too-large",
    });
    expect(oversizedIdentifiers.sessionId).toMatch(/^sha256:/);
    expect(oversizedIdentifiers.toolCallId).toMatch(/^sha256:/);
    expect(
      Buffer.byteLength(JSON.stringify(oversizedIdentifiers)),
    ).toBeLessThan(MAX_PERMISSION_AUDIT_RECORD_BYTES);
  });
});

describe("permission audit analysis", () => {
  test("parses records, diagnoses a truncated tail, aggregates, and emits unlabeled candidates", () => {
    const judge: PermissionAuditStage = {
      type: "judge",
      phase: "fallback",
      verdict: "ask",
      reasonCode: "judge-ask",
      outcome: "ask",
      source: "live",
      gates: { safety: "ALLOW", relevance: "ASK" },
    };
    const confirmation: PermissionAuditStage = {
      type: "confirmation",
      phase: "fallback",
      challengeSource: "local-judge",
      status: "accepted",
      reasonCode: "judge-ask",
    };
    const record = buildPermissionDecisionRecord(
      baseInput([judge, confirmation]),
    );
    const parsed = parsePermissionAuditJsonl(
      `${JSON.stringify(record)}\n{"schema":"pi-harness/bash-permission"`,
    );
    expect(parsed.records).toEqual([record]);
    expect(parsed.diagnostics).toEqual([{ line: 2, code: "truncated-tail" }]);

    const summary = summarizePermissionAudit(parsed.records);
    expect(summary.byDecision.ask).toBe(1);
    expect(summary.byJudgeGates["live:ALLOW/ASK"]).toBe(1);
    expect(summary.byConfirmation.accepted).toBe(1);
    expect(summary.byProcessKind.parent).toBe(1);

    const [candidate] = buildPermissionQualificationCandidates(parsed.records);
    expect(candidate?.command).toBe("git status --short");
    expect(candidate).not.toHaveProperty("expected");
  });

  test("rejects unrelated and malformed nested V1 records", () => {
    const result = parsePermissionAuditJsonl('{"kind":"provider-request"}\n');
    expect(result.records).toEqual([]);
    expect(result.diagnostics).toEqual([{ line: 1, code: "invalid-record" }]);

    const record = buildPermissionDecisionRecord(baseInput([allowedStage]));
    const malformed = [
      { ...record, command: { kind: "malformed", sha256: "bad", bytes: -1 } },
      { ...record, task: { correlation: "task" } },
      {
        ...record,
        process: {
          ...record.process,
          lineage: { lineageId: WRITER_ID, source: "forged" },
        },
      },
      {
        ...record,
        stages: [
          {
            type: "judge",
            phase: "fallback",
            verdict: "allow",
            reasonCode: "judge-allow",
            outcome: "allow",
            gates: { safety: "YES", relevance: "ALLOW" },
          },
        ],
      },
    ];
    const parsed = parsePermissionAuditJsonl(
      `${malformed.map((value) => JSON.stringify(value)).join("\n")}\n`,
    );
    expect(parsed.records).toEqual([]);
    expect(parsed.diagnostics).toEqual(
      malformed.map((_, index) => ({
        line: index + 1,
        code: "invalid-record",
      })),
    );
  });
});

describe("permission audit writer", () => {
  test("writes one private per-writer JSONL file and enforces directory mode", async () => {
    const root = await tempRoot("pi-permission-audit-writer");
    const logDir = join(root, "logs");
    const writer = createPermissionAuditWriter(logDir, {
      isChild: false,
      writerInstanceId: WRITER_ID,
      dependencies: { now: () => NOW },
    });
    const record = await writer.append((identity) =>
      fitPermissionDecisionRecord(
        baseInput([allowedStage], {
          ...identity,
          writerInstanceId: identity.writerInstanceId,
        }),
      ),
    );
    await writer.close();

    const path = join(logDir, permissionAuditLogFileName(NOW, WRITER_ID));
    expect(JSON.parse((await fs.readFile(path, "utf8")).trim())).toEqual(
      record,
    );
    expect((await fs.stat(logDir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });

  test("drains an already queued append before close", async () => {
    const root = await tempRoot("pi-permission-audit-close-drain");
    const logDir = join(root, "logs");
    const writer = createPermissionAuditWriter(logDir, {
      isChild: false,
      writerInstanceId: WRITER_ID,
      dependencies: { now: () => NOW },
    });
    const pending = writer.append((identity) =>
      fitPermissionDecisionRecord(baseInput([allowedStage], identity)),
    );
    const closing = writer.close();
    await expect(pending).resolves.toMatchObject({ toolCallId: "tool-1" });
    await expect(closing).resolves.toBeUndefined();
  });

  test("refuses a symlinked log directory", async () => {
    const root = await tempRoot("pi-permission-audit-symlink");
    const target = join(root, "target");
    const logDir = join(root, "logs");
    await fs.mkdir(target);
    await fs.symlink(target, logDir);
    const writer = createPermissionAuditWriter(logDir, {
      isChild: false,
      writerInstanceId: WRITER_ID,
      dependencies: { now: () => NOW },
    });
    await expect(
      writer.append((identity) =>
        fitPermissionDecisionRecord(baseInput([allowedStage], identity)),
      ),
    ).rejects.toThrow();
    await writer.close();
    expect(await fs.readdir(target)).toEqual([]);
  });

  test("rolls back a partial failed line and can append the next record", async () => {
    const root = await tempRoot("pi-permission-audit-partial");
    const logDir = join(root, "logs");
    let injected = false;
    const writer = createPermissionAuditWriter(logDir, {
      isChild: false,
      writerInstanceId: WRITER_ID,
      dependencies: {
        now: () => NOW,
        async open(path, flags, mode) {
          const handle = await fs.open(path, flags, mode);
          if (!path.endsWith(".jsonl")) return handle;
          const wrapped: PermissionAuditFileHandle = {
            stat: () => handle.stat(),
            chmod: (value) => handle.chmod(value),
            truncate: (value) => handle.truncate(value),
            close: () => handle.close(),
            async write(buffer, offset, length, position) {
              if (!injected) {
                injected = true;
                await handle.write(
                  buffer,
                  offset,
                  Math.max(1, Math.floor(length / 2)),
                  position,
                );
                throw new Error("injected partial write");
              }
              return handle.write(buffer, offset, length, position);
            },
          };
          return wrapped;
        },
      },
    });
    await expect(
      writer.append((identity) =>
        fitPermissionDecisionRecord(baseInput([allowedStage], identity)),
      ),
    ).rejects.toThrow("injected partial write");
    const second = await writer.append((identity) =>
      fitPermissionDecisionRecord(
        baseInput([allowedStage], { ...identity, toolCallId: "tool-2" }),
      ),
    );
    await writer.close();

    const path = join(logDir, permissionAuditLogFileName(NOW, WRITER_ID));
    const lines = (await fs.readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "")).toEqual(second);
    expect(second.sequence).toBe(2);
  });

  test("poisons the writer when partial-write rollback fails", async () => {
    const root = await tempRoot("pi-permission-audit-poison");
    const logDir = join(root, "logs");
    let writes = 0;
    let truncates = 0;
    let closes = 0;
    const writer = createPermissionAuditWriter(logDir, {
      isChild: false,
      writerInstanceId: WRITER_ID,
      dependencies: {
        now: () => NOW,
        async open(path, flags, mode) {
          const handle = await fs.open(path, flags, mode);
          if (!path.endsWith(".jsonl")) return handle;
          return {
            stat: () => handle.stat(),
            chmod: (value) => handle.chmod(value),
            async truncate() {
              truncates += 1;
              throw new Error("injected truncate failure");
            },
            async close() {
              closes += 1;
              await handle.close();
            },
            async write(buffer, offset, _length, position) {
              writes += 1;
              await handle.write(buffer, offset, 1, position);
              throw new Error("injected write failure");
            },
          };
        },
      },
    });
    await expect(
      writer.append((identity) =>
        fitPermissionDecisionRecord(baseInput([allowedStage], identity)),
      ),
    ).rejects.toThrow("injected write failure");
    await expect(
      writer.append((identity) =>
        fitPermissionDecisionRecord(baseInput([allowedStage], identity)),
      ),
    ).rejects.toThrow("poisoned");
    await writer.close();
    await writer.close();
    expect({ writes, truncates, closes }).toEqual({
      writes: 1,
      truncates: 1,
      closes: 1,
    });
  });

  test("removes only safe expired files and leaves hostile entries", async () => {
    const root = await tempRoot("pi-permission-audit-retention");
    const logDir = join(root, "logs");
    await fs.mkdir(logDir, { mode: 0o700 });
    const expired = join(
      logDir,
      `permission-2026-01-01-${OTHER_WRITER_ID}.jsonl`,
    );
    const loose = join(
      logDir,
      "permission-2026-01-02-323e4567-e89b-42d3-a456-426614174000.jsonl",
    );
    const cutoffDay = join(
      logDir,
      "permission-2026-04-24-623e4567-e89b-42d3-a456-426614174000.jsonl",
    );
    const justExpired = join(
      logDir,
      "permission-2026-04-23-923e4567-e89b-42d3-a456-426614174000.jsonl",
    );
    const ownerMismatch = join(
      logDir,
      "permission-2026-01-05-723e4567-e89b-42d3-a456-426614174000.jsonl",
    );
    const malformedName = join(
      logDir,
      "permission-2026-02-31-823e4567-e89b-42d3-a456-426614174000.jsonl",
    );
    const victim = join(root, "victim");
    const symlink = join(
      logDir,
      "permission-2026-01-03-423e4567-e89b-42d3-a456-426614174000.jsonl",
    );
    const hardlinkSource = join(root, "hardlink-source");
    const hardlink = join(
      logDir,
      "permission-2026-01-04-523e4567-e89b-42d3-a456-426614174000.jsonl",
    );
    await fs.writeFile(expired, "{}\n", { mode: 0o600 });
    await fs.writeFile(loose, "{}\n", { mode: 0o644 });
    await fs.writeFile(cutoffDay, "{}\n", { mode: 0o600 });
    await fs.writeFile(justExpired, "{}\n", { mode: 0o600 });
    await fs.writeFile(ownerMismatch, "{}\n", { mode: 0o600 });
    await fs.writeFile(malformedName, "{}\n", { mode: 0o600 });
    await fs.writeFile(victim, "victim");
    await fs.symlink(victim, symlink);
    await fs.writeFile(hardlinkSource, "{}\n", { mode: 0o600 });
    await fs.link(hardlinkSource, hardlink);

    const uid = process.getuid?.();
    const lstatWithOwnerMismatch = (async (
      path: Parameters<typeof fs.lstat>[0],
    ) => {
      const stats = await fs.lstat(path);
      if (uid === undefined || String(path) !== ownerMismatch) return stats;
      return new Proxy(stats, {
        get(target, property, receiver) {
          if (property === "uid") return uid + 1;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof fs.lstat;
    const writer = createPermissionAuditWriter(logDir, {
      isChild: false,
      writerInstanceId: WRITER_ID,
      dependencies: {
        now: () => NOW,
        ...(uid === undefined
          ? {}
          : { getuid: () => uid, lstat: lstatWithOwnerMismatch }),
      },
    });
    await writer.append((identity) =>
      fitPermissionDecisionRecord(baseInput([allowedStage], identity)),
    );
    await writer.close();

    await expect(fs.access(expired)).rejects.toThrow();
    await expect(fs.access(justExpired)).rejects.toThrow();
    await fs.access(loose);
    await fs.access(cutoffDay);
    if (uid === undefined) {
      await expect(fs.access(ownerMismatch)).rejects.toThrow();
    } else {
      await fs.access(ownerMismatch);
    }
    await fs.access(malformedName);
    await fs.access(symlink);
    await fs.access(hardlink);
    expect(await fs.readFile(victim, "utf8")).toBe("victim");
  });

  test("suppresses retention in children and rotates at the UTC day boundary", async () => {
    const root = await tempRoot("pi-permission-audit-child-retention");
    const logDir = join(root, "logs");
    await fs.mkdir(logDir, { mode: 0o700 });
    const expired = join(
      logDir,
      `permission-2026-01-01-${OTHER_WRITER_ID}.jsonl`,
    );
    await fs.writeFile(expired, "{}\n", { mode: 0o600 });
    let now = NOW;
    const writer = createPermissionAuditWriter(logDir, {
      isChild: true,
      writerInstanceId: WRITER_ID,
      dependencies: { now: () => now },
    });
    await writer.append((identity) =>
      fitPermissionDecisionRecord(baseInput([allowedStage], identity)),
    );
    now = new Date("2026-07-24T00:00:00.000Z");
    await writer.append((identity) =>
      fitPermissionDecisionRecord(
        baseInput([allowedStage], { ...identity, toolCallId: "tool-2" }),
      ),
    );
    await writer.close();

    await fs.access(expired);
    expect(
      (await fs.readdir(logDir)).filter((name) => name.includes(WRITER_ID)),
    ).toHaveLength(2);
  });
});

const harnessConfig = (home: string): HarnessConfig => ({
  isChild: false,
  features: {
    "hook-bridge": false,
    subagent: false,
    workflow: false,
    "bit-task": false,
    statusline: false,
    "provider-log": false,
    "asuku-notify": false,
    "ask-user-question": false,
  },
  trust: { trustedRoots: [] },
  paths: resolvePaths(home),
});

const activateTask = async (
  pi: ReturnType<typeof createFakePi>,
): Promise<void> => {
  await pi.emitInput({
    type: "input",
    text: "Inspect and update the repository",
    source: "interactive",
  });
  await pi.emitBeforeAgentStart({
    type: "before_agent_start",
    prompt: "Inspect and update the repository",
    systemPrompt: "base",
  });
};

describe("permission audit policy lifecycle", () => {
  test("writes exactly one terminal record for allow, accepted ASK, and deny", async () => {
    const home = await tempRoot("pi-permission-audit-policy");
    const config = harnessConfig(home);
    const pi = createFakePi({ cwd: home, sessionId: "audit-session" });
    const taskTracker = createPermissionTaskTracker();
    const audit = setupPermissionAudit(pi, config, { taskTracker });
    const blocker = (reason: string) => ({ block: true as const, reason });
    setupPermissionPolicy(pi, config, {
      taskTracker,
      permissionAudit: audit,
      blockToolCall: blocker,
    });
    audit.registerTail(pi, blocker);
    await activateTask(pi);

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "allow-1",
        input: { command: "bun test" },
      }),
    ).toBeUndefined();

    pi.queueConfirm(true);
    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "ask-1",
        input: { command: "git push origin main" },
      }),
    ).toBeUndefined();

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "deny-1",
        input: { command: "bit relay serve" },
      }),
    ).toMatchObject({ block: true });
    await pi.emitSessionShutdown();

    const files = (await fs.readdir(config.paths.logDir)).filter((name) =>
      name.startsWith("permission-"),
    );
    expect(files).toHaveLength(1);
    const parsed = parsePermissionAuditJsonl(
      await fs.readFile(join(config.paths.logDir, files[0] ?? ""), "utf8"),
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.records).toHaveLength(3);
    expect(
      parsed.records.map((record) => ({
        id: record.toolCallId,
        decision: record.effectiveDecision,
        disposition: record.boundaryDisposition,
      })),
    ).toEqual([
      { id: "allow-1", decision: "allow", disposition: "release" },
      { id: "ask-1", decision: "ask", disposition: "release" },
      { id: "deny-1", decision: "deny", disposition: "block" },
    ]);
    expect(parsed.records[0]?.task.task?.text).toBe(
      "Inspect and update the repository",
    );
    expect(parsed.records[1]?.stages).toContainEqual(
      expect.objectContaining({
        type: "confirmation",
        status: "accepted",
      }),
    );
  });

  test("records rejected ASK at the challenge site without reaching tail release", async () => {
    const home = await tempRoot("pi-permission-audit-reject");
    const config = harnessConfig(home);
    const pi = createFakePi({ cwd: home });
    const taskTracker = createPermissionTaskTracker();
    const audit = setupPermissionAudit(pi, config, { taskTracker });
    const blocker = (reason: string) => ({ block: true as const, reason });
    setupPermissionPolicy(pi, config, {
      taskTracker,
      permissionAudit: audit,
      blockToolCall: blocker,
    });
    audit.registerTail(pi, blocker);
    await activateTask(pi);
    pi.queueConfirm(false);

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "ask-rejected",
        input: { command: "git push origin main" },
      }),
    ).toMatchObject({ block: true });
    await pi.emitSessionShutdown();

    const [file] = await fs.readdir(config.paths.logDir);
    const parsed = parsePermissionAuditJsonl(
      await fs.readFile(join(config.paths.logDir, file ?? ""), "utf8"),
    );
    expect(parsed.records).toHaveLength(1);
    expect(parsed.records[0]).toMatchObject({
      toolCallId: "ask-rejected",
      effectiveDecision: "ask",
      boundaryDisposition: "block",
    });
    expect(parsed.records[0]?.stages).toContainEqual(
      expect.objectContaining({ type: "confirmation", status: "rejected" }),
    );
  });

  test("propagates real parent-child audit env without recording the permission token", async () => {
    const home = await tempRoot("pi-permission-audit-child-lineage");
    const parentConfig = harnessConfig(home);
    const parentPi = createFakePi({ cwd: home, sessionId: "parent-session" });
    const parentAudit = setupPermissionAudit(parentPi, parentConfig, {
      taskTracker: createPermissionTaskTracker(),
      env: {},
      randomUUID: () => WRITER_ID,
    });
    const auditOverrides = parentAudit.childEnvironment(
      parentPi.ctx,
      "invocation-1",
      "run-1",
    );
    expect(
      parentAudit.childEnvironment(parentPi.ctx, "invalid id", "also invalid"),
    ).toEqual({
      [PERMISSION_AUDIT_LINEAGE_ENV]: WRITER_ID,
      [PERMISSION_AUDIT_PARENT_SESSION_ENV]: "parent-session",
    });
    const permissionToken = "permission-signal-secret";
    const childEnv = sanitizeChildEnv(
      { NODE_OPTIONS: "--require attacker", AMBIENT: "kept" },
      {
        ...auditOverrides,
        [CHILD_PERMISSION_SIGNAL_ENV]: permissionToken,
      },
      { cwd: home },
    );
    expect(childEnv.NODE_OPTIONS).toBeUndefined();
    expect(childEnv[CHILD_PERMISSION_SIGNAL_ENV]).toBe(permissionToken);

    const config = { ...parentConfig, isChild: true };
    const pi = createFakePi({ cwd: home, sessionId: "child-session" });
    const taskTracker = createPermissionTaskTracker();
    const audit = setupPermissionAudit(pi, config, {
      taskTracker,
      env: childEnv,
    });
    const blocker = (reason: string) => ({ block: true as const, reason });
    audit.registerTail(pi, blocker);

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "child-allow",
        input: { command: "printf child" },
      }),
    ).toBeUndefined();
    await pi.emitSessionShutdown();

    const [file] = await fs.readdir(config.paths.logDir);
    const parsed = parsePermissionAuditJsonl(
      await fs.readFile(join(config.paths.logDir, file ?? ""), "utf8"),
    );
    expect(parsed.records[0]).toMatchObject({
      sessionId: "child-session",
      process: {
        isChild: true,
        lineage: {
          lineageId: WRITER_ID,
          source: "harness-env",
          parentSessionId: "parent-session",
          childInvocationId: "invocation-1",
          childRunId: "run-1",
        },
      },
    });
    expect(JSON.stringify(parsed.records[0])).not.toContain(
      CHILD_PERMISSION_SIGNAL_ENV,
    );
    expect(JSON.stringify(parsed.records[0])).not.toContain(permissionToken);
  });

  test("regenerates invalid inherited lineage and omits invalid correlation IDs", async () => {
    const home = await tempRoot("pi-permission-audit-invalid-lineage");
    const config = { ...harnessConfig(home), isChild: true };
    const pi = createFakePi({ cwd: home, sessionId: "child-session" });
    const audit = setupPermissionAudit(pi, config, {
      taskTracker: createPermissionTaskTracker(),
      env: {
        [PERMISSION_AUDIT_LINEAGE_ENV]: "not-a-uuid",
        [PERMISSION_AUDIT_PARENT_SESSION_ENV]: "invalid parent id",
        [PERMISSION_AUDIT_INVOCATION_ENV]: "invalid invocation id",
        [PERMISSION_AUDIT_RUN_ENV]: "invalid run id",
      },
      randomUUID: () => OTHER_WRITER_ID,
    });
    audit.registerTail(pi, (reason) => ({ block: true as const, reason }));

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "invalid-lineage",
        input: { command: "printf child" },
      }),
    ).toBeUndefined();
    await pi.emitSessionShutdown();

    const [file] = await fs.readdir(config.paths.logDir);
    const parsed = parsePermissionAuditJsonl(
      await fs.readFile(join(config.paths.logDir, file ?? ""), "utf8"),
    );
    expect(parsed.records[0]?.process.lineage).toEqual({
      lineageId: OTHER_WRITER_ID,
      source: "generated",
    });
  });

  test("blocks an oversized record with a persisted compact marker, not a sink warning", async () => {
    const home = await tempRoot("pi-permission-audit-oversized");
    const config = harnessConfig(home);
    const pi = createFakePi({ cwd: home });
    const taskTracker = createPermissionTaskTracker();
    const audit = setupPermissionAudit(pi, config, { taskTracker });
    const blocker = (reason: string) => ({ block: true as const, reason });
    audit.registerTail(pi, blocker);

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "oversized-record",
        input: { command: "x".repeat(MAX_PERMISSION_AUDIT_RECORD_BYTES) },
      }),
    ).toEqual({
      block: true,
      reason:
        "permission-audit: decision record exceeded 1 MiB; command blocked",
    });
    await pi.emitSessionShutdown();

    expect(pi.notifications).toEqual([]);
    const [file] = await fs.readdir(config.paths.logDir);
    const parsed = parsePermissionAuditJsonl(
      await fs.readFile(join(config.paths.logDir, file ?? ""), "utf8"),
    );
    expect(parsed.records[0]).toMatchObject({
      toolCallId: "oversized-record",
      command: { kind: "omitted", reason: "record-too-large" },
      boundaryDisposition: "block",
      terminalReasonCode: "record-too-large",
    });
  });

  test("waits for persistence before later handlers and reuses duplicate finalization", async () => {
    const home = await tempRoot("pi-permission-audit-release-order");
    const config = harnessConfig(home);
    const pi = createFakePi({ cwd: home });
    const taskTracker = createPermissionTaskTracker();
    let releaseAppend: (() => void) | undefined;
    let appendStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      appendStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let appends = 0;
    const writer: PermissionAuditWriter = {
      writerInstanceId: WRITER_ID,
      async append(build) {
        appends += 1;
        const record = build({
          writerInstanceId: WRITER_ID,
          sequence: appends,
          timestamp: NOW.toISOString(),
        });
        appendStarted?.();
        await gate;
        return record;
      },
      close: async () => {},
    };
    const audit = setupPermissionAudit(pi, config, { taskTracker, writer });
    const blocker = (reason: string) => ({ block: true as const, reason });
    audit.registerTail(pi, blocker);
    let laterHandlerCalls = 0;
    pi.on("tool_call", () => {
      laterHandlerCalls += 1;
      return undefined;
    });

    const pending = pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "ordered-release",
      input: { command: "bun test" },
    });
    await started;
    expect(laterHandlerCalls).toBe(0);
    const concurrentDuplicate = audit.finalizeBlock(
      "ordered-release",
      "concurrent-duplicate",
    );
    releaseAppend?.();
    await expect(pending).resolves.toBeUndefined();
    await expect(concurrentDuplicate).resolves.toBe(true);
    expect(laterHandlerCalls).toBe(1);
    await expect(
      audit.finalizeBlock("ordered-release", "late-duplicate"),
    ).resolves.toBe(true);
    expect(appends).toBe(1);

    await expect(
      pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "ordered-release",
        input: { command: "bun test" },
      }),
    ).resolves.toBeUndefined();
    expect(appends).toBe(1);
    expect(laterHandlerCalls).toBe(2);
  });

  test("finalizes pending shutdown transactions before closing the writer", async () => {
    const home = await tempRoot("pi-permission-audit-shutdown");
    const config = harnessConfig(home);
    const pi = createFakePi({ cwd: home });
    const taskTracker = createPermissionTaskTracker();
    const events: string[] = [];
    let written: ReturnType<typeof buildPermissionDecisionRecord> | undefined;
    const writer: PermissionAuditWriter = {
      writerInstanceId: WRITER_ID,
      async append(build) {
        events.push("append");
        written = build({
          writerInstanceId: WRITER_ID,
          sequence: 1,
          timestamp: NOW.toISOString(),
        });
        return written;
      },
      async close() {
        events.push("close");
      },
    };
    const audit = setupPermissionAudit(pi, config, { taskTracker, writer });
    await pi.emitToolCall({
      type: "tool_call",
      toolName: "bash",
      toolCallId: "pending-shutdown",
      input: { command: "bun test" },
    });
    audit.registerTail(pi, (reason) => ({ block: true as const, reason }));
    await pi.emitSessionShutdown();

    expect(events).toEqual(["append", "close"]);
    expect(written).toMatchObject({
      boundaryDisposition: "block",
      terminalReasonCode: "session-shutdown",
      stages: [
        {
          type: "error",
          component: "permission-audit",
          phase: "session-shutdown",
          verdict: "error",
          reasonCode: "session-shutdown",
        },
      ],
    });
  });

  test("blocks release and emits one generic warning when the sink fails", async () => {
    const home = await tempRoot("pi-permission-audit-unavailable");
    const config = harnessConfig(home);
    const pi = createFakePi({ cwd: home });
    const taskTracker = createPermissionTaskTracker();
    const failingWriter: PermissionAuditWriter = {
      writerInstanceId: WRITER_ID,
      append: async () => {
        throw new Error("secret sink failure");
      },
      close: async () => {},
    };
    const audit = setupPermissionAudit(pi, config, {
      taskTracker,
      writer: failingWriter,
    });
    const blocker = (reason: string) => ({ block: true as const, reason });
    audit.registerTail(pi, blocker);

    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "audit-failed",
        input: { command: "printf secret-token" },
      }),
    ).toEqual({
      block: true,
      reason:
        "permission-audit: decision record could not be persisted; command blocked",
    });
    expect(
      await pi.emitToolCall({
        type: "tool_call",
        toolName: "bash",
        toolCallId: "audit-failed-again",
        input: { command: "printf another-secret" },
      }),
    ).toMatchObject({ block: true });
    expect(pi.notifications).toEqual([
      {
        message:
          "Permission audit log is unavailable; Bash commands are blocked until logging is restored.",
        level: "error",
      },
    ]);
  });
});
