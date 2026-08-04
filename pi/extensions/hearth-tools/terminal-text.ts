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

/** Remove terminal control sequences before unvalidated tool text reaches TUI. */
export const stripTerminalControls = (
  value: string,
  lineFeedReplacement = "\n",
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
