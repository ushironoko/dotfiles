import type {
  ContextUsageLike,
  ModelLike,
  ThemeColorLike,
  ThemeLike,
} from "../../lib/pi-like";

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

// Keep these classifiers aligned with pi-tui 0.80.6's graphemeWidth.
const ZERO_WIDTH_GRAPHEME =
  /^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/v;
const LEADING_NON_PRINTING =
  /^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/v;
const RGI_EMOJI = /^\p{RGI_Emoji}$/v;

const couldBeEmoji = (grapheme: string): boolean => {
  const codePoint = grapheme.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x1f000 && codePoint <= 0x1fbff) ||
    (codePoint >= 0x2300 && codePoint <= 0x23ff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    (codePoint >= 0x2b50 && codePoint <= 0x2b55) ||
    grapheme.includes("\uFE0F") ||
    grapheme.length > 2
  );
};

// Fullwidth + wide ranges from the same Unicode EastAsianWidth table used by
// pi-tui 0.80.6's get-east-asian-width dependency. Keeping the compact table
// local preserves pi-harness's no-runtime-dependency deployment contract.
const EAST_ASIAN_WIDE_RANGES: readonly number[] = [
  12_288, 12_288, 65_281, 65_376, 65_504, 65_510, 4_352, 4_447, 8_986, 8_987,
  9_001, 9_002, 9_193, 9_196, 9_200, 9_200, 9_203, 9_203, 9_725, 9_726, 9_748,
  9_749, 9_776, 9_783, 9_800, 9_811, 9_855, 9_855, 9_866, 9_871, 9_875, 9_875,
  9_889, 9_889, 9_898, 9_899, 9_917, 9_918, 9_924, 9_925, 9_934, 9_934, 9_940,
  9_940, 9_962, 9_962, 9_970, 9_971, 9_973, 9_973, 9_978, 9_978, 9_981, 9_981,
  9_989, 9_989, 9_994, 9_995, 10_024, 10_024, 10_060, 10_060, 10_062, 10_062,
  10_067, 10_069, 10_071, 10_071, 10_133, 10_135, 10_160, 10_160, 10_175,
  10_175, 11_035, 11_036, 11_088, 11_088, 11_093, 11_093, 11_904, 11_929,
  11_931, 12_019, 12_032, 12_245, 12_272, 12_287, 12_289, 12_350, 12_353,
  12_438, 12_441, 12_543, 12_549, 12_591, 12_593, 12_686, 12_688, 12_773,
  12_783, 12_830, 12_832, 12_871, 12_880, 42_124, 42_128, 42_182, 43_360,
  43_388, 44_032, 55_203, 63_744, 64_255, 65_040, 65_049, 65_072, 65_106,
  65_108, 65_126, 65_128, 65_131, 94_176, 94_180, 94_192, 94_198, 94_208,
  101_589, 101_631, 101_662, 101_760, 101_874, 110_576, 110_579, 110_581,
  110_587, 110_589, 110_590, 110_592, 110_882, 110_898, 110_898, 110_928,
  110_930, 110_933, 110_933, 110_948, 110_951, 110_960, 111_355, 119_552,
  119_638, 119_648, 119_670, 126_980, 126_980, 127_183, 127_183, 127_374,
  127_374, 127_377, 127_386, 127_488, 127_490, 127_504, 127_547, 127_552,
  127_560, 127_568, 127_569, 127_584, 127_589, 127_744, 127_776, 127_789,
  127_797, 127_799, 127_868, 127_870, 127_891, 127_904, 127_946, 127_951,
  127_955, 127_968, 127_984, 127_988, 127_988, 127_992, 128_062, 128_064,
  128_064, 128_066, 128_252, 128_255, 128_317, 128_331, 128_334, 128_336,
  128_359, 128_378, 128_378, 128_405, 128_406, 128_420, 128_420, 128_507,
  128_591, 128_640, 128_709, 128_716, 128_716, 128_720, 128_722, 128_725,
  128_728, 128_732, 128_735, 128_747, 128_748, 128_756, 128_764, 128_992,
  129_003, 129_008, 129_008, 129_292, 129_338, 129_340, 129_349, 129_351,
  129_535, 129_648, 129_660, 129_664, 129_674, 129_678, 129_734, 129_736,
  129_736, 129_741, 129_756, 129_759, 129_770, 129_775, 129_784, 131_072,
  196_605, 196_608, 262_141,
];

const isWide = (codePoint: number): boolean => {
  for (let index = 0; index < EAST_ASIAN_WIDE_RANGES.length; index += 2) {
    const lower = EAST_ASIAN_WIDE_RANGES[index];
    const upper = EAST_ASIAN_WIDE_RANGES[index + 1];
    if (lower !== undefined && upper !== undefined) {
      if (codePoint >= lower && codePoint <= upper) return true;
    }
  }
  return false;
};

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (value: string): string[] =>
  [...segmenter.segment(value)].map(({ segment }) => segment);

const graphemeWidth = (grapheme: string): number => {
  if (ZERO_WIDTH_GRAPHEME.test(grapheme)) return 0;
  if (couldBeEmoji(grapheme) && RGI_EMOJI.test(grapheme)) return 2;

  const base = grapheme.replace(LEADING_NON_PRINTING, "");
  const codePoint = base.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) return 2;

  let width = isWide(codePoint) ? 2 : 1;
  if (grapheme.length > 1) {
    for (const character of grapheme.slice(1)) {
      const trailing = character.codePointAt(0) ?? 0;
      if (trailing >= 0xff00 && trailing <= 0xffef) {
        width += isWide(trailing) ? 2 : 1;
      } else if (trailing === 0x0e33 || trailing === 0x0eb3) {
        width += 1;
      }
    }
  }
  return width;
};

export const visibleStatuslineWidth = (value: string): number =>
  graphemes(value).reduce(
    (width, grapheme) => width + graphemeWidth(grapheme),
    0,
  );

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
