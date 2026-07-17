import {
  truncateToWidth as piTruncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

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

// pi aliases this documented package root to the TUI implementation bundled
// with the running binary. Re-export width behavior through this local adapter
// so sanitization/privacy logic stays local while Unicode behavior follows pi.
export { visibleWidth };

export const truncateToWidth = (
  value: string,
  width: number,
  suffix: string = "…",
): string => {
  if (width <= 0) return "";
  return stripTerminalControls(piTruncateToWidth(value, width, suffix));
};

/** Wrap already-sanitized plain text. Every returned line fits width. */
export const wrapPlainText = (value: string, width: number): string[] => {
  if (width <= 0) return [""];
  return wrapTextWithAnsi(value, width).map((line) =>
    stripTerminalControls(line),
  );
};
