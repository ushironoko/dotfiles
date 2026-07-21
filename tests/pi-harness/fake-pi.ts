/**
 * In-memory PiLike fake for adapter-layer tests.
 *
 * Tests drive it by emitting events and asserting on observable results
 * (block decisions, patched content, notifications) — never on handler
 * registration internals.
 *
 * Chain semantics encoded here (sources noted per plan's V-numbering):
 * - tool_call: handlers run in registration order; the first {block:true}
 *   short-circuits the chain (V2 verified block + verbatim reason delivery
 *   with a single handler; multi-handler ordering follows pi docs "load
 *   order chaining").
 * - tool_result: handlers chain middleware-style; a patch returned by one
 *   handler is visible to the next (pi docs).
 * - Blocked tool calls fire NO tool_result event (V2 measurement: blocked
 *   bash produced no tool_result in fixtures).
 */
import type {
  AgentStartInjection,
  BeforeAgentStartEvent,
  ContextUsageLike,
  CtxLike,
  DialogOptionsLike,
  FooterComponentLike,
  FooterDataLike,
  GenericEvent,
  InputEvent,
  ModelLike,
  NotifyLevel,
  PiEventHandler,
  PiModeLike,
  ThemeLike,
  TuiLike,
  PiEventName,
  PiLike,
  SessionStartEvent,
  ToolCallBlockResult,
  ToolCallEvent,
  ToolDefLike,
  ToolResultEvent,
  ToolResultPatch,
} from "../../pi/extensions/pi-harness/lib/pi-like";

interface Notification {
  message: string;
  level: NotifyLevel;
}

interface SelectDialog {
  title: string;
  options: string[];
  dialogOptions?: DialogOptionsLike;
}

interface InputDialog {
  title: string;
  placeholder?: string;
  dialogOptions?: DialogOptionsLike;
}

interface ConfirmDialog {
  title: string;
  message: string;
  dialogOptions?: DialogOptionsLike;
}

interface HandlerStore {
  session_start: PiEventHandler<"session_start">[];
  input: PiEventHandler<"input">[];
  before_agent_start: PiEventHandler<"before_agent_start">[];
  context: PiEventHandler<"context">[];
  tool_call: PiEventHandler<"tool_call">[];
  tool_result: PiEventHandler<"tool_result">[];
  agent_settled: PiEventHandler<"agent_settled">[];
  session_compact: PiEventHandler<"session_compact">[];
  session_shutdown: PiEventHandler<"session_shutdown">[];
  before_provider_request: PiEventHandler<"before_provider_request">[];
  after_provider_response: PiEventHandler<"after_provider_response">[];
}

export interface FakePi extends PiLike {
  emitSessionStart(payload: SessionStartEvent): Promise<void>;
  emitInput(payload: InputEvent): Promise<void>;
  emitBeforeAgentStart(
    payload: BeforeAgentStartEvent,
  ): Promise<AgentStartInjection | undefined>;
  emitContext(messages: unknown[]): Promise<void>;
  emitToolCall(
    payload: ToolCallEvent,
  ): Promise<ToolCallBlockResult | undefined>;
  emitToolResult(
    payload: ToolResultEvent,
  ): Promise<ToolResultPatch | undefined>;
  emitAgentSettled(payload?: GenericEvent): Promise<void>;
  emitSessionCompact(payload?: GenericEvent): Promise<void>;
  emitSessionShutdown(payload?: GenericEvent): Promise<void>;
  emitBeforeProviderRequest(payload: GenericEvent): Promise<void>;
  emitAfterProviderResponse(payload: GenericEvent): Promise<void>;
  /** Tools registered via registerTool, in order. */
  readonly tools: ToolDefLike[];
  /** Extension command names registered through the public API. */
  readonly commands: ReadonlySet<string>;
  /** Extension shortcuts registered through the public API. */
  readonly shortcuts: ReadonlySet<string>;
  /** Custom-entry renderer names registered through the public API. */
  readonly entryRenderers: ReadonlySet<string>;
  /** Entries appended through the public extension API. */
  readonly appendedEntries: readonly {
    customType: string;
    data: unknown;
  }[];
  /** Notifications captured from ctx.ui.notify. */
  readonly notifications: Notification[];
  /** Widget lines captured from ctx.ui.setWidget, keyed by widget id. */
  readonly widgets: Map<string, string[] | undefined>;
  /** Render the currently installed custom footer with the identity theme. */
  renderFooter(width: number): string[] | undefined;
  /** Notify footer branch subscribers, matching FooterDataProvider behavior. */
  setGitBranch(branch: string | null): void;
  /** Replace the context-usage result returned by the handler context. */
  setContextUsage(usage: ContextUsageLike | undefined): void;
  /** Number of renders requested through the fake TUI. */
  readonly footerRenderRequests: number;
  /** Queue a response for the next ctx.ui.confirm call (defaults to false). */
  queueConfirm(answer: boolean): void;
  /** Select the zero-based option on the next ctx.ui.select call. */
  queueSelectIndex(index: number | undefined): void;
  /** Queue text (or cancellation) for the next ctx.ui.input call. */
  queueInput(answer: string | undefined): void;
  /** Dialogs captured at the UI boundary. */
  readonly selectDialogs: SelectDialog[];
  readonly inputDialogs: InputDialog[];
  readonly confirmDialogs: ConfirmDialog[];
  /** Context handed to every handler; mutate hasUI to simulate print mode. */
  readonly ctx: CtxLike & { hasUI: boolean };
}

export function createFakePi(
  options: {
    hasUI?: boolean;
    mode?: PiModeLike;
    cwd?: string;
    gitBranch?: string | null;
    model?: ModelLike;
    contextUsage?: ContextUsageLike;
  } = {},
): FakePi {
  const store: HandlerStore = {
    session_start: [],
    input: [],
    before_agent_start: [],
    context: [],
    tool_call: [],
    tool_result: [],
    agent_settled: [],
    session_compact: [],
    session_shutdown: [],
    before_provider_request: [],
    after_provider_response: [],
  };
  const tools: ToolDefLike[] = [];
  const commands = new Set<string>();
  const shortcuts = new Set<string>();
  const entryRenderers = new Set<string>();
  const appendedEntries: { customType: string; data: unknown }[] = [];
  const notifications: Notification[] = [];
  const widgets = new Map<string, string[] | undefined>();
  const confirmQueue: boolean[] = [];
  const selectQueue: { index: number | undefined }[] = [];
  const inputQueue: { answer: string | undefined }[] = [];
  const selectDialogs: SelectDialog[] = [];
  const inputDialogs: InputDialog[] = [];
  const confirmDialogs: ConfirmDialog[] = [];
  const branchCallbacks = new Set<() => void>();
  let gitBranch = options.gitBranch ?? null;
  let { contextUsage } = options;
  let footerComponent: FooterComponentLike | undefined;
  let footerRenderRequests = 0;

  const tui: TuiLike = {
    requestRender: () => {
      footerRenderRequests += 1;
    },
  };
  const theme: ThemeLike = { fg: (_color, text) => text };
  const footerData: FooterDataLike = {
    getGitBranch: () => gitBranch,
    onBranchChange: (callback) => {
      branchCallbacks.add(callback);
      return () => branchCallbacks.delete(callback);
    },
  };

  const ctx: CtxLike & { hasUI: boolean } = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    cwd: options.cwd,
    model: options.model,
    getContextUsage: () => contextUsage,
    ui: {
      select: async (title, choices, dialogOptions) => {
        selectDialogs.push({
          title,
          options: [...choices],
          dialogOptions,
        });
        const reply = selectQueue.shift();
        return reply?.index === undefined ? undefined : choices[reply.index];
      },
      confirm: async (title, message, dialogOptions) => {
        confirmDialogs.push({ title, message, dialogOptions });
        return confirmQueue.shift() ?? false;
      },
      input: async (title, placeholder, dialogOptions) => {
        inputDialogs.push({ title, placeholder, dialogOptions });
        return inputQueue.shift()?.answer;
      },
      notify: (message, level) => {
        notifications.push({ message, level: level ?? "info" });
      },
      setWidget: (key, lines) => {
        widgets.set(key, lines);
      },
      setFooter: (factory) => {
        footerComponent?.dispose?.();
        footerComponent = factory?.(tui, theme, footerData);
      },
    },
  };

  // Indexing a mapped type by the single type parameter K distributes
  // correctly (unlike writing through store[event] directly, which TS
  // rejects as an intersection write).
  const registrars: {
    [K in PiEventName]: (handler: PiEventHandler<K>) => void;
  } = {
    session_start: (handler) => store.session_start.push(handler),
    input: (handler) => store.input.push(handler),
    before_agent_start: (handler) => store.before_agent_start.push(handler),
    context: (handler) => store.context.push(handler),
    tool_call: (handler) => store.tool_call.push(handler),
    tool_result: (handler) => store.tool_result.push(handler),
    agent_settled: (handler) => store.agent_settled.push(handler),
    session_compact: (handler) => store.session_compact.push(handler),
    session_shutdown: (handler) => store.session_shutdown.push(handler),
    before_provider_request: (handler) =>
      store.before_provider_request.push(handler),
    after_provider_response: (handler) =>
      store.after_provider_response.push(handler),
  };

  return {
    on<K extends PiEventName>(event: K, handler: PiEventHandler<K>) {
      registrars[event](handler);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    registerCommand(name, _options) {
      commands.add(name);
    },
    registerShortcut(shortcut, _options) {
      shortcuts.add(shortcut);
    },
    registerEntryRenderer(customType, _renderer) {
      entryRenderers.add(customType);
    },
    appendEntry(customType, data) {
      appendedEntries.push({ customType, data });
    },
    getThinkingLevel() {
      return "off";
    },
    async emitSessionStart(payload) {
      for (const handler of store.session_start) await handler(payload, ctx);
    },
    async emitInput(payload) {
      for (const handler of store.input) await handler(payload, ctx);
    },
    async emitBeforeAgentStart(payload) {
      let injection: AgentStartInjection | undefined;
      for (const handler of store.before_agent_start) {
        const result = await handler(payload, ctx);
        if (result !== undefined) injection = result;
      }
      return injection;
    },
    async emitContext(messages) {
      for (const handler of store.context) {
        await handler({ type: "context", messages }, ctx);
      }
    },
    async emitToolCall(payload) {
      for (const handler of store.tool_call) {
        const result = await handler(payload, ctx);
        if (result !== undefined && result.block === true) return result;
      }
      return undefined;
    },
    async emitToolResult(payload) {
      let current = payload;
      let lastPatch: ToolResultPatch | undefined;
      for (const handler of store.tool_result) {
        const patch = await handler(current, ctx);
        if (patch !== undefined) {
          lastPatch = patch;
          current = { ...current, ...patch };
        }
      }
      return lastPatch;
    },
    async emitAgentSettled(payload = { type: "agent_settled" }) {
      for (const handler of store.agent_settled) await handler(payload, ctx);
    },
    async emitSessionCompact(payload = { type: "session_compact" }) {
      for (const handler of store.session_compact) await handler(payload, ctx);
    },
    async emitSessionShutdown(payload = { type: "session_shutdown" }) {
      for (const handler of store.session_shutdown) await handler(payload, ctx);
    },
    async emitBeforeProviderRequest(payload) {
      for (const handler of store.before_provider_request) {
        await handler(payload, ctx);
      }
    },
    async emitAfterProviderResponse(payload) {
      for (const handler of store.after_provider_response) {
        await handler(payload, ctx);
      }
    },
    tools,
    commands,
    shortcuts,
    entryRenderers,
    appendedEntries,
    notifications,
    widgets,
    renderFooter(width) {
      return footerComponent?.render(width);
    },
    setGitBranch(branch) {
      gitBranch = branch;
      for (const callback of branchCallbacks) callback();
    },
    setContextUsage(usage) {
      contextUsage = usage;
    },
    get footerRenderRequests() {
      return footerRenderRequests;
    },
    queueConfirm(answer) {
      confirmQueue.push(answer);
    },
    queueSelectIndex(index) {
      selectQueue.push({ index });
    },
    queueInput(answer) {
      inputQueue.push({ answer });
    },
    selectDialogs,
    inputDialogs,
    confirmDialogs,
    ctx,
  };
}
