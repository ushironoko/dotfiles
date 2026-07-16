/**
 * Detect drift between Claude Bash permission sources and the translated
 * pi-harness rules. Read permissions are intentionally outside this Bash-only
 * policy.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const SETTINGS_PATH = resolve(
  import.meta.dir,
  "../claude/.claude/settings.json",
);
const RULES_PATH = resolve(
  import.meta.dir,
  "../pi/extensions/pi-harness/permission-rules.json",
);

type RuleBucket = "allow" | "deny";

export interface ClaudePermissionSettings {
  permissions?: { allow?: string[]; deny?: string[] };
}

export interface PiPermissionRules {
  allow?: { source?: string }[];
  deny?: { source?: string }[];
}

export interface PermissionRuleDrift {
  missing: string[];
  stale: string[];
  duplicates: string[];
  wrongBucket: string[];
}

const bashSources = (entries: readonly string[] | undefined): string[] =>
  (entries ?? []).filter((entry) => entry.startsWith("Bash("));

const duplicates = (entries: readonly string[]): string[] => {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry)) repeated.add(entry);
    seen.add(entry);
  }
  return [...repeated].sort();
};

export const findPermissionRuleDrift = (
  settings: ClaudePermissionSettings,
  rules: PiPermissionRules,
): PermissionRuleDrift => {
  const expected: Record<RuleBucket, string[]> = {
    allow: bashSources(settings.permissions?.allow),
    deny: bashSources(settings.permissions?.deny),
  };
  const actual: Record<RuleBucket, string[]> = {
    allow: (rules.allow ?? []).flatMap((rule) =>
      rule.source === undefined ? [] : [rule.source],
    ),
    deny: (rules.deny ?? []).flatMap((rule) =>
      rule.source === undefined ? [] : [rule.source],
    ),
  };

  const missing: string[] = [];
  const stale: string[] = [];
  const wrongBucket: string[] = [];
  const duplicateEntries: string[] = [];

  for (const bucket of ["allow", "deny"] as const) {
    const other: RuleBucket = bucket === "allow" ? "deny" : "allow";
    const expectedSet = new Set(expected[bucket]);
    const actualSet = new Set(actual[bucket]);
    const otherSet = new Set(actual[other]);

    for (const source of expected[bucket]) {
      if (actualSet.has(source)) continue;
      if (otherSet.has(source)) {
        wrongBucket.push(`${bucket}:${source}`);
      } else {
        missing.push(`${bucket}:${source}`);
      }
    }
    for (const source of actual[bucket]) {
      if (source.startsWith("Bash(") && !expectedSet.has(source)) {
        stale.push(`${bucket}:${source}`);
      }
    }
    for (const source of duplicates(actual[bucket])) {
      duplicateEntries.push(`${bucket}:${source}`);
    }
  }

  return {
    missing: [...new Set(missing)].sort(),
    stale: [...new Set(stale)].sort(),
    duplicates: duplicateEntries.sort(),
    wrongBucket: [...new Set(wrongBucket)].sort(),
  };
};

if (import.meta.main) {
  let rulesRaw: string;
  try {
    rulesRaw = await readFile(RULES_PATH, "utf8");
  } catch {
    console.log("check-pi-rules: SKIP (permission-rules.json not present yet)");
    process.exit(0);
  }

  const settings = JSON.parse(
    await readFile(SETTINGS_PATH, "utf8"),
  ) as ClaudePermissionSettings;
  const rules = JSON.parse(rulesRaw) as PiPermissionRules;
  const drift = findPermissionRuleDrift(settings, rules);
  const findings = (
    Object.entries(drift) as [keyof PermissionRuleDrift, string[]][]
  ).flatMap(([kind, entries]) =>
    entries.map((entry: string) => `${kind}: ${entry}`),
  );

  if (findings.length > 0) {
    console.error("check-pi-rules: permission source drift detected:");
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exit(1);
  }

  const allowCount = bashSources(settings.permissions?.allow).length;
  const denyCount = bashSources(settings.permissions?.deny).length;
  console.log(
    `check-pi-rules: OK (${allowCount} Bash allow, ${denyCount} Bash deny entries covered)`,
  );
}
