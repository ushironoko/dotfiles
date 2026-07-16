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
  CtxLike,
  DialogOptionsLike,
  GenericEvent,
  NotifyLevel,
  PiEventHandler,
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
  before_agent_start: PiEventHandler<"before_agent_start">[];
  tool_call: PiEventHandler<"tool_call">[];
  tool_result: PiEventHandler<"tool_result">[];
  agent_settled: PiEventHandler<"agent_settled">[];
  session_shutdown: PiEventHandler<"session_shutdown">[];
  before_provider_request: PiEventHandler<"before_provider_request">[];
  after_provider_response: PiEventHandler<"after_provider_response">[];
}

export interface FakePi extends PiLike {
  emitSessionStart(payload: SessionStartEvent): Promise<void>;
  emitBeforeAgentStart(
    payload: BeforeAgentStartEvent,
  ): Promise<AgentStartInjection | undefined>;
  emitToolCall(
    payload: ToolCallEvent,
  ): Promise<ToolCallBlockResult | undefined>;
  emitToolResult(
    payload: ToolResultEvent,
  ): Promise<ToolResultPatch | undefined>;
  emitAgentSettled(payload?: GenericEvent): Promise<void>;
  emitSessionShutdown(payload?: GenericEvent): Promise<void>;
  emitBeforeProviderRequest(payload: GenericEvent): Promise<void>;
  emitAfterProviderResponse(payload: GenericEvent): Promise<void>;
  /** Tools registered via registerTool, in order. */
  readonly tools: ToolDefLike[];
  /** Notifications captured from ctx.ui.notify. */
  readonly notifications: Notification[];
  /** Widget lines captured from ctx.ui.setWidget, keyed by widget id. */
  readonly widgets: Map<string, string[] | undefined>;
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
  options: { hasUI?: boolean; cwd?: string } = {},
): FakePi {
  const store: HandlerStore = {
    session_start: [],
    before_agent_start: [],
    tool_call: [],
    tool_result: [],
    agent_settled: [],
    session_shutdown: [],
    before_provider_request: [],
    after_provider_response: [],
  };
  const tools: ToolDefLike[] = [];
  const notifications: Notification[] = [];
  const widgets = new Map<string, string[] | undefined>();
  const confirmQueue: boolean[] = [];
  const selectQueue: { index: number | undefined }[] = [];
  const inputQueue: { answer: string | undefined }[] = [];
  const selectDialogs: SelectDialog[] = [];
  const inputDialogs: InputDialog[] = [];
  const confirmDialogs: ConfirmDialog[] = [];

  const ctx: CtxLike & { hasUI: boolean } = {
    hasUI: options.hasUI ?? true,
    cwd: options.cwd,
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
    },
  };

  // Indexing a mapped type by the single type parameter K distributes
  // correctly (unlike writing through store[event] directly, which TS
  // rejects as an intersection write).
  const registrars: {
    [K in PiEventName]: (handler: PiEventHandler<K>) => void;
  } = {
    session_start: (handler) => store.session_start.push(handler),
    before_agent_start: (handler) => store.before_agent_start.push(handler),
    tool_call: (handler) => store.tool_call.push(handler),
    tool_result: (handler) => store.tool_result.push(handler),
    agent_settled: (handler) => store.agent_settled.push(handler),
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
    async emitSessionStart(payload) {
      for (const handler of store.session_start) await handler(payload, ctx);
    },
    async emitBeforeAgentStart(payload) {
      let injection: AgentStartInjection | undefined;
      for (const handler of store.before_agent_start) {
        const result = await handler(payload, ctx);
        if (result !== undefined) injection = result;
      }
      return injection;
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
    notifications,
    widgets,
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
