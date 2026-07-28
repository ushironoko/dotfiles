import type { Component } from "@earendil-works/pi-tui";
import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

const SGR_ANSI = new RegExp(String.raw`\u001B\[([0-9;]*)m`, "g");
const CSI_ANSI = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");

const stripForegroundAnsi = (text: string, restoreForeground = ""): string =>
  text.replace(SGR_ANSI, (_sequence, rawParameters: string) => {
    const parameters = rawParameters === "" ? ["0"] : rawParameters.split(";");
    const kept: string[] = [];
    let resetsAll = false;
    for (let index = 0; index < parameters.length; index += 1) {
      const parameter = Number(parameters[index]);
      if (parameter === 0) {
        resetsAll = true;
        kept.push("0");
        continue;
      }
      if (parameter === 38) {
        const mode = Number(parameters[index + 1]);
        if (mode === 5) index += 2;
        else if (mode === 2) index += 4;
        continue;
      }
      if (parameter === 48 || parameter === 58) {
        const mode = Number(parameters[index + 1]);
        let operandCount = 0;
        if (mode === 5) operandCount = 2;
        else if (mode === 2) operandCount = 4;
        kept.push(...parameters.slice(index, index + operandCount + 1));
        index += operandCount;
        continue;
      }
      if (
        (parameter >= 30 && parameter <= 39) ||
        (parameter >= 90 && parameter <= 97)
      ) {
        continue;
      }
      kept.push(parameters[index] ?? "");
    }
    const preserved = kept.length === 0 ? "" : `\u001B[${kept.join(";")}m`;
    return resetsAll ? `${preserved}${restoreForeground}` : preserved;
  });

const isBlankRenderedLine = (text: string): boolean =>
  text.replace(CSI_ANSI, "").trim().length === 0;

interface LineRange {
  start: number;
  end: number;
}

const firstContentBlock = (lines: string[]): LineRange | undefined => {
  const start = lines.findIndex((line) => !isBlankRenderedLine(line));
  if (start === -1) return undefined;
  const separator = lines.findIndex(
    (line, index) => index > start && isBlankRenderedLine(line),
  );
  return { start, end: separator === -1 ? lines.length : separator };
};

type SettledStatus = "success" | "error";
type StatusTitleScope = "first-block" | "all-content";
const MIN_FIRST_BLOCK_STATUS_WIDTH = 12;

const settledStatus = (context: {
  isPartial: boolean;
  isError: boolean;
}): SettledStatus | undefined => {
  if (context.isPartial) return undefined;
  return context.isError ? "error" : "success";
};

class StatusTitleComponent implements Component {
  private cache: { width: number; lines: string[] } | undefined;

  constructor(
    private inner: Component,
    private theme: Theme,
    private status: SettledStatus | undefined,
    private readonly scope: StatusTitleScope,
  ) {}

  update(
    inner: Component,
    theme: Theme,
    status: SettledStatus | undefined,
  ): void {
    this.inner = inner;
    this.theme = theme;
    this.status = status;
    this.cache = undefined;
  }

  innerComponent(): Component {
    return this.inner;
  }

  private remember(width: number, lines: string[]): string[] {
    this.cache = { width, lines };
    return lines;
  }

  private styleTitleLines(
    lines: string[],
    status: SettledStatus,
    icon: string,
    indentContinuations: boolean,
  ): string[] {
    let markerAdded = false;
    const restoreForeground = this.theme.getFgAnsi(status);
    return lines.map((line) => {
      if (isBlankRenderedLine(line)) return line;
      if (!markerAdded) {
        markerAdded = true;
        const content =
          indentContinuations || line.length === 0
            ? `${icon} ${stripForegroundAnsi(line, restoreForeground)}`
            : icon;
        return this.theme.fg(status, content);
      }
      const indent = indentContinuations ? "  " : "";
      return this.theme.fg(
        status,
        `${indent}${stripForegroundAnsi(line, restoreForeground)}`,
      );
    });
  }

  render(width: number): string[] {
    const { status } = this;
    if (status === undefined) return this.inner.render(width);
    if (this.cache?.width === width) return this.cache.lines;
    if (this.scope === "first-block" && width <= MIN_FIRST_BLOCK_STATUS_WIDTH) {
      return this.remember(width, this.inner.render(width));
    }

    const icon = status === "success" ? "✓" : "✗";
    if (width <= 2) {
      const fullLines = this.inner.render(width);
      if (this.scope === "all-content") {
        return this.remember(
          width,
          this.styleTitleLines(fullLines, status, icon, false),
        );
      }
      const range = firstContentBlock(fullLines);
      if (range === undefined) return this.remember(width, fullLines);
      return this.remember(width, [
        ...fullLines.slice(0, range.start),
        ...this.styleTitleLines(
          fullLines.slice(range.start, range.end),
          status,
          icon,
          false,
        ),
        ...fullLines.slice(range.end),
      ]);
    }

    const narrowLines = this.inner.render(width - 2);
    if (this.scope === "all-content") {
      return this.remember(
        width,
        this.styleTitleLines(narrowLines, status, icon, true),
      );
    }

    const fullLines = this.inner.render(width);
    const fullRange = firstContentBlock(fullLines);
    const narrowRange = firstContentBlock(narrowLines);
    if (fullRange === undefined || narrowRange === undefined) {
      return this.remember(width, fullLines);
    }
    return this.remember(width, [
      ...fullLines.slice(0, fullRange.start),
      ...this.styleTitleLines(
        narrowLines.slice(narrowRange.start, narrowRange.end),
        status,
        icon,
        true,
      ),
      ...fullLines.slice(fullRange.end),
    ]);
  }

  invalidate(): void {
    this.cache = undefined;
    this.inner.invalidate();
  }
}

const withStatusTitle = <TParams extends TSchema, TDetails, TState>(
  definition: ToolDefinition<TParams, TDetails, TState>,
  scope: StatusTitleScope = "first-block",
): ToolDefinition<TParams, TDetails, TState> => {
  const { renderCall } = definition;
  if (renderCall === undefined) return definition;

  return {
    ...definition,
    renderCall(args, theme, context) {
      const previous =
        context.lastComponent instanceof StatusTitleComponent
          ? context.lastComponent
          : undefined;
      const inner = renderCall(args, theme, {
        ...context,
        lastComponent: previous?.innerComponent(),
      });
      const status = settledStatus(context);
      if (previous !== undefined) {
        previous.update(inner, theme, status);
        return previous;
      }
      return new StatusTitleComponent(inner, theme, status, scope);
    },
  };
};

export { stripForegroundAnsi, withStatusTitle };
