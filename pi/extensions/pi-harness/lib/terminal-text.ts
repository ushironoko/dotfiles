const consumeCsi = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 64 && code <= 126) return index + 1;
  }
  return value.length;
};

const consumeControlString = (value: string, start: number): number => {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 7 || code === 156) return index + 1;
    if (
      value[index] === "\u001b" &&
      index + 1 < value.length &&
      value[index + 1] === "\\"
    ) {
      return index + 2;
    }
  }
  return value.length;
};

/** Remove terminal control sequences before model-produced text reaches TUI. */
export const stripTerminalControls = (
  value: string,
  lineFeedReplacement: string = "\n",
): string => {
  let output = "";
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (value[index] === "\u001b") {
      const next = value[index + 1];
      if (next === "[") index = consumeCsi(value, index + 2);
      else if (
        next === "]" ||
        next === "P" ||
        next === "X" ||
        next === "^" ||
        next === "_"
      ) {
        index = consumeControlString(value, index + 2);
      } else index += index + 1 < value.length ? 2 : 1;
      continue;
    }
    if (code === 155) {
      index = consumeCsi(value, index + 1);
      continue;
    }
    if (
      code === 157 ||
      code === 144 ||
      code === 152 ||
      code === 158 ||
      code === 159
    ) {
      index = consumeControlString(value, index + 1);
      continue;
    }
    if (value[index] === "\n") {
      output += lineFeedReplacement;
      index += 1;
      continue;
    }
    if (value[index] === "\t") {
      output += "  ";
      index += 1;
      continue;
    }
    if (code <= 31 || (code >= 127 && code <= 159)) {
      index += 1;
      continue;
    }
    output += value[index];
    index += 1;
  }
  return output;
};

const TRUNCATION_SUFFIX = "…";

/** Prefix-cap a string by UTF-8 bytes without splitting a surrogate pair. */
export const capUtf8 = (value: string, maxBytes: number): string => {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const suffixBytes = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");
  const includeSuffix = suffixBytes <= maxBytes;
  const contentBytes = maxBytes - (includeSuffix ? suffixBytes : 0);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= contentBytes) {
      low = middle;
    } else high = middle - 1;
  }
  let end = low;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${includeSuffix ? TRUNCATION_SUFFIX : ""}`;
};

const isZeroWidth = (code: number): boolean =>
  (code >= 0x300 && code <= 0x36f) ||
  (code >= 0x1ab0 && code <= 0x1aff) ||
  (code >= 0x1dc0 && code <= 0x1dff) ||
  (code >= 0x20d0 && code <= 0x20ff) ||
  (code >= 0xfe00 && code <= 0xfe0f) ||
  (code >= 0xfe20 && code <= 0xfe2f) ||
  code === 0x200d;

const isWide = (code: number): boolean =>
  code >= 0x1100 &&
  (code <= 0x115f ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd));

const runeWidth = (rune: string): number => {
  const code = rune.codePointAt(0) ?? 0;
  if (isZeroWidth(code)) return 0;
  return isWide(code) ? 2 : 1;
};

export const visibleWidth = (value: string): number =>
  Array.from(value).reduce((width, rune) => width + runeWidth(rune), 0);

export const truncateToWidth = (
  value: string,
  width: number,
  suffix: string = "…",
): string => {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  const suffixWidth = visibleWidth(suffix);
  const available = Math.max(0, width - suffixWidth);
  let output = "";
  let used = 0;
  for (const rune of value) {
    const next = runeWidth(rune);
    if (used + next > available) break;
    output += rune;
    used += next;
  }
  return `${output}${suffixWidth <= width ? suffix : ""}`;
};

/** Wrap already-sanitized plain text. Every returned line fits width. */
export const wrapPlainText = (value: string, width: number): string[] => {
  if (width <= 0) return [""];
  const lines: string[] = [];
  for (const sourceLine of value.split("\n")) {
    if (sourceLine === "") {
      lines.push("");
      continue;
    }
    let current = "";
    let used = 0;
    for (const rune of sourceLine) {
      const next = runeWidth(rune);
      if (used > 0 && used + next > width) {
        lines.push(current);
        current = "";
        used = 0;
      }
      if (next > width) continue;
      current += rune;
      used += next;
    }
    lines.push(current);
  }
  return lines.length === 0 ? [""] : lines;
};
