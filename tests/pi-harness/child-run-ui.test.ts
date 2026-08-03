import { describe, expect, test } from "bun:test";

import type { MemoryAggregate } from "../../pi/extensions/pi-harness/features/agent-memory/cli";
import type { SourcedMemoryRecord } from "../../pi/extensions/pi-harness/features/agent-memory/model";
import {
  AgentMemoryRegistry,
  type AgentMemoryDataSource,
} from "../../pi/extensions/pi-harness/features/agent-memory/registry";
import {
  readFocusedComponent,
  setFocusSafely,
} from "../../pi/extensions/pi-harness/features/child-runs/focus-capability";
import type {
  BitIssueDetailResult,
  BitIssueListResult,
} from "../../pi/extensions/pi-harness/features/bit-issues/model";
import {
  BitIssueRegistry,
  type BitIssueDataSource,
} from "../../pi/extensions/pi-harness/features/bit-issues/registry";
import { ChildRunRegistry } from "../../pi/extensions/pi-harness/features/child-runs/registry";
import {
  AgentMemoryDetailComponent,
  BitIssueDetailComponent,
  ChildRunDetailComponent,
  ChildRunsBrowserComponent,
} from "../../pi/extensions/pi-harness/features/child-runs/ui";
import {
  stripTerminalControls,
  visibleWidth,
} from "../../pi/extensions/pi-harness/lib/terminal-text";

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

const semanticFgCodes: Readonly<Record<string, number>> = {
  success: 32,
  error: 31,
  text: 37,
  toolOutput: 90,
};

const semanticTheme = {
  fg(color: string, text: string) {
    const code = semanticFgCodes[color] ?? 36;
    return `\u001b[${code}m${text}\u001b[39m`;
  },
  bg(_color: string, text: string) {
    return `\u001b[48;5;236m${text}\u001b[49m`;
  },
  bold(text: string) {
    return `\u001b[1m${text}\u001b[22m`;
  },
};

const setup = (rows = 20, theme?: unknown, now: () => number = () => 100) => {
  let id = 0;
  const registry = new ChildRunRegistry({
    idFactory: () => `id-${++id}`,
    now,
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
  const killed: string[] = [];
  let unfocused = 0;
  let hidden = 0;
  const component = new ChildRunsBrowserComponent(
    registry,
    tui,
    keybindings,
    (runId) => inspected.push(runId),
    () => unfocused++,
    () => hidden++,
    undefined,
    theme,
    (runId) => killed.push(runId),
  );
  return {
    registry,
    component,
    tui,
    keybindings,
    renders,
    inspected,
    killed,
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
  test("renders nothing when empty", () => {
    const { component } = setup();
    expect(component.render(24)).toEqual([]);
  });

  test("orders child invocations newest first for rendering and navigation", () => {
    let timestamp = 100;
    const { registry, component } = setup(20, undefined, () => timestamp++);
    const older = registry.beginInvocation({
      toolCallId: "older-parent",
      source: "subagent",
      mode: "single",
      label: "older",
      runs: [{ agent: "older-agent", task: "older task", taskIndex: 0 }],
    });
    const newer = registry.beginInvocation({
      toolCallId: "newer-parent",
      source: "subagent",
      mode: "single",
      label: "newer",
      runs: [{ agent: "newer-agent", task: "newer task", taskIndex: 0 }],
    });

    component.prefer("child");
    const lines = component.render(80);

    expect(lines[0]).toContain("newer-agent");
    expect(lines[1]).toContain("older-agent");
    expect(component.getSelectedRunId()).toBe(newer.runIds[0]);
    component.handleInput("down");
    expect(component.getSelectedRunId()).toBe(older.runIds[0]);
    expect(
      registry.getSnapshots().map(({ invocationId }) => invocationId),
    ).toEqual([older.invocationId, newer.invocationId]);
  });

  test("caps populated height at three rows and uses every row for flat content", () => {
    for (const [rows, expectedHeight] of [
      [24, 3],
      [40, 3],
      [12, 3],
      [8, 2],
    ] as const) {
      const { registry, component } = setup(rows);
      addRuns(registry, 30);
      const lines = component.render(80);
      expect(lines).toHaveLength(expectedHeight);
      expect(lines.join("\n")).not.toContain("↑↓ select");
      expect(lines.at(-1)).toContain(`agent-${expectedHeight - 1}`);
    }
  });

  test("shows the selection cursor only while the browser is focused", () => {
    const { registry, component } = setup();
    addRuns(registry, 1);

    expect(component.render(80).some((item) => item.startsWith("> "))).toBe(
      false,
    );

    component.focused = true;
    expect(component.render(80).some((item) => item.startsWith("> "))).toBe(
      true,
    );

    component.focused = false;
    expect(component.render(80).some((item) => item.startsWith("> "))).toBe(
      false,
    );
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

  test("routes x to the selected child without changing its registry state", () => {
    const { registry, component, killed } = setup();
    const runIds = addRuns(registry, 2);
    component.render(80);
    component.handleInput("down");
    component.handleInput("x");

    expect(killed).toEqual([runIds[1]]);
    expect(component.getSelectedRunId()).toBe(runIds[1]);
    expect(registry.getRunStatus(runAt(runIds, 1))).toBe("queued");
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

  test("themes status icons and ellipsizes overlong run titles", () => {
    const { registry, component } = setup(20, semanticTheme);
    const { runIds } = registry.beginInvocation({
      toolCallId: "themed-browser",
      source: "workflow",
      label: "workflow",
      runs: [
        {
          agent: "successful-reviewer",
          task: `successful ${"title ".repeat(20)}SUCCESS-END`,
          taskIndex: 0,
          stageIndex: 0,
        },
        {
          agent: "failed-reviewer",
          task: `failed ${"title ".repeat(20)}FAIL-END`,
          taskIndex: 1,
          stageIndex: 0,
        },
      ],
    });
    registry.finishRun(runAt(runIds, 0), {
      status: "succeeded",
      reason: "completed",
      endedAt: 101,
    });
    registry.finishRun(runAt(runIds, 1), {
      status: "failed",
      reason: "model-error",
      endedAt: 102,
    });

    const lines = component.render(32);
    const rendered = lines.join("\n");
    const plain = lines.map((item) => stripTerminalControls(item));
    const runRows = plain.filter((item) => item.includes("reviewer"));
    expect(rendered).toContain("\u001b[32m✓\u001b[39m");
    expect(rendered).toContain("\u001b[31m✗\u001b[39m");
    expect(runRows).toHaveLength(2);
    expect(runRows.every((item) => item.endsWith("…"))).toBe(true);
    expect(plain.every((item) => visibleWidth(item) <= 32)).toBe(true);
    expect(rendered).not.toContain("SUCCESS-END");
    expect(rendered).not.toContain("FAIL-END");
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
  test("renders a themed metadata card and transcript status rows", () => {
    const { registry, tui, keybindings } = setup(24);
    const { runIds } = registry.beginInvocation({
      toolCallId: "parent-themed",
      source: "workflow",
      mode: "single",
      label: "review workflow\u001b]2;spoof\u0007",
      runs: [
        {
          agent: "codex-reviewer",
          task: "review the renderer",
          taskIndex: 0,
          stageIndex: 0,
          stageName: "verification",
        },
      ],
    });
    const runId = runAt(runIds, 0);
    registry.observe(runId, { type: "process_started", at: 1 });
    registry.observe(runId, {
      type: "tool_started",
      localId: 1,
      name: "read",
      at: 2,
    });
    registry.observe(runId, {
      type: "tool_finished",
      localId: 1,
      name: "read",
      failed: true,
      at: 3,
    });
    registry.observe(runId, {
      type: "assistant_final",
      text: "Found one actionable issue.",
      at: 4,
    });

    const detail = new ChildRunDetailComponent(
      registry,
      runId,
      tui,
      keybindings,
      () => {},
      semanticTheme,
    );

    const lines = detail.render(64);
    const plain = lines.map((item) => stripTerminalControls(item).trimEnd());
    const rendered = plain.join("\n");
    expect(lines.join("\n")).toContain("\u001b[48;5;236m");
    expect(lines.join("\n")).not.toContain("]2;spoof");
    expect(rendered).toContain("codex-reviewer");
    expect(rendered).toContain("review workflow · verification · S1/T1");
    expect(rendered).toContain("task  review the renderer");
    expect(rendered).toContain("Transcript");
    expect(rendered).toContain("✗ tool-1 read (failed)");
    expect(rendered).toContain("Found one actionable issue.");
    expect(lines.join("\n")).toContain(
      "\u001b[37mFound one actionable issue.\u001b[39m",
    );
    expect(lines.every((item) => visibleWidth(item) <= 64)).toBe(true);
  });

  test("uses the full terminal height and starts completed output at the top", () => {
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
    expect(lines).toHaveLength(24);
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
      [4, 4],
      [3, 3],
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

  test("wraps long detail rows without clipping their tails", () => {
    const { registry, tui, keybindings } = setup(60);
    const { runIds } = registry.beginInvocation({
      toolCallId: "parent",
      source: "workflow",
      mode: "single",
      label: "workflow invocation with extended context LABEL-END",
      runs: [
        {
          agent: "reviewer-agent-with-a-descriptive-name AGENT-END",
          task: "review the implementation carefully and report every discovered regression TASK-END",
          taskIndex: 0,
          stageIndex: 0,
          stageName: "verification stage with additional context STAGE-END",
        },
      ],
    });
    const runId = runAt(runIds, 0);
    registry.observe(runId, { type: "process_started", at: 1 });
    registry.observe(runId, {
      type: "tool_finished",
      localId: 1,
      name: "tool-with-a-long-descriptive-name TOOL-END",
      failed: false,
      at: 2,
    });
    registry.observe(runId, {
      type: "assistant_final",
      text: "A complete assistant response must remain readable through its final marker ASSISTANT-END",
      at: 3,
    });
    registry.finishRun(runId, {
      status: "succeeded",
      reason: "completed",
      endedAt: 4,
    });
    const detail = new ChildRunDetailComponent(
      registry,
      runId,
      tui,
      keybindings,
      () => {},
    );

    const lines = detail.render(24);
    const rendered = lines.join("\n");
    expect(rendered).toContain("AGENT-END");
    expect(rendered).toContain("LABEL-END");
    expect(rendered).toContain("STAGE-END");
    expect(rendered).toContain("TASK-END");
    expect(rendered).toContain("TOOL-END");
    expect(rendered).toContain("ASSISTANT-END");
    expect(lines.every((item) => visibleWidth(item) <= 24)).toBe(true);
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
    expect(detail.render(80).at(-1)).toContain("x kill");

    detail.handleInput("up");
    expect(detail.render(40)[0]).toContain("PAUSED");
    detail.handleInput("end");
    expect(detail.render(40)[0]).toContain("LIVE");
  });

  test("x kills the fixed run while Escape, Left, and b close the detail", () => {
    const { registry, tui, keybindings } = setup();
    const [runId] = addRuns(registry, 1);
    if (runId === undefined) throw new Error("run did not initialize");
    let closes = 0;
    const killed: string[] = [];
    const detail = new ChildRunDetailComponent(
      registry,
      runId,
      tui,
      keybindings,
      () => closes++,
      undefined,
      (selectedRunId) => killed.push(selectedRunId),
    );

    detail.handleInput("x");
    detail.handleInput("escape");
    detail.handleInput("left");
    detail.handleInput("b");
    expect(killed).toEqual([runId]);
    expect(closes).toBe(3);
  });
});

const bitList = (...ids: string[]): BitIssueListResult => ({
  issues: ids.map((id, index) => ({
    id,
    title: index === 0 ? `[plan:test#1] ${id}` : `[task:test#2:1] ${id}`,
    state: "open",
    author: "Pi Tester",
    createdAt: 10,
    updatedAt: 100 - index,
    labels: ["session:test"],
  })),
  truncated: false,
});

const bitDetail = (
  id: string,
  options: {
    state?: "open" | "closed";
    comments?: BitIssueDetailResult["comments"];
  } = {},
): BitIssueDetailResult => ({
  issue: {
    id,
    title: `[plan:test#1] ${id}`,
    state: options.state ?? "open",
    author: "Pi Tester",
    createdAt: 10,
    updatedAt: 100,
    labels: ["session:test"],
    body: `Body for ${id}\nwith CJK 界 and emoji 😀`,
  },
  comments: options.comments ?? { status: "none" },
});

const memoryEntry = (path: string, index: number): SourcedMemoryRecord => ({
  record: {
    version: 1,
    path,
    description: `Memory description ${index}`,
    updatedAt: `2026-08-${String(index + 1).padStart(2, "0")}T08:00:00.000Z`,
    deleted: false,
    content: `Durable content ${index}`,
  },
  sourceRef: `refs/notes/pi-agent-memory/sessions/${"a".repeat(64)}/writers/${"b".repeat(64)}`,
  targetOid: String(index).padStart(40, "c"),
});

const memoryAggregate = (paths: string[]): MemoryAggregate => {
  const entries = paths.map(memoryEntry);
  return {
    repository: {
      cwd: "/repo",
      topLevel: "/repo",
      commonDir: "/repo/.git",
      objectFormat: "sha1",
      trustSource: "direct",
    },
    merged: {
      entries: new Map(entries.map((entry) => [entry.record.path, entry])),
      deleted: new Map(),
    },
    refs: [],
    diagnostics: [],
    truncated: false,
  };
};

const setupCombined = async (
  issueIds: string[],
  childCount = 0,
  memoryPaths?: string[],
) => {
  const base = setup(40);
  base.component.dispose();
  if (childCount > 0) addRuns(base.registry, childCount);
  let currentList = bitList(...issueIds);
  const details = new Map(issueIds.map((id) => [id, bitDetail(id)] as const));
  const source: BitIssueDataSource = {
    listOpen: async () => currentList,
    getDetail: async (_cwd, id) => details.get(id) ?? bitDetail(id),
  };
  const issues = new BitIssueRegistry({ cli: source, now: () => 200 });
  issues.beginSession("/repo");
  await issues.refresh("/repo");
  const inspectedIssues: string[] = [];
  let refreshes = 0;
  let currentMemoryPaths = memoryPaths;
  const memorySource: AgentMemoryDataSource = {
    aggregate: async () => memoryAggregate(currentMemoryPaths ?? []),
    update: async () => {
      throw new Error("unused");
    },
  };
  const memory =
    memoryPaths === undefined
      ? undefined
      : new AgentMemoryRegistry({
          cli: memorySource,
          trust: { trustedRoots: ["/repo"] },
          now: () => 200,
        });
  if (memory !== undefined) {
    memory.beginSession("/repo");
    await memory.refresh("/repo");
  }
  const inspectedMemory: string[] = [];
  let memoryRefreshes = 0;
  const component = new ChildRunsBrowserComponent(
    base.registry,
    base.tui,
    base.keybindings,
    (runId) => base.inspected.push(runId),
    () => {},
    () => {},
    {
      registry: issues,
      onInspect: (id) => inspectedIssues.push(id),
      onRefresh: () => {
        refreshes += 1;
      },
    },
    undefined,
    (runId) => base.killed.push(runId),
    memory === undefined
      ? undefined
      : {
          registry: memory,
          onInspect: (path) => inspectedMemory.push(path),
          onRefresh: () => {
            memoryRefreshes += 1;
          },
        },
  );
  return {
    ...base,
    component,
    issues,
    details,
    inspectedIssues,
    memory,
    inspectedMemory,
    getRefreshes: () => refreshes,
    getMemoryRefreshes: () => memoryRefreshes,
    setIssueIds(ids: string[]) {
      currentList = bitList(...ids);
    },
    setMemoryPaths(paths: string[]) {
      currentMemoryPaths = paths;
    },
  };
};

describe("combined coordination browser", () => {
  test("renders nothing when every coordination source is empty", async () => {
    const combined = await setupCombined([], 0, []);
    expect(combined.component.render(80)).toEqual([]);
  });

  test("renders child and issue rows in one flat height budget", async () => {
    const issueOnly = await setupCombined(["issue-a", "issue-b"]);
    const onlyLines = issueOnly.component.render(80);
    expect(onlyLines[0]).toContain("#issue-a");
    expect(onlyLines.join("\n")).not.toContain("Open bit issues");
    expect(issueOnly.component.getSelectedIssueId()).toBe("issue-a");

    const combined = await setupCombined(["issue-a"], 1);
    const combinedLines = combined.component.render(80);
    expect(combinedLines.length).toBeLessThanOrEqual(10);
    expect(combinedLines[0]).toContain("agent-0");
    expect(combinedLines[1]).toContain("#issue-a");
    expect(combinedLines.join("\n")).not.toContain("Child sessions");
    expect(combinedLines.every((item) => visibleWidth(item) <= 80)).toBe(true);
  });

  test("renders project memory below open issues and navigates into its detail", async () => {
    const combined = await setupCombined(["issue-a"], 1, [
      "reference/zeta.md",
      "project/alpha.md",
    ]);
    const lines = combined.component.render(100);
    expect(lines[0]).toContain("agent-0");
    expect(lines[1]).toContain("#issue-a");
    expect(lines[2]).toContain("project/alpha.md");
    expect(lines.join("\n")).not.toContain("Project memory");

    combined.component.handleInput("down");
    combined.component.handleInput("down");
    expect(combined.component.getSelectedMemoryPath()).toBe("project/alpha.md");
    combined.component.handleInput("enter");
    expect(combined.inspectedMemory).toEqual(["project/alpha.md"]);

    combined.setMemoryPaths([
      "project/000-new.md",
      "project/alpha.md",
      "reference/zeta.md",
    ]);
    await combined.memory?.refresh("/repo");
    combined.component.render(100);
    expect(combined.component.getSelectedMemoryPath()).toBe("project/alpha.md");
  });

  test("moves selection across child and issue rows and dispatches typed detail", async () => {
    const combined = await setupCombined(["issue-a", "issue-b"], 1);
    const [runId] = combined.registry.getSnapshots()[0]?.runs ?? [];
    combined.component.render(80);
    expect(combined.component.getSelectedRunId()).toBe(runId?.runId);

    combined.component.handleInput("down");
    combined.component.handleInput("x");
    combined.component.handleInput("enter");
    expect(combined.inspectedIssues).toEqual(["issue-a"]);
    expect(combined.inspected).toEqual([]);
    expect(combined.killed).toEqual([]);

    combined.component.handleInput("up");
    combined.component.handleInput("x");
    combined.component.handleInput("right");
    expect(combined.inspected).toEqual([runId?.runId]);
    expect(combined.killed).toEqual([runId?.runId]);
  });

  test("keeps issue-id selection stable and chooses the nearby row after close", async () => {
    const combined = await setupCombined(["issue-a", "issue-b"]);
    combined.component.render(80);
    combined.component.handleInput("down");
    expect(combined.component.getSelectedIssueId()).toBe("issue-b");

    combined.details.set("issue-b", bitDetail("issue-b", { state: "closed" }));
    await combined.issues.loadDetail("issue-b");
    combined.component.render(80);
    expect(combined.component.getSelectedIssueId()).toBe("issue-a");
    expect(combined.component.render(80).join("\n")).not.toContain("#issue-b");
  });

  test("supports immediate and pending source preference plus explicit r refresh", async () => {
    const combined = await setupCombined(["issue-a"], 1);
    combined.component.render(80);
    combined.component.prefer("issue");
    expect(combined.component.getSelectedIssueId()).toBe("issue-a");
    combined.component.handleInput("r");
    expect(combined.getRefreshes()).toBe(1);

    const pending = await setupCombined(["issue-a"]);
    pending.component.render(80);
    pending.component.prefer("child");
    const [runId] = addRuns(pending.registry, 1);
    expect(pending.component.getSelectedRunId()).toBe(runId);
  });
});

describe("project memory detail component", () => {
  test("renders bounded untrusted content and scrolls to the final line", async () => {
    const { tui, keybindings } = setup(12);
    const base = memoryEntry("project/alpha.md", 0);
    const entry: SourcedMemoryRecord = {
      ...base,
      record: {
        ...base.record,
        description: "Architecture decision 界😀",
        content: `${"durable line 界😀 ".repeat(80)}\nCONTENT-END\u001b]2;spoof\u0007`,
      },
    };
    const aggregate: MemoryAggregate = {
      ...memoryAggregate([]),
      merged: {
        entries: new Map([[entry.record.path, entry]]),
        deleted: new Map(),
      },
    };
    const source: AgentMemoryDataSource = {
      aggregate: async () => aggregate,
      update: async () => {
        throw new Error("unused");
      },
    };
    const registry = new AgentMemoryRegistry({
      cli: source,
      trust: { trustedRoots: ["/repo"] },
    });
    registry.beginSession("/repo");
    await registry.refresh("/repo");
    let closes = 0;
    const detail = new AgentMemoryDetailComponent(
      registry,
      "project/alpha.md",
      tui,
      keybindings,
      () => closes++,
    );

    const initial = detail.render(24);
    expect(initial.join("\n")).toContain("project/alpha.md");
    expect(initial.every((line) => visibleWidth(line) <= 24)).toBe(true);
    expect(stripTerminalControls(initial.join("\n"))).not.toContain("spoof");

    detail.handleInput("end");
    expect(detail.render(24).join("\n")).toContain("CONTENT-END");
    detail.handleInput("b");
    expect(closes).toBe(1);
  });
});

describe("bit issue detail component", () => {
  test("renders loading, body, raw comments, sanitization, and scrolling", async () => {
    const { tui, keybindings } = setup(16);
    const source: BitIssueDataSource = {
      listOpen: async () => bitList("issue-a"),
      getDetail: async () =>
        bitDetail("issue-a", {
          comments: {
            status: "ready",
            text: `comment abc\n\n${"long comment 界😀 ".repeat(60)}\u001b]2;spoof\u0007`,
            truncated: false,
          },
        }),
    };
    const registry = new BitIssueRegistry({ cli: source });
    registry.beginSession("/repo");
    registry.prepareDetail("issue-a");
    const detail = new BitIssueDetailComponent(
      registry,
      "issue-a",
      tui,
      keybindings,
      () => {},
      semanticTheme,
    );
    expect(detail.render(32).join("\n")).toContain("Loading bit issue");

    await registry.loadDetail("issue-a");
    const lines = detail.render(32);
    expect(lines.join("\n")).toContain("Body");
    expect(lines.join("\n")).toContain("\u001b[37mBody for issue-a");
    expect(lines.join("\n")).toContain("Comments");
    expect(lines.join("\n")).not.toContain("spoof");
    expect(lines.every((item) => visibleWidth(item) <= 32)).toBe(true);
    detail.handleInput("end");
    expect(detail.getOffset()).toBeGreaterThan(0);
    detail.handleInput("home");
    expect(detail.getOffset()).toBe(0);
  });

  test("keeps the final comment state reachable on tiny terminals", async () => {
    for (const [rows, expectedHeight] of [
      [4, 4],
      [3, 3],
    ] as const) {
      const { tui, keybindings } = setup(rows);
      const source: BitIssueDataSource = {
        listOpen: async () => bitList("issue-a"),
        getDetail: async () => bitDetail("issue-a"),
      };
      const registry = new BitIssueRegistry({ cli: source });
      registry.beginSession("/repo");
      await registry.loadDetail("issue-a");
      const detail = new BitIssueDetailComponent(
        registry,
        "issue-a",
        tui,
        keybindings,
        () => {},
      );
      detail.render(40);
      detail.handleInput("end");
      const lines = detail.render(40);
      expect(lines).toHaveLength(expectedHeight);
      expect(lines.join("\n")).toContain("(no comments)");
    }
  });

  test("distinguishes no comments and detail errors", async () => {
    const { tui, keybindings } = setup(24);
    let fail = false;
    const source: BitIssueDataSource = {
      listOpen: async () => bitList("issue-a"),
      getDetail: async () => {
        if (fail) throw new Error("detail failed");
        return bitDetail("issue-a");
      },
    };
    const registry = new BitIssueRegistry({ cli: source });
    registry.beginSession("/repo");
    await registry.loadDetail("issue-a");
    const detail = new BitIssueDetailComponent(
      registry,
      "issue-a",
      tui,
      keybindings,
      () => {},
    );
    expect(detail.render(60).join("\n")).toContain("(no comments)");

    fail = true;
    await registry.loadDetail("issue-a");
    expect(detail.render(60).join("\n")).toContain(
      "Bit issue detail unavailable: detail failed",
    );
  });
});
