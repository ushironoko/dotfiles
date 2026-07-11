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

const evaluateCommand = (command: string, rules: LoadedRules): Verdict => {
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

export { evaluateCommand, loadRules };
export type { AllowRule, AskRule, DenyRule, LoadedRules, Verdict };
