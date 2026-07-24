#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import {
  buildPermissionQualificationCandidates,
  parsePermissionAuditJsonl,
  summarizePermissionAudit,
  type PermissionAuditParseDiagnostic,
  type PermissionQualificationCandidate,
} from "../../../extensions/pi-harness/features/permission-audit/analysis";
import type { PermissionDecisionRecordV1 } from "../../../extensions/pi-harness/features/permission-audit/model";

const ANALYSIS_SCHEMA = "pi-harness/permission-audit-analysis";
const TOP_ASK_SCHEMA = "pi-harness/permission-audit-top-ask";
const REVIEWED_SCHEMA = "pi-harness/permission-qualification-reviewed";
const LOG_FILE_PATTERN = /^permission-\d{4}-\d{2}-\d{2}-[0-9a-f-]{36}\.jsonl$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_8601_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_LABEL_BYTES = 16 * 1024 * 1024;
const DEFAULT_LOG_DIR = join(homedir(), ".pi/agent/pi-harness/logs");

type Command =
  | "summary"
  | "top-ask"
  | "locate"
  | "inspect"
  | "candidates"
  | "review";
type DecisionFilter = "allow" | "ask" | "deny" | "all";

interface ParsedArguments {
  readonly command: Command;
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

interface LoadedAudit {
  readonly files: number;
  readonly skippedFiles: number;
  readonly records: readonly PermissionDecisionRecordV1[];
  readonly diagnostics: readonly PermissionAuditParseDiagnostic[];
  readonly commandHashMismatches: number;
}

interface HumanLabel {
  readonly decisionId: string;
  readonly expected: "allow" | "ask";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const exactMode = (mode: number): number => mode & 0o777;

const ownerMatches = (uid: number): boolean =>
  typeof process.getuid !== "function" || uid === process.getuid();

const parseArguments = (argv: readonly string[]): ParsedArguments => {
  const commands = new Set<Command>([
    "summary",
    "top-ask",
    "locate",
    "inspect",
    "candidates",
    "review",
  ]);
  let index = 0;
  let command: Command = "summary";
  const [first] = argv;
  if (first !== undefined && !first.startsWith("--")) {
    if (!commands.has(first as Command)) {
      throw new Error(`unknown command: ${first}`);
    }
    command = first as Command;
    index += 1;
  }

  const flagNames = new Set([
    "show-sensitive",
    "include-sensitive",
    "confirm-human-labels",
  ]);
  const valueNames = new Set([
    "log-dir",
    "limit",
    "hash",
    "decision-id",
    "record-sha256",
    "match-count",
    "output",
    "decision",
    "candidate-file",
    "candidate-sha256",
    "labels",
    "since",
  ]);
  const flags = new Set<string>();
  const values = new Map<string, string>();
  while (index < argv.length) {
    const argument = argv[index];
    if (argument === undefined || !argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument ?? ""}`);
    }
    const name = argument.slice(2);
    if (flagNames.has(name)) {
      if (flags.has(name)) throw new Error(`duplicate flag: --${name}`);
      flags.add(name);
      index += 1;
      continue;
    }
    if (!valueNames.has(name)) throw new Error(`unknown option: --${name}`);
    if (values.has(name)) throw new Error(`duplicate option: --${name}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`missing value for --${name}`);
    }
    values.set(name, value);
    index += 2;
  }
  return { command, values, flags };
};

const requiredValue = (arguments_: ParsedArguments, name: string): string => {
  const value = arguments_.values.get(name);
  if (value === undefined || value === "") {
    throw new Error(`--${name} is required`);
  }
  return value;
};

const requiredAbsoluteValue = (
  arguments_: ParsedArguments,
  name: string,
): string => {
  const value = requiredValue(arguments_, name);
  if (!isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  return value;
};

const readVerifiedLog = async (path: string): Promise<string> => {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    exactMode(before.mode) !== 0o600 ||
    !ownerMatches(before.uid) ||
    before.size > MAX_FILE_BYTES
  ) {
    throw new Error("unsafe permission audit log file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      exactMode(after.mode) !== 0o600 ||
      !ownerMatches(after.uid) ||
      String(before.dev) !== String(after.dev) ||
      String(before.ino) !== String(after.ino) ||
      after.size > MAX_FILE_BYTES
    ) {
      throw new Error("permission audit log identity changed");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
};

const loadAudit = async (logDir: string): Promise<LoadedAudit> => {
  const directory = await lstat(logDir);
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    exactMode(directory.mode) !== 0o700 ||
    !ownerMatches(directory.uid)
  ) {
    throw new Error("permission audit log directory is not private");
  }
  const entries = await readdir(logDir);
  const names = entries.filter((name) => LOG_FILE_PATTERN.test(name)).sort();
  const records: PermissionDecisionRecordV1[] = [];
  const diagnostics: PermissionAuditParseDiagnostic[] = [];
  let files = 0;
  let skippedFiles = 0;
  let commandHashMismatches = 0;
  for (const name of names) {
    try {
      const text = await readVerifiedLog(join(logDir, name));
      const parsed = parsePermissionAuditJsonl(text);
      for (const record of parsed.records) {
        if (
          record.command.kind === "command" &&
          sha256Text(record.command.text) !== record.command.sha256
        ) {
          commandHashMismatches += 1;
          continue;
        }
        records.push(record);
      }
      diagnostics.push(...parsed.diagnostics);
      files += 1;
    } catch {
      skippedFiles += 1;
    }
  }
  return {
    files,
    skippedFiles,
    records,
    diagnostics,
    commandHashMismatches,
  };
};

const sortedCounts = (values: Readonly<Record<string, number>>) =>
  Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
  );

const diagnosticCounts = (
  diagnostics: readonly PermissionAuditParseDiagnostic[],
  commandHashMismatches: number,
): Readonly<Record<string, number>> => {
  const counts: Record<string, number> = {};
  if (commandHashMismatches > 0) {
    counts["command-hash-mismatch"] = commandHashMismatches;
  }
  for (const diagnostic of diagnostics) {
    counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1;
  }
  return sortedCounts(counts);
};

const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const analysisScope = (since: string | undefined) => ({
  recordWindow:
    since === undefined ? { kind: "all-retained" } : { kind: "since", since },
  fileDiagnostics: { kind: "all-retained-files" },
});

const summaryReport = (audit: LoadedAudit, since: string | undefined) => {
  const summary = summarizePermissionAudit(audit.records);
  return {
    schema: ANALYSIS_SCHEMA,
    version: 1,
    files: audit.files,
    skippedFiles: audit.skippedFiles,
    records: audit.records.length,
    scope: analysisScope(since),
    ...(since === undefined ? {} : { window: { since } }),
    diagnostics: diagnosticCounts(
      audit.diagnostics,
      audit.commandHashMismatches,
    ),
    summary: {
      total: summary.total,
      byDecision: sortedCounts(summary.byDecision),
      byDisposition: sortedCounts(summary.byDisposition),
      byRoute: sortedCounts(summary.byRoute),
      byReason: sortedCounts(summary.byReason),
      byJudgeGates: sortedCounts(summary.byJudgeGates),
      byConfirmation: sortedCounts(summary.byConfirmation),
      byProcessKind: sortedCounts(summary.byProcessKind),
    },
  };
};

const parseLimit = (value: string | undefined): number => {
  if (value === undefined) return 20;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000");
  }
  return parsed;
};

const topAskReport = (
  audit: LoadedAudit,
  limit: number,
  since: string | undefined,
) => {
  const grouped = new Map<
    string,
    {
      sha256: string;
      count: number;
      release: number;
      block: number;
      confirmations: Record<string, number>;
      reasons: Record<string, number>;
    }
  >();
  for (const record of audit.records) {
    if (
      record.effectiveDecision !== "ask" ||
      record.command.kind !== "command"
    ) {
      continue;
    }
    const current = grouped.get(record.command.sha256) ?? {
      sha256: record.command.sha256,
      count: 0,
      release: 0,
      block: 0,
      confirmations: {},
      reasons: {},
    };
    current.count += 1;
    current[record.boundaryDisposition] += 1;
    for (const stage of record.stages) {
      current.reasons[stage.reasonCode] =
        (current.reasons[stage.reasonCode] ?? 0) + 1;
      if (stage.type === "confirmation") {
        current.confirmations[stage.status] =
          (current.confirmations[stage.status] ?? 0) + 1;
      }
    }
    grouped.set(record.command.sha256, current);
  }
  const commands = [...grouped.values()]
    .sort((left, right) =>
      right.count === left.count
        ? left.sha256.localeCompare(right.sha256)
        : right.count - left.count,
    )
    .slice(0, limit)
    .map((entry) => ({
      ...entry,
      confirmations: sortedCounts(entry.confirmations),
      reasons: sortedCounts(entry.reasons),
    }));
  return {
    schema: TOP_ASK_SCHEMA,
    version: 1,
    scope: analysisScope(since),
    ...(since === undefined ? {} : { window: { since } }),
    commands,
  };
};

const ensurePrivateOutputParent = async (output: string): Promise<void> => {
  if (!isAbsolute(output)) throw new Error("--output must be an absolute path");
  const parent = dirname(output);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const stats = await lstat(parent);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    exactMode(stats.mode) !== 0o700 ||
    !ownerMatches(stats.uid)
  ) {
    throw new Error("output directory must be a private 0700 directory");
  }
};

const jsonlText = (values: readonly unknown[]): string => {
  const text = values.map((value) => JSON.stringify(value)).join("\n");
  return text === "" ? "" : `${text}\n`;
};

const sha256Text = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const writePrivateJsonl = async (
  output: string,
  values: readonly unknown[],
): Promise<string> => {
  const text = jsonlText(values);
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new Error("output exceeds the private artifact size limit");
  }
  await ensurePrivateOutputParent(output);
  const handle = await open(
    output,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || !ownerMatches(stats.uid)) {
      throw new Error("output is not a private regular file");
    }
    await handle.chmod(0o600);
    await handle.writeFile(text, "utf8");
    return sha256Text(text);
  } finally {
    await handle.close();
  }
};

const decisionFilter = (value: string | undefined): DecisionFilter => {
  const decision = value ?? "ask";
  if (!["allow", "ask", "deny", "all"].includes(decision)) {
    throw new Error("--decision must be allow, ask, deny, or all");
  }
  return decision as DecisionFilter;
};

const leapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const validIsoComponents = (match: RegExpMatchArray): boolean => {
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    ,
    zone,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const days = [
    31,
    leapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) {
    return false;
  }
  if (hourText === undefined) return true;
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== undefined && zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));
    if (
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return false;
    }
  }
  return true;
};

const parseSince = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const match = value.match(ISO_8601_PATTERN);
  const timestamp = Date.parse(value);
  if (
    match === null ||
    !validIsoComponents(match) ||
    !Number.isFinite(timestamp)
  ) {
    throw new Error("--since must be a valid ISO-8601 date or timestamp");
  }
  return new Date(timestamp).toISOString();
};

const filterSince = (
  audit: LoadedAudit,
  since: string | undefined,
): LoadedAudit =>
  since === undefined
    ? audit
    : {
        ...audit,
        records: audit.records.filter(
          (record) => Date.parse(record.timestamp) >= Date.parse(since),
        ),
      };

const rejectDuplicateCandidateIds = (
  candidates: readonly PermissionQualificationCandidate[],
): void => {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.decisionId)) {
      throw new Error("candidate records contain a duplicate decisionId");
    }
    seen.add(candidate.decisionId);
  }
};

const candidateRecords = (
  audit: LoadedAudit,
  filter: DecisionFilter,
): readonly PermissionQualificationCandidate[] => {
  const candidates = buildPermissionQualificationCandidates(
    filter === "all"
      ? audit.records
      : audit.records.filter((record) => record.effectiveDecision === filter),
  );
  rejectDuplicateCandidateIds(candidates);
  return candidates;
};

const validCandidateTask = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !["task", "none", "uncorrelated"].includes(String(value.correlation))
  ) {
    return false;
  }
  if (value.correlation !== "task") return value.task === undefined;
  return (
    isRecord(value.task) &&
    typeof value.task.text === "string" &&
    typeof value.task.source === "string" &&
    (value.task.fingerprint === undefined ||
      typeof value.task.fingerprint === "string")
  );
};

const readCandidateFile = async (
  path: string,
): Promise<{
  readonly candidates: readonly PermissionQualificationCandidate[];
  readonly sha256: string;
}> => {
  const text = await readVerifiedLog(path);
  const candidates: PermissionQualificationCandidate[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("candidate file contains invalid JSON");
    }
    if (
      !isRecord(value) ||
      value.schema !== "pi-harness/permission-qualification-candidate" ||
      value.version !== 1 ||
      typeof value.decisionId !== "string" ||
      !UUID_PATTERN.test(value.decisionId) ||
      typeof value.observedAt !== "string" ||
      !Number.isFinite(Date.parse(value.observedAt)) ||
      typeof value.command !== "string" ||
      typeof value.commandSha256 !== "string" ||
      !SHA256_PATTERN.test(value.commandSha256) ||
      sha256Text(value.command) !== value.commandSha256 ||
      !validCandidateTask(value.task) ||
      !Array.isArray(value.stages) ||
      !value.stages.every(
        (stage) =>
          isRecord(stage) &&
          typeof stage.type === "string" &&
          typeof stage.reasonCode === "string",
      ) ||
      !["allow", "ask", "deny"].includes(String(value.observedDecision)) ||
      !["release", "block"].includes(String(value.boundaryDisposition)) ||
      (value.runEvidence !== undefined && !isRecord(value.runEvidence)) ||
      (value.project !== undefined && !isRecord(value.project)) ||
      (value.leadingNavigation !== undefined &&
        !isRecord(value.leadingNavigation)) ||
      (value.gitCwd !== undefined && !isRecord(value.gitCwd)) ||
      "expected" in value
    ) {
      throw new Error("candidate file contains an invalid candidate");
    }
    candidates.push(value as unknown as PermissionQualificationCandidate);
  }
  rejectDuplicateCandidateIds(candidates);
  return { candidates, sha256: sha256Text(text) };
};

const readVerifiedLabels = async (path: string): Promise<string> => {
  const parent = await lstat(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    exactMode(parent.mode) !== 0o700 ||
    !ownerMatches(parent.uid)
  ) {
    throw new Error("labels directory must be a private 0700 directory");
  }
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    exactMode(before.mode) !== 0o600 ||
    !ownerMatches(before.uid) ||
    before.size > MAX_LABEL_BYTES
  ) {
    throw new Error("unsafe labels file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      exactMode(opened.mode) !== 0o600 ||
      !ownerMatches(opened.uid) ||
      String(before.dev) !== String(opened.dev) ||
      String(before.ino) !== String(opened.ino) ||
      opened.size > MAX_LABEL_BYTES
    ) {
      throw new Error("labels file identity changed");
    }
    const text = await handle.readFile("utf8");
    const completed = await handle.stat();
    if (
      completed.size !== opened.size ||
      completed.mtimeMs !== opened.mtimeMs ||
      completed.ctimeMs !== opened.ctimeMs
    ) {
      throw new Error("labels file changed while reading");
    }
    return text;
  } finally {
    await handle.close();
  }
};

const readLabels = async (path: string): Promise<HumanLabel[]> => {
  let value: unknown;
  try {
    value = JSON.parse(await readVerifiedLabels(path));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("labels file contains invalid JSON");
    }
    throw error;
  }
  if (!Array.isArray(value)) throw new Error("labels file must be an array");
  const labels: HumanLabel[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      typeof item.decisionId !== "string" ||
      !UUID_PATTERN.test(item.decisionId) ||
      (item.expected !== "allow" && item.expected !== "ask") ||
      seen.has(item.decisionId)
    ) {
      throw new Error("labels file contains an invalid or duplicate label");
    }
    seen.add(item.decisionId);
    labels.push({ decisionId: item.decisionId, expected: item.expected });
  }
  return labels;
};

const run = async (): Promise<void> => {
  const arguments_ = parseArguments(process.argv.slice(2));
  const logDir = arguments_.values.get("log-dir") ?? DEFAULT_LOG_DIR;

  if (arguments_.command === "review") {
    if (!arguments_.flags.has("confirm-human-labels")) {
      throw new Error("review requires --confirm-human-labels");
    }
    const candidateFile = await readCandidateFile(
      requiredAbsoluteValue(arguments_, "candidate-file"),
    );
    const expectedCandidateSha256 = requiredValue(
      arguments_,
      "candidate-sha256",
    );
    if (
      !SHA256_PATTERN.test(expectedCandidateSha256) ||
      candidateFile.sha256 !== expectedCandidateSha256
    ) {
      throw new Error("candidate file does not match --candidate-sha256");
    }
    const labels = await readLabels(
      requiredAbsoluteValue(arguments_, "labels"),
    );
    const byId = new Map(
      candidateFile.candidates.map((candidate) => [
        candidate.decisionId,
        candidate,
      ]),
    );
    const reviewed = labels.map((label) => {
      const candidate = byId.get(label.decisionId);
      if (candidate === undefined) {
        throw new Error("labels file references an unknown candidate");
      }
      return {
        ...candidate,
        schema: REVIEWED_SCHEMA,
        version: 1,
        expected: label.expected,
        labelSource: "human-review",
      };
    });
    const output = requiredValue(arguments_, "output");
    await writePrivateJsonl(output, reviewed);
    printJson({
      output,
      records: reviewed.length,
      candidateSha256: candidateFile.sha256,
    });
    return;
  }

  const since = parseSince(arguments_.values.get("since"));
  const audit = filterSince(await loadAudit(logDir), since);
  if (arguments_.command === "summary") {
    printJson(summaryReport(audit, since));
    return;
  }
  if (arguments_.command === "top-ask") {
    printJson(
      topAskReport(audit, parseLimit(arguments_.values.get("limit")), since),
    );
    return;
  }
  if (arguments_.command === "locate" || arguments_.command === "inspect") {
    const hash = requiredValue(arguments_, "hash");
    if (!SHA256_PATTERN.test(hash)) throw new Error("--hash must be SHA-256");
    const records = audit.records.filter(
      (record) => record.command.sha256 === hash,
    );
    if (records.length === 0) throw new Error("no matching command hash");
    if (arguments_.command === "locate") {
      const matches = records
        .map((record) => ({
          decisionId: record.decisionId,
          timestamp: record.timestamp,
          recordSha256: sha256Text(JSON.stringify(record)),
        }))
        .sort((left, right) =>
          left.timestamp === right.timestamp
            ? left.decisionId.localeCompare(right.decisionId)
            : left.timestamp.localeCompare(right.timestamp),
        );
      printJson({
        schema: ANALYSIS_SCHEMA,
        version: 1,
        scope: analysisScope(since),
        ...(since === undefined ? {} : { window: { since } }),
        hash,
        matchCount: matches.length,
        matches,
      });
      return;
    }
    if (!arguments_.flags.has("show-sensitive")) {
      throw new Error("inspect requires --show-sensitive");
    }
    const expectedMatchCount = Number(requiredValue(arguments_, "match-count"));
    if (
      !Number.isSafeInteger(expectedMatchCount) ||
      expectedMatchCount < 1 ||
      records.length !== expectedMatchCount
    ) {
      throw new Error("current match count differs from --match-count");
    }
    const expectedRecordSha256 = requiredValue(arguments_, "record-sha256");
    if (!SHA256_PATTERN.test(expectedRecordSha256)) {
      throw new Error("--record-sha256 must be SHA-256");
    }
    const decisionId = requiredValue(arguments_, "decision-id");
    if (!UUID_PATTERN.test(decisionId)) {
      throw new Error("--decision-id must be a UUID");
    }
    const selected = records.filter((item) => item.decisionId === decisionId);
    const [record] = selected;
    if (record === undefined || selected.length !== 1) {
      throw new Error("decisionId must uniquely match the command hash");
    }
    if (sha256Text(JSON.stringify(record)) !== expectedRecordSha256) {
      throw new Error("record changed since body-free locate");
    }
    printJson({
      schema: ANALYSIS_SCHEMA,
      version: 1,
      scope: analysisScope(since),
      ...(since === undefined ? {} : { window: { since } }),
      record,
    });
    return;
  }
  if (!arguments_.flags.has("include-sensitive")) {
    throw new Error("candidates requires --include-sensitive");
  }
  const candidates = candidateRecords(
    audit,
    decisionFilter(arguments_.values.get("decision")),
  );
  const output = requiredValue(arguments_, "output");
  const candidateSha256 = await writePrivateJsonl(output, candidates);
  printJson({
    output,
    records: candidates.length,
    candidateSha256,
    createdAt: new Date().toISOString(),
  });
};

await run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown failure";
  process.stderr.write(`permission-audit-analysis: ${message}\n`);
  process.exitCode = 1;
});
