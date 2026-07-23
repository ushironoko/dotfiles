import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Text,
  truncateToWidth as truncateStyledToWidth,
} from "@earendil-works/pi-tui";
import type { CtxLike } from "../../lib/pi-like";
import {
  stripTerminalControls,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "../../lib/terminal-text";
import type {
  BitIssueDetailResult,
  BitIssueDetailState,
  BitIssueSummary,
} from "../bit-issues/model";
import { BitIssueRegistry } from "../bit-issues/registry";
import type {
  ChildInvocationSnapshot,
  ChildRunStatus,
  LiveChildRun,
  TranscriptItem,
} from "./model";
import {
  readFocusedComponent,
  setFocusSafely,
  type FocusTuiLike,
} from "./focus-capability";
import { statusIcon, type ComponentLike } from "./presentation";
import { ChildRunRegistry } from "./registry";

interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

interface EditorLike extends ComponentLike {
  handleInput(data: string): void;
  getText(): string;
  getCursor(): { line: number; col: number };
  isShowingAutocomplete?(): boolean;
  keybindings?: KeybindingsLike;
}

interface TuiLike extends FocusTuiLike {
  terminal: { rows: number };
  requestRender(force?: boolean): void;
}

interface WidgetUiLike {
  setWidget(
    key: string,
    content: ((tui: TuiLike, theme: unknown) => ComponentLike) | undefined,
    options?: { placement: "belowEditor" },
  ): void;
  custom?<T>(
    factory: (
      tui: TuiLike,
      theme: unknown,
      keybindings: KeybindingsLike,
      done: (result: T) => void,
    ) => ComponentLike,
    options?: {
      overlay?: boolean;
      overlayOptions?: {
        width?: number | `${number}%`;
        maxHeight?: number | `${number}%`;
        anchor?: string;
        margin?: number;
      };
    },
  ): Promise<T>;
  onTerminalInput?(
    handler: (data: string) => { consume?: boolean; data?: string } | undefined,
  ): () => void;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export type BrowserContextLike = CtxLike;

type FlatRun = {
  invocation: ChildInvocationSnapshot;
  run: LiveChildRun;
};

const flattenRuns = (snapshots: ChildInvocationSnapshot[]): FlatRun[] =>
  snapshots.flatMap((invocation) =>
    invocation.runs.map((run) => ({ invocation, run })),
  );

const findRun = (
  snapshots: ChildInvocationSnapshot[],
  runId: string | undefined,
): FlatRun | undefined =>
  flattenRuns(snapshots).find(({ run }) => run.runId === runId);

const line = (value: string, width: number): string =>
  truncateToWidth(stripTerminalControls(value), Math.max(0, width), "");

const taskOneLine = (task: string): string =>
  stripTerminalControls(task, " ").replace(/\s+/g, " ").trim();

interface ChildRunTheme {
  fg(color: ThemeColor, text: string): string;
  bg(color: "selectedBg", text: string): string;
  bold(text: string): string;
}

const plainTheme: ChildRunTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

const resolveTheme = (value: unknown): ChildRunTheme => {
  if (typeof value !== "object" || value === null) return plainTheme;
  const candidate = value as Partial<ChildRunTheme>;
  return typeof candidate.fg === "function" &&
    typeof candidate.bg === "function" &&
    typeof candidate.bold === "function"
    ? (candidate as ChildRunTheme)
    : plainTheme;
};

const safeBlock = (value: string): string => stripTerminalControls(value);

const styledLine = (value: string, width: number): string => {
  const safeWidth = Math.max(1, width);
  return value.includes("\u001b")
    ? truncateStyledToWidth(value, safeWidth, "")
    : truncateToWidth(value, safeWidth, "");
};

const statusColors: Record<ChildRunStatus, ThemeColor> = {
  queued: "dim",
  running: "warning",
  succeeded: "success",
  failed: "error",
  aborted: "warning",
  skipped: "dim",
};

const statusColor = (status: ChildRunStatus): ThemeColor =>
  statusColors[status];

const transcriptComponent = (
  item: TranscriptItem,
  theme: ChildRunTheme,
): ComponentLike => {
  if (item.type === "assistant") {
    const assistant = new Container();
    assistant.addChild(
      new Text(theme.fg("accent", theme.bold("assistant")), 0, 0),
    );
    const body = new Box(1, 0);
    body.addChild(new Text(theme.fg("toolOutput", safeBlock(item.text)), 0, 0));
    assistant.addChild(body);
    return assistant;
  }
  if (item.type === "tool") {
    let runStatus: ChildRunStatus = "succeeded";
    if (item.status === "running") runStatus = "running";
    else if (item.status === "failed") runStatus = "failed";
    else if (item.status === "interrupted") runStatus = "aborted";
    const icon = theme.fg(statusColor(runStatus), statusIcon(runStatus));
    const tool = theme.fg("accent", theme.bold(`tool-${item.localId}`));
    const name = theme.fg("toolOutput", taskOneLine(item.name));
    const status = theme.fg(statusColor(runStatus), `(${item.status})`);
    return new Text(`${icon} ${tool} ${name} ${status}`, 0, 0);
  }
  return new Text(
    theme.fg(
      "warning",
      `… transcript truncated (${item.omittedItems} items, ${item.omittedBytes} bytes omitted)`,
    ),
    0,
    0,
  );
};

type BrowserSelection =
  | { readonly kind: "child"; readonly id: string }
  | { readonly kind: "issue"; readonly id: string };

interface BrowserRow {
  readonly text: string;
  readonly selection?: BrowserSelection;
}

export interface BitIssueBrowserBindings {
  readonly registry: BitIssueRegistry;
  readonly onInspect: (issueId: string) => void;
  readonly onRefresh: () => void | Promise<void>;
}

const selectionToken = (selection: BrowserSelection): string =>
  `${selection.kind}:${selection.id}`;

const issueIcon = (issue: BitIssueSummary): string => {
  if (issue.title.startsWith("[plan:")) return "◆";
  if (issue.title.startsWith("[task:")) return "◇";
  return "○";
};

export class ChildRunsBrowserComponent implements ComponentLike {
  private selection: BrowserSelection | undefined;
  private pendingPreference: BrowserSelection["kind"] | undefined;
  private selectedIndexHint = 0;
  private listOffset = 0;
  private readonly unsubscribeChild: () => void;
  private readonly unsubscribeIssues: (() => void) | undefined;

  constructor(
    private readonly registry: ChildRunRegistry,
    private readonly tui: TuiLike,
    private readonly keybindings: KeybindingsLike,
    private readonly onInspect: (runId: string) => void,
    private readonly onUnfocus: () => void,
    private readonly onHide: () => void,
    private readonly bitIssues?: BitIssueBrowserBindings,
  ) {
    this.unsubscribeChild = registry.subscribe(() => this.requestRender());
    this.unsubscribeIssues = bitIssues?.registry.subscribe(() =>
      this.requestRender(),
    );
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    // The browser participates in normal layout flow with chat, editor, status
    // rows, and footer. Combining sources must not increase this old budget.
    const height = Math.max(
      4,
      Math.min(Math.floor(this.tui.terminal.rows / 4), 10),
    );
    const snapshots = this.registry.getSnapshots();
    const runs = flattenRuns(snapshots);
    const issueSnapshot = this.bitIssues?.registry.getSnapshot();
    const issues = issueSnapshot?.issues ?? [];
    this.syncSelection(runs, issues);

    const body = this.renderList(
      snapshots,
      runs,
      issues,
      safeWidth,
      height - 2,
    );
    let issueState = "";
    if (issueSnapshot?.loading === true) issueState = " · refreshing";
    else if (issueSnapshot?.stale === true) issueState = " · stale";
    else if (issueSnapshot?.error !== undefined) issueState = " · unavailable";
    const title =
      this.bitIssues === undefined
        ? " Child sessions "
        : ` Child sessions: ${runs.length} | Open bit issues: ${issues.length}${issueState} `;
    const hint =
      this.bitIssues === undefined
        ? "↑↓ select  Enter inspect  Esc unfocus  q hide"
        : "↑↓ select  Enter inspect  r refresh  Esc unfocus  q hide";
    const borderWidth = Math.max(1, safeWidth - visibleWidth(title));
    return [
      line(`${title}${"─".repeat(borderWidth)}`, safeWidth),
      ...body,
      line(hint, safeWidth),
    ].slice(0, height);
  }

  handleInput(data: string): void {
    if (data === "q") {
      this.onHide();
      return;
    }
    if (data === "r" && this.bitIssues !== undefined) {
      void this.bitIssues.onRefresh();
      return;
    }
    if (this.matches(data, "tui.select.cancel")) {
      this.onUnfocus();
      return;
    }

    const selectable = this.selectableRows();
    const token = this.selection && selectionToken(this.selection);
    const current = Math.max(
      0,
      selectable.findIndex((selection) => selectionToken(selection) === token),
    );
    let nextIndex: number | undefined;
    if (this.matches(data, "tui.select.up") || data === "k") {
      nextIndex = Math.max(0, current - 1);
    } else if (this.matches(data, "tui.select.down") || data === "j") {
      nextIndex = Math.min(selectable.length - 1, current + 1);
    } else if (this.matches(data, "tui.select.pageUp")) {
      nextIndex = Math.max(0, current - 8);
    } else if (this.matches(data, "tui.select.pageDown")) {
      nextIndex = Math.min(selectable.length - 1, current + 8);
    } else if (
      this.matches(data, "tui.select.confirm") ||
      defaultKeyMatches(data, "tui.select.confirm") ||
      this.matches(data, "tui.editor.cursorRight")
    ) {
      if (this.selection?.kind === "child") this.onInspect(this.selection.id);
      else if (this.selection?.kind === "issue") {
        this.bitIssues?.onInspect(this.selection.id);
      }
    } else return;

    if (nextIndex !== undefined && nextIndex >= 0) {
      this.pendingPreference = undefined;
      this.selection = selectable[nextIndex];
      this.selectedIndexHint = nextIndex;
    }
    this.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribeChild();
    this.unsubscribeIssues?.();
  }

  getSelectedRunId(): string | undefined {
    return this.selection?.kind === "child" ? this.selection.id : undefined;
  }

  getSelectedIssueId(): string | undefined {
    return this.selection?.kind === "issue" ? this.selection.id : undefined;
  }

  prefer(kind: BrowserSelection["kind"]): void {
    this.pendingPreference = kind;
    const selectable = this.selectableRows();
    const preferred = selectable.find((selection) => selection.kind === kind);
    if (preferred !== undefined) {
      this.pendingPreference = undefined;
      this.selection = preferred;
      this.selectedIndexHint = selectable.findIndex(
        (selection) => selectionToken(selection) === selectionToken(preferred),
      );
    }
    this.requestRender();
  }

  private selectableRows(): BrowserSelection[] {
    const children = flattenRuns(this.registry.getSnapshots()).map(
      ({ run }): BrowserSelection => ({ kind: "child", id: run.runId }),
    );
    const issues =
      this.bitIssues?.registry
        .getSnapshot()
        .issues.map(
          (issue): BrowserSelection => ({ kind: "issue", id: issue.id }),
        ) ?? [];
    return [...children, ...issues];
  }

  private syncSelection(
    runs: FlatRun[],
    issues: readonly BitIssueSummary[],
  ): void {
    const selectable: BrowserSelection[] = [
      ...runs.map(
        ({ run }): BrowserSelection => ({
          kind: "child",
          id: run.runId,
        }),
      ),
      ...issues.map(
        (issue): BrowserSelection => ({ kind: "issue", id: issue.id }),
      ),
    ];
    if (this.pendingPreference !== undefined) {
      const preferred = selectable.find(
        (selection) => selection.kind === this.pendingPreference,
      );
      if (preferred !== undefined) {
        this.pendingPreference = undefined;
        this.selection = preferred;
        this.selectedIndexHint = selectable.indexOf(preferred);
        return;
      }
    }
    const token = this.selection && selectionToken(this.selection);
    const retained = selectable.find(
      (selection) => selectionToken(selection) === token,
    );
    if (retained !== undefined) {
      this.selection = retained;
      this.selectedIndexHint = selectable.indexOf(retained);
      return;
    }
    this.selection =
      selectable[Math.min(this.selectedIndexHint, selectable.length - 1)];
    this.selectedIndexHint = Math.max(
      0,
      Math.min(this.selectedIndexHint, selectable.length - 1),
    );
  }

  private renderList(
    snapshots: ChildInvocationSnapshot[],
    runs: FlatRun[],
    issues: readonly BitIssueSummary[],
    width: number,
    viewport: number,
  ): string[] {
    const issueSnapshot = this.bitIssues?.registry.getSnapshot();
    if (runs.length === 0 && issues.length === 0) {
      if (this.bitIssues === undefined) {
        return [
          line("No child runs on this session branch.", width),
          line("Start subagent or workflow to populate this view.", width),
        ];
      }
      let issueStatus = "Start subagent/workflow or create a local bit issue.";
      if (issueSnapshot?.loading === true)
        issueStatus = "Loading open bit issues…";
      else if (issueSnapshot?.error !== undefined) {
        issueStatus = `Open bit issues unavailable: ${issueSnapshot.error}`;
      }
      return [
        line("No child runs or open bit issues.", width),
        line(issueStatus, width),
      ];
    }

    const rendered: BrowserRow[] = [];
    if (runs.length > 0) {
      if (this.bitIssues !== undefined)
        rendered.push({ text: "Child sessions" });
      for (const invocation of snapshots) {
        rendered.push({
          text: `${invocation.label} · ${invocation.source} · ${invocation.runs.length} run(s)`,
        });
        for (const run of invocation.runs) {
          const stage =
            run.stageIndex === undefined
              ? `${run.taskIndex + 1}`
              : `S${run.stageIndex + 1}/T${run.taskIndex + 1}`;
          const selection: BrowserSelection = {
            kind: "child",
            id: run.runId,
          };
          rendered.push({
            selection,
            text: `${this.isSelected(selection) ? ">" : " "} ${statusIcon(run.status)} ${stage} ${run.agent} — ${taskOneLine(run.task)}`,
          });
        }
      }
    }
    if (issues.length > 0) {
      rendered.push({ text: "Open bit issues" });
      for (const issue of issues) {
        const selection: BrowserSelection = { kind: "issue", id: issue.id };
        rendered.push({
          selection,
          text: `${this.isSelected(selection) ? ">" : " "} ${issueIcon(issue)} #${issue.id.slice(0, 8)} ${taskOneLine(issue.title)}`,
        });
      }
      if (issueSnapshot?.truncated === true) {
        rendered.push({ text: "… more than 100 open bit issues" });
      }
    }
    if (issueSnapshot?.error !== undefined) {
      rendered.push({
        text: `${issueSnapshot.stale ? "stale" : "issue refresh failed"}: ${issueSnapshot.error}`,
      });
    }

    const selectedToken = this.selection && selectionToken(this.selection);
    const selectedLine = Math.max(
      0,
      rendered.findIndex(
        (item) =>
          item.selection !== undefined &&
          selectionToken(item.selection) === selectedToken,
      ),
    );
    this.listOffset = Math.max(
      0,
      Math.min(
        this.listOffset,
        Math.max(0, rendered.length - Math.max(1, viewport)),
      ),
    );
    if (selectedLine < this.listOffset) this.listOffset = selectedLine;
    if (selectedLine >= this.listOffset + viewport) {
      this.listOffset = selectedLine - viewport + 1;
    }
    return rendered
      .slice(this.listOffset, this.listOffset + viewport)
      .map((item) => line(item.text, width));
  }

  private isSelected(selection: BrowserSelection): boolean {
    return (
      this.selection !== undefined &&
      selectionToken(this.selection) === selectionToken(selection)
    );
  }

  private requestRender(): void {
    this.syncSelection(
      flattenRuns(this.registry.getSnapshots()),
      this.bitIssues?.registry.getSnapshot().issues ?? [],
    );
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

const detailContentLines = (
  selected: FlatRun,
  width: number,
  theme: ChildRunTheme,
): string[] => {
  const { invocation, run } = selected;
  const root = new Container();
  const metadata = new Box(1, 0, (text) => theme.bg("selectedBg", text));
  const status = theme.fg(
    statusColor(run.status),
    `${statusIcon(run.status)} ${run.status}`,
  );
  const reason =
    run.terminalReason === undefined
      ? ""
      : theme.fg(
          statusColor(run.status),
          ` (${taskOneLine(run.terminalReason)})`,
        );
  metadata.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold(taskOneLine(run.agent)))}  ${status}${reason}`,
      0,
      0,
    ),
  );

  const taskPosition = `T${run.taskIndex + 1}`;
  const position =
    run.stageIndex === undefined
      ? taskPosition
      : `S${run.stageIndex + 1}/${taskPosition}`;
  const invocationParts = [
    taskOneLine(invocation.label),
    run.stageName === undefined ? undefined : taskOneLine(run.stageName),
    position,
  ].filter((part): part is string => part !== undefined && part !== "");
  metadata.addChild(
    new Text(theme.fg("muted", invocationParts.join(" · ")), 0, 0),
  );
  metadata.addChild(
    new Text(
      theme.fg("muted", theme.bold("task  ")) +
        theme.fg("toolOutput", taskOneLine(run.task)),
      0,
      0,
    ),
  );
  root.addChild(metadata);
  root.addChild(new Text(theme.fg("accent", theme.bold("Transcript")), 0, 0));

  const transcript = new Box(1, 0);
  for (const item of run.transcript) {
    transcript.addChild(transcriptComponent(item, theme));
  }
  if (run.liveDraft) {
    transcript.addChild(
      new Text(theme.fg("warning", theme.bold("assistant LIVE")), 0, 0),
    );
    const draft = new Box(1, 0);
    draft.addChild(
      new Text(theme.fg("toolOutput", safeBlock(run.liveDraft)), 0, 0),
    );
    transcript.addChild(draft);
  }
  if (run.transcript.length === 0 && !run.liveDraft) {
    transcript.addChild(
      new Text(
        theme.fg(
          "dim",
          run.status === "queued"
            ? "(not launched)"
            : "(no assistant text yet)",
        ),
        0,
        0,
      ),
    );
  }
  if (run.protocolWarnings > 0) {
    transcript.addChild(
      new Text(
        theme.fg(
          "warning",
          `(${run.protocolWarnings} child stream warning(s))`,
        ),
        0,
        0,
      ),
    );
  }
  root.addChild(transcript);
  return root.render(Math.max(1, width));
};

/** Focused, near-full-screen transcript viewer for one fixed child run. */
export class ChildRunDetailComponent implements ComponentLike {
  private offset = 0;
  private follow: boolean;
  private lastMaxOffset = 0;
  private lastViewport = 1;
  private readonly unsubscribe: () => void;
  private readonly theme: ChildRunTheme;

  constructor(
    private readonly registry: ChildRunRegistry,
    private readonly runId: string,
    private readonly tui: TuiLike,
    private readonly keybindings: KeybindingsLike,
    private readonly onClose: () => void,
    theme?: unknown,
  ) {
    this.theme = resolveTheme(theme);
    const initialStatus = findRun(this.registry.getSnapshots(), this.runId)?.run
      .status;
    this.follow = initialStatus === "queued" || initialStatus === "running";
    this.unsubscribe = registry.subscribe(() => this.tui.requestRender());
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    // The overlay uses a one-cell margin on each side, so rows - 2 fills the
    // available height without competing with the resident editor-flow panel.
    // On tiny terminals, drop the hint and then the title before reducing the
    // transcript to zero visible rows.
    const height = Math.max(1, this.tui.terminal.rows - 2);
    const showTitle = height >= 2;
    const showHint = height >= 3;
    const chrome = Number(showTitle) + Number(showHint);
    const viewport = Math.max(1, height - chrome);
    this.lastViewport = viewport;
    const selected = findRun(this.registry.getSnapshots(), this.runId);
    const allLines =
      selected === undefined
        ? new Text(
            this.theme.fg(
              "warning",
              "Selected child run is no longer available.",
            ),
            0,
            0,
          ).render(safeWidth)
        : detailContentLines(selected, safeWidth, this.theme);

    this.lastMaxOffset = Math.max(0, allLines.length - viewport);
    if (this.follow) this.offset = this.lastMaxOffset;
    else this.offset = Math.min(this.offset, this.lastMaxOffset);

    const visible = allLines.slice(this.offset, this.offset + viewport);
    while (visible.length < viewport) visible.push("");

    const running = selected?.run.status === "running";
    let state = "";
    if (running && this.follow) {
      state = this.theme.fg("warning", " · LIVE");
    } else if (!this.follow) {
      state = this.theme.fg("warning", " · PAUSED");
    }
    const title = `${this.theme.fg("toolTitle", this.theme.bold(" Child session"))}${state} `;
    const borderWidth = Math.max(1, safeWidth - visibleWidth(title));
    const border = this.theme.fg("borderMuted", "─".repeat(borderWidth));
    const first = allLines.length === 0 ? 0 : this.offset + 1;
    const last = Math.min(allLines.length, this.offset + viewport);
    const position = `${first}-${last}/${allLines.length}`;
    const output: string[] = [];
    if (showTitle) {
      output.push(styledLine(`${title}${border}`, safeWidth));
    }
    output.push(...visible.map((item) => styledLine(item, safeWidth)));
    if (showHint) {
      const hint = this.theme.fg(
        "dim",
        "↑↓ scroll  PgUp/PgDn page  Home/End  Esc/←/b close  ",
      );
      output.push(
        styledLine(`${hint}${this.theme.fg("muted", position)}`, safeWidth),
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

    const page = Math.max(1, this.lastViewport - 1);
    if (
      data === "k" ||
      this.matches(data, "tui.select.up") ||
      defaultKeyMatches(data, "tui.select.up")
    ) {
      this.follow = false;
      this.offset = Math.max(0, this.offset - 1);
    } else if (
      this.matches(data, "tui.select.pageUp") ||
      defaultKeyMatches(data, "tui.select.pageUp")
    ) {
      this.follow = false;
      this.offset = Math.max(0, this.offset - page);
    } else if (
      data === "j" ||
      this.matches(data, "tui.select.down") ||
      defaultKeyMatches(data, "tui.select.down")
    ) {
      this.offset = Math.min(this.lastMaxOffset, this.offset + 1);
      this.follow = this.offset >= this.lastMaxOffset;
    } else if (
      this.matches(data, "tui.select.pageDown") ||
      defaultKeyMatches(data, "tui.select.pageDown")
    ) {
      this.offset = Math.min(this.lastMaxOffset, this.offset + page);
      this.follow = this.offset >= this.lastMaxOffset;
    } else if (
      this.matches(data, "tui.editor.cursorLineStart") ||
      defaultKeyMatches(data, "tui.editor.cursorLineStart")
    ) {
      this.follow = false;
      this.offset = 0;
    } else if (
      this.matches(data, "tui.editor.cursorLineEnd") ||
      defaultKeyMatches(data, "tui.editor.cursorLineEnd")
    ) {
      this.follow = true;
      this.offset = this.lastMaxOffset;
    } else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  getOffset(): number {
    return this.offset;
  }

  isFollowing(): boolean {
    return this.follow;
  }

  private matches(data: string, keybinding: string): boolean {
    try {
      return this.keybindings.matches(data, keybinding);
    } catch {
      return false;
    }
  }
}

const formatBitTimestamp = (seconds: number): string =>
  new Date(seconds * 1_000).toISOString();

const issueDetailContentLines = (
  detail: BitIssueDetailResult,
  width: number,
  theme: ChildRunTheme,
): string[] => {
  const { issue, comments } = detail;
  const root = new Container();
  const metadata = new Box(1, 0, (text) => theme.bg("selectedBg", text));
  const stateColor: ThemeColor = issue.state === "open" ? "success" : "warning";
  metadata.addChild(
    new Text(
      `${theme.fg("toolTitle", theme.bold(`#${issue.id} ${taskOneLine(issue.title)}`))}  ${theme.fg(stateColor, issue.state)}`,
      0,
      0,
    ),
  );
  metadata.addChild(
    new Text(theme.fg("muted", `author  ${taskOneLine(issue.author)}`), 0, 0),
  );
  metadata.addChild(
    new Text(
      theme.fg(
        "muted",
        `created ${formatBitTimestamp(issue.createdAt)} · updated ${formatBitTimestamp(issue.updatedAt)}`,
      ),
      0,
      0,
    ),
  );
  if (issue.labels.length > 0) {
    metadata.addChild(
      new Text(
        theme.fg(
          "muted",
          `labels  ${issue.labels.map(taskOneLine).join(", ")}`,
        ),
        0,
        0,
      ),
    );
  }
  root.addChild(metadata);
  root.addChild(new Text(theme.fg("accent", theme.bold("Body")), 0, 0));
  const body = new Box(1, 0);
  body.addChild(
    new Text(
      theme.fg(
        "toolOutput",
        wrapPlainText(
          issue.body === "" ? "(empty body)" : safeBlock(issue.body),
          Math.max(1, width - 2),
        ).join("\n"),
      ),
      0,
      0,
    ),
  );
  root.addChild(body);
  root.addChild(new Text(theme.fg("accent", theme.bold("Comments")), 0, 0));
  const commentBox = new Box(1, 0);
  if (comments.status === "none") {
    commentBox.addChild(new Text(theme.fg("dim", "(no comments)"), 0, 0));
  } else if (comments.status === "error") {
    commentBox.addChild(
      new Text(
        theme.fg(
          "warning",
          `Comments unavailable: ${taskOneLine(comments.message)}`,
        ),
        0,
        0,
      ),
    );
  } else {
    commentBox.addChild(
      new Text(
        theme.fg(
          comments.truncated ? "warning" : "toolOutput",
          wrapPlainText(safeBlock(comments.text), Math.max(1, width - 2)).join(
            "\n",
          ),
        ),
        0,
        0,
      ),
    );
  }
  root.addChild(commentBox);
  return root.render(Math.max(1, width));
};

/** Focused, near-full-screen read-only viewer for one local bit issue. */
export class BitIssueDetailComponent implements ComponentLike {
  private offset = 0;
  private lastMaxOffset = 0;
  private lastViewport = 1;
  private readonly unsubscribe: () => void;
  private readonly theme: ChildRunTheme;

  constructor(
    private readonly registry: BitIssueRegistry,
    private readonly issueId: string,
    private readonly tui: TuiLike,
    private readonly keybindings: KeybindingsLike,
    private readonly onClose: () => void,
    theme?: unknown,
  ) {
    this.theme = resolveTheme(theme);
    this.unsubscribe = registry.subscribe(() => this.tui.requestRender());
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const height = Math.max(1, this.tui.terminal.rows - 2);
    const showTitle = height >= 2;
    const showHint = height >= 3;
    const chrome = Number(showTitle) + Number(showHint);
    const viewport = Math.max(1, height - chrome);
    this.lastViewport = viewport;
    const state = this.registry.getDetailState(this.issueId);
    const allLines = this.contentLines(state, safeWidth);
    this.lastMaxOffset = Math.max(0, allLines.length - viewport);
    this.offset = Math.min(this.offset, this.lastMaxOffset);

    const visible = allLines.slice(this.offset, this.offset + viewport);
    while (visible.length < viewport) visible.push("");

    const title = this.theme.fg(
      "toolTitle",
      this.theme.bold(` Bit issue #${this.issueId} `),
    );
    const borderWidth = Math.max(1, safeWidth - visibleWidth(title));
    const first = allLines.length === 0 ? 0 : this.offset + 1;
    const last = Math.min(allLines.length, this.offset + viewport);
    const position = `${first}-${last}/${allLines.length}`;
    const output: string[] = [];
    if (showTitle) {
      output.push(
        styledLine(
          `${title}${this.theme.fg("borderMuted", "─".repeat(borderWidth))}`,
          safeWidth,
        ),
      );
    }
    output.push(...visible.map((item) => styledLine(item, safeWidth)));
    if (showHint) {
      const hint = this.theme.fg(
        "dim",
        "↑↓ scroll  PgUp/PgDn page  Home/End  Esc/←/b/q close  ",
      );
      output.push(
        styledLine(`${hint}${this.theme.fg("muted", position)}`, safeWidth),
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

    const page = Math.max(1, this.lastViewport - 1);
    if (
      data === "k" ||
      this.matches(data, "tui.select.up") ||
      defaultKeyMatches(data, "tui.select.up")
    ) {
      this.offset = Math.max(0, this.offset - 1);
    } else if (
      this.matches(data, "tui.select.pageUp") ||
      defaultKeyMatches(data, "tui.select.pageUp")
    ) {
      this.offset = Math.max(0, this.offset - page);
    } else if (
      data === "j" ||
      this.matches(data, "tui.select.down") ||
      defaultKeyMatches(data, "tui.select.down")
    ) {
      this.offset = Math.min(this.lastMaxOffset, this.offset + 1);
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

  dispose(): void {
    this.unsubscribe();
  }

  getOffset(): number {
    return this.offset;
  }

  private contentLines(state: BitIssueDetailState, width: number): string[] {
    if (state.status === "ready") {
      return issueDetailContentLines(state.detail, width, this.theme);
    }
    const message =
      state.status === "loading" || state.status === "idle"
        ? `Loading bit issue #${this.issueId}…`
        : `Bit issue detail unavailable: ${taskOneLine(state.message)}`;
    return new Text(
      this.theme.fg(state.status === "error" ? "warning" : "dim", message),
      0,
      0,
    ).render(width);
  }

  private matches(data: string, keybinding: string): boolean {
    try {
      return this.keybindings.matches(data, keybinding);
    } catch {
      return false;
    }
  }
}

type MountState = "unmounted" | "mounted" | "disposed";

export const CHILD_RUNS_WIDGET_KEY = "pi-harness-child-runs";

const isKeyRelease = (data: string): boolean =>
  !data.includes("\u001b[200~") &&
  [":3u", ":3~", ":3A", ":3B", ":3C", ":3D", ":3H", ":3F"].some((marker) =>
    data.includes(marker),
  );

const defaultKeyMatches = (data: string, keybinding: string): boolean => {
  const legacyKeys: Record<string, string[]> = {
    "tui.editor.cursorDown": ["down", "\u001b[B"],
    "tui.editor.cursorLeft": ["left", "\u001b[D"],
    "tui.editor.cursorRight": ["right", "\u001b[C"],
    "tui.editor.cursorLineStart": ["home", "\u001b[H", "\u001b[1~"],
    "tui.editor.cursorLineEnd": ["end", "\u001b[F", "\u001b[4~"],
    "tui.select.up": ["up", "\u001b[A"],
    "tui.select.down": ["down", "\u001b[B"],
    "tui.select.pageUp": ["pageup", "\u001b[5~"],
    "tui.select.pageDown": ["pagedown", "\u001b[6~"],
    "tui.select.confirm": ["enter", "\r", "\n"],
    "tui.select.cancel": ["escape", "\u001b"],
  };
  if (legacyKeys[keybinding]?.includes(data)) return true;

  if (!data.startsWith("\u001b[")) return false;
  const kittySequence = data.slice(2);
  const kittyPatterns: Partial<Record<string, RegExp>> = {
    "tui.editor.cursorDown": /^1;1(?::[12])?B$/,
    "tui.editor.cursorLeft": /^1;1(?::[12])?D$/,
    "tui.editor.cursorRight": /^1;1(?::[12])?C$/,
    "tui.editor.cursorLineStart": /^(?:1;1(?::[12])?H|7;1(?::[12])?~)$/,
    "tui.editor.cursorLineEnd": /^(?:1;1(?::[12])?F|8;1(?::[12])?~)$/,
    "tui.select.up": /^1;1(?::[12])?A$/,
    "tui.select.down": /^1;1(?::[12])?B$/,
    "tui.select.pageUp": /^5;1(?::[12])?~$/,
    "tui.select.pageDown": /^6;1(?::[12])?~$/,
    "tui.select.confirm": /^13(?:;1)?(?::[12])?u$/,
    "tui.select.cancel": /^27(?:;1)?(?::[12])?u$/,
  };
  return kittyPatterns[keybinding]?.test(kittySequence) ?? false;
};

const isEditorLike = (value: unknown): value is EditorLike =>
  typeof value === "object" &&
  value !== null &&
  "handleInput" in value &&
  typeof value.handleInput === "function" &&
  "getText" in value &&
  typeof value.getText === "function" &&
  "getCursor" in value &&
  typeof value.getCursor === "function";

const sameCursor = (
  left: { line: number; col: number },
  right: { line: number; col: number },
): boolean => left.line === right.line && left.col === right.col;

/**
 * Resident full-width child browser mounted in pi's below-editor widget slot.
 *
 * pi-tui currently exposes setFocus() but no public focus getter. To preserve
 * normal editor navigation, the controller reads the focused editor through a
 * single structural seam, forwards Down to it first, and only transfers focus
 * when text and cursor are unchanged (the editor's bottom boundary).
 *
 * Boundary transfer is best-effort for cursor-aware editors that expose
 * getText() and getCursor(). Editors without those optional capabilities keep
 * native Down handling and can focus the browser via /subagents or Ctrl+Alt+S.
 * Remapped Down is honored when the editor exposes its runtime keybindings
 * manager; otherwise only the fallback default terminal sequences are known.
 */
export interface ChildRunsPanelOptions {
  readonly bitIssues?: BitIssueRegistry;
  readonly refreshBitIssues?: () => void | Promise<unknown>;
}

export class ChildRunsPanelController {
  private state: MountState = "unmounted";
  private component: ChildRunsBrowserComponent | undefined;
  private editor: EditorLike | undefined;
  private returnFocus: ComponentLike | undefined;
  private tui: TuiLike | undefined;
  private ui: WidgetUiLike | undefined;
  private unsubscribeInput: (() => void) | undefined;
  private detailClose: (() => void) | undefined;
  private detailPromise: Promise<void> | undefined;
  private detailIssueId: string | undefined;
  private fallbackClose: (() => void) | undefined;
  private fallbackPromise: Promise<void> | undefined;
  private focusDegraded = false;
  private focusWarningShown = false;
  private hiddenByUser = false;
  private readonly keybindings: KeybindingsLike = {
    matches: (data, keybinding) =>
      this.editor?.keybindings?.matches(data, keybinding) ??
      defaultKeyMatches(data, keybinding),
  };

  constructor(
    private readonly registry: ChildRunRegistry,
    private readonly options: ChildRunsPanelOptions = {},
  ) {}

  ensureVisible(ctx: BrowserContextLike): void {
    this.hiddenByUser = false;
    this.show(ctx, false);
  }

  ensureVisibleForIssues(ctx: BrowserContextLike): void {
    if (this.hiddenByUser) return;
    this.show(ctx, false);
  }

  async showAndFocus(
    ctx: BrowserContextLike,
    preferred: BrowserSelection["kind"] = "child",
    refreshOnFocus = true,
  ): Promise<void> {
    this.hiddenByUser = false;
    if (!this.show(ctx, false, preferred)) return;
    if (this.focusBrowser(preferred, refreshOnFocus)) return;
    await this.openFallbackBrowser(preferred, refreshOnFocus);
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.detailClose?.();
    this.detailClose = undefined;
    if (this.detailIssueId !== undefined) {
      this.options.bitIssues?.cancelDetail(this.detailIssueId);
      this.detailIssueId = undefined;
    }
    this.fallbackClose?.();
    this.fallbackClose = undefined;
    if (this.isResidentFocused()) this.restoreFocus();
    if (this.state === "mounted") {
      this.ui?.setWidget(CHILD_RUNS_WIDGET_KEY, undefined);
    }
    this.unsubscribeInput?.();
    this.unsubscribeInput = undefined;
    this.component = undefined;
    this.editor = undefined;
    this.returnFocus = undefined;
    this.tui = undefined;
    this.ui = undefined;
    this.state = "disposed";
  }

  getMountState(): MountState {
    return this.state;
  }

  private show(
    ctx: BrowserContextLike,
    focus: boolean,
    preferred?: BrowserSelection["kind"],
  ): boolean {
    if (ctx.mode !== "tui" || this.state === "disposed") return false;
    if (this.state === "mounted") {
      if (preferred !== undefined) this.component?.prefer(preferred);
      if (focus && !this.focusBrowser(preferred)) {
        void this.openFallbackBrowser(preferred);
      }
      return true;
    }

    const ui = ctx.ui as unknown as WidgetUiLike;
    this.ui = ui;
    this.installInputListener(ui);
    try {
      ui.setWidget(
        CHILD_RUNS_WIDGET_KEY,
        (tui) => {
          this.tui = tui;
          this.captureCurrentFocus();
          const component = new ChildRunsBrowserComponent(
            this.registry,
            tui,
            this.keybindings,
            (runId) => this.openDetail(runId),
            () => this.restoreFocus(),
            () => this.hide(),
            this.bitIssueBindings(),
          );
          if (preferred !== undefined) component.prefer(preferred);
          this.component = component;
          return component;
        },
        { placement: "belowEditor" },
      );
      if (this.component === undefined || this.tui === undefined) {
        throw new Error("widget factory did not mount a component");
      }
      this.state = "mounted";
      if (focus && !this.focusBrowser(preferred)) {
        void this.openFallbackBrowser(preferred);
      }
      return true;
    } catch (error) {
      this.state = "unmounted";
      this.component?.dispose();
      this.component = undefined;
      ui.notify(
        `Coordination browser could not open: ${String(error)}`,
        "warning",
      );
      return false;
    }
  }

  private async openFallbackBrowser(
    preferred?: BrowserSelection["kind"],
    refreshOnFocus = true,
  ): Promise<void> {
    const { ui } = this;
    if (ui?.custom === undefined || this.state !== "mounted") {
      ui?.notify(
        "Coordination browser focus requires custom TUI support on this pi version.",
        "warning",
      );
      return;
    }
    if (this.fallbackPromise !== undefined) return this.fallbackPromise;

    let fallbackPromise: Promise<void>;
    try {
      fallbackPromise = ui.custom<void>(
        (tui, _theme, keybindings, done) => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            done(undefined);
          };
          this.fallbackClose = close;
          const component = new ChildRunsBrowserComponent(
            this.registry,
            tui,
            keybindings,
            (runId) => this.openDetail(runId),
            close,
            () => {
              this.hide();
              close();
            },
            this.bitIssueBindings(),
          );
          if (preferred !== undefined) component.prefer(preferred);
          if (refreshOnFocus) void this.options.refreshBitIssues?.();
          return component;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    } catch (error) {
      ui.notify(
        `Coordination browser fallback could not open: ${String(error)}`,
        "warning",
      );
      return;
    }

    this.fallbackPromise = fallbackPromise;
    await fallbackPromise
      .catch((error) => {
        ui.notify(
          `Coordination browser fallback could not open: ${String(error)}`,
          "warning",
        );
      })
      .finally(() => {
        if (this.fallbackPromise !== fallbackPromise) return;
        this.fallbackPromise = undefined;
        this.fallbackClose = undefined;
      });
  }

  private openDetail(runId: string): void {
    const { ui } = this;
    if (ui?.custom === undefined) {
      ui?.notify(
        "Child-session detail view requires custom TUI support.",
        "warning",
      );
      return;
    }
    if (this.detailPromise !== undefined) return;

    let detailPromise: Promise<void>;
    try {
      detailPromise = ui.custom<void>(
        (tui, theme, keybindings, done) => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            done(undefined);
          };
          this.detailClose = close;
          return new ChildRunDetailComponent(
            this.registry,
            runId,
            tui,
            keybindings,
            close,
            theme,
          );
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    } catch (error) {
      ui.notify(
        `Child-session detail view could not open: ${String(error)}`,
        "warning",
      );
      return;
    }

    this.detailPromise = detailPromise;
    void detailPromise
      .catch((error) => {
        ui.notify(
          `Child-session detail view could not open: ${String(error)}`,
          "warning",
        );
      })
      .finally(() => {
        if (this.detailPromise !== detailPromise) return;
        this.detailPromise = undefined;
        this.detailClose = undefined;
      });
  }

  private openIssueDetail(issueId: string): void {
    const { ui } = this;
    const registry = this.options.bitIssues;
    if (registry === undefined) return;
    if (ui?.custom === undefined) {
      ui?.notify(
        "Bit issue detail view requires custom TUI support.",
        "warning",
      );
      return;
    }
    if (this.detailPromise !== undefined) return;

    registry.prepareDetail(issueId);
    this.detailIssueId = issueId;
    let detailPromise: Promise<void>;
    try {
      detailPromise = ui.custom<void>(
        (tui, theme, keybindings, done) => {
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            registry.cancelDetail(issueId);
            done(undefined);
          };
          this.detailClose = close;
          return new BitIssueDetailComponent(
            registry,
            issueId,
            tui,
            keybindings,
            close,
            theme,
          );
        },
        {
          overlay: true,
          overlayOptions: {
            width: "100%",
            maxHeight: "100%",
            anchor: "center",
            margin: 1,
          },
        },
      );
    } catch (error) {
      registry.cancelDetail(issueId);
      this.detailIssueId = undefined;
      ui.notify(
        `Bit issue detail view could not open: ${String(error)}`,
        "warning",
      );
      return;
    }

    this.detailPromise = detailPromise;
    void (async () => {
      try {
        await this.options.refreshBitIssues?.();
      } catch {
        // Detail retrieval still provides a useful latest-state error.
      }
      if (this.detailIssueId === issueId) await registry.loadDetail(issueId);
    })();
    void detailPromise
      .catch((error) => {
        ui.notify(
          `Bit issue detail view could not open: ${String(error)}`,
          "warning",
        );
      })
      .finally(() => {
        if (this.detailPromise !== detailPromise) return;
        registry.cancelDetail(issueId);
        this.detailPromise = undefined;
        this.detailClose = undefined;
        this.detailIssueId = undefined;
      });
  }

  private bitIssueBindings(): BitIssueBrowserBindings | undefined {
    const registry = this.options.bitIssues;
    if (registry === undefined) return undefined;
    return {
      registry,
      onInspect: (issueId) => this.openIssueDetail(issueId),
      onRefresh: async () => {
        await this.options.refreshBitIssues?.();
      },
    };
  }

  private installInputListener(ui: WidgetUiLike): void {
    if (
      this.focusDegraded ||
      this.unsubscribeInput !== undefined ||
      ui.onTerminalInput === undefined
    )
      return;
    this.unsubscribeInput = ui.onTerminalInput((data) =>
      this.handleTerminalInput(data),
    );
  }

  private handleTerminalInput(data: string): { consume: true } | undefined {
    if (
      this.state !== "mounted" ||
      this.component === undefined ||
      this.tui === undefined ||
      isKeyRelease(data) ||
      !this.keybindings.matches(data, "tui.editor.cursorDown")
    ) {
      return undefined;
    }

    const focused = this.readCurrentFocus();
    if (focused === undefined || focused === this.component) return undefined;
    if (!isEditorLike(focused)) return undefined;
    this.captureFocusTarget(focused);
    const editor = focused;
    if (editor.isShowingAutocomplete?.() === true) return undefined;

    const beforeText = editor.getText();
    const beforeCursor = editor.getCursor();
    editor.handleInput(data);
    const afterText = editor.getText();
    const afterCursor = editor.getCursor();
    if (beforeText === afterText && sameCursor(beforeCursor, afterCursor)) {
      this.focusBrowser();
    } else {
      this.tui.requestRender();
    }
    return { consume: true };
  }

  private captureFocusTarget(
    candidate: ComponentLike | null | undefined,
  ): void {
    if (
      candidate === undefined ||
      candidate === null ||
      candidate === this.component
    )
      return;
    this.returnFocus = candidate;
    if (isEditorLike(candidate)) this.editor = candidate;
  }

  private focusBrowser(
    preferred?: BrowserSelection["kind"],
    refreshOnFocus = true,
  ): boolean {
    if (
      this.state !== "mounted" ||
      this.component === undefined ||
      this.focusDegraded
    )
      return false;
    const focused = this.readCurrentFocus();
    if (focused === undefined || focused === null) return false;
    this.captureFocusTarget(focused);
    if (this.returnFocus === undefined || this.tui === undefined) return false;
    if (preferred !== undefined) this.component.prefer(preferred);
    const result = setFocusSafely(this.tui, this.component);
    if (!result.ok) {
      this.degradeFocus(result.reason);
      return false;
    }
    this.tui.requestRender();
    if (refreshOnFocus) void this.options.refreshBitIssues?.();
    return true;
  }

  private restoreFocus(): void {
    if (this.returnFocus === undefined || this.tui === undefined) return;
    const result = setFocusSafely(this.tui, this.returnFocus);
    if (!result.ok) {
      this.degradeFocus(result.reason);
      return;
    }
    this.tui.requestRender();
  }

  private captureCurrentFocus(): void {
    const focused = this.readCurrentFocus();
    if (focused !== undefined) this.captureFocusTarget(focused);
  }

  private readCurrentFocus(): ComponentLike | null | undefined {
    if (this.tui === undefined || this.focusDegraded) return undefined;
    const result = readFocusedComponent(this.tui);
    if (!result.supported) {
      this.degradeFocus(result.reason);
      return undefined;
    }
    return result.component;
  }

  private isResidentFocused(): boolean {
    if (this.component === undefined) return false;
    return this.readCurrentFocus() === this.component;
  }

  private degradeFocus(reason: string): void {
    if (!this.focusDegraded) {
      this.focusDegraded = true;
      this.unsubscribeInput?.();
      this.unsubscribeInput = undefined;
    }
    if (this.focusWarningShown) return;
    this.focusWarningShown = true;
    const fallbackKeys =
      this.options.bitIssues === undefined
        ? "/subagents or Ctrl+Alt+S"
        : "/subagents, /bit-issues, Ctrl+Alt+S, or Ctrl+Alt+I";
    this.ui?.notify(
      `Coordination browser focus degraded: ${reason}. Use ${fallbackKeys} for the public overlay fallback.`,
      "warning",
    );
  }

  private hide(): void {
    if (this.state !== "mounted") return;
    this.hiddenByUser = true;
    if (this.isResidentFocused()) this.restoreFocus();
    this.state = "unmounted";
    this.component = undefined;
    this.ui?.setWidget(CHILD_RUNS_WIDGET_KEY, undefined);
  }
}
