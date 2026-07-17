import { describe, expect, test } from "bun:test";

import {
  readFocusedComponent,
  setFocusSafely,
} from "../../pi/extensions/pi-harness/features/child-runs/focus-capability";
import { ChildRunRegistry } from "../../pi/extensions/pi-harness/features/child-runs/registry";
import {
  ChildRunDetailComponent,
  ChildRunsBrowserComponent,
} from "../../pi/extensions/pi-harness/features/child-runs/ui";
import { visibleWidth } from "../../pi/extensions/pi-harness/lib/terminal-text";

describe("child-session private focus capability", () => {
  const component = { render: () => ["x"], invalidate() {} };

  test("reads a valid focus target and changes focus through the public setter", () => {
    let focused = component;
    const tui = {
      get focusedComponent() {
        return focused;
      },
      setFocus(next: typeof component | null) {
        if (next !== null) focused = next;
      },
    };

    expect(readFocusedComponent(tui)).toEqual({
      supported: true,
      component,
    });
    expect(setFocusSafely(tui, component)).toEqual({ ok: true });
  });

  test("fails closed for absent, throwing, and changed-shape focus state", () => {
    expect(readFocusedComponent({ setFocus() {} })).toEqual({
      supported: false,
      reason: "TUI focus inspection is unavailable",
    });
    const throwingTui = {
      get focusedComponent(): unknown {
        throw new Error("private API changed");
      },
      setFocus() {},
    };
    expect(readFocusedComponent(throwingTui)).toEqual({
      supported: false,
      reason: "TUI focus inspection failed",
    });
    const changedTui = {
      focusedComponent: "not-a-component",
      setFocus() {},
    };
    expect(readFocusedComponent(changedTui)).toEqual({
      supported: false,
      reason: "TUI focus target has changed shape",
    });
  });

  test("contains a throwing public focus setter", () => {
    expect(
      setFocusSafely(
        {
          setFocus() {
            throw new Error("focus failed");
          },
        },
        component,
      ),
    ).toEqual({ ok: false, reason: "TUI focus change failed" });
  });
});

const setup = (rows = 20) => {
  let id = 0;
  const registry = new ChildRunRegistry({
    idFactory: () => `id-${++id}`,
    now: () => 100,
  });
  const renders: number[] = [];
  const tui = {
    terminal: { rows },
    requestRender: () => renders.push(1),
  };
  const keybindings = {
    matches(data: string, key: string) {
      const values: Record<string, string> = {
        "tui.select.up": "up",
        "tui.select.down": "down",
        "tui.select.pageUp": "pageup",
        "tui.select.pageDown": "pagedown",
        "tui.select.confirm": "enter",
        "tui.select.cancel": "escape",
        "tui.editor.cursorLeft": "left",
        "tui.editor.cursorRight": "right",
        "tui.editor.cursorLineStart": "home",
        "tui.editor.cursorLineEnd": "end",
      };
      return values[key] === data;
    },
  };
  const inspected: string[] = [];
  let unfocused = 0;
  let hidden = 0;
  const component = new ChildRunsBrowserComponent(
    registry,
    tui,
    keybindings,
    (runId) => inspected.push(runId),
    () => unfocused++,
    () => hidden++,
  );
  return {
    registry,
    component,
    tui,
    keybindings,
    renders,
    inspected,
    getUnfocused: () => unfocused,
    getHidden: () => hidden,
  };
};

const addRuns = (registry: ChildRunRegistry, count: number): string[] =>
  registry.beginInvocation({
    toolCallId: `parent-${count}`,
    source: "workflow",
    label: "workflow",
    runs: Array.from({ length: count }, (_, taskIndex) => ({
      agent: `agent-${taskIndex}`,
      task: `inspect task ${taskIndex}`,
      taskIndex,
      stageIndex: 0,
    })),
  }).runIds;

const runAt = (runIds: string[], index: number): string => {
  const runId = runIds[index];
  if (runId === undefined) throw new Error(`run ${index} did not initialize`);
  return runId;
};

const addTranscript = (
  registry: ChildRunRegistry,
  runId: string,
  count: number,
): void => {
  registry.observe(runId, { type: "process_started", at: 1 });
  for (let index = 0; index < count; index++) {
    registry.observe(runId, {
      type: "assistant_final",
      text: `line ${index}`,
      at: index + 2,
    });
  }
};

describe("child-session browser component", () => {
  test("renders an explanatory empty state within width", () => {
    const { component } = setup();
    const lines = component.render(24);
    expect(lines.join("\n")).toContain("No child runs");
    expect(lines.every((item) => visibleWidth(item) <= 24)).toBe(true);
  });

  test("caps populated list height for common and small terminals", () => {
    for (const [rows, expectedHeight] of [
      [24, 6],
      [40, 10],
      [12, 4],
    ] as const) {
      const { registry, component } = setup(rows);
      addRuns(registry, 30);
      const lines = component.render(80);
      expect(lines).toHaveLength(expectedHeight);
      expect(lines.at(-1)).toContain("↑↓ select");
    }
  });

  test("routes raw Enter to the selected run", () => {
    const { registry, component, inspected } = setup();
    const runIds = addRuns(registry, 2);
    component.render(80);
    component.handleInput("down");
    component.handleInput("\r");
    expect(inspected).toEqual([runIds[1]]);
    expect(component.getSelectedRunId()).toBe(runIds[1]);
  });

  test("keeps selection stable by run id while opening its detail viewer", () => {
    const { registry, component, inspected } = setup();
    const started = registry.beginInvocation({
      toolCallId: "parent",
      source: "workflow",
      label: "workflow",
      runs: [
        { agent: "one", task: "first", taskIndex: 0, stageIndex: 0 },
        { agent: "two", task: "second", taskIndex: 1, stageIndex: 0 },
      ],
    });
    component.render(40);
    component.handleInput("down");
    expect(component.getSelectedRunId()).toBe(started.runIds[1]);
    registry.observe(runAt(started.runIds, 0), {
      type: "process_started",
      at: 1,
    });
    expect(component.getSelectedRunId()).toBe(started.runIds[1]);
    component.handleInput("enter");
    expect(inspected).toEqual([started.runIds[1]]);
    expect(component.getSelectedRunId()).toBe(started.runIds[1]);
  });

  test("Escape unfocuses and q hides without changing run state", () => {
    const { registry, component, getUnfocused, getHidden } = setup();
    const { runIds } = registry.beginInvocation({
      toolCallId: "parent",
      source: "subagent",
      mode: "single",
      label: "subagent",
      runs: [{ agent: "worker", task: "inspect", taskIndex: 0 }],
    });
    component.handleInput("escape");
    component.handleInput("q");
    expect(getUnfocused()).toBe(1);
    expect(getHidden()).toBe(1);
    expect(registry.getRunStatus(runAt(runIds, 0))).toBe("queued");
  });
});

describe("child-session detail component", () => {
  test("uses the near-full terminal height and starts completed output at the top", () => {
    const { registry, tui, keybindings } = setup(24);
    const [runId] = addRuns(registry, 1);
    if (runId === undefined) throw new Error("run did not initialize");
    addTranscript(registry, runId, 30);
    registry.finishRun(runId, {
      status: "succeeded",
      reason: "completed",
      endedAt: 100,
    });
    const detail = new ChildRunDetailComponent(
      registry,
      runId,
      tui,
      keybindings,
      () => {},
    );

    const lines = detail.render(80);
    expect(lines).toHaveLength(22);
    expect(lines[0]).toContain("Child session");
    expect(lines[1]).toContain("agent-0");
    expect(lines.at(-1)).toContain("Home/End");
  });

  test("keeps automatic follow when a queued run starts producing output", () => {
    const { registry, tui, keybindings } = setup(12);
    const [runId] = addRuns(registry, 1);
    if (runId === undefined) throw new Error("run did not initialize");
    const detail = new ChildRunDetailComponent(
      registry,
      runId,
      tui,
      keybindings,
      () => {},
    );
    detail.render(80);

    addTranscript(registry, runId, 20);
    const lines = detail.render(80);
    expect(detail.isFollowing()).toBe(true);
    expect(detail.getOffset()).toBeGreaterThan(0);
    expect(lines[0]).toContain("LIVE");
  });

  test("keeps the last transcript line reachable on tiny terminals", () => {
    for (const [rows, expectedHeight] of [
      [4, 2],
      [3, 1],
    ] as const) {
      const { registry, tui, keybindings } = setup(rows);
      const [runId] = addRuns(registry, 1);
      if (runId === undefined) throw new Error("run did not initialize");
      addTranscript(registry, runId, 6);
      registry.finishRun(runId, {
        status: "succeeded",
        reason: "completed",
        endedAt: 100,
      });
      const detail = new ChildRunDetailComponent(
        registry,
        runId,
        tui,
        keybindings,
        () => {},
      );
      detail.render(40);
      detail.handleInput("end");

      const lines = detail.render(40);
      expect(lines).toHaveLength(expectedHeight);
      expect(lines.join("\n")).toContain("line 5");
    }
  });

  test("scrolls one fixed transcript without moving the resident list selection", () => {
    const { registry, component, tui, keybindings, inspected } = setup(12);
    const runIds = addRuns(registry, 2);
    const runId = runAt(runIds, 1);
    addTranscript(registry, runId, 30);
    registry.finishRun(runId, {
      status: "succeeded",
      reason: "completed",
      endedAt: 100,
    });
    component.render(80);
    component.handleInput("down");
    component.handleInput("enter");
    const detail = new ChildRunDetailComponent(
      registry,
      runAt(inspected, 0),
      tui,
      keybindings,
      () => {},
    );
    detail.render(80);

    detail.handleInput("down");
    detail.handleInput("pagedown");
    expect(detail.getOffset()).toBeGreaterThan(0);
    expect(component.getSelectedRunId()).toBe(runId);

    detail.handleInput("home");
    expect(detail.getOffset()).toBe(0);
    detail.handleInput("end");
    expect(detail.isFollowing()).toBe(true);
    expect(component.getSelectedRunId()).toBe(runId);
  });

  test("sanitizes and width-bounds assistant transcript rendering", () => {
    const { registry, tui, keybindings } = setup();
    const { runIds } = registry.beginInvocation({
      toolCallId: "parent",
      source: "subagent",
      mode: "single",
      label: "subagent",
      runs: [
        {
          agent: "worker\u001b]2;spoof\u0007",
          task: "inspect 界😀",
          taskIndex: 0,
        },
      ],
    });
    const runId = runAt(runIds, 0);
    registry.observe(runId, { type: "process_started", at: 1 });
    registry.observe(runId, {
      type: "assistant_final",
      text: "answer\u001b[31m red\u001b[0m 界😀".repeat(10),
      at: 2,
    });
    registry.finishRun(runId, {
      status: "succeeded",
      reason: "completed",
      endedAt: 3,
    });
    const detail = new ChildRunDetailComponent(
      registry,
      runId,
      tui,
      keybindings,
      () => {},
    );

    const lines = detail.render(28);
    expect(lines.join("\n")).toContain("answer red");
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.every((item) => visibleWidth(item) <= 28)).toBe(true);
  });

  test("pauses live follow on upward scroll and resumes with End", () => {
    const { registry, tui, keybindings } = setup();
    const { runIds } = registry.beginInvocation({
      toolCallId: "parent",
      source: "subagent",
      mode: "single",
      label: "subagent",
      runs: [{ agent: "worker", task: "inspect", taskIndex: 0 }],
    });
    const runId = runAt(runIds, 0);
    addTranscript(registry, runId, 30);
    const detail = new ChildRunDetailComponent(
      registry,
      runId,
      tui,
      keybindings,
      () => {},
    );
    detail.render(40);

    detail.handleInput("up");
    expect(detail.render(40)[0]).toContain("PAUSED");
    detail.handleInput("end");
    expect(detail.render(40)[0]).toContain("LIVE");
  });

  test("Escape, Left, and b close the detail viewer", () => {
    const { registry, tui, keybindings } = setup();
    const [runId] = addRuns(registry, 1);
    if (runId === undefined) throw new Error("run did not initialize");
    let closes = 0;
    const detail = new ChildRunDetailComponent(
      registry,
      runId,
      tui,
      keybindings,
      () => closes++,
    );

    detail.handleInput("escape");
    detail.handleInput("left");
    detail.handleInput("b");
    expect(closes).toBe(3);
  });
});
