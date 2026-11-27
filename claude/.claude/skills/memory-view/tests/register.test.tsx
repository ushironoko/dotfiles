import { expect, test } from "claude-code/testing";
import type { On } from "claude-code";

const DIR = "/home/me/.claude/projects/-work-app/memory";
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

const PANE = {
  plugin: "memory-view",
  component: "Pane",
  requestId: "memory-view",
  surface: "terminal",
  props: {
    title: "Memories",
    isFocused: true,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const;

const seed = (): Map<string, { text: string; mtimeMs: number }> =>
  new Map([
    [
      `${DIR}/MEMORY.md`,
      {
        text: "# Memory Index\n\n- [Tabs](feedback_tabs.md) — use tabs\n- [Deploy](project_deploy.md) — friday freeze\n",
        mtimeMs: NOW - 60_000,
      },
    ],
    [
      `${DIR}/feedback_tabs.md`,
      {
        text: "---\nname: feedback-tabs\ndescription: Indent with tabs\nmetadata:\n  type: feedback\n---\n\nAlways indent with tabs.\n",
        mtimeMs: NOW - 2 * 3_600_000,
      },
    ],
    [
      `${DIR}/project_deploy.md`,
      {
        text: "---\nname: project-deploy\ndescription: No deploys on Friday\ntype: project\n---\n\nFreeze deploys on Fridays.\n",
        mtimeMs: NOW - 3 * 86_400_000,
      },
    ],
  ]);

const engine = (
  on: On,
  files: Map<string, { text: string; mtimeMs: number }>,
) => {
  on("session.start", (_, e) => ({ cwd: e.cwd }));
  on("clock.now", () => ({ value: NOW }));
  on("clock.after", (_, e) =>
    e.ms > 1000
      ? { deny: "long timers stay asleep in tests" }
      : { value: undefined },
  );
  on("session.info", () => ({
    value: { transcriptPath: "/home/me/.claude/projects/-work-app/s.jsonl" },
  }));
  on("command.register", () => ({ value: { command: "memories" } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.close", () => ({ value: undefined }));
  on("ui.focus", { plugin: "*" }, () => ({}));
  on("fs.list", (_, e) => ({
    value: [...files.entries()]
      .filter(([path]) => path.startsWith(`${e.path}/`))
      .map(([path, file]) => ({
        name: path.slice(e.path.length + 1),
        kind: "file" as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
  }));
  on("fs.read", (_, e) => {
    const file = files.get(e.path);

    return file === undefined
      ? { deny: `read ${e.path} failed: ENOENT` }
      : { value: file.text.slice(0, e.length ?? file.text.length) };
  });
  on("fs.write", (_, e) => {
    files.set(e.path, { text: e.text, mtimeMs: NOW });

    return { value: undefined };
  });
  on("process.run", (_, e) => {
    const path = e.argv.at(-1) ?? "";

    files.delete(path);

    return {
      value: {
        exitCode: 0,
        stdout: "",
        stderr: "",
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    };
  });
};

const RUN = {
  command: "memories",
  args: "",
  origin: { kind: "composer" },
  presentation: { isFullscreen: true, columns: 200 },
} as const;

const ringMove = (element: string) =>
  ({
    component: "Pane",
    requestId: "memory-view",
    plugin: "memory-view",
    element,
    origin: { kind: "person" },
  }) as const;

test("lists memories, opens one, edits it and saves", async ($, on) => {
  const files = seed();

  engine(on, files);
  await $.session.start({
    cwd: "/work/app",
    surface: "terminal",
    isInteractive: true,
  });
  await $.command.run(RUN);

  const ui = await $.ui.mount(PANE);

  expect(
    await ui.find({ key: "open:MEMORY.md" }).then((found) => found?.text),
  ).toContain("MEMORY.md");
  expect(
    await ui
      .find({ key: "open:feedback_tabs.md" })
      .then((found) => found?.text),
  ).toContain("feedback-tabs");
  expect(
    await ui
      .find({ type: "Text", text: /Indent with tabs/ })
      .then((found) => found?.text),
  ).toContain("feedback");

  await ui.press({ key: "open:feedback_tabs.md" });
  expect(await ui.find({ key: "back" }).then((found) => found?.text)).toContain(
    "back",
  );
  expect(
    await ui.find({ type: "Markdown" }).then((found) => found?.text),
  ).toContain("Always indent with tabs.");

  await ui.press({ key: "edit" });
  const edited = "---\nname: feedback-tabs\n---\n\nNever indent with spaces.\n";

  await ui.input({ key: "editor", text: edited, kind: "change" });
  await ui.input({ key: "editor", text: edited });
  expect(files.get(`${DIR}/feedback_tabs.md`)?.text).toBe(edited);
  await ui.unmount();
});

test("x deletes the focused memory and its index pointer; u restores both", async ($, on) => {
  const files = seed();
  const index = files.get(`${DIR}/MEMORY.md`)?.text;

  engine(on, files);
  await $.session.start({
    cwd: "/work/app",
    surface: "terminal",
    isInteractive: true,
  });
  await $.command.run(RUN);

  const ui = await $.ui.mount(PANE);

  await $.ui.focus(ringMove("open:project_deploy.md"));
  await ui.press({ key: "delete" });

  expect(files.has(`${DIR}/project_deploy.md`)).toBe(false);
  expect(files.get(`${DIR}/MEMORY.md`)?.text).not.toContain(
    "project_deploy.md",
  );
  expect(await ui.find({ key: "open:project_deploy.md" })).toBeUndefined();

  await ui.press({ key: "undo" });
  expect(files.has(`${DIR}/project_deploy.md`)).toBe(true);
  expect(files.get(`${DIR}/MEMORY.md`)?.text).toBe(index);
  await ui.unmount();
});

test("x on the index or with no row focused deletes nothing", async ($, on) => {
  const files = seed();

  engine(on, files);
  await $.session.start({
    cwd: "/work/app",
    surface: "terminal",
    isInteractive: true,
  });
  await $.command.run(RUN);

  const ui = await $.ui.mount(PANE);

  await ui.press({ key: "delete" });
  expect(files.size).toBe(3);

  await $.ui.focus(ringMove("open:MEMORY.md"));
  await ui.press({ key: "delete" });
  expect(files.size).toBe(3);
  expect(
    await ui
      .find({ type: "Text", text: /is the index/ })
      .then((found) => found?.text),
  ).toBeDefined();
  await ui.unmount();
});

test("Tab away from the editor saves and leaves it", async ($, on) => {
  const files = seed();

  engine(on, files);
  await $.session.start({
    cwd: "/work/app",
    surface: "terminal",
    isInteractive: true,
  });
  await $.command.run(RUN);

  const ui = await $.ui.mount(PANE);

  await ui.press({ key: "open:project_deploy.md" });
  await ui.press({ key: "edit" });
  await ui.input({ key: "editor", text: "tabbed", kind: "change" });
  await $.ui.focus(ringMove("back"));

  expect(files.get(`${DIR}/project_deploy.md`)?.text).toBe("tabbed");
  expect(await ui.find({ key: "editor" })).toBeUndefined();
  await ui.unmount();
});
