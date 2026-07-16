import { describe, expect, test } from "bun:test";

import { ChildRunRegistry } from "../../pi/extensions/pi-harness/features/child-runs/registry";
import { ChildRunsBrowserComponent } from "../../pi/extensions/pi-harness/features/child-runs/ui";
import { visibleWidth } from "../../pi/extensions/pi-harness/lib/terminal-text";

const setup = () => {
  let id = 0;
  const registry = new ChildRunRegistry({
    idFactory: () => `id-${++id}`,
    now: () => 100,
  });
  const renders: number[] = [];
  const tui = {
    terminal: { rows: 20 },
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
        "tui.editor.cursorLineEnd": "end",
      };
      return values[key] === data;
    },
  };
  let unfocused = 0;
  let hidden = 0;
  const component = new ChildRunsBrowserComponent(
    registry,
    tui,
    keybindings,
    () => unfocused++,
    () => hidden++,
  );
  return {
    registry,
    component,
    renders,
    getUnfocused: () => unfocused,
    getHidden: () => hidden,
  };
};

describe("child-session browser component", () => {
  test("renders an explanatory empty state within width", () => {
    const { component } = setup();
    const lines = component.render(24);
    expect(lines.join("\n")).toContain("No child runs");
    expect(lines.every((item) => visibleWidth(item) <= 24)).toBe(true);
  });

  test("keeps selection stable by run id and opens the selected detail", () => {
    const { registry, component } = setup();
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
    registry.observe(started.runIds[0]!, { type: "process_started", at: 1 });
    expect(component.getSelectedRunId()).toBe(started.runIds[1]);
    component.handleInput("enter");
    expect(component.getMode()).toBe("detail");
    expect(component.render(40).join("\n")).toContain("second");
  });

  test("sanitizes and width-bounds assistant transcript rendering", () => {
    const { registry, component } = setup();
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
    registry.observe(runIds[0]!, { type: "process_started", at: 1 });
    registry.observe(runIds[0]!, {
      type: "assistant_final",
      text: "answer\u001b[31m red\u001b[0m 界😀".repeat(10),
      at: 2,
    });
    component.render(28);
    component.handleInput("enter");
    const lines = component.render(28);
    expect(lines.join("\n")).toContain("answer red");
    expect(lines.join("\n")).not.toContain("\u001b");
    expect(lines.every((item) => visibleWidth(item) <= 28)).toBe(true);
  });

  test("pauses live follow on upward scroll and resumes with End", () => {
    const { registry, component } = setup();
    const { runIds } = registry.beginInvocation({
      toolCallId: "parent",
      source: "subagent",
      mode: "single",
      label: "subagent",
      runs: [{ agent: "worker", task: "inspect", taskIndex: 0 }],
    });
    const runId = runIds[0]!;
    registry.observe(runId, { type: "process_started", at: 1 });
    for (let index = 0; index < 30; index++) {
      registry.observe(runId, {
        type: "assistant_final",
        text: `line ${index}`,
        at: index + 2,
      });
    }
    component.render(40);
    component.handleInput("enter");
    component.render(40);
    component.handleInput("up");
    expect(component.render(40)[1]).toContain("[PAUSED]");
    component.handleInput("end");
    expect(component.render(40)[1]).toContain("[LIVE]");
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
    expect(registry.getRunStatus(runIds[0]!)).toBe("queued");
  });
});
