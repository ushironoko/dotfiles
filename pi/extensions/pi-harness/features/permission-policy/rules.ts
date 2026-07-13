interface DenyRule {
  readonly source?: string;
  readonly pattern: RegExp;
  readonly reason: string;
}

interface AllowRule {
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
  if (value.reason !== undefined && typeof value.reason !== "string") {
    return undefined;
  }
  return {
    pattern: value.pattern,
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

// --- Compound-command scanning (safety-floor bypass fix) ---------------------
//
// evaluateCommand used to test the WHOLE command string against `^`-anchored
// rules, so a benign prefix hid the rest: `echo ok; bit issue claim` slipped
// past the deny floor. The scanner below splits the command into simple
// commands (respecting quotes/escapes/comments), recurses into command
// substitutions, and evaluates each unit independently. Anything it cannot
// parse structurally is denied (fail-closed).

const SUB_PLACEHOLDER = "";
const MAX_SUBSTITUTION_DEPTH = 20;

const WRAPPER_WORDS: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "command",
  "nohup",
  "time",
  "nice",
]);

const OPAQUE_HEAD_WORDS: ReadonlySet<string> = new Set(["eval", "xargs"]);

const SHELL_INTERPRETERS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);

const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

const UNPARSEABLE_REASON =
  "permission-policy: コマンドを解析できませんでした（引用符または括弧が不整合のため fail-closed でブロックしました）";
const OPAQUE_EXECUTOR_REASON =
  "不透明な実行子（eval / sh -c / xargs 等）は内容を静的に検査できないため確認が必要です";

interface Balanced {
  readonly inner: string;
  readonly end: number;
}

// Find the matching close for an open delimiter, skipping quoted spans and
// nested pairs. Returns undefined on imbalance so callers can fail closed.
const readBalanced = (
  text: string,
  openIndex: number,
  open: string,
  close: string,
): Balanced | undefined => {
  let depth = 1;
  let j = openIndex + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "'") {
      const k = text.indexOf("'", j + 1);
      if (k === -1) return undefined;
      j = k + 1;
      continue;
    }
    if (c === '"') {
      j += 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) return undefined;
      j += 1;
      continue;
    }
    if (c === "`") {
      j += 1;
      while (j < text.length && text[j] !== "`") {
        j += text[j] === "\\" ? 2 : 1;
      }
      if (j >= text.length) return undefined;
      j += 1;
      continue;
    }
    if (c === open) {
      depth += 1;
      j += 1;
      continue;
    }
    if (c === close) {
      depth -= 1;
      if (depth === 0) {
        return { inner: text.slice(openIndex + 1, j), end: j + 1 };
      }
      j += 1;
      continue;
    }
    j += 1;
  }
  return undefined;
};

const readBacktick = (text: string, index: number): Balanced | undefined => {
  let j = index + 1;
  while (j < text.length) {
    const c = text[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") return { inner: text.slice(index + 1, j), end: j + 1 };
    j += 1;
  }
  return undefined;
};

const ANSI_C_SIMPLE: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  f: "\f",
  v: "\v",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

interface AnsiResult {
  readonly decoded: string;
  readonly end: number;
}

// $'...' ANSI-C quoting. Decoded only so the literal content is matched
// correctly; its whitespace stays inside the word (it is quoted).
const readAnsiC = (
  text: string,
  quoteIndex: number,
): AnsiResult | undefined => {
  let j = quoteIndex + 1;
  let out = "";
  while (j < text.length) {
    const c = text[j];
    if (c === "'") return { decoded: out, end: j + 1 };
    if (c === "\\") {
      const n = text[j + 1];
      if (n === undefined) {
        out += "\\";
        j += 1;
        continue;
      }
      const simple = ANSI_C_SIMPLE[n];
      if (simple !== undefined) {
        out += simple;
        j += 2;
        continue;
      }
      if (n === "x") {
        const hex = /^[0-9A-Fa-f]{1,2}/.exec(text.slice(j + 2));
        if (hex) {
          out += String.fromCharCode(parseInt(hex[0], 16));
          j += 2 + hex[0].length;
          continue;
        }
      }
      if (n === "u" || n === "U") {
        const re = n === "u" ? /^[0-9A-Fa-f]{1,4}/ : /^[0-9A-Fa-f]{1,8}/;
        const hex = re.exec(text.slice(j + 2));
        if (hex) {
          out += String.fromCodePoint(parseInt(hex[0], 16));
          j += 2 + hex[0].length;
          continue;
        }
      }
      if (n >= "0" && n <= "7") {
        const oct = /^[0-7]{1,3}/.exec(text.slice(j + 1));
        if (oct) {
          out += String.fromCharCode(parseInt(oct[0], 8));
          j += 1 + oct[0].length;
          continue;
        }
      }
      out += n;
      j += 2;
      continue;
    }
    out += c;
    j += 1;
  }
  return undefined;
};

interface DollarResult {
  readonly append: string;
  readonly sub?: string;
  // An unquoted $IFS / ${IFS} expands to whitespace and splits words.
  readonly boundary: boolean;
  readonly end: number;
}

const readDollar = (text: string, index: number): DollarResult | undefined => {
  const n = text[index + 1];
  if (n === "(") {
    // $(( ... )) is arithmetic, not a command; $( ... ) is a substitution.
    const arithmetic = text[index + 2] === "(";
    const bal = readBalanced(text, index + 1, "(", ")");
    if (bal === undefined) return undefined;
    return arithmetic
      ? { append: SUB_PLACEHOLDER, boundary: false, end: bal.end }
      : {
          append: SUB_PLACEHOLDER,
          sub: bal.inner,
          boundary: false,
          end: bal.end,
        };
  }
  if (n === "{") {
    const bal = readBalanced(text, index + 1, "{", "}");
    if (bal === undefined) return undefined;
    if (bal.inner === "IFS")
      return { append: "", boundary: true, end: bal.end };
    return { append: SUB_PLACEHOLDER, boundary: false, end: bal.end };
  }
  if (n === "'") {
    const ansi = readAnsiC(text, index + 1);
    if (ansi === undefined) return undefined;
    return { append: ansi.decoded, boundary: false, end: ansi.end };
  }
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(index + 1));
  if (nameMatch) {
    const name = nameMatch[0];
    if (name === "IFS") {
      return { append: "", boundary: true, end: index + 1 + name.length };
    }
    return {
      append: SUB_PLACEHOLDER,
      boundary: false,
      end: index + 1 + name.length,
    };
  }
  if (n !== undefined && "?$!#@*-0123456789".includes(n)) {
    return { append: SUB_PLACEHOLDER, boundary: false, end: index + 2 };
  }
  return { append: "$", boundary: false, end: index + 1 };
};

interface DoubleQuoteResult {
  readonly literal: string;
  readonly subs: readonly string[];
  readonly end: number;
}

const readDoubleQuote = (
  text: string,
  index: number,
): DoubleQuoteResult | undefined => {
  let j = index + 1;
  let literal = "";
  const subs: string[] = [];
  while (j < text.length) {
    const c = text[j];
    if (c === '"') return { literal, subs, end: j + 1 };
    if (c === "\\") {
      const n = text[j + 1];
      if (n === undefined) return undefined;
      if (n === '"' || n === "\\" || n === "$" || n === "`") {
        literal += n;
        j += 2;
        continue;
      }
      if (n === "\n") {
        j += 2;
        continue;
      }
      literal += "\\";
      j += 1;
      continue;
    }
    if (c === "$") {
      const dollar = readDollar(text, j);
      if (dollar === undefined) return undefined;
      literal += dollar.boundary ? " " : dollar.append;
      if (dollar.sub !== undefined) subs.push(dollar.sub);
      j = dollar.end;
      continue;
    }
    if (c === "`") {
      const back = readBacktick(text, j);
      if (back === undefined) return undefined;
      subs.push(back.inner);
      literal += SUB_PLACEHOLDER;
      j = back.end;
      continue;
    }
    literal += c;
    j += 1;
  }
  return undefined;
};

interface ScanResult {
  readonly segments: readonly (readonly string[])[];
  readonly subs: readonly string[];
  readonly ok: boolean;
}

// Tokenize a command line into simple-command segments (each a list of words)
// plus the raw text of every command substitution to evaluate recursively.
const scan = (command: string): ScanResult => {
  const segments: string[][] = [];
  const subs: string[] = [];
  let words: string[] = [];
  let word = "";
  let atWordStart = true;
  let i = 0;

  const flushWord = (): void => {
    if (word !== "") {
      words.push(word);
      word = "";
    }
  };
  const flushSegment = (): void => {
    flushWord();
    if (words.length > 0) {
      segments.push(words);
      words = [];
    }
  };
  const fail = (): ScanResult => ({ segments, subs, ok: false });

  while (i < command.length) {
    const c = command[i];

    if (c === "\\") {
      const n = command[i + 1];
      if (n === undefined) {
        word += "\\";
        i += 1;
        atWordStart = false;
        continue;
      }
      if (n === "\n") {
        i += 2;
        continue;
      }
      word += n;
      i += 2;
      atWordStart = false;
      continue;
    }

    if (c === "'") {
      const k = command.indexOf("'", i + 1);
      if (k === -1) return fail();
      word += command.slice(i + 1, k);
      i = k + 1;
      atWordStart = false;
      continue;
    }

    if (c === '"') {
      const dq = readDoubleQuote(command, i);
      if (dq === undefined) return fail();
      word += dq.literal;
      subs.push(...dq.subs);
      i = dq.end;
      atWordStart = false;
      continue;
    }

    if (c === "$") {
      const dollar = readDollar(command, i);
      if (dollar === undefined) return fail();
      if (dollar.boundary) {
        flushWord();
        atWordStart = true;
        i = dollar.end;
        continue;
      }
      word += dollar.append;
      if (dollar.sub !== undefined) subs.push(dollar.sub);
      i = dollar.end;
      atWordStart = false;
      continue;
    }

    if (c === "`") {
      const back = readBacktick(command, i);
      if (back === undefined) return fail();
      subs.push(back.inner);
      word += SUB_PLACEHOLDER;
      i = back.end;
      atWordStart = false;
      continue;
    }

    if (c === "<" || c === ">") {
      if (command[i + 1] === "(") {
        const bal = readBalanced(command, i + 1, "(", ")");
        if (bal === undefined) return fail();
        subs.push(bal.inner);
        word += SUB_PLACEHOLDER;
        i = bal.end;
        atWordStart = false;
        continue;
      }
      // Redirection operator: a word boundary; skip the operator run so the
      // target becomes its own (harmless) word.
      flushWord();
      i += 1;
      while (
        i < command.length &&
        (command[i] === "<" || command[i] === ">" || command[i] === "&")
      ) {
        i += 1;
      }
      atWordStart = true;
      continue;
    }

    if (c === " " || c === "\t") {
      flushWord();
      i += 1;
      atWordStart = true;
      continue;
    }

    if (c === "\n" || c === "\r") {
      flushSegment();
      i += 1;
      atWordStart = true;
      continue;
    }

    if (c === "#" && atWordStart) {
      const nl = command.indexOf("\n", i);
      i = nl === -1 ? command.length : nl;
      continue;
    }

    if (c === ";") {
      flushSegment();
      i += 1;
      if (command[i] === ";") i += 1;
      if (command[i] === "&") i += 1;
      atWordStart = true;
      continue;
    }

    if (c === "&") {
      flushSegment();
      i += 1;
      if (command[i] === "&") i += 1;
      atWordStart = true;
      continue;
    }

    if (c === "|") {
      flushSegment();
      i += 1;
      if (command[i] === "|" || command[i] === "&") i += 1;
      atWordStart = true;
      continue;
    }

    if (c === "(" || c === ")") {
      flushSegment();
      i += 1;
      atWordStart = true;
      continue;
    }

    word += c;
    atWordStart = false;
    i += 1;
  }

  flushSegment();
  return { segments, subs, ok: true };
};

const evaluateSegmentString = (
  command: string,
  rules: LoadedRules,
): Verdict => {
  const denied = rules.deny.find((rule) => rule.pattern.test(command));
  if (denied !== undefined) {
    return { verdict: "deny", reason: denied.reason };
  }

  const allowed = rules.allow.find((rule) => rule.pattern.test(command));
  if (allowed !== undefined) {
    return allowed.reason === undefined
      ? { verdict: "allow" }
      : { verdict: "allow", reason: allowed.reason };
  }

  const asked = rules.ask.find((rule) => rule.pattern.test(command));
  if (asked !== undefined) {
    return { verdict: "ask", reason: asked.reason };
  }

  return { verdict: "default-continue" };
};

// A leading `{` group opener, VAR=value assignments, and transparent wrappers
// (sudo/env/...) do not change WHICH command runs, so strip them before the
// `^`-anchored rules see the real command word.
const stripLeading = (words: readonly string[]): readonly string[] => {
  let result = words;
  while (result.length > 0) {
    const head = result[0];
    if (
      head === "{" ||
      ASSIGNMENT_PREFIX.test(head) ||
      WRAPPER_WORDS.has(head)
    ) {
      result = result.slice(1);
      continue;
    }
    break;
  }
  return result;
};

const isOpaqueExecutor = (words: readonly string[]): boolean => {
  const head = words[0];
  if (head === undefined) return false;
  if (OPAQUE_HEAD_WORDS.has(head)) return true;
  if (SHELL_INTERPRETERS.has(head)) {
    return words.slice(1).some((w) => w === "-c");
  }
  return false;
};

const evaluateSegment = (
  words: readonly string[],
  rules: LoadedRules,
): Verdict => {
  const effective = stripLeading(words);
  if (effective.length === 0) return { verdict: "default-continue" };
  const command = effective.join(" ");
  const ruleVerdict = evaluateSegmentString(command, rules);
  if (ruleVerdict.verdict !== "default-continue") return ruleVerdict;
  if (isOpaqueExecutor(effective)) {
    return { verdict: "ask", reason: OPAQUE_EXECUTOR_REASON };
  }
  return ruleVerdict;
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
  const scanned = scan(command);
  if (!scanned.ok) return { verdict: "deny", reason: UNPARSEABLE_REASON };
  const verdicts: Verdict[] = [];
  for (const segment of scanned.segments) {
    verdicts.push(evaluateSegment(segment, rules));
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
