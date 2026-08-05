import {
  Container,
  CURSOR_MARKER,
  KeybindingsManager,
  setKeybindings,
  TUI,
  TUI_KEYBINDINGS,
  type Component,
  type Terminal,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "bun:test";

const SEGMENT_RESET = "\u001b[0m\u001b]8;;\u0007";

class FakeTerminal implements Terminal {
  columns = 20;
  rows = 6;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  input?: (data: string) => void;
  resize?: () => void;

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.input = onInput;
    this.resize = onResize;
  }

  stop(): void {}

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.writes.push(data);
  }

  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

class MutableLines implements Component {
  constructor(public lines: string[]) {}

  render(): string[] {
    return [...this.lines];
  }

  invalidate(): void {}
}

class WrappedLines implements Component {
  constructor(private readonly paragraphs: string[]) {}

  render(width: number): string[] {
    const chunkWidth = Math.max(1, width);
    return this.paragraphs.flatMap((paragraph) => {
      const lines: string[] = [];
      for (let index = 0; index < paragraph.length; index += chunkWidth) {
        lines.push(paragraph.slice(index, index + chunkWidth));
      }
      return lines;
    });
  }

  invalidate(): void {}
}

class TestTui extends TUI {
  renderFrame(): string[] {
    this.doRender();
    return this.previousLines.map((line) => line.replaceAll(SEGMENT_RESET, ""));
  }

  sendInput(data: string): void {
    this.handleInput(data);
  }

  get observedHardwareCursorRow(): number {
    return this.hardwareCursorRow;
  }
}

const renderLines = (tui: TestTui): string[] => tui.renderFrame();

const numberedLines = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `line-${index + 1}`);

afterEach(() => {
  setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
});

describe("pi-tui fixed bottom viewport", () => {
  test("keeps the original scrollback rendering when no bottom is fixed", () => {
    const tui = new TestTui(new FakeTerminal());
    tui.addChild(new MutableLines(numberedLines(10)));

    expect(renderLines(tui)).toEqual(numberedLines(10));
  });

  test("pins the editor/footer and pages conversation history with keys and wheel", () => {
    const terminal = new FakeTerminal();
    const tui = new TestTui(terminal);
    const editor = new MutableLines(["EDITOR"]);
    const bottom = new Container();
    bottom.addChild(editor);
    bottom.addChild(new MutableLines(["FOOTER"]));
    tui.addChild(new MutableLines(numberedLines(10)));
    tui.setFixedBottom(bottom, editor);
    tui.setFocus(editor);

    expect(renderLines(tui)).toEqual([
      "line-7",
      "line-8",
      "line-9",
      "line-10",
      "EDITOR",
      "FOOTER",
    ]);
    expect(terminal.writes.join("")).not.toContain("\u001b[3J");

    tui.sendInput("\u001b[5~");
    expect(tui.getViewportOffset()).toBe(4);
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-3",
      "line-4",
      "line-5",
      "line-6",
    ]);

    tui.sendInput("\u001b[57421;1:3u");
    expect(tui.getViewportOffset()).toBe(4);

    tui.sendInput("\u001b[<65;10;3M");
    expect(tui.getViewportOffset()).toBe(1);
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-6",
      "line-7",
      "line-8",
      "line-9",
    ]);

    tui.sendInput("\u001b[<64;10;3M");
    expect(tui.getViewportOffset()).toBe(4);
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-3",
      "line-4",
      "line-5",
      "line-6",
    ]);

    tui.sendInput("\u001b[6~");
    expect(tui.getViewportOffset()).toBe(0);
    expect(renderLines(tui).slice(-2)).toEqual(["EDITOR", "FOOTER"]);
  });

  test("uses configured editor paging keys and respects disabled actions", () => {
    setKeybindings(
      new KeybindingsManager(TUI_KEYBINDINGS, {
        "tui.editor.pageUp": "ctrl+u",
        "tui.editor.pageDown": [],
      }),
    );
    const tui = new TestTui(new FakeTerminal());
    let received = "";
    const editor: Component = {
      render: () => ["EDITOR"],
      invalidate: () => {},
      handleInput: (data) => {
        received = data;
      },
    };
    const bottom = new Container();
    bottom.addChild(editor);
    bottom.addChild(new MutableLines(["FOOTER"]));
    tui.addChild(new MutableLines(numberedLines(10)));
    tui.setFixedBottom(bottom, editor);
    tui.setFocus(editor);
    renderLines(tui);

    tui.sendInput("\u001b[5~");
    expect(received).toBe("\u001b[5~");
    expect(tui.getViewportOffset()).toBe(0);

    received = "";
    tui.sendInput("\u0015");
    expect(received).toBe("");
    expect(tui.getViewportOffset()).toBe(4);

    tui.sendInput("\u001b[6~");
    expect(received).toBe("\u001b[6~");
    expect(tui.getViewportOffset()).toBe(4);
  });

  test("forwards paging keys when history cannot move in that direction", () => {
    const tui = new TestTui(new FakeTerminal());
    const received: string[] = [];
    const editor: Component = {
      render: () => ["EDITOR"],
      invalidate: () => {},
      handleInput: (data) => {
        received.push(data);
      },
    };
    const bottom = new Container();
    bottom.addChild(editor);
    bottom.addChild(new MutableLines(["FOOTER"]));
    tui.addChild(new MutableLines(numberedLines(10)));
    tui.setFixedBottom(bottom, editor);
    tui.setFocus(editor);
    renderLines(tui);

    tui.sendInput("\u001b[6~");
    expect(received).toEqual(["\u001b[6~"]);

    tui.sendInput("\u001b[5~");
    tui.sendInput("\u001b[5~");
    expect(tui.getViewportOffset()).toBe(6);
    expect(received).toEqual(["\u001b[6~"]);

    tui.sendInput("\u001b[5~");
    expect(received).toEqual(["\u001b[6~", "\u001b[5~"]);

    tui.sendInput("\u001b[6~");
    tui.sendInput("\u001b[6~");
    expect(tui.getViewportOffset()).toBe(0);
    tui.sendInput("\u001b[6~");
    expect(received).toEqual([
      "\u001b[6~",
      "\u001b[5~",
      "\u001b[6~",
    ]);
  });

  test("forwards paging keys when no history page is available", () => {
    const terminal = new FakeTerminal();
    terminal.rows = 2;
    const tui = new TestTui(terminal);
    const received: string[] = [];
    const editor: Component = {
      render: () => ["EDITOR-1", "EDITOR-2", "EDITOR-3"],
      invalidate: () => {},
      handleInput: (data) => {
        received.push(data);
      },
    };
    tui.addChild(new MutableLines(numberedLines(10)));
    tui.setFixedBottom(editor, editor);
    tui.setFocus(editor);
    renderLines(tui);

    tui.sendInput("\u001b[5~");
    tui.sendInput("\u001b[6~");

    expect(tui.getViewportOffset()).toBe(0);
    expect(received).toEqual(["\u001b[5~", "\u001b[6~"]);

    const fittingTui = new TestTui(new FakeTerminal());
    const fittingReceived: string[] = [];
    const fittingEditor: Component = {
      render: () => ["EDITOR"],
      invalidate: () => {},
      handleInput: (data) => {
        fittingReceived.push(data);
      },
    };
    fittingTui.addChild(new MutableLines(numberedLines(2)));
    fittingTui.setFixedBottom(fittingEditor, fittingEditor);
    fittingTui.setFocus(fittingEditor);
    renderLines(fittingTui);
    fittingTui.sendInput("\u001b[5~");
    fittingTui.sendInput("\u001b[6~");

    expect(fittingReceived).toEqual(["\u001b[5~", "\u001b[6~"]);
  });

  test("preserves a scrolled history anchor during streaming and follows on demand", () => {
    const terminal = new FakeTerminal();
    const history = new MutableLines(numberedLines(10));
    const bottom = new MutableLines(["EDITOR", "FOOTER"]);
    const tui = new TestTui(terminal);
    tui.addChild(history);
    tui.setFixedBottom(bottom);
    renderLines(tui);

    tui.scrollViewport(4);
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-3",
      "line-4",
      "line-5",
      "line-6",
    ]);

    history.lines.push("line-11", "line-12");
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-3",
      "line-4",
      "line-5",
      "line-6",
    ]);

    history.lines.pop();
    history.lines.pop();
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-3",
      "line-4",
      "line-5",
      "line-6",
    ]);
    history.lines.push("line-11", "line-12");
    renderLines(tui);

    tui.followViewport();
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-9",
      "line-10",
      "line-11",
      "line-12",
    ]);

    terminal.rows = 8;
    expect(renderLines(tui)).toEqual([
      "line-7",
      "line-8",
      "line-9",
      "line-10",
      "line-11",
      "line-12",
      "EDITOR",
      "FOOTER",
    ]);

    bottom.lines = ["EDITOR-1", "EDITOR-2", "EDITOR-3", "FOOTER"];
    expect(renderLines(tui)).toEqual([
      "line-9",
      "line-10",
      "line-11",
      "line-12",
      "EDITOR-1",
      "EDITOR-2",
      "EDITOR-3",
      "FOOTER",
    ]);
  });

  test("keeps the same history anchor when the available page height changes", () => {
    const terminal = new FakeTerminal();
    const history = new MutableLines(numberedLines(12));
    const bottom = new MutableLines(["EDITOR", "FOOTER"]);
    const tui = new TestTui(terminal);
    tui.addChild(history);
    tui.setFixedBottom(bottom);
    renderLines(tui);
    tui.scrollViewport(4);

    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-5",
      "line-6",
      "line-7",
      "line-8",
    ]);

    terminal.rows = 8;
    expect(renderLines(tui).slice(0, 6)).toEqual([
      "line-5",
      "line-6",
      "line-7",
      "line-8",
      "line-9",
      "line-10",
    ]);

    bottom.lines = ["EDITOR-1", "EDITOR-2", "EDITOR-3", "FOOTER"];
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "line-5",
      "line-6",
      "line-7",
      "line-8",
    ]);
  });

  test("keeps the same history anchor when width changes rewrap content", () => {
    const terminal = new FakeTerminal();
    const tui = new TestTui(terminal);
    const paragraphs = Array.from(
      { length: 10 },
      (_, index) => `message-${String(index + 1).padStart(2, "0")}`,
    );
    tui.addChild(new WrappedLines(paragraphs));
    tui.setFixedBottom(new MutableLines(["EDITOR", "FOOTER"]));
    renderLines(tui);
    tui.scrollViewport(4);

    expect(renderLines(tui).slice(0, 4)).toEqual([
      "message-03",
      "message-04",
      "message-05",
      "message-06",
    ]);

    terminal.columns = 5;
    expect(renderLines(tui).slice(0, 4)).toEqual([
      "messa",
      "ge-03",
      "messa",
      "ge-04",
    ]);
  });

  test("keeps overlays and embedded selectors in control of paging input", () => {
    const terminal = new FakeTerminal();
    const tui = new TestTui(terminal);
    const editor = new MutableLines(["EDITOR"]);
    const bottom = new Container();
    bottom.addChild(editor);
    bottom.addChild(new MutableLines(["FOOTER"]));
    tui.addChild(new MutableLines(numberedLines(10)));
    tui.setFixedBottom(bottom, editor);
    tui.setFocus(editor);
    renderLines(tui);
    tui.scrollViewport(2);

    let received = "";
    const overlay: Component & { focused: boolean } = {
      focused: false,
      render: () => ["OVERLAY"],
      invalidate: () => {},
      handleInput: (data) => {
        received = data;
      },
    };
    const handle = tui.showOverlay(overlay);
    tui.sendInput("\u001b[5~");

    expect(received).toBe("\u001b[5~");
    expect(tui.getViewportOffset()).toBe(2);
    handle.hide();

    received = "";
    const selector: Component = {
      render: () => ["SELECTOR"],
      invalidate: () => {},
      handleInput: (data) => {
        received = data;
      },
    };
    bottom.clear();
    bottom.addChild(selector);
    tui.setFocus(selector);
    tui.sendInput("\u001b[5~");

    expect(received).toBe("\u001b[5~");
    expect(tui.getViewportOffset()).toBe(2);
  });

  test("retargets paging when an extension installs a custom editor", () => {
    const terminal = new FakeTerminal();
    const tui = new TestTui(terminal);
    const defaultEditor = new MutableLines(["DEFAULT EDITOR"]);
    const customEditor = new MutableLines(["CUSTOM EDITOR"]);
    const bottom = new Container();
    bottom.addChild(defaultEditor);
    bottom.addChild(new MutableLines(["FOOTER"]));
    tui.addChild(new MutableLines(numberedLines(10)));
    tui.setFixedBottom(bottom, defaultEditor);
    tui.setFocus(defaultEditor);
    renderLines(tui);

    bottom.clear();
    bottom.addChild(customEditor);
    bottom.addChild(new MutableLines(["FOOTER"]));
    tui.setViewportPagingFocus(customEditor);
    tui.setFocus(customEditor);
    tui.sendInput("\u001b[5~");

    expect(tui.getViewportOffset()).toBe(4);
    expect(renderLines(tui).slice(-2)).toEqual(["CUSTOM EDITOR", "FOOTER"]);
  });

  test("clips optional fixed rows before removing the focused editor", () => {
    const terminal = new FakeTerminal();
    terminal.rows = 3;
    const tui = new TestTui(terminal, true);
    tui.setFixedBottom(
      new MutableLines([
        "WIDGET ABOVE 1",
        "WIDGET ABOVE 2",
        `EDIT${CURSOR_MARKER}OR`,
        "WIDGET BELOW 1",
        "WIDGET BELOW 2",
        "FOOTER",
      ]),
    );

    expect(renderLines(tui)).toEqual(["EDITOR", "WIDGET BELOW 2", "FOOTER"]);
    expect(tui.observedHardwareCursorRow).toBe(0);

    terminal.rows = 0;
    expect(renderLines(tui)).toEqual([]);
  });

  test("suppresses a Kitty image split by the conversation boundary", () => {
    const tui = new TestTui(new FakeTerminal());
    const image = "\u001b_Gi=42,r=3;AAAA\u001b\\";
    tui.addChild(
      new MutableLines(["a", "b", "c", "d", image, "", "", "h", "i", "j"]),
    );
    tui.setFixedBottom(new MutableLines(["EDITOR", "FOOTER"]));
    renderLines(tui);
    tui.scrollViewport(4);

    const frame = renderLines(tui);
    expect(frame).toEqual(["c", "d", "", "", "EDITOR", "FOOTER"]);
    expect(frame.join("")).not.toContain("\u001b_G");
  });

  test("enables mouse tracking and keeps the hardware cursor in the fixed editor", () => {
    const terminal = new FakeTerminal();
    const tui = new TestTui(terminal, true);
    tui.addChild(new MutableLines(numberedLines(10)));
    tui.setFixedBottom(new MutableLines([`EDIT${CURSOR_MARKER}OR`, "FOOTER"]));

    expect(renderLines(tui).slice(-2)).toEqual(["EDITOR", "FOOTER"]);
    expect(tui.observedHardwareCursorRow).toBe(4);

    tui.start();
    tui.stop();
    expect(terminal.writes.join("")).toContain("\u001b[?1000h\u001b[?1006h");
    expect(terminal.writes.join("")).toContain("\u001b[?1006l\u001b[?1000l");
  });
});
