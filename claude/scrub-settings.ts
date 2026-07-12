#!/usr/bin/env bun
/**
 * claude-scrub git clean filter for claude/.claude/settings.json.
 *
 * Claude Code rewrites the live (symlinked) settings.json at runtime with
 * machine/account-local state — currently the top-level "remote" key
 * (defaultEnvironmentId). This filter drops that key at `git add` time so the
 * committed blob stays portable while the working tree keeps the live value.
 *
 * Invalid JSON exits non-zero: the filter is registered with required=true,
 * so git aborts the operation instead of staging unparseable content.
 */
const input = await Bun.stdin.text();

let parsed: unknown;
try {
  parsed = JSON.parse(input);
} catch (error) {
  console.error(
    `claude-scrub: settings.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
  console.error("claude-scrub: settings.json must be a JSON object");
  process.exit(1);
}

const { remote: _remote, ...portable } = parsed as Record<string, unknown>;

process.stdout.write(`${JSON.stringify(portable, null, 2)}\n`);

export {};
