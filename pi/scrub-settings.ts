#!/usr/bin/env bun
/**
 * Git clean filter for the live, symlinked Pi settings file.
 *
 * Pi rewrites settings.json at runtime. Keep the working-tree file complete,
 * but omit machine/account-local state and credential-bearing values from the
 * blob staged by Git. The required filter fails closed on malformed input.
 */
const input = await Bun.stdin.text();

let parsed: unknown;
try {
  parsed = JSON.parse(input);
} catch (error) {
  console.error(
    `pi-scrub: settings.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  console.error("pi-scrub: settings.json must be a JSON object");
  process.exit(1);
}

const OMIT = Symbol("omit");
const OMIT_TOP_LEVEL = new Set([
  "httpProxy",
  "lastChangelogVersion",
  "trackingId",
]);
const PORTABLE_ABSOLUTE_VALUES = new Set([
  "!/Users/ushironoko/.agents/skills/**",
]);
const CREDENTIAL_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i;
const ABSOLUTE_PATH = /(^|[\s"'(=><])!?\/(?!\/)/;
const SENSITIVE_KEY_SUFFIXES = [
  "apikey",
  "authorization",
  "credential",
  "password",
  "secret",
  "token",
];

const hasSensitiveKey = (key: string): boolean => {
  const normalized = key.replaceAll(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
};

const hasSensitiveString = (value: string): boolean => {
  if (PORTABLE_ABSOLUTE_VALUES.has(value)) return false;
  if (CREDENTIAL_URL.test(value)) return true;
  return value.startsWith("file:/") || ABSOLUTE_PATH.test(value);
};

const scrub = (value: unknown): unknown | typeof OMIT => {
  if (typeof value === "string") {
    return hasSensitiveString(value) ? OMIT : value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const scrubbed = scrub(item);
      return scrubbed === OMIT ? [] : [scrubbed];
    });
  }
  if (value !== null && typeof value === "object") {
    const scrubbed: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (hasSensitiveKey(key)) continue;
      const scrubbedChild = scrub(child);
      if (scrubbedChild !== OMIT) scrubbed[key] = scrubbedChild;
    }
    return scrubbed;
  }
  return value;
};

const portable: Record<string, unknown> = {};
for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
  if (OMIT_TOP_LEVEL.has(key) || hasSensitiveKey(key)) continue;
  const scrubbed = scrub(value);
  if (scrubbed !== OMIT) portable[key] = scrubbed;
}

process.stdout.write(`${JSON.stringify(portable, null, 2)}\n`);

export {};
