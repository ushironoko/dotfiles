/**
 * Detects drift between the Claude harness permission source of truth
 * (claude/.claude/settings.json permissions.deny) and the pi-harness rule
 * data (pi/extensions/pi-harness/permission-rules.json).
 *
 * Until Phase 2A lands the rules file this check reports SKIP and succeeds,
 * so run-all stays green during the skeleton phase.
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

interface ClaudeSettings {
  permissions?: { deny?: string[] };
}

interface PiPermissionRules {
  deny?: { source?: string }[];
}

let rulesRaw: string;
try {
  rulesRaw = await readFile(RULES_PATH, "utf8");
} catch {
  console.log(
    "check-pi-rules: SKIP (permission-rules.json not present yet — lands in Phase 2A)",
  );
  process.exit(0);
}

const settings: ClaudeSettings = JSON.parse(
  await readFile(SETTINGS_PATH, "utf8"),
);
const rules: PiPermissionRules = JSON.parse(rulesRaw);

const claudeDeny = settings.permissions?.deny ?? [];
const piDenySources = new Set(
  (rules.deny ?? [])
    .map((rule) => rule.source)
    .filter((source) => source !== undefined),
);

const missing = claudeDeny.filter((entry) => !piDenySources.has(entry));
if (missing.length > 0) {
  console.error(
    "check-pi-rules: claude settings.json deny entries missing from permission-rules.json:",
  );
  for (const entry of missing) console.error(`  - ${entry}`);
  console.error(
    "Each Claude deny entry must appear as a deny rule 'source' (the rule itself may translate the pattern).",
  );
  process.exit(1);
}

console.log(`check-pi-rules: OK (${claudeDeny.length} deny entries covered)`);
