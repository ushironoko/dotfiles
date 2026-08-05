import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Text,
  type Component,
  truncateToWidth as truncateStyledToWidth,
} from "@earendil-works/pi-tui";
import {
  stripTerminalControls,
  truncateToWidth,
  visibleWidth,
} from "../../lib/terminal-text";
import type { BtwHistoryData } from "./index";

interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

interface TuiLike {
  terminal: { rows: number };
  requestRender(force?: boolean): void;
}

interface BtwPaneTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

const plainTheme: BtwPaneTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

const resolveTheme = (value: unknown): BtwPaneTheme => {
  if (typeof value !== "object" || value === null) return plainTheme;
  const candidate = value as Partial<BtwPaneTheme>;
  return typeof candidate.fg === "function" &&
    typeof candidate.bg === "function" &&
    typeof candidate.bold === "function"
    ? (candidate as BtwPaneTheme)
    : plainTheme;
};

const styledLine = (value: string, width: number, suffix = ""): string => {
  const safeWidth = Math.max(1, width);
  return value.includes("\u001b")
    ? truncateStyledToWidth(value, safeWidth, suffix)
    : truncateToWidth(value, safeWidth, suffix);
};

const defaultKeyMatches = (data: string, keybinding: string): boolean => {
  const legacyKeys: Record<string, string[]> = {
    "tui.editor.cursorLeft": ["left", "\u001b[D"],
    "tui.editor.cursorLineStart": ["home", "\u001b[H", "\u001b[1~"],
    "tui.editor.cursorLineEnd": ["end", "\u001b[F", "\u001b[4~"],
    "tui.select.up": ["up", "\u001b[A"],
    "tui.select.down": ["down", "\u001b[B"],
    "tui.select.pageUp": ["pageup", "\u001b[5~"],
    "tui.select.pageDown": ["pagedown", "\u001b[6~"],
    "tui.select.cancel": ["escape", "\u001b"],
  };
  if (legacyKeys[keybinding]?.includes(data)) return true;
  if (!data.startsWith("\u001b[")) return false;

  const kittySequence = data.slice(2);
  const kittyPatterns: Partial<Record<string, RegExp>> = {
    "tui.editor.cursorLeft": /^1;1(?::[12])?D$/,
    "tui.editor.cursorLineStart": /^(?:1;1(?::[12])?H|7;1(?::[12])?~)$/,
    "tui.editor.cursorLineEnd": /^(?:1;1(?::[12])?F|8;1(?::[12])?~)$/,
    "tui.select.up": /^1;1(?::[12])?A$/,
    "tui.select.down": /^1;1(?::[12])?B$/,
    "tui.select.pageUp": /^5;1(?::[12])?~$/,
    "tui.select.pageDown": /^6;1(?::[12])?~$/,
    "tui.select.cancel": /^27(?:;1)?(?::[12])?u$/,
  };
  return kittyPatterns[keybinding]?.test(kittySequence) ?? false;
};

const contentLines = (
  record: BtwHistoryData,
  width: number,
  theme: BtwPaneTheme,
): string[] => {
  const root = new Container();
  const metadata = new Box(1, 0, (text) => theme.bg("selectedBg", text));
  metadata.addChild(
    new Text(
      `${theme.fg("accent", theme.bold("Question"))}\n${theme.fg(
        "text",
        stripTerminalControls(record.question),
      )}`,
      0,
      0,
    ),
  );
  metadata.addChild(
    new Text(
      theme.fg(
        "muted",
        `${stripTerminalControls(record.model)} · ${new Date(record.createdAt).toLocaleString()}${
          record.answerTruncated ? " · retained answer truncated" : ""
        }`,
      ),
      0,
      0,
    ),
  );
  root.addChild(metadata);
  root.addChild(new Text(theme.fg("accent", theme.bold("Answer")), 0, 0));
  const answer = new Box(1, 0);
  answer.addChild(
    new Text(theme.fg("text", stripTerminalControls(record.answer)), 0, 0),
  );
  root.addChild(answer);
  return root.render(Math.max(1, width));
};

/** Full-screen BTW answer viewer with branch-local history navigation. */
export class BtwAnswerPaneComponent implements Component {
  private selectedIndex: number;
  private offset = 0;
  private lastMaxOffset = 0;
  private lastViewport = 1;
  private readonly theme: BtwPaneTheme;

  constructor(
    private readonly histories: readonly BtwHistoryData[],
    selectedId: string | undefined,
    private readonly tui: TuiLike,
    private readonly keybindings: KeybindingsLike,
    private readonly onClose: () => void,
    theme?: unknown,
  ) {
    this.theme = resolveTheme(theme);
    const selectedIndex = histories.findIndex((item) => item.id === selectedId);
    this.selectedIndex =
      selectedIndex === -1 ? Math.max(0, histories.length - 1) : selectedIndex;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const height = Math.max(1, this.tui.terminal.rows);
    const showTitle = height >= 2;
    const showHint = height >= 3;
    const chrome = Number(showTitle) + Number(showHint);
    const viewport = Math.max(1, height - chrome);
    this.lastViewport = viewport;

    const selected = this.histories[this.selectedIndex];
    const allLines =
      selected === undefined
        ? new Text(
            this.theme.fg("warning", "No BTW answers are available."),
            0,
            0,
          ).render(safeWidth)
        : contentLines(selected, safeWidth, this.theme);
    this.lastMaxOffset = Math.max(0, allLines.length - viewport);
    this.offset = Math.min(this.offset, this.lastMaxOffset);

    const visible = allLines.slice(this.offset, this.offset + viewport);
    while (visible.length < viewport) visible.push("");

    const historyPosition =
      selected === undefined
        ? "0/0"
        : `${this.selectedIndex + 1}/${this.histories.length}`;
    const title = `${this.theme.fg("toolTitle", this.theme.bold(" BTW answer"))} ${this.theme.fg("muted", historyPosition)} `;
    const borderWidth = Math.max(1, safeWidth - visibleWidth(title));
    const border = this.theme.fg("borderMuted", "─".repeat(borderWidth));
    const first = allLines.length === 0 ? 0 : this.offset + 1;
    const last = Math.min(allLines.length, this.offset + viewport);
    const scrollPosition = `${first}-${last}/${allLines.length}`;

    const output: string[] = [];
    if (showTitle) output.push(styledLine(`${title}${border}`, safeWidth));
    output.push(...visible.map((item) => styledLine(item, safeWidth)));
    if (showHint) {
      const hint = this.theme.fg(
        "dim",
        "↑ older  ↓ newer  PgUp/PgDn scroll  Home/End  Esc/←/b close  ",
      );
      output.push(
        styledLine(
          `${hint}${this.theme.fg("muted", scrollPosition)}`,
          safeWidth,
        ),
      );
    }
    return output.slice(0, height);
  }

  handleInput(data: string): void {
    if (
      data === "q" ||
      data === "b" ||
      this.matches(data, "tui.select.cancel") ||
      this.matches(data, "tui.editor.cursorLeft") ||
      defaultKeyMatches(data, "tui.select.cancel") ||
      defaultKeyMatches(data, "tui.editor.cursorLeft")
    ) {
      this.onClose();
      return;
    }

    if (
      data === "k" ||
      this.matches(data, "tui.select.up") ||
      defaultKeyMatches(data, "tui.select.up")
    ) {
      this.selectHistory(this.selectedIndex - 1);
      return;
    }
    if (
      data === "j" ||
      this.matches(data, "tui.select.down") ||
      defaultKeyMatches(data, "tui.select.down")
    ) {
      this.selectHistory(this.selectedIndex + 1);
      return;
    }

    const page = Math.max(1, this.lastViewport - 1);
    if (
      this.matches(data, "tui.select.pageUp") ||
      defaultKeyMatches(data, "tui.select.pageUp")
    ) {
      this.offset = Math.max(0, this.offset - page);
    } else if (
      this.matches(data, "tui.select.pageDown") ||
      defaultKeyMatches(data, "tui.select.pageDown")
    ) {
      this.offset = Math.min(this.lastMaxOffset, this.offset + page);
    } else if (
      this.matches(data, "tui.editor.cursorLineStart") ||
      defaultKeyMatches(data, "tui.editor.cursorLineStart")
    ) {
      this.offset = 0;
    } else if (
      this.matches(data, "tui.editor.cursorLineEnd") ||
      defaultKeyMatches(data, "tui.editor.cursorLineEnd")
    ) {
      this.offset = this.lastMaxOffset;
    } else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  getSelectedId(): string | undefined {
    return this.histories[this.selectedIndex]?.id;
  }

  getOffset(): number {
    return this.offset;
  }

  private selectHistory(index: number): void {
    const next = Math.max(0, Math.min(this.histories.length - 1, index));
    if (next === this.selectedIndex || this.histories.length === 0) return;
    this.selectedIndex = next;
    this.offset = 0;
    this.lastMaxOffset = 0;
    this.tui.requestRender();
  }

  private matches(data: string, keybinding: string): boolean {
    try {
      return this.keybindings.matches(data, keybinding);
    } catch {
      return false;
    }
  }
}
