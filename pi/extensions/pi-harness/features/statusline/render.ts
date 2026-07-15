/**
 * Pure rendering for the statusline widget: cache JSON written by
 * statusline_checks_run.sh + git branch → widget lines. Glyphs follow
 * status_to_glyph in statusline_checks_lib.sh (without ANSI colors — the
 * widget line is plain text).
 */

export const STATUSLINE_WIDGET_KEY = "pi-harness-statusline";

export interface StatuslineCheckState {
  status?: string;
  [key: string]: unknown;
}

export interface StatuslineCache {
  label?: string;
  checks?: Record<string, StatuslineCheckState | undefined>;
  [key: string]: unknown;
}

const GLYPHS: Record<string, string> = {
  ok: "✓",
  fail: "✗",
  running: "…",
  skipped: "-",
};

/** Display order and short names for the three check slots. */
const SLOTS: readonly (readonly [slot: string, display: string])[] = [
  ["lint", "lint"],
  ["typecheck", "type"],
  ["test", "test"],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const glyph = (status: unknown): string =>
  typeof status === "string" ? (GLYPHS[status] ?? "?") : "?";

export const parseStatuslineCache = (
  raw: string,
): StatuslineCache | undefined => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as StatuslineCache) : undefined;
  } catch {
    return undefined;
  }
};

export const renderStatusline = (
  cache: StatuslineCache | undefined,
  branch: string | undefined,
): string[] | undefined => {
  const parts: string[] = [];
  if (cache !== undefined) {
    if (typeof cache.label === "string" && cache.label !== "") {
      parts.push(cache.label);
    }
    if (isRecord(cache.checks)) {
      const checks = cache.checks;
      parts.push(
        SLOTS.map(([slot, display]) => {
          const state = checks[slot];
          return `${display}:${glyph(isRecord(state) ? state.status : undefined)}`;
        }).join(" "),
      );
    }
  }
  if (branch !== undefined && branch !== "") parts.push(`(${branch})`);
  return parts.length === 0 ? undefined : [parts.join(" ")];
};
