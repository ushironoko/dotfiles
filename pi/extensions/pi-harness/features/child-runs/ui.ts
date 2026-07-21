import type { CtxLike } from "../../lib/pi-like";
import {
  stripTerminalControls,
  truncateToWidth,
  visibleWidth,
  wrapPlainText,
} from "../../lib/terminal-text";
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

const statusLabel = (status: ChildRunStatus): string =>
  `${statusIcon(status)} ${status}`;

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

const wrapDetailLine = (value: string, width: number): string[] =>
  wrapPlainText(stripTerminalControls(value), Math.max(1, width));

const wrapDetailText = (
  prefix: string,
  value: string,
  width: number,
): string[] => {
  const safeWidth = Math.max(1, width);
  const safePrefix = stripTerminalControls(prefix, " ");
  const safeValue = stripTerminalControls(value);
  const prefixWidth = visibleWidth(safePrefix);
  if (prefixWidth >= safeWidth) {
    return wrapDetailLine(`${safePrefix}${safeValue}`, safeWidth);
  }
  const continuation = " ".repeat(prefixWidth);
  return wrapPlainText(safeValue, safeWidth - prefixWidth).map(
    (part, index) => `${index === 0 ? safePrefix : continuation}${part}`,
  );
};

const transcriptLines = (item: TranscriptItem, width: number): string[] => {
  if (item.type === "assistant") {
    return ["assistant:", ...wrapDetailText("  ", item.text, width)];
  }
  if (item.type === "tool") {
    let runStatus: ChildRunStatus = "succeeded";
    if (item.status === "running") runStatus = "running";
    else if (item.status === "failed") runStatus = "failed";
    else if (item.status === "interrupted") runStatus = "aborted";
    return wrapDetailLine(
      `${statusIcon(runStatus)} tool-${item.localId} ${item.name} (${item.status})`,
      width,
    );
  }
  return wrapDetailLine(
    `… transcript truncated (${item.omittedItems} items, ${item.omittedBytes} bytes omitted)`,
    width,
  );
};

export class ChildRunsBrowserComponent implements ComponentLike {
  private selectedRunId: string | undefined;
  private listOffset = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly registry: ChildRunRegistry,
    private readonly tui: TuiLike,
    private readonly keybindings: KeybindingsLike,
    private readonly onInspect: (runId: string) => void,
    private readonly onUnfocus: () => void,
    private readonly onHide: () => void,
  ) {
    this.unsubscribe = registry.subscribe(() => this.tui.requestRender());
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    // The browser now participates in normal layout flow with chat, editor,
    // status rows, and footer. Keep its budget conservative rather than using
    // the former overlay-sized 80%/30-row cap. Common 24/40-row terminals get
    // at most 6/10 browser rows; very small terminals retain minimal controls.
    const height = Math.max(
      4,
      Math.min(Math.floor(this.tui.terminal.rows / 4), 10),
    );
    const snapshots = this.registry.getSnapshots();
    const runs = flattenRuns(snapshots);
    if (
      this.selectedRunId === undefined ||
      !runs.some(({ run }) => run.runId === this.selectedRunId)
    ) {
      this.selectedRunId = runs[0]?.run.runId;
    }

    const body = this.renderList(snapshots, runs, safeWidth, height - 2);
    const title = " Child sessions ";
    const borderWidth = Math.max(1, safeWidth - visibleWidth(title));
    return [
      line(`${title}${"─".repeat(borderWidth)}`, safeWidth),
      ...body,
      line("↑↓ select  Enter inspect  Esc unfocus  q hide", safeWidth),
    ].slice(0, height);
  }

  handleInput(data: string): void {
    const runs = flattenRuns(this.registry.getSnapshots());
    if (data === "q") {
      this.onHide();
      return;
    }
    if (this.matches(data, "tui.select.cancel")) {
      this.onUnfocus();
      return;
    }

    const current = Math.max(
      0,
      runs.findIndex(({ run }) => run.runId === this.selectedRunId),
    );
    if (this.matches(data, "tui.select.up") || data === "k") {
      this.selectedRunId = runs[Math.max(0, current - 1)]?.run.runId;
    } else if (this.matches(data, "tui.select.down") || data === "j") {
      this.selectedRunId =
        runs[Math.min(runs.length - 1, current + 1)]?.run.runId;
    } else if (this.matches(data, "tui.select.pageUp")) {
      this.selectedRunId = runs[Math.max(0, current - 8)]?.run.runId;
    } else if (this.matches(data, "tui.select.pageDown")) {
      this.selectedRunId =
        runs[Math.min(runs.length - 1, current + 8)]?.run.runId;
    } else if (
      this.matches(data, "tui.select.confirm") ||
      defaultKeyMatches(data, "tui.select.confirm") ||
      this.matches(data, "tui.editor.cursorRight")
    ) {
      if (this.selectedRunId !== undefined) {
        this.onInspect(this.selectedRunId);
      }
    } else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  getSelectedRunId(): string | undefined {
    return this.selectedRunId;
  }

  private renderList(
    snapshots: ChildInvocationSnapshot[],
    runs: FlatRun[],
    width: number,
    viewport: number,
  ): string[] {
    if (runs.length === 0) {
      return [
        line("No child runs on this session branch.", width),
        line("Start subagent or workflow to populate this view.", width),
      ];
    }
    const rendered: { text: string; runId?: string }[] = [];
    for (const invocation of snapshots) {
      rendered.push({
        text: `${invocation.label} · ${invocation.source} · ${invocation.runs.length} run(s)`,
      });
      for (const run of invocation.runs) {
        const stage =
          run.stageIndex === undefined
            ? `${run.taskIndex + 1}`
            : `S${run.stageIndex + 1}/T${run.taskIndex + 1}`;
        rendered.push({
          runId: run.runId,
          text: `${run.runId === this.selectedRunId ? ">" : " "} ${statusIcon(run.status)} ${stage} ${run.agent} — ${taskOneLine(run.task)}`,
        });
      }
    }
    const selectedLine = Math.max(
      0,
      rendered.findIndex((item) => item.runId === this.selectedRunId),
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

  private matches(data: string, keybinding: string): boolean {
    try {
      return this.keybindings.matches(data, keybinding);
    } catch {
      return false;
    }
  }
}

const detailContentLines = (selected: FlatRun, width: number): string[] => {
  const { invocation, run } = selected;
  const lines: string[] = [
    ...wrapDetailLine(`${run.agent} · ${statusLabel(run.status)}`, width),
    ...wrapDetailLine(
      `${invocation.label}${run.stageName ? ` · ${run.stageName}` : ""}`,
      width,
    ),
    ...wrapDetailText("task: ", taskOneLine(run.task), width),
    "",
  ];
  for (const item of run.transcript) {
    lines.push(...transcriptLines(item, width));
  }
  if (run.liveDraft) {
    lines.push("assistant [live]:");
    lines.push(...wrapDetailText("  ", run.liveDraft, width));
  }
  if (run.transcript.length === 0 && !run.liveDraft) {
    lines.push(
      ...wrapDetailLine(
        run.status === "queued" ? "(not launched)" : "(no assistant text yet)",
        width,
      ),
    );
  }
  if (run.protocolWarnings > 0) {
    lines.push(
      ...wrapDetailLine(
        `(${run.protocolWarnings} child stream warning(s))`,
        width,
      ),
    );
  }
  return lines;
};

/** Focused, near-full-screen transcript viewer for one fixed child run. */
export class ChildRunDetailComponent implements ComponentLike {
  private offset = 0;
  private follow: boolean;
  private lastMaxOffset = 0;
  private lastViewport = 1;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly registry: ChildRunRegistry,
    private readonly runId: string,
    private readonly tui: TuiLike,
    private readonly keybindings: KeybindingsLike,
    private readonly onClose: () => void,
  ) {
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
        ? wrapDetailLine(
            "Selected child run is no longer available.",
            safeWidth,
          )
        : detailContentLines(selected, safeWidth);

    this.lastMaxOffset = Math.max(0, allLines.length - viewport);
    if (this.follow) this.offset = this.lastMaxOffset;
    else this.offset = Math.min(this.offset, this.lastMaxOffset);

    const visible = allLines.slice(this.offset, this.offset + viewport);
    while (visible.length < viewport) visible.push("");

    const running = selected?.run.status === "running";
    let state = "";
    if (running && this.follow) state = " · LIVE";
    else if (!this.follow) state = " · PAUSED";
    const title = ` Child session${state} `;
    const borderWidth = Math.max(1, safeWidth - visibleWidth(title));
    const first = allLines.length === 0 ? 0 : this.offset + 1;
    const last = Math.min(allLines.length, this.offset + viewport);
    const position = `${first}-${last}/${allLines.length}`;
    const output: string[] = [];
    if (showTitle) {
      output.push(line(`${title}${"─".repeat(borderWidth)}`, safeWidth));
    }
    output.push(...visible.map((item) => line(item, safeWidth)));
    if (showHint) {
      output.push(
        line(
          `↑↓ scroll  PgUp/PgDn page  Home/End  Esc/←/b close  ${position}`,
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
  private fallbackClose: (() => void) | undefined;
  private fallbackPromise: Promise<void> | undefined;
  private focusDegraded = false;
  private focusWarningShown = false;
  private readonly keybindings: KeybindingsLike = {
    matches: (data, keybinding) =>
      this.editor?.keybindings?.matches(data, keybinding) ??
      defaultKeyMatches(data, keybinding),
  };

  constructor(private readonly registry: ChildRunRegistry) {}

  ensureVisible(ctx: BrowserContextLike): void {
    this.show(ctx, false);
  }

  async showAndFocus(ctx: BrowserContextLike): Promise<void> {
    if (!this.show(ctx, false)) return;
    if (this.focusBrowser()) return;
    await this.openFallbackBrowser();
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.detailClose?.();
    this.detailClose = undefined;
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

  private show(ctx: BrowserContextLike, focus: boolean): boolean {
    if (ctx.mode !== "tui" || this.state === "disposed") return false;
    if (this.state === "mounted") {
      if (focus && !this.focusBrowser()) void this.openFallbackBrowser();
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
          );
          this.component = component;
          return component;
        },
        { placement: "belowEditor" },
      );
      if (this.component === undefined || this.tui === undefined) {
        throw new Error("widget factory did not mount a component");
      }
      this.state = "mounted";
      if (focus && !this.focusBrowser()) void this.openFallbackBrowser();
      return true;
    } catch (error) {
      this.state = "unmounted";
      this.component?.dispose();
      this.component = undefined;
      ui.notify(
        `Child-session browser could not open: ${String(error)}`,
        "warning",
      );
      return false;
    }
  }

  private async openFallbackBrowser(): Promise<void> {
    const { ui } = this;
    if (ui?.custom === undefined || this.state !== "mounted") {
      ui?.notify(
        "Child-session browser focus requires custom TUI support on this pi version.",
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
          return new ChildRunsBrowserComponent(
            this.registry,
            tui,
            keybindings,
            (runId) => this.openDetail(runId),
            close,
            () => {
              this.hide();
              close();
            },
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
        `Child-session browser fallback could not open: ${String(error)}`,
        "warning",
      );
      return;
    }

    this.fallbackPromise = fallbackPromise;
    await fallbackPromise
      .catch((error) => {
        ui.notify(
          `Child-session browser fallback could not open: ${String(error)}`,
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
        (tui, _theme, keybindings, done) => {
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

  private focusBrowser(): boolean {
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
    const result = setFocusSafely(this.tui, this.component);
    if (!result.ok) {
      this.degradeFocus(result.reason);
      return false;
    }
    this.tui.requestRender();
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
    this.ui?.notify(
      `Child-session browser focus degraded: ${reason}. Use /subagents or Ctrl+Alt+S for the public overlay fallback.`,
      "warning",
    );
  }

  private hide(): void {
    if (this.state !== "mounted") return;
    if (this.isResidentFocused()) this.restoreFocus();
    this.state = "unmounted";
    this.component = undefined;
    this.ui?.setWidget(CHILD_RUNS_WIDGET_KEY, undefined);
  }
}
