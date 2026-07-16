import { describe, expect, test } from "bun:test";
import {
  Editor,
  Spacer,
  Text,
  TUI,
  type EditorTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import { ChildRunRegistry } from "../../pi/extensions/pi-harness/features/child-runs/registry";
import { ChildRunsBrowserComponent } from "../../pi/extensions/pi-harness/features/child-runs/ui";

type BrowserTui = ConstructorParameters<typeof ChildRunsBrowserComponent>[1];

const identity = (text: string): string => text;

const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

const createTerminal = (columns: number, rows: number): Terminal => ({
  start() {},
  stop() {},
  drainInput: async () => {},
  write() {},
  columns,
  rows,
  kittyProtocolActive: false,
  moveBy() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
});

const createLayout = (rows: number, columns: number) => {
  let id = 0;
  const registry = new ChildRunRegistry({
    idFactory: () => `layout-${++id}`,
    now: () => 100,
  });
  registry.beginInvocation({
    toolCallId: "layout-parent",
    source: "workflow",
    label: "workflow",
    runs: Array.from({ length: 30 }, (_, taskIndex) => ({
      agent: `agent-${taskIndex}`,
      task: `inspect task ${taskIndex}`,
      taskIndex,
      stageIndex: 0,
    })),
  });

  const terminal = createTerminal(columns, rows);
  const tui = new TUI(terminal);
  const chat = new Text(
    Array.from(
      { length: 30 },
      (_, index) => `chat-${String(index).padStart(2, "0")}`,
    ).join("\n"),
    0,
    0,
  );
  const status = new Text("working status", 0, 0);
  const editor = new Editor(tui, editorTheme, { paddingX: 0 });
  editor.setText("draft-1\ndraft-2\ndraft-3\ndraft-4\ndraft-5");
  const browser = new ChildRunsBrowserComponent(
    registry,
    tui as unknown as BrowserTui,
    { matches: () => false },
    () => {},
    () => {},
  );
  const footer = new Text("footer-main\nfooter-detail", 0, 0);

  // Match interactive-mode's vertical order around the editor: status,
  // empty aboveEditor spacer, editor, belowEditor widget, then footer.
  tui.addChild(chat);
  tui.addChild(status);
  tui.addChild(new Spacer(1));
  tui.addChild(editor);
  tui.addChild(browser);
  tui.addChild(footer);

  const editorLines = editor.render(columns);
  const browserLines = browser.render(columns);
  const allLines = tui.render(columns);
  const viewport = allLines.slice(-rows);
  return { editorLines, browserLines, viewport };
};

const countLine = (lines: string[], target: string): number =>
  lines.filter((line) => line === target).length;

describe("child-session browser normal-flow layout", () => {
  for (const [rows, columns, expectedPanelHeight] of [
    [24, 80, 6],
    [40, 120, 10],
  ] as const) {
    test(`keeps the editor visible in a ${rows}-row terminal`, () => {
      const { editorLines, browserLines, viewport } = createLayout(
        rows,
        columns,
      );

      expect(browserLines).toHaveLength(expectedPanelHeight);
      for (const editorLine of new Set(editorLines)) {
        expect(countLine(viewport, editorLine)).toBeGreaterThanOrEqual(
          countLine(editorLines, editorLine),
        );
      }
      expect(viewport.filter((line) => line.startsWith("chat-"))).toHaveLength(
        rows === 24 ? 7 : 19,
      );
      expect(viewport.at(-2)?.trimEnd()).toBe("footer-main");
      expect(viewport.at(-1)?.trimEnd()).toBe("footer-detail");
    });
  }
});
