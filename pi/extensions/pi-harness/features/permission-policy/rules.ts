import {
  interpreterConcreteArg,
  isOpaqueExecutor,
  normalizeSegment,
  type NormalizedSegment,
  scanCommand,
  speculativeFloor,
} from "./scan";

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
    pattern: "^git\\s+push\\b[^\\n]*(?:\\s--force|\\s-f)(?=\\s|$)",
    reason: "強制 push には確認が必要です",
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
  "permission-policy: コマンドを解析できませんでした（引用符または括弧が不整合のため fail-closed でブロックしました）";
const OPAQUE_EXECUTOR_REASON =
  "不透明な実行子（eval / sh -c / xargs 等）は内容を静的に検査できないため確認が必要です";
const POTENTIALLY_SENSITIVE_REASON =
  "動的展開・未対応構文により、禁止/破壊的コマンドにならないと静的に判定できないため確認が必要です";

// Structural deny for a bit invocation that a `^`-anchored regex cannot express
// robustly: `bit clone` with a `relay+…` operand in ANY position (options may
// precede it, so `bit clone --depth 1 relay+x` must not slip past). The head and
// wrappers are already normalized by normalizeSegment.
const structuralBitDeny = (seg: NormalizedSegment): string | undefined => {
  const words = seg.words;
  if (words[0] !== "bit" || words[1] !== "clone") return undefined;
  for (let i = 2; i < words.length; i += 1) {
    if (!seg.opaque.has(i) && words[i].startsWith("relay+")) {
      return "bit clone relay+ は禁止です";
    }
  }
  return undefined;
};

// One simple command. Precedence: concrete DENY > built-in DENY-potential
// (unsuppressable by user allow — the data-leak floor) > user ALLOW > concrete
// ASK > built-in ASK-potential > opaque executor > default-continue.
const evaluateNormalized = (
  normalized: NormalizedSegment,
  rules: LoadedRules,
  allowCandidate: string | undefined,
): Verdict => {
  if (normalized.words.length === 0) return { verdict: "default-continue" };
  const command = normalized.words.join(" ");
  const potential = speculativeFloor(normalized);

  const denied = rules.deny.find((rule) => rule.pattern.test(command));
  if (denied !== undefined) return { verdict: "deny", reason: denied.reason };

  const structural = structuralBitDeny(normalized);
  if (structural !== undefined) return { verdict: "deny", reason: structural };

  if (potential === "deny") {
    return { verdict: "ask", reason: POTENTIALLY_SENSITIVE_REASON };
  }

  // Allow grants use the scanner's conservative concrete representation
  // before wrapper stripping or executable basename normalization.
  const allowed =
    allowCandidate === undefined
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

  if (isOpaqueExecutor(normalized.words)) {
    return { verdict: "ask", reason: OPAQUE_EXECUTOR_REASON };
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
): Verdict => {
  if (depth > MAX_SUBSTITUTION_DEPTH) {
    return { verdict: "deny", reason: UNPARSEABLE_REASON };
  }
  const scanned = scanCommand(command);
  if (!scanned.ok) return { verdict: "deny", reason: UNPARSEABLE_REASON };
  const verdicts: Verdict[] = [];
  for (const segment of scanned.segments) {
    const normalized = normalizeSegment(segment);
    verdicts.push(
      evaluateNormalized(normalized, rules, segment.allowCandidate),
    );
    // `sh -c '<script>'` runs exactly <script>; evaluate it so a denied body
    // (e.g. `bit relay sync`) is denied instead of downgraded to an opaque ask.
    const inner = interpreterConcreteArg(normalized);
    if (inner !== undefined) {
      verdicts.push(evaluateCommandInner(inner, rules, depth + 1));
    }
  }
  for (const sub of scanned.subs) {
    verdicts.push(evaluateCommandInner(sub, rules, depth + 1));
  }
  return combineVerdicts(verdicts);
};

const evaluateCommand = (command: string, rules: LoadedRules): Verdict =>
  evaluateCommandInner(command, rules, 0);

export { evaluateCommand, loadRules };
export type { AllowRule, AskRule, DenyRule, LoadedRules, Verdict };
