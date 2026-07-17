import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/**
 * Structural types for the subset of pi's ExtensionAPI that pi-harness uses.
 *
 * These are intentionally NOT imported from @earendil-works/pi-coding-agent at
 * runtime: features depend on this narrow seam so tests can substitute an
 * in-memory fake (tests/pi-harness/fake-pi.ts) and pi API churn stays
 * localized here. Event shapes were recorded from pi 0.80.6 on 2026-07-10
 * (fixtures: tests/fixtures/pi-harness/raw/).
 */

export interface SessionStartEvent {
  type: "session_start";
  reason: string;
}

export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  images?: unknown[];
  systemPrompt?: string;
  systemPromptOptions?: Record<string, unknown>;
}

export interface ToolCallEvent {
  type: "tool_call";
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface ToolResultContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface ToolResultEvent {
  type: "tool_result";
  toolName: string;
  toolCallId?: string;
  content?: ToolResultContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface GenericEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiEventMap {
  session_start: SessionStartEvent;
  before_agent_start: BeforeAgentStartEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  agent_settled: GenericEvent;
  session_shutdown: GenericEvent;
  // Provider hooks (V10): request payload before send, and status + headers
  // before the stream is consumed. pi-harness only observes these (void
  // results); payload mutation is out of scope.
  before_provider_request: GenericEvent;
  after_provider_response: GenericEvent;
}

export type PiEventName = keyof PiEventMap;

/** Returned by tool_call handlers to veto execution. */
export interface ToolCallBlockResult {
  block: true;
  reason: string;
}

/** Returned by tool_result handlers to patch the result shown to the model. */
export interface ToolResultPatch {
  content?: ToolResultContentBlock[];
  isError?: boolean;
}

/** Returned by before_agent_start handlers to inject a message. */
export interface AgentStartInjection {
  message: {
    customType: string;
    content: string;
    display: boolean;
  };
}

export interface PiEventResultMap {
  session_start: void;
  before_agent_start: AgentStartInjection | undefined | void;
  tool_call: ToolCallBlockResult | undefined | void;
  tool_result: ToolResultPatch | undefined | void;
  agent_settled: void;
  session_shutdown: void;
  before_provider_request: void;
  after_provider_response: void;
}

export type NotifyLevel = "info" | "warning" | "error";

export type ThemeColorLike =
  | "accent"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim";

export interface ThemeLike {
  fg(color: ThemeColorLike, text: string): string;
}

export interface TuiLike {
  requestRender(): void;
}

export interface FooterDataLike {
  getGitBranch(): string | null;
  onBranchChange(callback: () => void): () => void;
}

export interface FooterComponentLike {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export type FooterFactoryLike = (
  tui: TuiLike,
  theme: ThemeLike,
  footerData: FooterDataLike,
) => FooterComponentLike;

export interface ModelLike {
  id: string;
  name?: string;
}

export interface ContextUsageLike {
  percent: number | null;
}

export type PiModeLike = "tui" | "rpc" | "json" | "print";

export interface DialogOptionsLike {
  signal?: AbortSignal;
  timeout?: number;
}

export interface UiLike {
  select(
    title: string,
    options: string[],
    dialogOptions?: DialogOptionsLike,
  ): Promise<string | undefined>;
  confirm(
    title: string,
    message: string,
    dialogOptions?: DialogOptionsLike,
  ): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    dialogOptions?: DialogOptionsLike,
  ): Promise<string | undefined>;
  notify(message: string, level?: NotifyLevel): void;
  setWidget?(key: string, lines: string[] | undefined): void;
  setFooter?(factory: FooterFactoryLike | undefined): void;
}

export interface CtxLike {
  hasUI: boolean;
  ui: UiLike;
  mode?: PiModeLike;
  cwd?: string;
  model?: ModelLike;
  getContextUsage?(): ContextUsageLike | undefined;
}

export type PiEventHandler<K extends PiEventName> = (
  event: PiEventMap[K],
  ctx: CtxLike,
) => Promise<PiEventResultMap[K]> | PiEventResultMap[K];

export interface ToolDefLike {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: "parallel" | "sequential";
  parameters: TSchema;
  execute: (
    toolCallId: string,
    params: never,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: CtxLike,
  ) => Promise<AgentToolResult<unknown>>;
}

export interface PiLike {
  on<K extends PiEventName>(event: K, handler: PiEventHandler<K>): void;
  registerTool(tool: ToolDefLike): void;
}

// Compile-only contracts against pi's documented public API. Keeping these
// next to the narrow seam makes local and global declaration compilation fail
// when the real runtime can no longer supply what the harness expects.
type Assert<T extends true> = T;
type _PiApiContract = Assert<ExtensionAPI extends PiLike ? true : false>;
type _PiContextContract = Assert<
  ExtensionContext extends CtxLike ? true : false
>;
