import { truncateToWidth as truncateStyledToWidth } from "@earendil-works/pi-tui";
import type {
  ContextUsageLike,
  ModelLike,
  ThemeColorLike,
  ThemeLike,
} from "../../lib/pi-like";
import { visibleWidth } from "../../lib/terminal-text";

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

export interface GitStatus {
  isRepository: boolean;
  repository?: string;
  additions: number;
  deletions: number;
}

export interface StatuslineSnapshot {
  directory: string;
  git: GitStatus;
  projectLabel?: string;
  cache?: StatuslineCache;
}

export interface StatuslineRuntime {
  branch?: string | null;
  modelName?: string;
  remainingContext?: number;
}

interface Span {
  text: string;
  tone?: ThemeColorLike;
}

const STATUS_STYLES = new Map<string, readonly [string, ThemeColorLike]>([
  ["ok", ["✓", "success"]],
  ["fail", ["✗", "error"]],
  ["running", ["…", "warning"]],
  ["skipped", ["-", "dim"]],
]);

/** Display order and Claude-compatible initials for the three check slots. */
const SLOTS: readonly (readonly [slot: string, display: string])[] = [
  ["lint", "L"],
  ["typecheck", "T"],
  ["test", "X"],
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const singleLine = (value: string): string =>
  [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        ? " "
        : character;
    })
    .join("")
    .replace(/ +/g, " ")
    .trim();

const checkStatus = (
  cache: StatuslineCache | undefined,
  slot: string,
): string => {
  const state = cache?.checks?.[slot];
  return isRecord(state) && typeof state.status === "string"
    ? state.status
    : "pending";
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (value: string): string[] =>
  [...segmenter.segment(value)].map(({ segment }) => segment);

const graphemeWidth = (grapheme: string): number => visibleWidth(grapheme);

export const visibleStatuslineWidth = visibleWidth;

const consumeCsi = (
  value: string,
  start: number,
): { end: number; final?: string; valid: boolean } => {
  let valid = true;
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 64 && code <= 126) {
      return { end: index + 1, final: value[index], valid };
    }
    if (code < 32 || code > 63) valid = false;
  }
  return { end: value.length, valid: false };
};

const sgrIsOnlyFullReset = (body: string): boolean =>
  body
    .split(";")
    .every((parameter) => parameter === "" || /^0+$/.test(parameter));

const consumeControlString = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 7 || code === 156) return index + 1;
    if (value[index] === "\u001b" && value[index + 1] === "\\") {
      return index + 2;
    }
  }
  return value.length;
};

const consumeEscapeSequence = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 48 && code <= 126) return index + 1;
    if (code < 32 || code > 47) return index + 1;
  }
  return value.length;
};

/**
 * Preserve extension SGR styling, but collapse whitespace and every other
 * terminal control so one status cannot alter or add footer lines.
 */
const singleLineExtensionStatus = (value: string): string | undefined => {
  let output = "";
  let pendingSpace = false;
  let hasVisibleCharacter = false;
  let sgrNeedsReset = false;
  let index = 0;

  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (value[index] === "\u001b") {
      const next = value[index + 1];
      if (next === "[") {
        const csi = consumeCsi(value, index + 2);
        if (csi.valid && csi.final === "m") {
          output += value.slice(index, csi.end);
          sgrNeedsReset = !sgrIsOnlyFullReset(
            value.slice(index + 2, csi.end - 1),
          );
        } else pendingSpace = true;
        index = csi.end;
        continue;
      }
      if (
        next === "]" ||
        next === "P" ||
        next === "X" ||
        next === "^" ||
        next === "_"
      ) {
        pendingSpace = true;
        index = consumeControlString(value, index + 2);
        continue;
      }
      pendingSpace = true;
      index = consumeEscapeSequence(value, index + 1);
      continue;
    }
    if (code === 155) {
      const csi = consumeCsi(value, index + 1);
      if (csi.valid && csi.final === "m") {
        output += `\u001b[${value.slice(index + 1, csi.end)}`;
        sgrNeedsReset = !sgrIsOnlyFullReset(
          value.slice(index + 1, csi.end - 1),
        );
      } else pendingSpace = true;
      index = csi.end;
      continue;
    }
    if (
      code === 157 ||
      code === 144 ||
      code === 152 ||
      code === 158 ||
      code === 159
    ) {
      pendingSpace = true;
      index = consumeControlString(value, index + 1);
      continue;
    }
    if (
      code <= 32 ||
      (code >= 127 && code <= 159) ||
      code === 8232 ||
      code === 8233
    ) {
      pendingSpace = true;
      index += 1;
      continue;
    }

    if (pendingSpace && hasVisibleCharacter) output += " ";
    output += value[index];
    pendingSpace = false;
    hasVisibleCharacter = true;
    index += 1;
  }

  if (!hasVisibleCharacter || visibleWidth(output) === 0) return undefined;
  return sgrNeedsReset ? `${output}\u001b[0m` : output;
};

const compareExtensionStatusKeys = (
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

/** Render every extension status on one stable, terminal-width-safe line. */
export const renderExtensionStatuses = (
  statuses: ReadonlyMap<string, string>,
  width: number,
): string | undefined => {
  if (width <= 0) return undefined;
  const statusLine = [...statuses.entries()]
    .sort(compareExtensionStatusKeys)
    .map(([, text]) => singleLineExtensionStatus(text))
    .filter((text): text is string => text !== undefined)
    .join(" ");
  if (statusLine === "") return undefined;
  return truncateStyledToWidth(statusLine, width, "…");
};

const appendSpan = (spans: Span[], span: Span): void => {
  if (span.text === "") return;
  const previous = spans.at(-1);
  if (previous !== undefined && previous.tone === span.tone) {
    previous.text += span.text;
  } else {
    spans.push({ ...span });
  }
};

const truncateSpans = (spans: Span[], width: number): Span[] => {
  if (width <= 0) return [];
  const totalWidth = spans.reduce(
    (total, span) => total + visibleStatuslineWidth(span.text),
    0,
  );
  if (totalWidth <= width) return spans;

  const truncated: Span[] = [];
  const contentWidth = Math.max(0, width - 1);
  let used = 0;

  let complete = false;
  for (const span of spans) {
    if (complete) break;
    let text = "";
    for (const grapheme of graphemes(span.text)) {
      const nextWidth = graphemeWidth(grapheme);
      if (used + nextWidth > contentWidth) {
        complete = true;
        break;
      }
      text += grapheme;
      used += nextWidth;
    }
    appendSpan(truncated, { text, tone: span.tone });
  }

  appendSpan(truncated, { text: "…", tone: "dim" });
  return truncated;
};

const flattenFields = (fields: Span[][]): Span[] => {
  const spans: Span[] = [];
  fields.forEach((field, index) => {
    if (index > 0) appendSpan(spans, { text: " | ", tone: "muted" });
    for (const span of field) appendSpan(spans, span);
  });
  return spans;
};

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

export const formatModelName = (
  model: ModelLike | undefined,
): string | undefined => {
  const name = model?.name ?? model?.id;
  if (name === undefined || name === "") return undefined;
  return singleLine(name).replace(/ *\([^)]*context[^)]*\)$/i, "");
};

const roundTiesToEven = (value: number): number => {
  const lower = Math.floor(value);
  const fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
};

export const remainingContextPercent = (
  usage: ContextUsageLike | undefined,
): number | undefined => {
  if (usage?.percent === null || usage?.percent === undefined) return undefined;
  if (!Number.isFinite(usage.percent)) return undefined;
  const bounded = Math.min(100, Math.max(0, usage.percent));
  return 100 - roundTiesToEven(bounded);
};

const contextTone = (remaining: number): ThemeColorLike => {
  if (remaining >= 30) return "success";
  if (remaining >= 10) return "warning";
  return "error";
};

/**
 * Render the Claude-compatible one-line footer. Every field is kept as plain
 * spans until after width truncation, so theme escape sequences never affect
 * the terminal-width calculation.
 */
export const renderStatusline = (
  snapshot: StatuslineSnapshot,
  runtime: StatuslineRuntime,
  width: number,
  theme: ThemeLike,
): string[] => {
  const fields: Span[][] = [];
  const directory = singleLine(snapshot.directory);

  if (snapshot.git.isRepository && snapshot.git.repository !== undefined) {
    fields.push([{ text: singleLine(snapshot.git.repository) }]);
  }
  // Claude always starts with the current directory, even when its basename
  // is empty (for example, the filesystem root).
  fields.push([{ text: directory }]);

  const branch =
    runtime.branch === undefined || runtime.branch === null
      ? ""
      : singleLine(runtime.branch);
  if (branch !== "" && branch !== "detached") {
    fields.push([{ text: branch }]);
  }

  if (
    snapshot.git.isRepository &&
    (snapshot.git.additions > 0 || snapshot.git.deletions > 0)
  ) {
    fields.push([
      { text: `+${snapshot.git.additions}`, tone: "success" },
      { text: " " },
      { text: `-${snapshot.git.deletions}`, tone: "error" },
    ]);
  }

  const cachedLabel =
    typeof snapshot.cache?.label === "string"
      ? singleLine(snapshot.cache.label)
      : "";
  const projectLabel = cachedLabel || singleLine(snapshot.projectLabel ?? "");
  if (projectLabel !== "") {
    const checks: Span[] = [{ text: projectLabel }];
    for (const [slot, display] of SLOTS) {
      const status = checkStatus(snapshot.cache, slot);
      const [glyph, tone] = STATUS_STYLES.get(status) ?? ["?", "dim"];
      checks.push({ text: ` ${display}` }, { text: glyph, tone });
    }
    fields.push(checks);
  }

  const modelName = singleLine(runtime.modelName ?? "");
  if (modelName !== "") fields.push([{ text: modelName, tone: "accent" }]);

  if (runtime.remainingContext !== undefined) {
    const remaining = Math.min(
      100,
      Math.max(0, Math.round(runtime.remainingContext)),
    );
    fields.push([{ text: `${remaining}%`, tone: contextTone(remaining) }]);
  }

  const spans = truncateSpans(flattenFields(fields), Math.max(0, width));
  return [
    spans
      .map((span) =>
        span.tone === undefined ? span.text : theme.fg(span.tone, span.text),
      )
      .join(""),
  ];
};
