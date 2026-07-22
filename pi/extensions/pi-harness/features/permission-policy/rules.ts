import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import {
  interpreterConcreteArg,
  isOpaqueExecutor,
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

interface TrustedReadContext {
  /** Filesystem-verified effective cwd for the command. */
  readonly cwd: string;
  /** Complete canonical non-bare roots for the verified Git repository. */
  readonly navigableRoots: readonly string[];
}

interface EvaluationOptions {
  /** Filesystem-verified target of a leading same-repository cd segment. */
  readonly trustedLeadingCdTarget?: string;
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

const remoteHelperExec = (word: string): boolean => {
  const repository = word.startsWith("--repo=")
    ? word.slice("--repo=".length)
    : word;
  return /^[A-Za-z0-9][A-Za-z0-9+.-]*::/.test(repository);
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
  names.some(
    (name) =>
      name.startsWith("--") &&
      word.startsWith(`${name}=`),
  );

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

const gitSubcommandAsk = (
  subcommand: string,
  rest: readonly string[],
): string | undefined => {
  if (subcommand === "push") {
    return gitPushRisk(rest) ?? "git push は remote を変更するため確認が必要です";
  }
  if (subcommand === "help") {
    return "Git help viewer の外部program実行には確認が必要です";
  }
  if (
    ["reset", "restore", "rebase", "cherry-pick", "revert"].includes(
      subcommand,
    )
  ) {
    return `git ${subcommand} は作業ツリーまたは履歴を変更するため確認が必要です`;
  }
  if (
    subcommand === "clean" &&
    rest.some((word) =>
      optionIs(word, "-f", "--force") || /^-[^-]*f/.test(word),
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
  if (
    subcommand === "fetch" &&
    rest.some(
      (word) =>
        optionIs(word, "-f", "--force") ||
        word.startsWith("+") ||
        remoteHelperExec(word),
    )
  ) {
    return "強制または外部helper経由の git fetch には確認が必要です";
  }
  if (
    (subcommand === "switch" || subcommand === "checkout") &&
    rest.some((word) => optionIs(word, "-f", "--force", "--discard-changes"))
  ) {
    return `git ${subcommand} による変更破棄には確認が必要です`;
  }
  if (subcommand === "add" && rest.some(hasPathTraversal)) {
    return "worktree 外を参照する git add には確認が必要です";
  }
  return undefined;
};

const structuralGitAsk = (seg: NormalizedSegment): string | undefined => {
  const position = gitSubcommandPosition(seg.words);
  if (position === undefined) return undefined;
  if (position.riskyGlobalOption || position.ambiguousOption) {
    return "Git の作業場所・設定・不明なグローバルオプション変更には確認が必要です";
  }
  if (seg.opaque.has(position.index)) {
    return "Git サブコマンドを静的に特定できないため確認が必要です";
  }

  const subcommand = seg.words[position.index];
  if (subcommand === undefined) return undefined;
  return gitSubcommandAsk(
    subcommand,
    seg.words.slice(position.index + 1),
  );
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

const containsSensitivePath = (words: readonly string[]): boolean =>
  words.some((word) => {
    // `:` is also a boundary for Git revision paths such as
    // `HEAD:.ssh/id_ed25519`; `/` covers absolute, home, and relative paths.
    const components = word.toLowerCase().split(/[/:]/).filter(Boolean);
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
  words.slice(1).some(
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

const rgReadOperands = (
  words: readonly string[],
): readonly string[] | undefined => {
  let literal = false;
  let noConfig = false;
  const positional: string[] = [];
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
    positional.push(word);
  }
  if (!noConfig || positional.length === 0) return undefined;
  return positional.slice(1);
};

const isProjectBoundedRgRead = (
  words: readonly string[],
  context: TrustedReadContext | undefined,
): boolean => {
  if (context === undefined || context.navigableRoots.length === 0) return false;
  const operands = rgReadOperands(words);
  if (operands === undefined) return false;
  const paths = operands.length === 0 ? ["."] : operands;
  return paths.every((operand) => {
    if (
      operand === "" ||
      isAbsolute(operand) ||
      operand.startsWith("~") ||
      hasPathTraversal(operand)
    ) {
      return false;
    }
    try {
      const canonical = realpathSync(resolve(context.cwd, operand));
      return context.navigableRoots.some((root) =>
        isPathWithin(canonical, root),
      );
    } catch {
      return false;
    }
  });
};

const structuralKnownAsk = (
  segment: Segment,
  normalized: NormalizedSegment,
): string | undefined => {
  if (normalized.privileged) return "sudo 経由の実行には確認が必要です";
  if (segment.hasOutputRedirection) {
    return "ファイルへの出力リダイレクトには確認が必要です";
  }
  if (
    containsSensitivePath([
      ...normalized.words,
      ...segment.redirectionTargets,
    ])
  ) {
    return "認証情報または機密設定へのアクセスには確認が必要です";
  }
  if (isPackageRunnerInvocation(normalized.words)) {
    return "パッケージランナーによるコード実行には確認が必要です";
  }
  if (
    normalized.words[0] === "find" &&
    normalized.words.some((word) => FIND_RISK_TOKENS.has(word))
  ) {
    return "find による削除・コマンド実行・ファイル出力には確認が必要です";
  }
  if (isUploadCommand(normalized.words)) {
    return "remote 実行またはデータ送信には確認が必要です";
  }
  if (
    normalized.words[0] === "rg" &&
    hasRgExecutionOption(normalized.words)
  ) {
    return "rg の外部preprocessor・archive展開・symlink追跡には確認が必要です";
  }
  if (
    normalized.words[0] === "git" &&
    hasGitReadExecutionOption(normalized.words)
  ) {
    return "Git の外部diff・textconv実行またはファイル出力には確認が必要です";
  }
  if (isOpaqueExecutor(normalized.words)) {
    return OPAQUE_EXECUTOR_REASON;
  }
  return structuralGitAsk(normalized);
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
    structuralKnownAsk(segment, normalized) !== gitAsk
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
  if (
    subcommand === undefined ||
    HELPER_CAPABLE_GIT_READS.has(subcommand)
  ) {
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

const structuralKnownAllow = (
  segment: Segment,
  normalized: NormalizedSegment,
  trustedReadContext: TrustedReadContext | undefined,
): boolean => {
  if (
    segment.allowCandidate === undefined ||
    segment.hasAnsiC ||
    normalized.opaque.size !== 0 ||
    segment.words[0] !== normalized.words[0]
  ) {
    return false;
  }

  // Even read-only Git subcommands can execute repository/global helpers
  // (fsmonitor, external diff, or textconv), so they always remain residual.
  if (normalized.words[0] === "git") return false;

  if (normalized.words[0] === "rg") {
    return (
      !hasRgExecutionOption(normalized.words) &&
      isProjectBoundedRgRead(normalized.words, trustedReadContext)
    );
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
  trustedReadContext: TrustedReadContext | undefined,
): Verdict => {
  if (normalized.words.length === 0) {
    return segment.hasOutputRedirection
      ? {
          verdict: "ask",
          reason: "ファイルへの出力リダイレクトには確認が必要です",
        }
      : { verdict: "default-continue" };
  }
  const command = normalized.words.join(" ");
  const potential = speculativeFloor(normalized);

  const denied = rules.deny.find((rule) => rule.pattern.test(command));
  if (denied !== undefined) return { verdict: "deny", reason: denied.reason };

  const structural = structuralBitDeny(normalized);
  if (structural !== undefined) return { verdict: "deny", reason: structural };

  if (potential === "deny") {
    return { verdict: "ask", reason: POTENTIALLY_SENSITIVE_REASON };
  }

  const structuralAsk = structuralKnownAsk(segment, normalized);
  if (structuralAsk !== undefined) {
    return { verdict: "ask", reason: structuralAsk };
  }

  // A same-repository leading cd is neutral only for explicit-allow
  // aggregation. The caller obtains this target through filesystem/Git
  // validation; the scanner check here reasserts the exact safe shell shape.
  if (
    trustedLeadingCdTarget !== undefined &&
    literalTrustedCdTarget(segment) === trustedLeadingCdTarget
  ) {
    return { verdict: "allow" };
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
    return allowed.reason === undefined
      ? { verdict: "allow" }
      : { verdict: "allow", reason: allowed.reason };
  }

  const asked = rules.ask.find((rule) => rule.pattern.test(command));
  if (asked !== undefined) return { verdict: "ask", reason: asked.reason };

  if (potential === "ask") {
    return { verdict: "ask", reason: POTENTIALLY_SENSITIVE_REASON };
  }

  if (structuralKnownAllow(segment, normalized, trustedReadContext)) {
    return { verdict: "allow" };
  }

  return { verdict: "default-continue" };
};

const VERDICT_RANK: Readonly<Record<Verdict["verdict"], number>> = {
  deny: 3,
  ask: 2,
  allow: 1,
  "default-continue": 0,
};

// Precedence deny > ask > allow > default-continue. `allow` only wins when
// EVERY unit is explicitly allowed; a mix of allow + continue proceeds as the
// default (both proceed, so the block outcome is identical either way).
const combineVerdicts = (verdicts: readonly Verdict[]): Verdict => {
  let best: Verdict = { verdict: "default-continue" };
  let allAllow = verdicts.length > 0;
  for (const verdict of verdicts) {
    if (verdict.verdict !== "allow") allAllow = false;
    if (VERDICT_RANK[verdict.verdict] > VERDICT_RANK[best.verdict]) {
      best = verdict;
    }
  }
  if (best.verdict === "allow" && !allAllow) {
    return { verdict: "default-continue" };
  }
  return best;
};

const evaluateCommandInner = (
  command: string,
  rules: LoadedRules,
  depth: number,
  options: EvaluationOptions,
): Verdict => {
  if (depth > MAX_SUBSTITUTION_DEPTH) {
    return { verdict: "deny", reason: UNPARSEABLE_REASON };
  }
  const scanned = scanCommand(command);
  if (!scanned.ok) return { verdict: "deny", reason: UNPARSEABLE_REASON };
  const verdicts: Verdict[] = [];
  for (const [index, segment] of scanned.segments.entries()) {
    const normalized = normalizeSegment(segment);
    verdicts.push(
      evaluateNormalized(
        segment,
        normalized,
        rules,
        segment.allowCandidate,
        depth === 0 && index === 0 ? options.trustedLeadingCdTarget : undefined,
        depth === 0 ? options.trustedReadContext : undefined,
      ),
    );
    // `sh -c '<script>'` runs exactly <script>; evaluate it so a denied body
    // (e.g. `bit relay sync`) is denied instead of downgraded to an opaque ask.
    const inner = interpreterConcreteArg(normalized);
    if (inner !== undefined) {
      verdicts.push(evaluateCommandInner(inner, rules, depth + 1, {}));
    }
  }
  for (const sub of scanned.subs) {
    verdicts.push(evaluateCommandInner(sub, rules, depth + 1, {}));
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
  "init",
  "merge",
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

const hasProjectSensitiveMutation = (command: string): boolean => {
  const scanned = scanCommand(command);
  if (!scanned.ok) return true;
  return scanned.segments.some((segment) => {
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
    return (
      subcommand !== undefined &&
      PROJECT_SENSITIVE_GIT_SUBCOMMANDS.has(subcommand)
    );
  });
};

const evaluateCommand = (
  command: string,
  rules: LoadedRules,
  options: EvaluationOptions = {},
): Verdict => evaluateCommandInner(command, rules, 0, options);

export {
  evaluateCommand,
  hasProjectSensitiveMutation,
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
