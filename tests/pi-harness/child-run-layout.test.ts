import { describe, expect, test } from "bun:test";
import {
  Editor,
  Spacer,
  Text,
  TUI,
  type EditorTheme,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  BitIssueRegistry,
  type BitIssueDataSource,
} from "../../pi/extensions/pi-harness/features/bit-issues/registry";
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

const createLayout = async (
  rows: number,
  columns: number,
  includeIssues: boolean = false,
) => {
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

  const issueSource: BitIssueDataSource = {
    listOpen: async () => ({
      issues: Array.from({ length: 30 }, (_, index) => ({
        id: `issue-${index}`,
        title: `inspect issue ${index}`,
        state: "open" as const,
        author: "Pi Tester",
        createdAt: 1,
        updatedAt: 100 - index,
        labels: [],
      })),
      truncated: false,
    }),
    getDetail: async (_cwd, id) => ({
      issue: {
        id,
        title: id,
        state: "open",
        author: "Pi Tester",
        createdAt: 1,
        updatedAt: 1,
        labels: [],
        body: "body",
      },
      comments: { status: "none" },
    }),
  };
  const issues = includeIssues
    ? new BitIssueRegistry({ cli: issueSource })
    : undefined;
  if (issues !== undefined) {
    issues.beginSession("/repo");
    await issues.refresh("/repo");
  }

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
    () => {},
    issues === undefined
      ? undefined
      : { registry: issues, onInspect: () => {}, onRefresh: () => {} },
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
    test(`keeps the editor visible in a ${rows}-row terminal`, async () => {
      const { editorLines, browserLines, viewport } = await createLayout(
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

  test("keeps the same total budget when child and issue sections coexist", async () => {
    for (const [rows, columns, expectedPanelHeight] of [
      [24, 80, 6],
      [40, 120, 10],
    ] as const) {
      const { editorLines, browserLines, viewport } = await createLayout(
        rows,
        columns,
        true,
      );
      expect(browserLines).toHaveLength(expectedPanelHeight);
      expect(browserLines[0]).toContain("Open bit issues: 30");
      for (const editorLine of new Set(editorLines)) {
        expect(countLine(viewport, editorLine)).toBeGreaterThanOrEqual(
          countLine(editorLines, editorLine),
        );
      }
    }
  });
});
