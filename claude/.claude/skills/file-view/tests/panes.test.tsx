import { expect, test } from "claude-code/testing";

const TOOL = "mcp__file-view__open_file";

const paneOf = (requestId: string) =>
  ({
    plugin: "file-view",
    component: "Pane",
    requestId,
    surface: "terminal",
    props: {
      title: requestId,
      isFocused: false,
      bodyColumns: 60,
      placement: "dock",
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const;

test("each file opens in a pane of its own and reopening one reuses it", async ($, on) => {
  const opened: string[] = [];

  on("tool.register", () => ({ value: { tool: TOOL } }));
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("session.root", () => ({ value: "/repo" }));
  on("fs.stat", () => ({
    value: { kind: "file", size: 1, mtimeMs: 0, isLink: false },
  }));
  on("fs.read", (_, e) => ({ value: `source of ${e.path}` }));
  on("ui.open", (_, e) => {
    opened.push(e.id);

    return { value: { isPlaced: true } };
  });

  await $.session.start({
    cwd: "/repo",
    surface: "terminal",
    isInteractive: true,
  });
  await $.tool.call({ tool: TOOL, path: "a.ts" });
  await $.tool.call({ tool: TOOL, path: "b.ts" });
  await $.tool.call({ tool: TOOL, path: "/repo/a.ts" });

  expect(opened).toEqual(["file-view", "file-view-2", "file-view"]);

  const first = await $.ui.mount(paneOf("file-view"));
  const second = await $.ui.mount(paneOf("file-view-2"));

  const firstTitle = await first.find({ type: "Text", text: /\/repo\/a\.ts/ });
  const secondTitle = await second.find({
    type: "Text",
    text: /\/repo\/b\.ts/,
  });

  expect(firstTitle?.text).toBe("/repo/a.ts");
  expect(secondTitle?.text).toBe("/repo/b.ts");
  await first.unmount();
  await second.unmount();
});
