import { readdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import {
  interpreterConcreteArg,
  isOpaqueExecutor,
  opaqueExecutorConcreteArg,
  normalizeSegment,
  type NormalizedSegment,
  scanCommand,
  type Segment,
  speculativeFloor,
} from "./scan";
import { isPackageRunnerInvocation } from "./package-runner";
import { literalTrustedCdTarget } from "./trusted-cd";
import { isPathWithin } from "../../lib/trust";

interface DenyRule {
  readonly source?: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

interface AllowRule {
  readonly source?: string;
  readonly pattern: RegExp;
  readonly reason?: string;
}

interface AskRule {
  readonly pattern: RegExp;
  readonly reason: string;
}

interface LoadedRules {
  readonly deny: readonly DenyRule[];
  readonly allow: readonly AllowRule[];
  readonly ask: readonly AskRule[];
}

type Verdict =
  | { readonly verdict: "deny"; readonly reason: string }
  | { readonly verdict: "ask"; readonly reason: string }
  | { readonly verdict: "allow"; readonly reason?: string }
  | { readonly verdict: "default-continue" };

export type PermissionVerdictBasis =
  | "parse-error"
  | "depth-limit"
  | "configured-deny"
  | "structural-deny"
  | "speculative-deny"
  | "structural-ask"
  | "rg-option-glob-ask"
  | "trusted-leading-cd"
  | "configured-allow"
  | "active-skill-allow"
  | "configured-ask"
  | "speculative-ask"
  | "builtin-read-allow"
  | "sandbox-git-allow"
  | "sandbox-read-allow"
  | "sandbox-residual"
  | "default-continue"
  | "combined-allow"
  | "combined-default";

export interface PermissionVerdictAudit {
  readonly basis: PermissionVerdictBasis;
  readonly reasonCode: string;
  readonly ruleSource?: string;
}

export type AuditedVerdict = Verdict & {
  readonly audit: PermissionVerdictAudit;
};

const audited = <T extends Verdict>(
  verdict: T,
  basis: PermissionVerdictBasis,
  ruleSource?: string,
): T & { readonly audit: PermissionVerdictAudit } => ({
  ...verdict,
  audit: {
    basis,
    reasonCode: basis,
    ...(ruleSource === undefined ? {} : { ruleSource }),
  },
});

interface TrustedReadContext {
  /** Filesystem-verified effective cwd for the command. */
  readonly cwd: string;
  /** Complete canonical non-bare roots for the verified Git repository. */
  readonly navigableRoots: readonly string[];
}

interface EvaluationOptions {
  /** Parser-only uncertainty is residual when OS effects are sandboxed. */
  readonly effectSandboxed?: boolean;
  /** Filesystem-verified target of a leading same-repository cd segment. */
  readonly trustedLeadingCdTarget?: string;
  /** Literal git -C target verified as a same-repository listed worktree path. */
  readonly trustedGitCwdTarget?: string;
  /** Canonical worktree roots writable in the active sandbox profile. */
  readonly trustedWritableWorktrees?: readonly string[];
  /** Canonical configured roots that may contain a newly created worktree. */
  readonly trustedWorktreeCreateRoots?: readonly string[];
  /** Filesystem-verified scope used only by narrow mechanical read allows. */
  readonly trustedReadContext?: TrustedReadContext;
}

interface DenyDefinition {
  readonly source?: string;
  readonly pattern: string;
  readonly reason: string;
}

interface AllowDefinition {
  readonly source?: string;
  readonly pattern: string;
  readonly reason?: string;
}

interface AskDefinition {
  readonly pattern: string;
  readonly reason: string;
}

interface ParsedRules {
  readonly deny: readonly DenyDefinition[];
  readonly allow: readonly AllowDefinition[];
  readonly ask: readonly AskDefinition[];
}

interface CompilationResult<T> {
  readonly rules: readonly T[];
  readonly invalid: boolean;
}

const BUILT_IN_DENY_DEFINITIONS: readonly DenyDefinition[] = [
  {
    source: "Bash(bit issue claim:*)",
    pattern: "^bit\\s+issue\\s+claim\\b",
    reason: "bit issue claim は禁止です",
  },
  {
    source: "Bash(bit issue unclaim:*)",
    pattern: "^bit\\s+issue\\s+unclaim\\b",
    reason: "bit issue unclaim は禁止です",
  },
  {
    source: "Bash(bit issue claims:*)",
    pattern: "^bit\\s+issue\\s+claims\\b",
    reason: "bit issue claims は禁止です",
  },
  {
    source: "Bash(bit issue watch:*)",
    pattern: "^bit\\s+issue\\s+watch\\b",
    reason: "bit issue watch は禁止です",
  },
  {
    source: "Bash(bit issue import:*)",
    pattern: "^bit\\s+issue\\s+import\\b",
    reason: "bit issue import は禁止です",
  },
  {
    source: "Bash(bit pr import:*)",
    pattern: "^bit\\s+pr\\s+import\\b",
    reason: "bit pr import は禁止です",
  },
  {
    source: "Bash(bit relay:*)",
    pattern: "^bit\\s+relay\\b",
    reason: "bit relay は禁止です",
  },
  {
    source: "Bash(bit clone relay+*)",
    pattern: "^bit\\s+clone\\s+relay\\+",
    reason: "bit clone relay+ は禁止です",
  },
];

const BUILT_IN_ASK_DEFINITIONS: readonly AskDefinition[] = [
  {
    pattern:
      "^rm\\s+(?=(?:-\\S+\\s+)*(?:\\/\\S*|~(?:\\/\\S*)?)(?:\\s|$))(?=(?:-\\S+\\s+)*-\\S*r\\S*)(?=(?:-\\S+\\s+)*-\\S*f\\S*)",
    reason: "再帰的な強制削除には確認が必要です",
  },
  {
    pattern: "^git\\s+reset\\b[^\\n]*\\s--hard(?=\\s|$)",
    reason: "hard reset には確認が必要です",
  },
  {
    pattern:
      "^git\\s+clean\\s+(?=(?:-\\S+\\s+)*-\\S*f\\S*)(?=(?:-\\S+\\s+)*-\\S*d\\S*)",
    reason: "強制 clean には確認が必要です",
  },
  {
    pattern: "^chmod\\s+-R\\s+777(?:\\s|$)",
    reason: "再帰的な全権限付与には確認が必要です",
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const parseDenyDefinition = (value: unknown): DenyDefinition | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.pattern !== "string" || typeof value.reason !== "string") {
    return undefined;
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    return undefined;
  }
  return {
    pattern: value.pattern,
    reason: value.reason,
    ...(value.source === undefined ? {} : { source: value.source }),
  };
};

const parseAllowDefinition = (value: unknown): AllowDefinition | undefined => {
  if (!isRecord(value) || typeof value.pattern !== "string") {
    return undefined;
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    return undefined;
  }
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return undefined;
  }
  return {
    pattern: value.pattern,
    ...(value.source === undefined ? {} : { source: value.source }),
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  };
};

const parseAskDefinition = (value: unknown): AskDefinition | undefined => {
  if (!isRecord(value)) return undefined;
  if (typeof value.pattern !== "string" || typeof value.reason !== "string") {
    return undefined;
  }
  return { pattern: value.pattern, reason: value.reason };
};

const parseArray = <T>(
  value: unknown,
  parse: (entry: unknown) => T | undefined,
): readonly T[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const parsed: T[] = [];
  for (const entry of value) {
    const rule = parse(entry);
    if (rule === undefined) return undefined;
    parsed.push(rule);
  }
  return parsed;
};

const parseRules = (jsonText: string): ParsedRules | undefined => {
  try {
    const value: unknown = JSON.parse(jsonText);
    if (!isRecord(value)) return undefined;

    const deny = parseArray(value.deny, parseDenyDefinition);
    const allow = parseArray(value.allow ?? [], parseAllowDefinition);
    const ask = parseArray(value.ask, parseAskDefinition);
    if (deny === undefined || allow === undefined || ask === undefined) {
      return undefined;
    }
    return { deny, allow, ask };
  } catch {
    return undefined;
  }
};

const compileDenyRules = (
  definitions: readonly DenyDefinition[],
): CompilationResult<DenyRule> => {
  const rules: DenyRule[] = [];
  let invalid = false;
  for (const definition of definitions) {
    try {
      rules.push({
        pattern: new RegExp(definition.pattern),
        reason: definition.reason,
        ...(definition.source === undefined
          ? {}
          : { source: definition.source }),
      });
    } catch {
      invalid = true;
    }
  }
  return { rules, invalid };
};

const compileAllowRules = (
  definitions: readonly AllowDefinition[],
): CompilationResult<AllowRule> => {
  const rules: AllowRule[] = [];
  let invalid = false;
  for (const definition of definitions) {
    try {
      rules.push({
        pattern: new RegExp(definition.pattern),
        ...(definition.source === undefined
          ? {}
          : { source: definition.source }),
        ...(definition.reason === undefined
          ? {}
          : { reason: definition.reason }),
      });
    } catch {
      invalid = true;
    }
  }
  return { rules, invalid };
};

const compileAskRules = (
  definitions: readonly AskDefinition[],
): CompilationResult<AskRule> => {
  const rules: AskRule[] = [];
  let invalid = false;
  for (const definition of definitions) {
    try {
      rules.push({
        pattern: new RegExp(definition.pattern),
        reason: definition.reason,
      });
    } catch {
      invalid = true;
    }
  }
  return { rules, invalid };
};

const builtInDenyRules = (): readonly DenyRule[] => {
  return compileDenyRules(BUILT_IN_DENY_DEFINITIONS).rules;
};

const builtInAskRules = (): readonly AskRule[] => {
  return compileAskRules(BUILT_IN_ASK_DEFINITIONS).rules;
};

const loadRules = (jsonText: string | undefined): LoadedRules => {
  const parsed = jsonText === undefined ? undefined : parseRules(jsonText);
  if (parsed === undefined) {
    return {
      deny: builtInDenyRules(),
      allow: [],
      ask: builtInAskRules(),
    };
  }

  const deny = compileDenyRules(parsed.deny);
  const allow = compileAllowRules(parsed.allow);
  const ask = compileAskRules(parsed.ask);

  // The built-in deny floor is ALWAYS unioned in — a valid-but-empty rules
  // file must not be able to drop the mandatory denials (review finding:
  // fail-closed means the floor survives every config shape).
  return {
    deny: [...deny.rules, ...builtInDenyRules()],
    allow: allow.rules,
    ask: [...ask.rules, ...builtInAskRules()],
  };
};

// --- Verdict evaluation ------------------------------------------------------

const MAX_SUBSTITUTION_DEPTH = 20;

const UNPARSEABLE_REASON =
  "permission-policy: コマンドを解析できませんでした（引用符/括弧の不整合または未対応構文のため fail-closed でブロックしました）";
const OPAQUE_EXECUTOR_REASON =
  "不透明な実行子（eval / sh -c / xargs 等）は内容を静的に検査できないため確認が必要です";
const POTENTIALLY_SENSITIVE_REASON =
  "動的展開・未対応構文により、禁止/破壊的コマンドにならないと静的に判定できないため確認が必要です";

// Structural deny for a bit invocation that a `^`-anchored regex cannot express
// robustly: `bit clone` with a `relay+…` operand in ANY position (options may
// precede it, so `bit clone --depth 1 relay+x` must not slip past). The head and
// wrappers are already normalized by normalizeSegment.
const structuralBitDeny = (seg: NormalizedSegment): string | undefined => {
  const { words } = seg;
  if (words[0] !== "bit" || words[1] !== "clone") return undefined;
  for (let i = 2; i < words.length; i += 1) {
    if (!seg.opaque.has(i) && words[i].startsWith("relay+")) {
      return "bit clone relay+ は禁止です";
    }
  }
  return undefined;
};

const NOTES_MUTATION_ACTIONS: ReadonlySet<string> = new Set([
  "add",
  "append",
  "copy",
  "edit",
  "merge",
  "prune",
  "remove",
]);
const NOTES_READ_ACTIONS: ReadonlySet<string> = new Set([
  "get-ref",
  "list",
  "show",
]);

const notesMutationReason = (command: "bit" | "git"): string =>
  `${command} notes による直接変更は禁止です`;

// `git notes` and `bit notes` writes belong to the structured agent-memory
// feature. Keep this as a structural floor: configured regexes cannot safely
// account for Git global options, wrapper normalization, or an opaque action.
// A concrete list/show action remains on the ordinary policy path.
const notesActionDeny = (
  seg: NormalizedSegment,
  command: "bit" | "git",
  start: number,
): string | undefined => {
  let index = start;
  while (index < seg.words.length) {
    const word = seg.words[index];
    if (word === undefined) return undefined;
    if (seg.opaque.has(index)) return notesMutationReason(command);
    if (word === "--") {
      index += 1;
      break;
    }
    if (word === "--ref") {
      if (seg.words[index + 1] === undefined) return undefined;
      index += 2;
      continue;
    }
    if (word.startsWith("--ref=")) {
      index += 1;
      continue;
    }
    if (word.startsWith("-")) {
      // An unknown option makes the action position ambiguous. Continue
      // looking so a following literal or opaque mutation cannot bypass the
      // boundary; harmless option-only forms remain on the ordinary path.
      index += 1;
      continue;
    }
    break;
  }

  const action = seg.words[index];
  if (action === undefined) return undefined;
  if (
    seg.opaque.has(index) ||
    NOTES_MUTATION_ACTIONS.has(action) ||
    !NOTES_READ_ACTIONS.has(action)
  ) {
    return notesMutationReason(command);
  }
  return undefined;
};

const structuralNotesDeny = (seg: NormalizedSegment): string | undefined => {
  if (seg.words[0] === "bit" && seg.words[1] === "notes") {
    return notesActionDeny(seg, "bit", 2);
  }

  const position = gitSubcommandPosition(seg.words);
  if (
    position === undefined ||
    seg.opaque.has(position.index) ||
    seg.words[position.index] !== "notes"
  ) {
    return undefined;
  }
  return notesActionDeny(seg, "git", position.index + 1);
};

const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--attr-source",
  "--config-env",
  "--git-dir",
  "--namespace",
  "--work-tree",
]);

const GIT_INERT_GLOBAL_OPTIONS: ReadonlySet<string> = new Set([
  "-P",
  "--no-pager",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-advice",
  "--version",
]);

interface GitSubcommandPosition {
  readonly index: number;
  readonly ambiguousOption: boolean;
  readonly riskyGlobalOption: boolean;
  readonly cOnlyGlobalOption: boolean;
}

const gitSubcommandPosition = (
  words: readonly string[],
): GitSubcommandPosition | undefined => {
  if (words[0] !== "git") return undefined;
  let index = 1;
  let ambiguousOption = false;
  let riskyGlobalOption = false;
  let sawCOption = false;
  let sawOtherRiskyOption = false;
  while (index < words.length) {
    const word = words[index];
    if (word === undefined) return undefined;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(word)) {
      riskyGlobalOption = true;
      if (word === "-C") sawCOption = true;
      else sawOtherRiskyOption = true;
      index += 2;
      continue;
    }
    if ((word.startsWith("-C") || word.startsWith("-c")) && word.length > 2) {
      riskyGlobalOption = true;
      if (word.startsWith("-C")) sawCOption = true;
      else sawOtherRiskyOption = true;
      index += 1;
      continue;
    }
    if (GIT_INERT_GLOBAL_OPTIONS.has(word)) {
      index += 1;
      continue;
    }
    if (word.startsWith("--") && word.includes("=")) {
      riskyGlobalOption = true;
      sawOtherRiskyOption = true;
      index += 1;
      continue;
    }
    if (word.startsWith("-")) {
      // Unknown no-equals options may alter command resolution or consume the
      // following word. They are not eligible for residual model approval.
      ambiguousOption = true;
      index += 1;
      continue;
    }
    return {
      index,
      ambiguousOption,
      riskyGlobalOption,
      cOnlyGlobalOption:
        riskyGlobalOption && sawCOption && !sawOtherRiskyOption,
    };
  }
  return undefined;
};

const FORCE_PUSH_LONG_OPTIONS = [
  "force",
  "force-with-lease",
  "force-if-includes",
] as const;
const DESTRUCTIVE_PUSH_LONG_OPTIONS = ["delete", "mirror", "prune"] as const;
const COMMAND_PUSH_LONG_OPTIONS = ["exec", "receive-pack"] as const;

const abbreviatesLongOption = (
  word: string,
  options: readonly string[],
): boolean => {
  if (!word.startsWith("--")) return false;
  const name = word.slice(2).split("=", 1)[0] ?? "";
  return name !== "" && options.some((option) => option.startsWith(name));
};

const STANDARD_GIT_URL_SCHEMES: ReadonlySet<string> = new Set([
  "file",
  "ftp",
  "ftps",
  "git",
  "http",
  "https",
  "git+ssh",
  "ssh",
  "ssh+git",
]);

const gitUrlScheme = (word: string): string | undefined =>
  /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(word)?.[1]?.toLowerCase();

const remoteHelperExec = (word: string): boolean => {
  const repository = word.startsWith("--repo=")
    ? word.slice("--repo=".length)
    : word;
  if (/^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(repository)) return true;
  const scheme = gitUrlScheme(repository);
  return scheme !== undefined && !STANDARD_GIT_URL_SCHEMES.has(scheme);
};

const clusteredPushRisk = (
  word: string,
): "force" | "destructive" | undefined => {
  if (!/^-[^-]/.test(word)) return undefined;
  for (const option of word.slice(1)) {
    if (option === "f") return "force";
    if (option === "d") return "destructive";
    // -o consumes the rest of this word as a push-option value; letters in
    // that value are not additional short options.
    if (option === "o") return undefined;
  }
  return undefined;
};

const optionIs = (word: string, ...names: readonly string[]): boolean =>
  names.includes(word) ||
  names.some((name) => name.startsWith("--") && word.startsWith(`${name}=`));

const hasPathTraversal = (word: string): boolean =>
  word.split("/").some((part) => part === "..");

const gitPushRisk = (rest: readonly string[]): string | undefined => {
  for (const word of rest) {
    const shortRisk = clusteredPushRisk(word);
    if (
      abbreviatesLongOption(word, FORCE_PUSH_LONG_OPTIONS) ||
      shortRisk === "force"
    ) {
      return "強制 push には確認が必要です";
    }
    if (
      abbreviatesLongOption(word, COMMAND_PUSH_LONG_OPTIONS) ||
      remoteHelperExec(word)
    ) {
      return "remote 側で任意コマンドを指定する push には確認が必要です";
    }
    if (
      abbreviatesLongOption(word, DESTRUCTIVE_PUSH_LONG_OPTIONS) ||
      shortRisk === "destructive" ||
      word.startsWith("+") ||
      word.startsWith(":")
    ) {
      return "remote ref を削除・強制更新する push には確認が必要です";
    }
  }
  return undefined;
};

const FORCE_FETCH_LONG_OPTIONS = ["force"] as const;
const HELPER_FETCH_LONG_OPTIONS = ["server-option", "upload-pack"] as const;
const DYNAMIC_FETCH_LONG_OPTIONS = ["refmap", "stdin"] as const;
const DESTRUCTIVE_FETCH_LONG_OPTIONS = [
  "prune",
  "prune-tags",
  "update-head-ok",
] as const;

type FetchRisk = "destructive" | "force" | "helper";

const clusteredFetchRisk = (word: string): FetchRisk | undefined => {
  if (!/^-[^-]/.test(word)) return undefined;
  for (const option of word.slice(1)) {
    if (option === "f") return "force";
    if (option === "o") return "helper";
    if (option === "p" || option === "P" || option === "u") {
      return "destructive";
    }
    // -j consumes the remainder as its jobs value.
    if (option === "j") return undefined;
  }
  return undefined;
};

const FETCH_LONG_OPTIONS_WITH_VALUE = [
  "deepen",
  "depth",
  "filter",
  "jobs",
  "negotiation-tip",
  "refmap",
  "server-option",
  "shallow-exclude",
  "shallow-since",
  "submodule-prefix",
  "upload-pack",
] as const;
const FETCH_SHORT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["j", "o"]);

const shortOptionConsumesNext = (
  word: string,
  optionsWithValue: ReadonlySet<string>,
): boolean => {
  if (!/^-[^-]/.test(word)) return false;
  for (let index = 1; index < word.length; index += 1) {
    if (optionsWithValue.has(word[index] ?? "")) {
      return index === word.length - 1;
    }
  }
  return false;
};

const gitFetchRisk = (rest: readonly string[]): string | undefined => {
  let parsingOptions = true;
  let multipleRepositories = false;
  let positionalCount = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) break;
    if (word === "--" && parsingOptions) {
      parsingOptions = false;
      continue;
    }
    const shortRisk = parsingOptions ? clusteredFetchRisk(word) : undefined;
    if (
      (parsingOptions &&
        abbreviatesLongOption(word, FORCE_FETCH_LONG_OPTIONS)) ||
      shortRisk === "force"
    ) {
      return "強制 git fetch には確認が必要です";
    }
    if (
      (parsingOptions &&
        abbreviatesLongOption(word, HELPER_FETCH_LONG_OPTIONS)) ||
      shortRisk === "helper"
    ) {
      return "外部helperまたはtransport overrideを使う git fetch には確認が必要です";
    }
    if (
      parsingOptions &&
      abbreviatesLongOption(word, DYNAMIC_FETCH_LONG_OPTIONS)
    ) {
      return "動的なrefspecを使う git fetch には確認が必要です";
    }
    if (
      (parsingOptions &&
        abbreviatesLongOption(word, DESTRUCTIVE_FETCH_LONG_OPTIONS)) ||
      shortRisk === "destructive"
    ) {
      return "refを削除・直接更新する git fetch には確認が必要です";
    }
    if (parsingOptions && abbreviatesLongOption(word, ["multiple"])) {
      multipleRepositories = true;
    }
    if (
      parsingOptions &&
      !word.includes("=") &&
      (abbreviatesLongOption(word, FETCH_LONG_OPTIONS_WITH_VALUE) ||
        shortOptionConsumesNext(word, FETCH_SHORT_OPTIONS_WITH_VALUE))
    ) {
      index += 1;
      continue;
    }
    if (parsingOptions && word.startsWith("-")) continue;

    const isRepository = multipleRepositories || positionalCount === 0;
    positionalCount += 1;
    if (isRepository) {
      if (remoteHelperExec(word)) {
        return "外部helperまたはtransport overrideを使う git fetch には確認が必要です";
      }
      continue;
    }
    if (word.startsWith("+")) {
      return "強制 git fetch には確認が必要です";
    }
    if (word.includes(":")) {
      return "refを削除・直接更新する git fetch には確認が必要です";
    }
  }
  return undefined;
};

const clusteredSwitchRisk = (
  word: string,
  subcommand: "checkout" | "switch",
): boolean => {
  if (!/^-[^-]/.test(word)) return false;
  for (const option of word.slice(1)) {
    if (option === "f" || option === "m") return true;
    if (subcommand === "switch") {
      if (option === "C") return true;
      // -c consumes the remainder as the new branch name.
      if (option === "c") return false;
    } else {
      if (option === "B") return true;
      // -b consumes the remainder as the new branch name.
      if (option === "b") return false;
    }
  }
  return false;
};

const gitSwitchRisk = (
  subcommand: "checkout" | "switch",
  rest: readonly string[],
): string | undefined => {
  const destructiveLongOptions = [
    "conflict",
    "discard-changes",
    "force",
    "force-create",
    "ignore-other-worktrees",
    "merge",
    "orphan",
  ] as const;
  for (const word of rest) {
    if (word === "--") return undefined;
    if (
      abbreviatesLongOption(word, destructiveLongOptions) ||
      clusteredSwitchRisk(word, subcommand)
    ) {
      return `git ${subcommand} による変更破棄・branch強制更新には確認が必要です`;
    }
  }
  return undefined;
};

const COMMIT_LONG_OPTIONS_WITH_VALUE = [
  "author",
  "cleanup",
  "date",
  "file",
  "fixup",
  "message",
  "reedit-message",
  "reuse-message",
  "squash",
  "template",
  "trailer",
] as const;
const COMMIT_SHORT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "C",
  "F",
  "c",
  "m",
  "t",
]);
const LOG_SHOW_LONG_OPTIONS_WITH_VALUE = [
  "after",
  "anchored",
  "author",
  "before",
  "committer",
  "date",
  "decorate-refs",
  "decorate-refs-exclude",
  "diff-algorithm",
  "diff-filter",
  "dst-prefix",
  "encoding",
  "exclude",
  "exclude-hidden",
  "find-object",
  "glob",
  "grep",
  "grep-reflog",
  "ignore-matching-lines",
  "inter-hunk-context",
  "line-prefix",
  "max-count",
  "max-parents",
  "min-parents",
  "output",
  "output-indicator-context",
  "output-indicator-new",
  "output-indicator-old",
  "rotate-to",
  "since",
  "since-as-filter",
  "skip",
  "skip-to",
  "src-prefix",
  "stat-count",
  "stat-name-width",
  "stat-width",
  "until",
  "word-diff-regex",
  "ws-error-highlight",
] as const;
const LOG_SHOW_SHORT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "G",
  "L",
  "O",
  "S",
  "U",
  "l",
  "n",
]);
const MERGE_LONG_OPTIONS_WITH_VALUE = [
  "cleanup",
  "file",
  "into-name",
  "message",
  "strategy",
  "strategy-option",
] as const;
const MERGE_SHORT_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "F",
  "X",
  "m",
  "s",
]);

const gitCommitRisk = (rest: readonly string[]): string | undefined => {
  let parsingOptions = true;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) break;
    if (word === "--" && parsingOptions) {
      parsingOptions = false;
      continue;
    }
    if (!parsingOptions) continue;
    if (abbreviatesLongOption(word, ["amend"])) {
      return "git commit --amend による履歴変更には確認が必要です";
    }
    if (
      abbreviatesLongOption(word, ["pathspec-file-nul", "pathspec-from-file"])
    ) {
      return "外部入力からpathspecを読む git commit には確認が必要です";
    }
    if (
      !word.includes("=") &&
      (abbreviatesLongOption(word, COMMIT_LONG_OPTIONS_WITH_VALUE) ||
        shortOptionConsumesNext(word, COMMIT_SHORT_OPTIONS_WITH_VALUE))
    ) {
      index += 1;
    }
  }
  return undefined;
};

const gitMergeRisk = (rest: readonly string[]): string | undefined => {
  let parsingOptions = true;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) break;
    if (word === "--" && parsingOptions) {
      parsingOptions = false;
      continue;
    }
    if (!parsingOptions) continue;
    if (abbreviatesLongOption(word, ["abort", "quit"])) {
      return "git merge の中断による作業ツリー・状態変更には確認が必要です";
    }
    if (
      !word.includes("=") &&
      (abbreviatesLongOption(word, MERGE_LONG_OPTIONS_WITH_VALUE) ||
        shortOptionConsumesNext(word, MERGE_SHORT_OPTIONS_WITH_VALUE))
    ) {
      index += 1;
    }
  }
  return undefined;
};

const gitPathspecOperands = (
  subcommand: string,
  rest: readonly string[],
): readonly string[] => {
  if (!["add", "commit", "log", "show"].includes(subcommand)) return [];
  let longOptionsWithValue: readonly string[] = [];
  let shortOptionsWithValue: ReadonlySet<string> = new Set();
  if (subcommand === "commit") {
    longOptionsWithValue = COMMIT_LONG_OPTIONS_WITH_VALUE;
    shortOptionsWithValue = COMMIT_SHORT_OPTIONS_WITH_VALUE;
  } else if (subcommand === "log" || subcommand === "show") {
    longOptionsWithValue = LOG_SHOW_LONG_OPTIONS_WITH_VALUE;
    shortOptionsWithValue = LOG_SHOW_SHORT_OPTIONS_WITH_VALUE;
  }
  const operands: string[] = [];
  let parsingOptions = true;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) break;
    if (word === "--" && parsingOptions) {
      parsingOptions = false;
      continue;
    }
    if (
      parsingOptions &&
      !word.includes("=") &&
      (abbreviatesLongOption(word, longOptionsWithValue) ||
        shortOptionConsumesNext(word, shortOptionsWithValue))
    ) {
      index += 1;
      continue;
    }
    if (parsingOptions && word.startsWith("-")) continue;
    operands.push(word);
  }
  return operands;
};

const gitSubcommandAsk = (
  subcommand: string,
  rest: readonly string[],
): string | undefined => {
  if (subcommand === "push") {
    return (
      gitPushRisk(rest) ?? "git push は remote を変更するため確認が必要です"
    );
  }
  if (subcommand === "help") {
    return "Git help viewer の外部program実行には確認が必要です";
  }
  if (
    ["reset", "restore", "rebase", "cherry-pick", "revert"].includes(subcommand)
  ) {
    return `git ${subcommand} は作業ツリーまたは履歴を変更するため確認が必要です`;
  }
  if (
    subcommand === "clean" &&
    rest.some(
      (word) => optionIs(word, "-f", "--force") || /^-[^-]*f/.test(word),
    )
  ) {
    return "git clean によるファイル削除には確認が必要です";
  }
  if (
    subcommand === "branch" &&
    rest.some(
      (word) =>
        optionIs(word, "-d", "-D", "-f", "--delete", "--force") ||
        abbreviatesLongOption(word, ["delete", "force"]) ||
        /^-[^-]*[dDf]/.test(word),
    )
  ) {
    return "Git branch の削除・強制更新には確認が必要です";
  }
  if (
    subcommand === "worktree" &&
    rest.some((word) => ["remove", "move", "prune", "repair"].includes(word))
  ) {
    return "Git worktree の削除・移動・修復には確認が必要です";
  }
  if (subcommand === "fetch") {
    const risk = gitFetchRisk(rest);
    if (risk !== undefined) return risk;
  }
  if (subcommand === "switch" || subcommand === "checkout") {
    const risk = gitSwitchRisk(subcommand, rest);
    if (risk !== undefined) return risk;
  }
  if (
    gitPathspecOperands(subcommand, rest).some(
      (word) => word.startsWith(":(") || /^:[!/^]/.test(word),
    )
  ) {
    return `git ${subcommand} のpathspec magicには確認が必要です`;
  }
  if (subcommand === "add") {
    let parsingOptions = true;
    for (const word of rest) {
      if (word === "--") {
        parsingOptions = false;
        continue;
      }
      if (
        parsingOptions &&
        (abbreviatesLongOption(word, ["force"]) || /^-[^-]*f/.test(word))
      ) {
        return "ignored fileを強制追加する git add には確認が必要です";
      }
      if (
        parsingOptions &&
        abbreviatesLongOption(word, ["pathspec-file-nul", "pathspec-from-file"])
      ) {
        return "外部入力からpathspecを読む git add には確認が必要です";
      }
    }
  }
  if (subcommand === "commit") {
    const risk = gitCommitRisk(rest);
    if (risk !== undefined) return risk;
  }
  if (subcommand === "merge") {
    const risk = gitMergeRisk(rest);
    if (risk !== undefined) return risk;
  }
  if (subcommand === "add" && rest.some(hasPathTraversal)) {
    return "worktree 外を参照する git add には確認が必要です";
  }
  return undefined;
};

const literalGitCwdTarget = (
  seg: NormalizedSegment,
  position: GitSubcommandPosition,
): string | undefined => {
  if (!position.cOnlyGlobalOption || position.ambiguousOption) return undefined;
  let target: string | undefined;
  for (let index = 1; index < position.index; index += 1) {
    const word = seg.words[index];
    if (word === undefined || seg.opaque.has(index)) return undefined;
    if (word === "-C") {
      const valueIndex = index + 1;
      const value = seg.words[valueIndex];
      if (
        value === undefined ||
        seg.opaque.has(valueIndex) ||
        target !== undefined
      ) {
        return undefined;
      }
      target = value;
      index = valueIndex;
      continue;
    }
    if (word.startsWith("-C") && word.length > 2) {
      if (target !== undefined) return undefined;
      target = word.slice(2);
    }
  }
  // Bash expands a leading `~`, while Node path resolution treats it as a
  // literal directory. Likewise, lexical normalization of `link/..` differs
  // from Git/chdir resolution when `link` is a symlink. Keep both shapes on
  // the confirmation path instead of attaching false listed-worktree scope.
  return target !== undefined &&
    !target.startsWith("~") &&
    !hasPathTraversal(target)
    ? target
    : undefined;
};

const GIT_GLOBAL_OPTION_REASON =
  "Git の作業場所・設定・不明なグローバルオプション変更には確認が必要です";

const structuralGitAsk = (
  seg: NormalizedSegment,
  trustedGitCwdTarget?: string,
): string | undefined => {
  const position = gitSubcommandPosition(seg.words);
  if (position === undefined) return undefined;
  const gitCwdTarget = literalGitCwdTarget(seg, position);
  const verifiedGitCwd =
    trustedGitCwdTarget !== undefined && gitCwdTarget === trustedGitCwdTarget;
  if (
    position.ambiguousOption ||
    (position.riskyGlobalOption && !verifiedGitCwd)
  ) {
    return GIT_GLOBAL_OPTION_REASON;
  }
  if (seg.opaque.has(position.index)) {
    return "Git サブコマンドを静的に特定できないため確認が必要です";
  }

  const subcommand = seg.words[position.index];
  if (subcommand === undefined) return undefined;
  return gitSubcommandAsk(subcommand, seg.words.slice(position.index + 1));
};

const FIND_RISK_TOKENS: ReadonlySet<string> = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-fprint",
  "-fprintf",
  "-fls",
]);

const SENSITIVE_PATH_COMPONENTS: readonly (readonly string[])[] = [
  [".ssh"],
  [".gnupg"],
  [".aws", "credentials"],
  [".config", "gcloud"],
  [".kube", "config"],
  [".netrc"],
  [".npmrc"],
  [".pypirc"],
  ["etc", "shadow"],
  ["etc", "sudoers"],
];

const stripGitPathspecMagic = (word: string): string => {
  if (word.startsWith(":(")) {
    const end = word.indexOf(")", 2);
    return end === -1 ? word : word.slice(end + 1);
  }
  return /^:[!/^]/.test(word) ? word.slice(2) : word;
};

const containsSensitivePath = (words: readonly string[]): boolean =>
  words.some((word) => {
    // `:` is also a boundary for Git revision paths such as
    // `HEAD:.ssh/id_ed25519`; `/` covers absolute, home, and relative paths.
    // Strip Git's leading pathspec magic so `:(top).ssh/...` cannot hide the
    // sensitive component from deterministic inspection.
    const components = stripGitPathspecMagic(word)
      .toLowerCase()
      .split(/[/:]/)
      .filter(Boolean);
    return SENSITIVE_PATH_COMPONENTS.some((sensitive) =>
      components.some((_, start) =>
        sensitive.every(
          (component, offset) => components[start + offset] === component,
        ),
      ),
    );
  });

const isUploadCommand = (words: readonly string[]): boolean => {
  const [head, ...rest] = words;
  if (head === "scp" || head === "sftp" || head === "ssh") return true;
  if (head === "rsync" && rest.some((word) => word.includes(":"))) return true;
  if (head !== "curl") return false;
  return rest.some(
    (word) =>
      optionIs(
        word,
        "-d",
        "--data",
        "--data-ascii",
        "--data-binary",
        "--data-raw",
        "--data-urlencode",
        "-F",
        "--form",
        "--form-string",
        "--json",
        "-T",
        "--upload-file",
        "-X",
        "--request",
      ) || /^-[dFTX].+/.test(word),
  );
};

const RG_EXECUTION_OPTIONS: ReadonlySet<string> = new Set([
  "--pre",
  "--hostname-bin",
  "-z",
  "--search-zip",
  "-L",
  "--follow",
]);

const hasRgExecutionOption = (words: readonly string[]): boolean =>
  words
    .slice(1)
    .some(
      (word) =>
        RG_EXECUTION_OPTIONS.has(word) ||
        word.startsWith("--pre=") ||
        word.startsWith("--hostname-bin=") ||
        (/^-[^-]/.test(word) && /[Lz]/.test(word.slice(1))),
    );

const hasGitReadExecutionOption = (words: readonly string[]): boolean =>
  words.some(
    (word) =>
      word === "--ext-diff" ||
      word === "--textconv" ||
      word === "--help" ||
      word === "--output" ||
      word.startsWith("--output="),
  );

const RG_SAFE_FLAG_OPTIONS: ReadonlySet<string> = new Set([
  "--case-sensitive",
  "--fixed-strings",
  "--hidden",
  "--ignore-case",
  "--line-number",
  "--no-config",
  "--smart-case",
  "--word-regexp",
  "-F",
  "-i",
  "-n",
  "-s",
  "-S",
  "-w",
]);

const RG_SAFE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--glob",
  "-g",
  "--type",
  "-t",
  "--type-not",
  "-T",
]);

interface RgReadOperand {
  readonly index: number;
  readonly value: string;
  readonly literalGlob: boolean;
}

const rgReadOperands = (
  normalized: NormalizedSegment,
): readonly RgReadOperand[] | undefined => {
  const { words } = normalized;
  let literal = false;
  let noConfig = false;
  const positional: { index: number; value: string }[] = [];
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (word === undefined) return undefined;
    if (!literal && word === "--") {
      literal = true;
      continue;
    }
    if (!literal && word.startsWith("-")) {
      if (word === "--no-config") noConfig = true;
      if (RG_SAFE_FLAG_OPTIONS.has(word)) continue;
      if (RG_SAFE_VALUE_OPTIONS.has(word)) {
        index += 1;
        if (words[index] === undefined) return undefined;
        continue;
      }
      if (
        word.startsWith("--glob=") ||
        word.startsWith("--type=") ||
        word.startsWith("--type-not=") ||
        /^-[gtT].+/.test(word)
      ) {
        continue;
      }
      if (/^-[FinisSw]+$/.test(word)) continue;
      return undefined;
    }
    positional.push({ index, value: word });
  }
  const [pattern, ...paths] = positional;
  if (
    !noConfig ||
    pattern === undefined ||
    normalized.opaque.has(pattern.index)
  ) {
    return undefined;
  }

  const operands = paths.map(({ index, value }) => ({
    index,
    value,
    literalGlob: normalized.literalGlobs.has(index),
  }));
  const allowedOpaque = new Set(
    operands
      .filter((operand) => operand.literalGlob)
      .map((operand) => operand.index),
  );
  for (const index of normalized.opaque) {
    if (!allowedOpaque.has(index)) return undefined;
  }
  return operands;
};

const pathInsideVerifiedRoots = (
  path: string,
  roots: readonly string[],
): boolean => roots.some((root) => isPathWithin(path, root));

const canonicalOrAncestorInsideRoots = (
  candidate: string,
  roots: readonly string[],
): boolean => {
  let current = candidate;
  while (true) {
    try {
      return pathInsideVerifiedRoots(realpathSync(current), roots);
    } catch {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
};

const simpleStarPattern = (value: string): RegExp | undefined => {
  if (!value.includes("*") || /[?[\]{}]/.test(value)) return undefined;
  const source = value
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))
    // Shell `*` may match newlines, and dotfiles can become eligible when the
    // caller environment enables dotglob (directly or through GLOBIGNORE).
    // Validate that conservative superset; basenames cannot contain `/`.
    .join("[^/]*");
  return new RegExp(`^${source}$`, "u");
};

interface RgGlobInspection {
  readonly bounded: boolean;
  readonly optionLike: boolean;
}

const inspectProjectBoundedRgGlob = (
  operand: string,
  context: TrustedReadContext,
): RgGlobInspection => {
  const unsafe = { bounded: false, optionLike: false };
  const parentOperand = dirname(operand);
  if (parentOperand.includes("*")) return unsafe;
  const match = simpleStarPattern(basename(operand));
  if (match === undefined) return unsafe;
  const parentPath = isAbsolute(parentOperand)
    ? parentOperand
    : resolve(context.cwd, parentOperand);
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(parentPath);
  } catch {
    return unsafe;
  }
  if (!pathInsideVerifiedRoots(canonicalParent, context.navigableRoots)) {
    return unsafe;
  }

  let entries: string[];
  try {
    entries = readdirSync(canonicalParent);
  } catch {
    return unsafe;
  }
  const matches = entries.filter((candidate) => match.test(candidate));
  // Check the complete expansion set before containment so an earlier symlink
  // escape cannot hide a later argv option from the deterministic ASK.
  if (matches.some((entry) => entry.startsWith("-"))) {
    // Shell expansion happens before rg parses argv. A basename such as `-L`
    // or `--pre=sh` can therefore turn a path glob into an execution option.
    return { bounded: false, optionLike: true };
  }
  for (const entry of matches) {
    try {
      if (
        !pathInsideVerifiedRoots(
          realpathSync(resolve(canonicalParent, entry)),
          context.navigableRoots,
        )
      ) {
        return unsafe;
      }
    } catch {
      return unsafe;
    }
  }
  return { bounded: true, optionLike: false };
};

const hasRgOptionLikeGlobExpansion = (
  normalized: NormalizedSegment,
  context: TrustedReadContext | undefined,
): boolean => {
  if (context === undefined) return false;
  const operands = rgReadOperands(normalized);
  return (
    operands?.some(
      (operand) =>
        operand.literalGlob &&
        inspectProjectBoundedRgGlob(operand.value, context).optionLike,
    ) === true
  );
};

const isProjectBoundedRgRead = (
  normalized: NormalizedSegment,
  context: TrustedReadContext | undefined,
): boolean => {
  if (context === undefined || context.navigableRoots.length === 0) {
    return false;
  }
  const operands = rgReadOperands(normalized);
  if (operands === undefined) return false;
  const paths =
    operands.length === 0
      ? [{ index: -1, value: ".", literalGlob: false }]
      : operands;
  return paths.every((operand) => {
    if (
      operand.value === "" ||
      operand.value.startsWith("~") ||
      hasPathTraversal(operand.value)
    ) {
      return false;
    }
    if (operand.literalGlob) {
      return inspectProjectBoundedRgGlob(operand.value, context).bounded;
    }
    const candidate = isAbsolute(operand.value)
      ? operand.value
      : resolve(context.cwd, operand.value);
    return canonicalOrAncestorInsideRoots(candidate, context.navigableRoots);
  });
};

interface StructuralRisk {
  readonly kind: "semantic" | "parser-only";
  readonly reason: string;
}

const structuralKnownRisk = (
  segment: Segment,
  normalized: NormalizedSegment,
  trustedGitCwdTarget?: string,
): StructuralRisk | undefined => {
  if (
    containsSensitivePath([...normalized.words, ...segment.redirectionTargets])
  ) {
    return {
      kind: "semantic",
      reason: "認証情報または機密設定へのアクセスには確認が必要です",
    };
  }
  if (
    normalized.words[0] === "find" &&
    normalized.words.some((word) => FIND_RISK_TOKENS.has(word))
  ) {
    return {
      kind: "semantic",
      reason: "find による削除・コマンド実行・ファイル出力には確認が必要です",
    };
  }
  if (isUploadCommand(normalized.words)) {
    return {
      kind: "semantic",
      reason: "remote 実行またはデータ送信には確認が必要です",
    };
  }
  const gitRisk = structuralGitAsk(normalized, trustedGitCwdTarget);
  if (gitRisk !== undefined) return { kind: "semantic", reason: gitRisk };
  if (normalized.privileged) {
    return { kind: "parser-only", reason: "sudo 経由の実行には確認が必要です" };
  }
  if (segment.hasOutputRedirection) {
    return {
      kind: "parser-only",
      reason: "ファイルへの出力リダイレクトには確認が必要です",
    };
  }
  if (isPackageRunnerInvocation(normalized.words)) {
    return {
      kind: "parser-only",
      reason: "パッケージランナーによるコード実行には確認が必要です",
    };
  }
  if (normalized.words[0] === "rg" && hasRgExecutionOption(normalized.words)) {
    return {
      kind: "parser-only",
      reason:
        "rg の外部preprocessor・archive展開・symlink追跡には確認が必要です",
    };
  }
  if (
    normalized.words[0] === "git" &&
    hasGitReadExecutionOption(normalized.words)
  ) {
    return {
      kind: "parser-only",
      reason:
        "Git の外部diff・textconv実行またはファイル出力には確認が必要です",
    };
  }
  if (isOpaqueExecutor(normalized.words)) {
    return { kind: "parser-only", reason: OPAQUE_EXECUTOR_REASON };
  }
  return undefined;
};

const HELPER_CAPABLE_GIT_READS: ReadonlySet<string> = new Set([
  "status",
  "diff",
  "log",
  "show",
]);

const isSkillOverridableAsk = (command: string): boolean => {
  const scanned = scanCommand(command);
  if (
    !scanned.ok ||
    scanned.subs.length !== 0 ||
    scanned.segments.length !== 1
  ) {
    return false;
  }
  const [segment] = scanned.segments;
  if (segment === undefined || segment.allowCandidate === undefined) {
    return false;
  }
  const normalized = normalizeSegment(segment);
  if (normalized.opaque.size !== 0 || normalized.hasAnsiC) return false;

  const gitAsk = structuralGitAsk(normalized);
  if (
    gitAsk === undefined ||
    structuralKnownRisk(segment, normalized)?.reason !== gitAsk
  ) {
    return false;
  }
  const position = gitSubcommandPosition(normalized.words);
  if (
    position === undefined ||
    position.ambiguousOption ||
    (position.riskyGlobalOption && !position.cOnlyGlobalOption) ||
    normalized.opaque.has(position.index)
  ) {
    return false;
  }

  const subcommand = normalized.words[position.index];
  if (subcommand === undefined || HELPER_CAPABLE_GIT_READS.has(subcommand)) {
    return false;
  }
  const rest = normalized.words.slice(position.index + 1);
  if (subcommand === "push") return gitPushRisk(rest) === undefined;
  return (
    position.cOnlyGlobalOption &&
    gitSubcommandAsk(subcommand, rest) === undefined
  );
};

const isHelperCapableGitRead = (normalized: NormalizedSegment): boolean => {
  if (normalized.words[0] !== "git") return false;
  const position = gitSubcommandPosition(normalized.words);
  if (
    position === undefined ||
    position.ambiguousOption ||
    normalized.opaque.has(position.index)
  ) {
    return false;
  }
  const subcommand = normalized.words[position.index];
  return subcommand !== undefined && HELPER_CAPABLE_GIT_READS.has(subcommand);
};

interface KnownGitArgSpec {
  readonly longFlags?: ReadonlySet<string>;
  /** Optional values are accepted only in attached `--name=value` form. */
  readonly longOptionalValues?: ReadonlySet<string>;
  readonly longValues?: ReadonlySet<string>;
  readonly shortFlags?: ReadonlySet<string>;
  readonly shortValues?: ReadonlySet<string>;
  readonly numericShort?: boolean;
}

const parseKnownGitArgs = (
  rest: readonly string[],
  spec: KnownGitArgSpec,
): readonly string[] | undefined => {
  const positionals: string[] = [];
  let parsingOptions = true;
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) return undefined;
    if (parsingOptions && word === "--") {
      parsingOptions = false;
      continue;
    }
    if (!parsingOptions || !word.startsWith("-") || word === "-") {
      positionals.push(word);
      continue;
    }
    if (spec.numericShort === true && /^-\d+$/.test(word)) continue;
    if (word.startsWith("--")) {
      const equals = word.indexOf("=");
      const name = equals === -1 ? word : word.slice(0, equals);
      if (equals !== -1) {
        if (
          (!spec.longValues?.has(name) &&
            !spec.longOptionalValues?.has(name)) ||
          equals === word.length - 1
        ) {
          return undefined;
        }
        continue;
      }
      if (spec.longFlags?.has(name) || spec.longOptionalValues?.has(name)) {
        continue;
      }
      const value = rest[index + 1];
      if (
        !spec.longValues?.has(name) ||
        value === undefined ||
        (value.startsWith("-") && !/^-\d+$/.test(value))
      ) {
        return undefined;
      }
      index += 1;
      continue;
    }
    for (let offset = 1; offset < word.length; offset += 1) {
      const option = word[offset] ?? "";
      if (spec.shortFlags?.has(option)) continue;
      if (!spec.shortValues?.has(option)) return undefined;
      if (offset === word.length - 1) {
        const value = rest[index + 1];
        if (
          value === undefined ||
          (value.startsWith("-") && !/^-\d+$/.test(value))
        ) {
          return undefined;
        }
        index += 1;
      }
      break;
    }
  }
  return positionals;
};

const set = (...values: readonly string[]): ReadonlySet<string> =>
  new Set(values);

const GIT_DIFF_ARG_SPEC: KnownGitArgSpec = {
  longFlags: set(
    "--binary",
    "--cached",
    "--check",
    "--compact-summary",
    "--exit-code",
    "--find-copies-harder",
    "--full-index",
    "--histogram",
    "--ignore-all-space",
    "--ignore-blank-lines",
    "--ignore-cr-at-eol",
    "--ignore-space-at-eol",
    "--ignore-space-change",
    "--irreversible-delete",
    "--minimal",
    "--name-only",
    "--name-status",
    "--no-ext-diff",
    "--no-patch",
    "--no-renames",
    "--no-textconv",
    "--numstat",
    "--patch",
    "--patience",
    "--pickaxe-all",
    "--pickaxe-regex",
    "--quiet",
    "--raw",
    "--relative",
    "--shortstat",
    "--stat",
    "--staged",
    "--summary",
  ),
  longValues: set(
    "--abbrev",
    "--anchored",
    "--break-rewrites",
    "--diff-algorithm",
    "--diff-filter",
    "--dirstat",
    "--dst-prefix",
    "--find-copies",
    "--find-object",
    "--find-renames",
    "--inter-hunk-context",
    "--line-prefix",
    "--output-indicator-context",
    "--output-indicator-new",
    "--output-indicator-old",
    "--rotate-to",
    "--skip-to",
    "--src-prefix",
    "--stat-count",
    "--stat-name-width",
    "--stat-width",
    "--submodule",
    "--unified",
    "--word-diff",
    "--word-diff-regex",
    "--ws-error-highlight",
  ),
  shortFlags: set("b", "c", "m", "p", "s", "u", "w"),
  shortValues: set("G", "O", "S", "U", "l"),
};

const PURE_GIT_READ_SUBCOMMANDS: ReadonlySet<string> = set(
  "describe",
  "for-each-ref",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "rev-list",
  "rev-parse",
  "show-ref",
);

const pureGitReadSpec = (subcommand: string): KnownGitArgSpec | undefined => {
  switch (subcommand) {
    case "rev-parse": {
      return {
        longFlags: set(
          "--absolute-git-dir",
          "--all",
          "--branches",
          "--end-of-options",
          "--flags",
          "--git-common-dir",
          "--git-dir",
          "--is-bare-repository",
          "--is-inside-git-dir",
          "--is-inside-work-tree",
          "--is-shallow-repository",
          "--local-env-vars",
          "--no-flags",
          "--no-revs",
          "--quiet",
          "--remotes",
          "--revs-only",
          "--show-cdup",
          "--show-prefix",
          "--show-superproject-working-tree",
          "--show-toplevel",
          "--show-object-format",
          "--sq",
          "--symbolic",
          "--symbolic-full-name",
          "--tags",
          "--verify",
        ),
        longValues: set(
          "--abbrev-ref",
          "--branches",
          "--default",
          "--disambiguate",
          "--exclude",
          "--git-path",
          "--glob",
          "--path-format",
          "--prefix",
          "--remotes",
          "--short",
          "--tags",
        ),
        shortFlags: set("q"),
      };
    }
    case "merge-base": {
      return {
        longFlags: set(
          "--all",
          "--fork-point",
          "--independent",
          "--is-ancestor",
          "--octopus",
        ),
        shortFlags: set("a"),
      };
    }
    case "ls-files": {
      return {
        longFlags: set(
          "--cached",
          "--debug",
          "--deleted",
          "--directory",
          "--empty-directory",
          "--eol",
          "--error-unmatch",
          "--ignored",
          "--killed",
          "--modified",
          "--others",
          "--recurse-submodules",
          "--resolve-undo",
          "--stage",
          "--unmerged",
          "--verbose",
        ),
        longValues: set("--abbrev", "--format", "--with-tree"),
        shortFlags: set("c", "d", "i", "k", "m", "o", "s", "t", "u", "v"),
      };
    }
    case "ls-tree": {
      return {
        longFlags: set(
          "--full-name",
          "--full-tree",
          "--long",
          "--name-only",
          "--name-status",
          "--object-only",
        ),
        longValues: set("--abbrev", "--format"),
        shortFlags: set("d", "l", "r", "t", "z"),
      };
    }
    case "show-ref": {
      return {
        longFlags: set(
          "--dereference",
          "--exists",
          "--head",
          "--heads",
          "--quiet",
          "--tags",
          "--verify",
        ),
        longValues: set("--abbrev", "--hash"),
        shortFlags: set("d", "q", "s"),
      };
    }
    case "for-each-ref": {
      return {
        longFlags: set(
          "--ignore-case",
          "--omit-empty",
          "--perl",
          "--python",
          "--shell",
          "--tcl",
        ),
        longValues: set(
          "--contains",
          "--count",
          "--format",
          "--merged",
          "--no-contains",
          "--no-merged",
          "--points-at",
          "--sort",
        ),
      };
    }
    case "describe": {
      return {
        longFlags: set(
          "--all",
          "--always",
          "--contains",
          "--debug",
          "--exact-match",
          "--first-parent",
          "--long",
          "--tags",
        ),
        longValues: set(
          "--abbrev",
          "--broken",
          "--candidates",
          "--dirty",
          "--exclude",
          "--match",
        ),
      };
    }
    case "name-rev": {
      return {
        longFlags: set("--all", "--always", "--name-only", "--tags"),
        longValues: set("--exclude", "--refs"),
      };
    }
    case "rev-list": {
      return {
        longFlags: set(
          "--all",
          "--alternate-refs",
          "--author-date-order",
          "--boundary",
          "--branches",
          "--cherry-mark",
          "--cherry-pick",
          "--children",
          "--count",
          "--date-order",
          "--do-walk",
          "--first-parent",
          "--full-history",
          "--header",
          "--ignore-missing",
          "--left-only",
          "--left-right",
          "--no-object-names",
          "--no-walk",
          "--objects",
          "--objects-edge",
          "--objects-edge-aggressive",
          "--parents",
          "--quiet",
          "--remotes",
          "--reverse",
          "--right-only",
          "--single-worktree",
          "--tags",
          "--timestamp",
          "--topo-order",
        ),
        longValues: set(
          "--after",
          "--before",
          "--exclude",
          "--filter",
          "--glob",
          "--max-count",
          "--max-parents",
          "--min-parents",
          "--missing",
          "--pretty",
          "--since",
          "--skip",
          "--until",
        ),
        shortValues: set("n"),
        numericShort: true,
      };
    }
    default: {
      return undefined;
    }
  }
};

const optionWordsBeforeTerminator = (
  rest: readonly string[],
): readonly string[] => {
  const terminator = rest.indexOf("--");
  return terminator === -1 ? rest : rest.slice(0, terminator);
};

const gitReadOnlyModeEligible = (
  subcommand: string,
  rest: readonly string[],
): boolean => {
  if (PURE_GIT_READ_SUBCOMMANDS.has(subcommand)) {
    const spec = pureGitReadSpec(subcommand);
    return spec !== undefined && parseKnownGitArgs(rest, spec) !== undefined;
  }
  if (subcommand === "diff") {
    return parseKnownGitArgs(rest, GIT_DIFF_ARG_SPEC) !== undefined;
  }
  if (subcommand === "branch") {
    const args = parseKnownGitArgs(rest, {
      longFlags: set(
        "--all",
        "--ignore-case",
        "--list",
        "--omit-empty",
        "--remotes",
        "--show-current",
        "--verbose",
      ),
      longOptionalValues: set(
        "--abbrev",
        "--color",
        "--column",
        "--contains",
        "--merged",
        "--no-contains",
        "--no-merged",
      ),
      longValues: set("--format", "--points-at", "--sort"),
      shortFlags: set("a", "r", "v"),
    });
    if (args === undefined) return false;
    if (rest.length === 0) return true;
    if (rest.length === 1 && rest[0] === "--show-current") return true;
    return optionWordsBeforeTerminator(rest).includes("--list");
  }
  if (subcommand === "remote") return rest.length === 0;
  if (subcommand === "stash") {
    const [mode, ...args] = rest;
    if (mode === "list") {
      return (
        parseKnownGitArgs(args, {
          longFlags: set("--oneline"),
          longValues: set("--format", "--max-count"),
          shortValues: set("n"),
          numericShort: true,
        })?.length === 0
      );
    }
    if (mode === "show") {
      return parseKnownGitArgs(args, GIT_DIFF_ARG_SPEC) !== undefined;
    }
    return false;
  }
  if (subcommand === "tag") {
    const args = parseKnownGitArgs(rest, {
      longFlags: set("--ignore-case", "--list", "--omit-empty"),
      longOptionalValues: set(
        "--color",
        "--column",
        "--contains",
        "--merged",
        "--no-contains",
        "--no-merged",
      ),
      longValues: set("--format", "--points-at", "--sort"),
      shortFlags: set("l", "n"),
    });
    if (args === undefined) return false;
    if (rest.length === 0) return true;
    return optionWordsBeforeTerminator(rest).some(
      (word) => word === "--list" || /^-[^-]*l/.test(word),
    );
  }
  return false;
};

const pathInsideRoots = (
  operand: string,
  cwd: string,
  roots: readonly string[],
  allowMissing: boolean,
): boolean => {
  if (operand === "" || operand.startsWith("~") || hasPathTraversal(operand)) {
    return false;
  }
  const candidate = isAbsolute(operand) ? operand : resolve(cwd, operand);
  if (allowMissing) return canonicalOrAncestorInsideRoots(candidate, roots);
  try {
    return pathInsideVerifiedRoots(realpathSync(candidate), roots);
  } catch {
    return false;
  }
};

const effectiveGitCwd = (options: EvaluationOptions): string | undefined => {
  const context = options.trustedReadContext;
  if (context === undefined) return undefined;
  if (options.trustedGitCwdTarget === undefined) return context.cwd;
  const candidate = isAbsolute(options.trustedGitCwdTarget)
    ? options.trustedGitCwdTarget
    : resolve(context.cwd, options.trustedGitCwdTarget);
  try {
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
};

const gitWorktreeModeEligible = (
  rest: readonly string[],
  options: EvaluationOptions,
): boolean => {
  const [mode, ...args] = rest;
  if (mode === "list") {
    return (
      parseKnownGitArgs(args, {
        longFlags: set("--porcelain", "--verbose", "--zero"),
        longValues: set("--expire"),
        shortFlags: set("v", "z"),
      })?.length === 0
    );
  }
  const context = options.trustedReadContext;
  const gitCwd = effectiveGitCwd(options);
  if (context === undefined || gitCwd === undefined) return false;
  if (mode === "add") {
    const positionals = parseKnownGitArgs(args, {
      longFlags: set(
        "--checkout",
        "--detach",
        "--guess-remote",
        "--lock",
        "--no-checkout",
        "--no-guess-remote",
        "--no-track",
        "--orphan",
        "--quiet",
        "--track",
      ),
      longValues: set("--reason"),
      shortFlags: set("d", "q"),
      shortValues: set("b"),
    });
    const target = positionals?.[0];
    return (
      target !== undefined &&
      (positionals?.length ?? 0) <= 2 &&
      (options.trustedWorktreeCreateRoots?.length ?? 0) > 0 &&
      pathInsideRoots(
        target,
        gitCwd,
        options.trustedWorktreeCreateRoots ?? [],
        true,
      )
    );
  }
  if (mode === "lock" || mode === "unlock") {
    const positionals = parseKnownGitArgs(
      args,
      mode === "lock" ? { longValues: set("--reason") } : {},
    );
    const target = positionals?.[0];
    return (
      target !== undefined &&
      positionals?.length === 1 &&
      pathInsideRoots(
        target,
        gitCwd,
        options.trustedWritableWorktrees ?? [],
        false,
      )
    );
  }
  return false;
};

const BASE_SANDBOX_GIT_SUBCOMMANDS: ReadonlySet<string> = set(
  "add",
  "commit",
  "fetch",
  "log",
  "merge",
  "merge-tree",
  "show",
  "status",
  "switch",
);
const MUTATING_SANDBOX_GIT_SUBCOMMANDS: ReadonlySet<string> = set(
  "add",
  "commit",
  "fetch",
  "merge",
  "merge-tree",
  "pull",
  "switch",
);
const SANDBOX_GIT_CANDIDATE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  ...BASE_SANDBOX_GIT_SUBCOMMANDS,
  ...PURE_GIT_READ_SUBCOMMANDS,
  "branch",
  "diff",
  "pull",
  "remote",
  "stash",
  "tag",
  "worktree",
]);

const gitSubcommandModeEligible = (
  subcommand: string,
  rest: readonly string[],
  options: EvaluationOptions,
): boolean => {
  if (BASE_SANDBOX_GIT_SUBCOMMANDS.has(subcommand)) return true;
  if (gitReadOnlyModeEligible(subcommand, rest)) return true;
  if (subcommand === "worktree") return gitWorktreeModeEligible(rest, options);
  // Pull may be rewritten through repository url.*.insteadOf/protocol config.
  // Keep every form residual until the resolved transport is pinned at runtime.
  return false;
};

const gitModeMutates = (subcommand: string, rest: readonly string[]): boolean =>
  MUTATING_SANDBOX_GIT_SUBCOMMANDS.has(subcommand) ||
  (subcommand === "worktree" &&
    ["add", "lock", "unlock"].includes(rest[0] ?? ""));

const gitCwdIsWritable = (
  target: string,
  options: EvaluationOptions,
): boolean => {
  const context = options.trustedReadContext;
  if (context === undefined) return false;
  return pathInsideRoots(
    target,
    context.cwd,
    options.trustedWritableWorktrees ?? [],
    false,
  );
};

const isSandboxAllowedGitCommand = (
  segment: Segment,
  normalized: NormalizedSegment,
  options: EvaluationOptions,
): boolean => {
  if (
    segment.allowCandidate === undefined ||
    segment.hasAnsiC ||
    segment.words[0] !== normalized.words[0] ||
    normalized.words[0] !== "git" ||
    normalized.opaque.size !== 0 ||
    hasGitReadExecutionOption(normalized.words)
  ) {
    return false;
  }
  const position = gitSubcommandPosition(normalized.words);
  if (
    position === undefined ||
    position.ambiguousOption ||
    normalized.opaque.has(position.index)
  ) {
    return false;
  }
  const target = literalGitCwdTarget(normalized, position);
  if (position.riskyGlobalOption) {
    if (
      !position.cOnlyGlobalOption ||
      target === undefined ||
      target !== options.trustedGitCwdTarget
    ) {
      return false;
    }
  }
  const subcommand = normalized.words[position.index];
  if (subcommand === undefined) return false;
  const rest = normalized.words.slice(position.index + 1);
  if (!gitSubcommandModeEligible(subcommand, rest, options)) return false;
  if (gitModeMutates(subcommand, rest)) {
    if (target !== undefined && options.trustedReadContext === undefined) {
      return false;
    }
    if (options.trustedReadContext !== undefined) {
      const effectiveCwd = target ?? options.trustedReadContext.cwd;
      if (!gitCwdIsWritable(effectiveCwd, options)) return false;
    }
  }
  return true;
};

const gitReadCwdTarget = (command: string): string | undefined => {
  const scanned = scanCommand(command);
  if (
    !scanned.ok ||
    scanned.subs.length !== 0 ||
    scanned.segments.length !== 1
  ) {
    return undefined;
  }
  const [segment] = scanned.segments;
  if (
    segment === undefined ||
    segment.allowCandidate === undefined ||
    segment.hasInputRedirection ||
    segment.hasOutputRedirection ||
    segment.redirectionTargets.length !== 0
  ) {
    return undefined;
  }
  const normalized = normalizeSegment(segment);
  if (
    normalized.hasAnsiC ||
    normalized.opaque.size !== 0 ||
    segment.words[0] !== normalized.words[0] ||
    hasGitReadExecutionOption(normalized.words) ||
    structuralKnownRisk(segment, normalized)?.reason !==
      GIT_GLOBAL_OPTION_REASON
  ) {
    return undefined;
  }
  const position = gitSubcommandPosition(normalized.words);
  const subcommand =
    position === undefined ? undefined : normalized.words[position.index];
  if (
    position === undefined ||
    subcommand === undefined ||
    !SANDBOX_GIT_CANDIDATE_SUBCOMMANDS.has(subcommand)
  ) {
    return undefined;
  }
  return literalGitCwdTarget(normalized, position);
};

const commandPositionals = (
  rest: readonly string[],
  spec: KnownGitArgSpec,
): readonly string[] | undefined => parseKnownGitArgs(rest, spec);

const grepFileOperands = (
  rest: readonly string[],
): readonly string[] | undefined => {
  const hasExplicitPattern = rest.some(
    (word) =>
      word === "-e" ||
      word === "--regexp" ||
      word.startsWith("--regexp=") ||
      /^-[^-]*e/.test(word),
  );
  const positionals = commandPositionals(rest, {
    longFlags: set(
      "--basic-regexp",
      "--binary-files-without-match",
      "--byte-offset",
      "--count",
      "--extended-regexp",
      "--files-with-matches",
      "--files-without-match",
      "--fixed-strings",
      "--ignore-case",
      "--invert-match",
      "--line-number",
      "--line-regexp",
      "--no-filename",
      "--no-messages",
      "--only-matching",
      "--quiet",
      "--text",
      "--with-filename",
      "--word-regexp",
    ),
    longOptionalValues: set("--color"),
    longValues: set(
      "--after-context",
      "--before-context",
      "--binary-files",
      "--context",
      "--max-count",
      "--regexp",
    ),
    shortFlags: set(
      "E",
      "F",
      "G",
      "H",
      "I",
      "L",
      "P",
      "Z",
      "a",
      "b",
      "c",
      "h",
      "i",
      "l",
      "n",
      "o",
      "q",
      "s",
      "v",
      "w",
      "x",
      "z",
    ),
    shortValues: set("A", "B", "C", "e", "m"),
  });
  if (positionals === undefined) return undefined;
  if (hasExplicitPattern) return positionals;
  return positionals.length === 0 ? undefined : positionals.slice(1);
};

const stripJqStrings = (filter: string): string => {
  let output = "";
  let quoted = false;
  let escaped = false;
  for (const character of filter) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      output += " ";
      continue;
    }
    if (character === '"') {
      quoted = true;
      output += " ";
    } else {
      output += character;
    }
  }
  return output;
};

const jqFilterAllowed = (filter: string): boolean => {
  // jq executes expressions inside string interpolation. Reject interpolation
  // wholesale rather than trying to parse nested jq syntax here.
  if (filter.includes(String.raw`\(`)) return false;
  const code = stripJqStrings(filter);
  return !(
    /\$ENV\b/.test(code) ||
    /(^|[^.$A-Za-z0-9_])(env|include|import|input|inputs|module|modulemeta)\b/.test(
      code,
    )
  );
};

interface JqReadArgs {
  readonly files: readonly string[];
  readonly noInput: boolean;
}

const jqReadArgs = (rest: readonly string[]): JqReadArgs | undefined => {
  let parsingOptions = true;
  let noInput = false;
  const positionals: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const word = rest[index];
    if (word === undefined) return undefined;
    if (parsingOptions && word === "--") {
      parsingOptions = false;
      continue;
    }
    if (!parsingOptions || !word.startsWith("-") || word === "-") {
      positionals.push(word);
      continue;
    }
    if (/^-[acejMnrRsSV0]+$/.test(word)) {
      if (word.includes("n")) noInput = true;
      continue;
    }
    if (
      [
        "--compact-output",
        "--exit-status",
        "--join-output",
        "--monochrome-output",
        "--null-input",
        "--raw-input",
        "--raw-output",
        "--slurp",
        "--sort-keys",
        "--version",
      ].includes(word)
    ) {
      if (word === "--null-input") noInput = true;
      continue;
    }
    if (word === "--indent") {
      if (rest[index + 1] === undefined) return undefined;
      index += 1;
      continue;
    }
    if (word === "--arg" || word === "--argjson") {
      if (rest[index + 1] === undefined || rest[index + 2] === undefined) {
        return undefined;
      }
      index += 2;
      continue;
    }
    return undefined;
  }
  const [filter, ...files] = positionals;
  if (filter === undefined || !jqFilterAllowed(filter)) return undefined;
  return { files, noInput };
};

const sandboxProjectReadAllowed = (
  segment: Segment,
  normalized: NormalizedSegment,
  context: TrustedReadContext | undefined,
): boolean => {
  if (
    segment.allowCandidate === undefined ||
    segment.hasAnsiC ||
    segment.words[0] !== normalized.words[0] ||
    normalized.opaque.size !== 0 ||
    segment.redirectionTargets.length !== 0
  ) {
    return false;
  }
  const [command, ...rest] = normalized.words;
  if (context === undefined) return false;
  if (command === "pwd") {
    return (
      commandPositionals(rest, { shortFlags: set("L", "P") })?.length === 0
    );
  }

  let operands: readonly string[] | undefined;
  let safeWithoutOperands = false;
  if (command === "ls") {
    operands = commandPositionals(rest, {
      longFlags: set(
        "--all",
        "--almost-all",
        "--classify",
        "--directory",
        "--group-directories-first",
        "--human-readable",
        "--inode",
        "--literal",
        "--long",
        "--numeric-uid-gid",
        "--quote-name",
        "--reverse",
        "--size",
      ),
      longOptionalValues: set("--color"),
      longValues: set(
        "--block-size",
        "--format",
        "--hide",
        "--ignore",
        "--indicator-style",
        "--quoting-style",
        "--sort",
        "--time",
        "--time-style",
        "--width",
      ),
      shortFlags: set(
        "1",
        "A",
        "F",
        "G",
        "H",
        "S",
        "U",
        "a",
        "d",
        "f",
        "g",
        "h",
        "i",
        "k",
        "l",
        "m",
        "n",
        "o",
        "p",
        "q",
        "r",
        "s",
        "t",
        "u",
        "v",
        "x",
      ),
    });
  } else if (command === "stat") {
    operands = commandPositionals(rest, {
      longFlags: set("--dereference", "--file-system", "--terse"),
      longValues: set("--format", "--printf"),
      shortFlags: set("L", "t"),
    });
  } else if (command === "readlink") {
    operands = commandPositionals(rest, {
      longFlags: set(
        "--canonicalize",
        "--canonicalize-existing",
        "--canonicalize-missing",
        "--no-newline",
        "--quiet",
        "--verbose",
        "--zero",
      ),
      shortFlags: set("e", "f", "m", "n", "q", "s", "v", "z"),
    });
  } else if (command === "realpath") {
    operands = commandPositionals(rest, {
      longFlags: set(
        "--canonicalize-existing",
        "--canonicalize-missing",
        "--logical",
        "--physical",
        "--quiet",
        "--strip",
        "--zero",
      ),
      shortFlags: set("L", "P", "e", "m", "q", "s", "z"),
    });
  } else if (command === "cat") {
    operands = commandPositionals(rest, {
      longFlags: set(
        "--number",
        "--number-nonblank",
        "--show-all",
        "--show-ends",
        "--show-nonprinting",
        "--show-tabs",
        "--squeeze-blank",
      ),
      shortFlags: set("A", "E", "T", "b", "e", "n", "s", "t", "u", "v"),
    });
  } else if (command === "head" || command === "tail") {
    operands = commandPositionals(rest, {
      longFlags: set("--quiet", "--verbose", "--zero-terminated"),
      longValues: set("--bytes", "--lines"),
      shortFlags: set("q", "v", "z"),
      shortValues: set("c", "n"),
      numericShort: true,
    });
  } else if (command === "wc") {
    operands = commandPositionals(rest, {
      longFlags: set(
        "--bytes",
        "--chars",
        "--lines",
        "--max-line-length",
        "--words",
      ),
      shortFlags: set("L", "c", "l", "m", "w"),
    });
  } else if (command === "grep") {
    operands = grepFileOperands(rest);
  } else if (command === "jq") {
    const jqArgs = jqReadArgs(rest);
    operands = jqArgs?.files;
    safeWithoutOperands = jqArgs?.noInput === true;
  } else {
    return false;
  }
  if (operands === undefined) return false;
  if (operands.length === 0 && safeWithoutOperands) return true;

  // Pre-execution path validation cannot pin a pathname until Bash opens it.
  // The runtime has denyRead but no project read allowlist, so another process
  // could swap any validated path to an outside symlink. Keep every pathname
  // reader residual until execution can consume a pinned object/path.
  return false;
};

const structuralKnownAllow = (
  segment: Segment,
  normalized: NormalizedSegment,
  trustedReadContext: TrustedReadContext | undefined,
): boolean => {
  if (segment.hasAnsiC || segment.words[0] !== normalized.words[0]) {
    return false;
  }

  // Even read-only Git subcommands can execute repository/global helpers
  // (fsmonitor, external diff, or textconv), so they always remain residual.
  if (normalized.words[0] === "git") return false;

  if (normalized.words[0] === "rg") {
    const onlyNullOutputRedirects =
      !segment.hasInputRedirection &&
      !segment.hasOutputRedirection &&
      segment.redirectionTargets.length > 0 &&
      segment.redirectionTargets.every((target) => target === "/dev/null");
    if (segment.redirectionTargets.length > 0 && !onlyNullOutputRedirects) {
      return false;
    }
    if (
      segment.allowCandidate === undefined &&
      normalized.literalGlobs.size === 0 &&
      !onlyNullOutputRedirects
    ) {
      return false;
    }
    return (
      !hasRgExecutionOption(normalized.words) &&
      isProjectBoundedRgRead(normalized, trustedReadContext)
    );
  }

  if (segment.allowCandidate === undefined || normalized.opaque.size !== 0) {
    return false;
  }

  // The legacy `head -N` form has no file operand and only bounds stdin from
  // the preceding pipe. Other option forms stay residual rather than trying to
  // reproduce head's complete option/operand parser here.
  return (
    normalized.words[0] === "head" &&
    normalized.words.length === 2 &&
    /^-\d+$/.test(normalized.words[1] ?? "")
  );
};

// One simple command. Precedence: concrete DENY > built-in DENY-potential
// (unsuppressable by user allow — the data-leak floor) > mandatory structural
// ASK > user ALLOW > concrete ASK > built-in ASK-potential > narrow built-in
// read-only ALLOW > default-continue.
const evaluateNormalized = (
  segment: Segment,
  normalized: NormalizedSegment,
  rules: LoadedRules,
  allowCandidate: string | undefined,
  trustedLeadingCdTarget: string | undefined,
  trustedGitCwdTarget: string | undefined,
  trustedWritableWorktrees: readonly string[] | undefined,
  trustedWorktreeCreateRoots: readonly string[] | undefined,
  trustedReadContext: TrustedReadContext | undefined,
  effectSandboxed: boolean,
): AuditedVerdict => {
  if (normalized.words.length === 0) {
    // A parenthesized group can leave redirects in a wordless outer segment.
    // Apply every segment-wide floor before returning so a sensitive input
    // target or output write cannot disappear behind that shell shape.
    const structuralRisk = structuralKnownRisk(
      segment,
      normalized,
      trustedGitCwdTarget,
    );
    if (structuralRisk === undefined) {
      return audited({ verdict: "default-continue" }, "default-continue");
    }
    return effectSandboxed && structuralRisk.kind === "parser-only"
      ? audited({ verdict: "default-continue" }, "sandbox-residual")
      : audited(
          { verdict: "ask", reason: structuralRisk.reason },
          "structural-ask",
        );
  }
  const command = normalized.words.join(" ");
  const potential = speculativeFloor(normalized);
  let sandboxResidual = effectSandboxed && potential !== undefined;

  const denied = rules.deny.find((rule) => rule.pattern.test(command));
  if (denied !== undefined) {
    return audited(
      { verdict: "deny", reason: denied.reason },
      "configured-deny",
      denied.source,
    );
  }

  const structural = structuralBitDeny(normalized);
  if (structural !== undefined) {
    return audited({ verdict: "deny", reason: structural }, "structural-deny");
  }

  const notesMutation = structuralNotesDeny(normalized);
  if (notesMutation !== undefined) {
    return audited(
      { verdict: "deny", reason: notesMutation },
      "structural-deny",
    );
  }

  if (potential === "deny" && !effectSandboxed) {
    return audited(
      { verdict: "ask", reason: POTENTIALLY_SENSITIVE_REASON },
      "speculative-deny",
    );
  }

  const structuralRisk = structuralKnownRisk(
    segment,
    normalized,
    trustedGitCwdTarget,
  );
  if (structuralRisk !== undefined) {
    if (!effectSandboxed || structuralRisk.kind === "semantic") {
      return audited(
        { verdict: "ask", reason: structuralRisk.reason },
        "structural-ask",
      );
    }
    sandboxResidual = true;
  }
  if (hasRgOptionLikeGlobExpansion(normalized, trustedReadContext)) {
    if (!effectSandboxed) {
      return audited(
        {
          verdict: "ask",
          reason:
            "rg のglob展開が実行オプションとして解釈される可能性があります",
        },
        "rg-option-glob-ask",
      );
    }
    sandboxResidual = true;
  }

  // A same-repository leading cd is neutral only for explicit-allow
  // aggregation. The caller obtains this target through filesystem/Git
  // validation; the scanner check here reasserts the exact safe shell shape.
  if (
    trustedLeadingCdTarget !== undefined &&
    literalTrustedCdTarget(segment) === trustedLeadingCdTarget
  ) {
    return audited({ verdict: "allow" }, "trusted-leading-cd");
  }

  // Git reads may invoke configured helpers, and rg requires no-config plus
  // filesystem-verified operands. Neither an active-skill grant nor a
  // configured allow may bypass those conditions; unsafe/unverified forms stay
  // residual for the judge rather than becoming a deterministic rejection.
  const mandatoryReadResidual =
    isHelperCapableGitRead(normalized) ||
    (normalized.words[0] === "rg" &&
      !structuralKnownAllow(segment, normalized, trustedReadContext));

  // Allow grants use the scanner's conservative concrete representation
  // before wrapper stripping or executable basename normalization.
  const allowed =
    mandatoryReadResidual || allowCandidate === undefined
      ? undefined
      : rules.allow.find((rule) => rule.pattern.test(allowCandidate));
  if (allowed !== undefined) {
    const verdict =
      allowed.reason === undefined
        ? ({ verdict: "allow" } as const)
        : ({ verdict: "allow", reason: allowed.reason } as const);
    return audited(verdict, "configured-allow", allowed.source);
  }

  const asked = rules.ask.find((rule) => rule.pattern.test(command));
  if (asked !== undefined) {
    return audited({ verdict: "ask", reason: asked.reason }, "configured-ask");
  }

  if (potential === "ask" && !effectSandboxed) {
    return audited(
      { verdict: "ask", reason: POTENTIALLY_SENSITIVE_REASON },
      "speculative-ask",
    );
  }

  // The OS sandbox confines filesystem/network effects, so these common Git
  // operations can bypass the residual model route when their command shape is
  // fully concrete. Deterministic deny/ask rules above still win for force,
  // destructive checkout, sensitive paths, path traversal, risky global
  // options, and any configured confirmation rule.
  if (
    effectSandboxed &&
    isSandboxAllowedGitCommand(segment, normalized, {
      effectSandboxed,
      ...(trustedGitCwdTarget === undefined ? {} : { trustedGitCwdTarget }),
      ...(trustedWritableWorktrees === undefined
        ? {}
        : { trustedWritableWorktrees }),
      ...(trustedWorktreeCreateRoots === undefined
        ? {}
        : { trustedWorktreeCreateRoots }),
      ...(trustedReadContext === undefined ? {} : { trustedReadContext }),
    })
  ) {
    return audited({ verdict: "allow" }, "sandbox-git-allow");
  }

  if (
    effectSandboxed &&
    sandboxProjectReadAllowed(segment, normalized, trustedReadContext)
  ) {
    return audited({ verdict: "allow" }, "sandbox-read-allow");
  }

  if (structuralKnownAllow(segment, normalized, trustedReadContext)) {
    return audited({ verdict: "allow" }, "builtin-read-allow");
  }

  return audited(
    { verdict: "default-continue" },
    sandboxResidual ? "sandbox-residual" : "default-continue",
  );
};

const SANDBOX_RESIDUAL_BASES: ReadonlySet<PermissionVerdictBasis> = new Set([
  "parse-error",
  "depth-limit",
  "sandbox-residual",
]);

export const isSandboxResidualVerdict = (verdict: AuditedVerdict): boolean =>
  verdict.verdict === "default-continue" &&
  SANDBOX_RESIDUAL_BASES.has(verdict.audit.basis);

const VERDICT_RANK: Readonly<Record<Verdict["verdict"], number>> = {
  deny: 3,
  ask: 2,
  allow: 1,
  "default-continue": 0,
};

// Precedence deny > ask > allow > default-continue. `allow` only wins when
// EVERY unit is explicitly allowed; a mix of allow + continue proceeds as the
// default (both proceed, so the block outcome is identical either way).
const combineVerdicts = (
  verdicts: readonly AuditedVerdict[],
): AuditedVerdict => {
  let best: AuditedVerdict = audited(
    { verdict: "default-continue" },
    "default-continue",
  );
  let allAllow = verdicts.length > 0;
  const sandboxResidual = verdicts.find(isSandboxResidualVerdict);
  for (const verdict of verdicts) {
    if (verdict.verdict !== "allow") allAllow = false;
    if (VERDICT_RANK[verdict.verdict] > VERDICT_RANK[best.verdict]) {
      best = verdict;
    }
  }
  if (best.verdict === "allow" && !allAllow) {
    return (
      sandboxResidual ??
      audited({ verdict: "default-continue" }, "combined-default")
    );
  }
  if (best.verdict === "default-continue" && sandboxResidual !== undefined) {
    return sandboxResidual;
  }
  if (allAllow && verdicts.length > 1) {
    return audited(best, "combined-allow");
  }
  return best;
};

const evaluateCommandInner = (
  command: string,
  rules: LoadedRules,
  depth: number,
  options: EvaluationOptions,
): AuditedVerdict => {
  if (depth > MAX_SUBSTITUTION_DEPTH) {
    return options.effectSandboxed === true
      ? audited({ verdict: "default-continue" }, "depth-limit")
      : audited({ verdict: "deny", reason: UNPARSEABLE_REASON }, "depth-limit");
  }
  const scanned = scanCommand(command);
  if (!scanned.ok) {
    return options.effectSandboxed === true
      ? audited({ verdict: "default-continue" }, "parse-error")
      : audited({ verdict: "deny", reason: UNPARSEABLE_REASON }, "parse-error");
  }
  const verdicts: AuditedVerdict[] = [];
  let readerPathsStable = true;
  for (const [index, segment] of scanned.segments.entries()) {
    const normalized = normalizeSegment(segment);
    const verdict = evaluateNormalized(
      segment,
      normalized,
      rules,
      segment.allowCandidate,
      depth === 0 && index === 0 ? options.trustedLeadingCdTarget : undefined,
      depth === 0 && index === 0 ? options.trustedGitCwdTarget : undefined,
      depth === 0 ? options.trustedWritableWorktrees : undefined,
      depth === 0 ? options.trustedWorktreeCreateRoots : undefined,
      depth === 0 && readerPathsStable ? options.trustedReadContext : undefined,
      options.effectSandboxed === true,
    );
    verdicts.push(verdict);
    if (
      depth === 0 &&
      ![
        "builtin-read-allow",
        "sandbox-read-allow",
        "trusted-leading-cd",
      ].includes(verdict.audit.basis)
    ) {
      readerPathsStable = false;
    }
    // `sh -c '<script>'` runs exactly <script>; evaluate it so a denied body
    // (e.g. `bit relay sync`) is denied instead of downgraded to an opaque ask.
    const inner =
      interpreterConcreteArg(normalized) ??
      opaqueExecutorConcreteArg(normalized);
    if (inner !== undefined) {
      verdicts.push(
        evaluateCommandInner(inner, rules, depth + 1, {
          effectSandboxed: options.effectSandboxed,
        }),
      );
    }
  }
  for (const sub of scanned.subs) {
    verdicts.push(
      evaluateCommandInner(sub, rules, depth + 1, {
        effectSandboxed: options.effectSandboxed,
      }),
    );
  }
  return combineVerdicts(verdicts);
};

const PROJECT_SENSITIVE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add",
  "am",
  "apply",
  "bisect",
  "branch",
  "checkout",
  "checkout-index",
  "cherry-pick",
  "clean",
  "commit",
  "config",
  "fetch",
  "init",
  "merge",
  "merge-tree",
  "mv",
  "notes",
  "pull",
  "read-tree",
  "rebase",
  "reset",
  "replace",
  "restore",
  "revert",
  "rm",
  "stash",
  "submodule",
  "switch",
  "tag",
  "update-index",
  "update-ref",
  "worktree",
]);

const segmentHasProjectSensitiveMutation = (segment: Segment): boolean => {
  const normalized = normalizeSegment(segment);
  const position = gitSubcommandPosition(normalized.words);
  if (
    position === undefined ||
    position.ambiguousOption ||
    position.riskyGlobalOption ||
    normalized.opaque.has(position.index)
  ) {
    return false;
  }
  const subcommand = normalized.words[position.index];
  if (subcommand === undefined) return false;
  const rest = normalized.words.slice(position.index + 1);
  if (gitReadOnlyModeEligible(subcommand, rest)) return false;
  if (subcommand === "worktree" && gitWorktreeModeEligible(rest, {})) {
    return false;
  }
  return PROJECT_SENSITIVE_GIT_SUBCOMMANDS.has(subcommand);
};

const hasProjectSensitiveMutationInner = (
  command: string,
  depth: number,
): boolean => {
  if (depth > MAX_SUBSTITUTION_DEPTH) return true;
  const scanned = scanCommand(command);
  if (!scanned.ok) return true;
  return (
    scanned.segments.some(segmentHasProjectSensitiveMutation) ||
    scanned.subs.some((sub) => hasProjectSensitiveMutationInner(sub, depth + 1))
  );
};

const SHELL_NAVIGATION_COMMANDS: ReadonlySet<string> = new Set([
  "cd",
  "popd",
  "pushd",
]);

const segmentHasShellNavigation = (segment: Segment): boolean =>
  SHELL_NAVIGATION_COMMANDS.has(normalizeSegment(segment).words[0] ?? "");

const hasUnverifiedProjectMutationNavigationInner = (
  command: string,
  depth: number,
  allowLeadingCd: boolean,
): boolean => {
  if (depth > MAX_SUBSTITUTION_DEPTH) return true;
  const scanned = scanCommand(command);
  if (!scanned.ok) return true;
  const directMutation = scanned.segments.some(
    segmentHasProjectSensitiveMutation,
  );
  const navigationIndices = scanned.segments
    .map((segment, index) =>
      segmentHasShellNavigation(segment) ? index : undefined,
    )
    .filter((index): index is number => index !== undefined);
  const [firstSegment] = scanned.segments;
  const onlyVerifiedLeadingCd =
    allowLeadingCd &&
    navigationIndices.length === 1 &&
    navigationIndices[0] === 0 &&
    firstSegment !== undefined &&
    firstSegment.topLevel &&
    firstSegment.followedByAnd &&
    normalizeSegment(firstSegment).words[0] === "cd";
  const unverifiedSameScope =
    directMutation && navigationIndices.length > 0 && !onlyVerifiedLeadingCd;
  return (
    unverifiedSameScope ||
    scanned.subs.some((sub) =>
      hasUnverifiedProjectMutationNavigationInner(sub, depth + 1, false),
    )
  );
};

const hasProjectSensitiveMutation = (command: string): boolean =>
  hasProjectSensitiveMutationInner(command, 0);

const hasUnverifiedProjectMutationNavigation = (
  command: string,
  allowLeadingCd: boolean,
): boolean =>
  hasUnverifiedProjectMutationNavigationInner(command, 0, allowLeadingCd);

const evaluateCommandWithAudit = (
  command: string,
  rules: LoadedRules,
  options: EvaluationOptions = {},
): AuditedVerdict => evaluateCommandInner(command, rules, 0, options);

const evaluateCommand = (
  command: string,
  rules: LoadedRules,
  options: EvaluationOptions = {},
): Verdict => {
  const { audit: _audit, ...verdict } = evaluateCommandWithAudit(
    command,
    rules,
    options,
  );
  return verdict;
};

export {
  evaluateCommand,
  evaluateCommandWithAudit,
  gitReadCwdTarget,
  hasProjectSensitiveMutation,
  hasUnverifiedProjectMutationNavigation,
  isSkillOverridableAsk,
  loadRules,
};
export type {
  AllowRule,
  AskRule,
  DenyRule,
  EvaluationOptions,
  LoadedRules,
  Verdict,
};
