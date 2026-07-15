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
import { statusIcon, type ComponentLike } from "./presentation";
import { ChildRunRegistry } from "./registry";

interface TuiLike {
  terminal: { rows: number };
  requestRender(force?: boolean): void;
}

interface KeybindingsLike {
  matches(data: string, keybinding: string): boolean;
}

interface OverlayHandleLike {
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(options?: { target: ComponentLike | null }): void;
  isFocused(): boolean;
}

interface OverlayOptionsLike {
  width?: number | `${number}%`;
  maxHeight?: number | `${number}%`;
  anchor?: string;
  margin?: number;
  nonCapturing?: boolean;
  visible?: (termWidth: number, termHeight: number) => boolean;
}

interface CustomUiLike {
  custom<T>(
    factory: (
      tui: TuiLike,
      theme: unknown,
      keybindings: KeybindingsLike,
      done: (result: T) => void,
    ) => ComponentLike,
    options: {
      overlay: true;
      overlayOptions: OverlayOptionsLike | (() => OverlayOptionsLike);
      onHandle: (handle: OverlayHandleLike) => void;
    },
  ): Promise<T>;
  notify(message: string, level?: "info" | "warning" | "error"): void;
}

export type BrowserContextLike = CtxLike;

type BrowserMode = "list" | "detail";

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

const line = (value: string, width: number): string =>
  truncateToWidth(stripTerminalControls(value), Math.max(0, width), "");

const taskOneLine = (task: string): string =>
  stripTerminalControls(task, " ").replace(/\s+/g, " ").trim();

const transcriptLines = (item: TranscriptItem, width: number): string[] => {
  if (item.type === "assistant") {
    return ["assistant:"].concat(
      wrapPlainText(item.text, Math.max(1, width - 2)).map(
        (part) => `  ${part}`,
      ),
    );
  }
  if (item.type === "tool") {
    let runStatus: ChildRunStatus = "succeeded";
    if (item.status === "running") runStatus = "running";
    else if (item.status === "failed") runStatus = "failed";
    else if (item.status === "interrupted") runStatus = "aborted";
    return [
      `${statusIcon(runStatus)} tool-${item.localId} ${item.name} (${item.status})`,
    ];
  }
  return [
    `… transcript truncated (${item.omittedItems} items, ${item.omittedBytes} bytes omitted)`,
  ];
};

export class ChildRunsBrowserComponent implements ComponentLike {
  private mode: BrowserMode = "list";
  private selectedRunId: string | undefined;
  private listOffset = 0;
  private detailOffset = 0;
  private follow = true;
  private lastDetailMaxOffset = 0;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly registry: ChildRunRegistry,
    private readonly tui: TuiLike,
    private readonly keybindings: KeybindingsLike,
    private readonly onUnfocus: () => void,
    private readonly onHide: () => void,
  ) {
    this.unsubscribe = registry.subscribe(() => this.tui.requestRender());
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const height = Math.max(
      6,
      Math.min(Math.floor(this.tui.terminal.rows * 0.8), 30),
    );
    const snapshots = this.registry.getSnapshots();
    const runs = flattenRuns(snapshots);
    if (
      this.selectedRunId === undefined ||
      !runs.some(({ run }) => run.runId === this.selectedRunId)
    ) {
      this.selectedRunId = runs[0]?.run.runId;
    }

    const body =
      this.mode === "detail"
        ? this.renderDetail(runs, safeWidth, height - 3)
        : this.renderList(snapshots, runs, safeWidth, height - 3);
    const title =
      this.mode === "detail" ? " Child session " : " Child sessions ";
    const borderWidth = Math.max(1, safeWidth - visibleWidth(title));
    return [
      line(`${title}${"─".repeat(borderWidth)}`, safeWidth),
      ...body,
      line(
        this.mode === "detail"
          ? "←/b list  ↑↓ scroll  End live  Esc unfocus  q hide"
          : "↑↓ select  Enter inspect  Esc unfocus  q hide",
        safeWidth,
      ),
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

    if (this.mode === "list") {
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
        this.matches(data, "tui.editor.cursorRight")
      ) {
        if (this.selectedRunId !== undefined) {
          this.mode = "detail";
          this.follow = true;
          this.detailOffset = 0;
        }
      } else return;
    } else {
      if (data === "b" || this.matches(data, "tui.editor.cursorLeft")) {
        this.mode = "list";
      } else if (this.matches(data, "tui.select.up") || data === "k") {
        this.follow = false;
        this.detailOffset = Math.max(0, this.detailOffset - 1);
      } else if (this.matches(data, "tui.select.pageUp")) {
        this.follow = false;
        this.detailOffset = Math.max(0, this.detailOffset - 8);
      } else if (this.matches(data, "tui.select.down") || data === "j") {
        this.detailOffset = Math.min(
          this.lastDetailMaxOffset,
          this.detailOffset + 1,
        );
        this.follow = this.detailOffset >= this.lastDetailMaxOffset;
      } else if (this.matches(data, "tui.select.pageDown")) {
        this.detailOffset = Math.min(
          this.lastDetailMaxOffset,
          this.detailOffset + 8,
        );
        this.follow = this.detailOffset >= this.lastDetailMaxOffset;
      } else if (this.matches(data, "tui.editor.cursorLineEnd")) {
        this.follow = true;
        this.detailOffset = this.lastDetailMaxOffset;
      } else return;
    }
    this.tui.requestRender();
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe();
  }

  getSelectedRunId(): string | undefined {
    return this.selectedRunId;
  }

  getMode(): BrowserMode {
    return this.mode;
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

  private renderDetail(
    runs: FlatRun[],
    width: number,
    viewport: number,
  ): string[] {
    const selected = runs.find(({ run }) => run.runId === this.selectedRunId);
    if (selected === undefined) {
      this.mode = "list";
      return [line("Selected child run is no longer available.", width)];
    }
    const { invocation, run } = selected;
    const allLines: string[] = [
      `${run.agent} · ${statusLabel(run.status)}`,
      `${invocation.label}${run.stageName ? ` · ${run.stageName}` : ""}`,
      `task: ${taskOneLine(run.task)}`,
      "",
    ];
    for (const item of run.transcript) {
      allLines.push(...transcriptLines(item, width));
    }
    if (run.liveDraft) {
      allLines.push("assistant [live]:");
      allLines.push(
        ...wrapPlainText(run.liveDraft, Math.max(1, width - 2)).map(
          (part) => `  ${part}`,
        ),
      );
    }
    if (run.transcript.length === 0 && !run.liveDraft) {
      allLines.push(
        run.status === "queued" ? "(not launched)" : "(no assistant text yet)",
      );
    }
    if (run.protocolWarnings > 0) {
      allLines.push(`(${run.protocolWarnings} child stream warning(s))`);
    }
    this.lastDetailMaxOffset = Math.max(0, allLines.length - viewport);
    if (this.follow) this.detailOffset = this.lastDetailMaxOffset;
    else
      this.detailOffset = Math.min(this.detailOffset, this.lastDetailMaxOffset);
    const visible = allLines.slice(
      this.detailOffset,
      this.detailOffset + Math.max(1, viewport),
    );
    if (this.follow && run.status === "running") {
      visible[0] = `[LIVE] ${visible[0] ?? ""}`;
    } else if (!this.follow) {
      visible[0] = `[PAUSED] ${visible[0] ?? ""}`;
    }
    return visible.map((item) => line(item, width));
  }

  private matches(data: string, keybinding: string): boolean {
    try {
      return this.keybindings.matches(data, keybinding);
    } catch {
      return false;
    }
  }
}

type MountState = "unmounted" | "mounting" | "mounted" | "disposed";

export class ChildRunsOverlayController {
  private state: MountState = "unmounted";
  private handle: OverlayHandleLike | undefined;
  private component: ChildRunsBrowserComponent | undefined;
  private pendingFocus = false;
  private explicitlyVisible = false;
  private ready: Promise<boolean> | undefined;

  constructor(private readonly registry: ChildRunRegistry) {}

  ensureVisible(ctx: BrowserContextLike): void {
    void this.show(ctx, false);
  }

  async showAndFocus(ctx: BrowserContextLike): Promise<void> {
    await this.show(ctx, true);
  }

  dispose(): void {
    if (this.state === "disposed") return;
    this.state = "disposed";
    this.component?.dispose();
    this.component = undefined;
    this.explicitlyVisible = false;
    this.handle?.hide();
    this.handle = undefined;
  }

  getMountState(): MountState {
    return this.state;
  }

  getHandle(): OverlayHandleLike | undefined {
    return this.handle;
  }

  private async show(
    ctx: BrowserContextLike,
    focus: boolean,
  ): Promise<boolean> {
    if (ctx.mode !== "tui" || this.state === "disposed") return false;
    if (focus) this.explicitlyVisible = true;
    if (this.state === "mounted" && this.handle !== undefined) {
      this.handle.setHidden(false);
      if (focus) this.handle.focus();
      return true;
    }
    if (this.state === "mounting") {
      this.pendingFocus ||= focus;
      return (await this.ready) ?? false;
    }

    this.state = "mounting";
    this.pendingFocus = focus;
    let settleReady: (mounted: boolean) => void = () => {};
    this.ready = new Promise<boolean>((resolve) => {
      settleReady = resolve;
    });
    const ui = ctx.ui as unknown as CustomUiLike;
    let localComponent: ChildRunsBrowserComponent | undefined;
    const customPromise = ui.custom<void>(
      (tui, _theme, keybindings) => {
        localComponent = new ChildRunsBrowserComponent(
          this.registry,
          tui,
          keybindings,
          () => this.handle?.unfocus(),
          () => this.hide(),
        );
        this.component = localComponent;
        return localComponent;
      },
      {
        overlay: true,
        overlayOptions: () => ({
          nonCapturing: true,
          anchor: "right-center",
          width: 48,
          maxHeight: "80%",
          margin: 1,
          visible: (termWidth) =>
            termWidth >= 120 ||
            this.explicitlyVisible ||
            this.handle?.isFocused() === true,
        }),
        onHandle: (handle) => {
          if (this.state === "disposed") {
            handle.hide();
            settleReady(false);
            return;
          }
          this.handle = handle;
          this.state = "mounted";
          handle.setHidden(false);
          if (this.pendingFocus) handle.focus();
          this.pendingFocus = false;
          settleReady(true);
        },
      },
    );
    void customPromise
      .then(() => {
        if (this.state === "disposed") return;
        localComponent?.dispose();
        if (this.component === localComponent) this.component = undefined;
        this.handle = undefined;
        this.explicitlyVisible = false;
        this.state = "unmounted";
      })
      .catch((error) => {
        if (this.state !== "disposed") {
          this.state = "unmounted";
          this.handle = undefined;
          this.explicitlyVisible = false;
          this.component?.dispose();
          this.component = undefined;
          ui.notify(
            `Child-session browser could not open: ${String(error)}`,
            "warning",
          );
        }
        settleReady(false);
      });
    return (await this.ready) ?? false;
  }

  private hide(): void {
    this.explicitlyVisible = false;
    this.handle?.unfocus();
    this.handle?.setHidden(true);
  }
}
