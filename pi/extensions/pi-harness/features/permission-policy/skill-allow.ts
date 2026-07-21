import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { BeforeAgentStartEvent } from "../../lib/pi-like";
import {
  evaluateCommand,
  type AllowRule,
  type LoadedRules,
  type Verdict,
} from "./rules";
import { normalizeSegment, scanCommand } from "./scan";

const MAX_SKILL_BYTES = 256 * 1024;
const MAX_ALLOWED_TOOLS_BYTES = 8 * 1024;
const MAX_BASH_GRANTS = 64;
const MAX_BASH_PATTERN_BYTES = 512;
const BASH_ENTRY_PATTERN = /Bash\(([^()]*)\)/g;
const SKILL_HEADER_PATTERN = /^<skill name="([^"\n]+)" location="([^"\n]+)">\n/;
const SAFE_GLOB_WORD_PATTERN = /^[A-Za-z0-9_@%+=:,./~*-]+$/;

interface LoadedSkillLike {
  name: string;
  filePath: string;
  baseDir: string;
}

interface LoadedSkillSnapshot {
  readonly name: string;
  readonly filePath: string;
  readonly expanded: string;
  readonly grants: readonly AllowRule[];
}

interface ParsedMarkdown {
  frontmatter: string;
  body: string;
}

interface SkillInvocation {
  readonly name: string;
  readonly args: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n?/g, "\n");

const splitFrontmatter = (markdown: string): ParsedMarkdown => {
  const normalized = normalizeNewlines(markdown);
  if (!normalized.startsWith("---")) {
    return { frontmatter: "", body: normalized.trim() };
  }
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: "", body: normalized.trim() };
  return {
    frontmatter: normalized.slice(4, end),
    body: normalized.slice(end + 4).trim(),
  };
};

const loadedSkillsFrom = (
  event: BeforeAgentStartEvent,
): readonly LoadedSkillLike[] => {
  const options = event.systemPromptOptions;
  if (!isRecord(options) || !Array.isArray(options.skills)) return [];

  const skills: LoadedSkillLike[] = [];
  for (const value of options.skills) {
    if (!isRecord(value)) continue;
    const { name, filePath, baseDir } = value;
    if (
      typeof name !== "string" ||
      typeof filePath !== "string" ||
      typeof baseDir !== "string" ||
      !isAbsolute(filePath) ||
      !isAbsolute(baseDir) ||
      dirname(filePath) !== baseDir
    ) {
      continue;
    }
    skills.push({ name, filePath, baseDir });
  }
  return skills;
};

const scalarAllowedTools = (frontmatter: string): string | undefined => {
  for (const line of frontmatter.split("\n")) {
    const match = /^allowed-tools:\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    let value = match[1] ?? "";
    if (Buffer.byteLength(value, "utf8") > MAX_ALLOWED_TOOLS_BYTES) {
      return undefined;
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        const parsed: unknown = JSON.parse(value);
        return typeof parsed === "string" ? parsed : undefined;
      } catch {
        return undefined;
      }
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    return value;
  }
  return undefined;
};

const escapeRegex = (value: string): string =>
  value.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`);

const globWordRegex = (word: string): string =>
  word
    .split("*")
    .map((part) => escapeRegex(part))
    .join("[^ ]*");

const compileBashGrant = (
  rawPattern: string,
  skillName: string,
): AllowRule | undefined => {
  if (Buffer.byteLength(rawPattern, "utf8") > MAX_BASH_PATTERN_BYTES) {
    return undefined;
  }
  let normalized = rawPattern.trim().replace(/\s+/g, " ");
  if (normalized.endsWith(":*")) {
    normalized = `${normalized.slice(0, -2)} *`;
  }
  const words = normalized.split(" ");
  if (
    words.length === 0 ||
    words[0] === "*" ||
    words.some(
      (word) =>
        word === "" ||
        !SAFE_GLOB_WORD_PATTERN.test(word) ||
        word.includes("**"),
    )
  ) {
    return undefined;
  }

  let source = "^";
  for (const [index, word] of words.entries()) {
    if (word === "*" && index === words.length - 1) {
      source += "(?: .*)?";
      continue;
    }
    if (index > 0) source += " ";
    source += word === "*" ? "[^ ]+" : globWordRegex(word);
  }
  source += "$";

  return {
    source: `active skill ${skillName}: Bash(${rawPattern})`,
    pattern: new RegExp(source),
    reason: `explicitly invoked skill ${skillName}`,
  };
};

const bashGrantsFrom = (
  frontmatter: string,
  skillName: string,
): readonly AllowRule[] => {
  const allowedTools = scalarAllowedTools(frontmatter);
  if (allowedTools === undefined) return [];

  const rules: AllowRule[] = [];
  for (const match of allowedTools.matchAll(BASH_ENTRY_PATTERN)) {
    if (rules.length >= MAX_BASH_GRANTS) return [];
    const start = match.index ?? -1;
    const end = start + match[0].length;
    const before = start <= 0 ? "" : allowedTools[start - 1];
    const after = end >= allowedTools.length ? "" : allowedTools[end];
    if (
      (before !== "" && before !== "," && !/\s/.test(before)) ||
      (after !== "" && after !== "," && !/\s/.test(after))
    ) {
      continue;
    }
    const rule = compileBashGrant(match[1] ?? "", skillName);
    if (rule !== undefined) rules.push(rule);
  }
  return rules;
};

const parseSkillInvocation = (text: string): SkillInvocation | undefined => {
  if (!text.startsWith("/skill:")) return undefined;
  const spaceIndex = text.indexOf(" ");
  return {
    name: spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex),
    args: spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim(),
  };
};

type ActiveSkillBashAllowResolver = (
  prompt: string,
  invocation: SkillInvocation,
) => readonly AllowRule[];

const snapshotLoadedSkill = (
  skill: LoadedSkillLike,
): LoadedSkillSnapshot | undefined => {
  try {
    const stats = statSync(skill.filePath);
    if (!stats.isFile() || stats.size > MAX_SKILL_BYTES) return undefined;
    const markdown = readFileSync(skill.filePath, "utf8");
    const parsed = splitFrontmatter(markdown);
    return {
      name: skill.name,
      filePath: skill.filePath,
      expanded: `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${parsed.body}\n</skill>`,
      grants: bashGrantsFrom(parsed.frontmatter, skill.name),
    };
  } catch {
    // A missing, replaced, or unreadable skill never grants permissions.
    return undefined;
  }
};

const resolvePromptBashAllows = (
  prompt: string,
  invocation: SkillInvocation,
  snapshots: readonly LoadedSkillSnapshot[],
): readonly AllowRule[] => {
  const header = SKILL_HEADER_PATTERN.exec(prompt);
  if (header === null || header[1] !== invocation.name) return [];
  const snapshot = snapshots.find(
    (candidate) =>
      candidate.name === invocation.name && candidate.filePath === header[2],
  );
  if (snapshot === undefined) return [];

  const expected =
    invocation.args === ""
      ? snapshot.expanded
      : `${snapshot.expanded}\n\n${invocation.args}`;
  return prompt === expected ? snapshot.grants : [];
};

const createActiveSkillBashAllowResolver = (
  event: BeforeAgentStartEvent,
): ActiveSkillBashAllowResolver => {
  // Snapshot body and grants together at the run boundary. A frontmatter-only
  // file change cannot silently widen a queued invocation later in this run.
  const snapshots = loadedSkillsFrom(event)
    .map((skill) => snapshotLoadedSkill(skill))
    .filter((skill) => skill !== undefined);
  return (prompt, invocation) =>
    resolvePromptBashAllows(prompt, invocation, snapshots);
};

const resolveActiveSkillBashAllows = (
  event: BeforeAgentStartEvent,
  rawInput: string,
): readonly AllowRule[] => {
  const invocation = parseSkillInvocation(rawInput);
  return invocation === undefined
    ? []
    : createActiveSkillBashAllowResolver(event)(event.prompt, invocation);
};

type SkillAwareVerdict = Verdict & { readonly grantedBySkill?: boolean };

const evaluateCommandWithSkillAllows = (
  command: string,
  rules: LoadedRules,
  skillAllows: readonly AllowRule[],
): SkillAwareVerdict => {
  const base = evaluateCommand(command, rules);
  // Skill grants are intentionally below every normal deny, ask, and static
  // allow decision. In particular, `git push --force` must still ask even if
  // the active skill broadly grants `git push *`.
  if (base.verdict !== "default-continue" || skillAllows.length === 0) {
    return base;
  }
  const withSkill = evaluateCommand(command, {
    ...rules,
    allow: [...rules.allow, ...skillAllows],
  });
  return withSkill.verdict === "allow"
    ? { ...withSkill, grantedBySkill: true }
    : base;
};

// Return the one literal `git -C` target that a skill-granted command would
// use. Dynamic, malformed, or repeated `-C` forms fail closed (undefined);
// null means the granted command does not redirect Git to another cwd.
const skillGrantedGitCwd = (command: string): string | null | undefined => {
  const scanned = scanCommand(command);
  if (!scanned.ok || scanned.segments.length !== 1) return undefined;
  const segment = normalizeSegment(scanned.segments[0]);
  if (segment.words[0] !== "git") return null;

  let target: string | undefined;
  for (let index = 1; index < segment.words.length; index += 1) {
    const word = segment.words[index];
    if (word === undefined) return undefined;
    if (word === "-C") {
      const valueIndex = index + 1;
      const value = segment.words[valueIndex];
      if (
        value === undefined ||
        segment.opaque.has(index) ||
        segment.opaque.has(valueIndex) ||
        target !== undefined
      ) {
        return undefined;
      }
      target = value;
      index = valueIndex;
      continue;
    }
    if (word.startsWith("-C") && word.length > 2) {
      if (segment.opaque.has(index) || target !== undefined) return undefined;
      target = word.slice(2);
      continue;
    }
    if (word === "-c" || word === "--config-env") {
      index += 1;
      continue;
    }
    if (word.startsWith("-c") || word.startsWith("--config-env=")) continue;
    if (word.startsWith("-")) continue;
    break;
  }
  return target ?? null;
};

export {
  createActiveSkillBashAllowResolver,
  evaluateCommandWithSkillAllows,
  parseSkillInvocation,
  resolveActiveSkillBashAllows,
  skillGrantedGitCwd,
};
export type {
  ActiveSkillBashAllowResolver,
  SkillAwareVerdict,
  SkillInvocation,
};
