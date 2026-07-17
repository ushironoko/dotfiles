import { normalizeProviderSourceUrl } from "./schema";

const CODEX_RESPONSES_ENDPOINT =
  "https://chatgpt.com/backend-api/codex/responses";

const MAX_MODEL_ID_LENGTH = 160;
const MAX_ANSWER_CHARS = 32_000;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 256 * 1024;
const MAX_SOURCE_TITLE_CHARS = 240;
const MAX_QUERY_DETAIL_CHARS = 500;
const MAX_COLLECTED_QUERIES = 32;
const MAX_COLLECTED_SOURCES = 128;
const MAX_SSE_EVENTS = 4_096;
const DEFAULT_TOTAL_TIMEOUT_MS = 120_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

interface CodexAuthInput {
  apiKey?: string;
  headers?: Record<string, string>;
}

interface CodexWebRequest {
  modelId: string;
  auth: CodexAuthInput;
  prompt: string;
  instructions: string;
  maxSources: number;
  requiredUrl?: string;
  signal?: AbortSignal;
}

interface CodexWebSource {
  title: string;
  url: string;
}

interface CodexWebResult {
  answer: string;
  queries: string[];
  sources: CodexWebSource[];
}

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface CodexWebClientOptions {
  fetch?: FetchLike;
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxStreamBytes?: number;
  maxEventChars?: number;
  maxAnswerChars?: number;
}

type AbortKind = "user" | "total-timeout" | "idle-timeout";

interface AbortEventSignalLike {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

interface AbortControllerLike {
  readonly signal: AbortSignal & AbortEventSignalLike;
  abort(): void;
}

const asAbortEventSignal = (
  value: AbortSignal | undefined,
): AbortEventSignalLike | undefined => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("aborted" in value) ||
    typeof value.aborted !== "boolean" ||
    !("addEventListener" in value) ||
    typeof value.addEventListener !== "function" ||
    !("removeEventListener" in value) ||
    typeof value.removeEventListener !== "function"
  ) {
    return undefined;
  }
  return value as unknown as AbortEventSignalLike;
};

const createAbortController = (): AbortControllerLike => {
  const controller: unknown = new AbortController();
  if (
    typeof controller !== "object" ||
    controller === null ||
    !("abort" in controller) ||
    typeof controller.abort !== "function" ||
    !("signal" in controller) ||
    !asAbortEventSignal(controller.signal as AbortSignal)
  ) {
    throw new Error("AbortController is unavailable");
  }
  const native = controller as {
    signal: AbortSignal & AbortEventSignalLike;
    abort(): void;
  };
  return {
    signal: native.signal,
    abort: () => Reflect.apply(native.abort, controller, []),
  };
};

const isAborted = (signal: AbortSignal): boolean =>
  asAbortEventSignal(signal)?.aborted === true;

class CodexWebError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexWebError";
    this.code = code;
  }
}

interface ParsedSseResult {
  answer: string;
  queries: string[];
  sources: CodexWebSource[];
  citedSources: CodexWebSource[];
  searchCompleted: boolean;
  terminal: boolean;
  eventCount: number;
  queryKeys: Set<string>;
  sourceKeys: Set<string>;
  citedSourceKeys: Set<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const getHeader = (
  headers: Record<string, string> | undefined,
  wanted: string,
): string | undefined => {
  if (!headers) return undefined;
  const normalizedWanted = wanted.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === normalizedWanted && value.trim())
      return value.trim();
  }
  return undefined;
};

const decodeAccountId = (bearer: string): string | undefined => {
  const token = bearer.replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
};

const buildCodexAuthHeaders = (auth: CodexAuthInput): Headers => {
  const explicitAuthorization = getHeader(auth.headers, "authorization");
  const authorization =
    explicitAuthorization ??
    (auth.apiKey?.trim() ? `Bearer ${auth.apiKey.trim()}` : undefined);
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
    throw new CodexWebError(
      "missing-auth",
      "Current Codex model has no usable OAuth bearer credential. Run /login for OpenAI Codex.",
    );
  }

  const accountId =
    getHeader(auth.headers, "chatgpt-account-id") ??
    decodeAccountId(authorization);
  if (!accountId) {
    throw new CodexWebError(
      "missing-account-id",
      "Current Codex credential has no ChatGPT account id. Run /login again.",
    );
  }

  const headers = new Headers();
  headers.set("authorization", authorization);
  headers.set("chatgpt-account-id", accountId);
  headers.set("content-type", "application/json");
  headers.set("accept", "text/event-stream");
  headers.set("openai-beta", "responses=experimental");
  headers.set("originator", "pi");
  return headers;
};

const sanitizeDiagnostic = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sess)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, 240) : undefined;
};

const safeTitle = (value: unknown, url: string): string => {
  const fallback = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "Source";
    }
  })();
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.slice(0, MAX_SOURCE_TITLE_CHARS) || fallback;
};

const addUniqueQuery = (state: ParsedSseResult, value: unknown): void => {
  if (typeof value !== "string") return;
  const normalized = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_DETAIL_CHARS);
  if (
    !normalized ||
    state.queryKeys.has(normalized) ||
    state.queries.length >= MAX_COLLECTED_QUERIES
  ) {
    return;
  }
  state.queryKeys.add(normalized);
  state.queries.push(normalized);
};

const addSource = (
  state: ParsedSseResult,
  rawUrl: unknown,
  rawTitle?: unknown,
  cited = false,
): void => {
  const url = normalizeProviderSourceUrl(rawUrl);
  if (!url) return;
  const source = { title: safeTitle(rawTitle, url), url };

  if (
    cited &&
    !state.citedSourceKeys.has(url) &&
    state.citedSources.length < MAX_COLLECTED_SOURCES
  ) {
    state.citedSourceKeys.add(url);
    state.citedSources.push(source);
  }
  if (
    state.sourceKeys.has(url) ||
    state.sources.length >= MAX_COLLECTED_SOURCES
  ) {
    return;
  }
  state.sourceKeys.add(url);
  state.sources.push(source);
};

const collectSearchCall = (item: unknown, state: ParsedSseResult): void => {
  if (!isRecord(item) || item.type !== "web_search_call") return;
  if (item.status === "completed") state.searchCompleted = true;
  const action = isRecord(item.action) ? item.action : undefined;
  if (!action) return;

  addUniqueQuery(state, action.query);
  if (Array.isArray(action.queries)) {
    for (const query of action.queries) addUniqueQuery(state, query);
  }
  if (Array.isArray(action.sources)) {
    for (const source of action.sources) {
      if (!isRecord(source)) continue;
      addSource(
        state,
        source.url,
        source.title ?? source.display_name ?? source.name,
      );
    }
  }
  addSource(state, action.url);
};

const collectAnnotation = (
  annotation: unknown,
  state: ParsedSseResult,
): void => {
  if (!isRecord(annotation) || annotation.type !== "url_citation") return;
  const nested = isRecord(annotation.url_citation)
    ? annotation.url_citation
    : undefined;
  addSource(
    state,
    annotation.url ?? nested?.url,
    annotation.title ?? nested?.title,
    true,
  );
};

const collectResponseOutput = (
  response: unknown,
  state: ParsedSseResult,
  maxAnswerChars: number,
): void => {
  if (!isRecord(response) || !Array.isArray(response.output)) return;
  for (const item of response.output) {
    collectSearchCall(item, state);
    if (
      !isRecord(item) ||
      item.type !== "message" ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "output_text") continue;
      if (!state.answer && typeof content.text === "string") {
        state.answer = content.text;
        if (state.answer.length > maxAnswerChars) {
          throw new CodexWebError(
            "answer-too-large",
            `Codex web answer exceeded ${maxAnswerChars} characters`,
          );
        }
      }
      if (Array.isArray(content.annotations)) {
        for (const annotation of content.annotations) {
          collectAnnotation(annotation, state);
        }
      }
    }
  }
};

const processEvent = (
  event: unknown,
  state: ParsedSseResult,
  maxAnswerChars: number,
): boolean => {
  if (!isRecord(event)) {
    throw new CodexWebError(
      "invalid-event",
      "Codex returned a non-object SSE event",
    );
  }
  state.eventCount += 1;
  if (state.eventCount > MAX_SSE_EVENTS) {
    throw new CodexWebError(
      "too-many-events",
      `Codex response exceeded ${MAX_SSE_EVENTS} SSE events`,
    );
  }

  const { type } = event;
  if (type === "error" || type === "response.failed") {
    throw new CodexWebError(
      "provider-error",
      "Codex web request failed during streaming",
    );
  }
  if (type === "response.incomplete") {
    throw new CodexWebError(
      "incomplete-response",
      "Codex web request ended with an incomplete response",
    );
  }
  if (type === "response.output_text.delta") {
    if (typeof event.delta !== "string") {
      throw new CodexWebError(
        "invalid-event",
        "Codex returned an invalid text delta",
      );
    }
    state.answer += event.delta;
    if (state.answer.length > maxAnswerChars) {
      throw new CodexWebError(
        "answer-too-large",
        `Codex web answer exceeded ${maxAnswerChars} characters`,
      );
    }
    return false;
  }
  if (type === "response.output_text.annotation.added") {
    collectAnnotation(event.annotation, state);
    return false;
  }
  if (
    type === "response.output_item.added" ||
    type === "response.output_item.done"
  ) {
    collectSearchCall(event.item, state);
    return false;
  }
  if (type === "response.web_search_call.completed") {
    state.searchCompleted = true;
    return false;
  }
  if (type === "response.completed" || type === "response.done") {
    if (!isRecord(event.response) || event.response.status !== "completed") {
      throw new CodexWebError(
        "non-completed-response",
        "Codex web request ended without a completed response status",
      );
    }
    collectResponseOutput(event.response, state, maxAnswerChars);
    state.terminal = true;
    return true;
  }
  return false;
};

const parseSse = async (
  body: ReadableStream<Uint8Array>,
  options: {
    maxStreamBytes: number;
    maxEventChars: number;
    maxAnswerChars: number;
    onActivity: () => void;
    signal: AbortSignal;
  },
): Promise<ParsedSseResult> => {
  const reader = body.getReader();
  const abortSignal = asAbortEventSignal(options.signal);
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  abortSignal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder();
  const state: ParsedSseResult = {
    answer: "",
    queries: [],
    sources: [],
    citedSources: [],
    searchCompleted: false,
    terminal: false,
    eventCount: 0,
    queryKeys: new Set(),
    sourceKeys: new Set(),
    citedSourceKeys: new Set(),
  };
  let totalBytes = 0;
  let buffer = "";
  let eventData = "";
  let reachedEof = false;
  let stopped = false;

  const appendEventData = (value: string): void => {
    eventData = eventData ? `${eventData}\n${value}` : value;
    if (eventData.length > options.maxEventChars) {
      throw new CodexWebError(
        "event-too-large",
        `Codex SSE event exceeded ${options.maxEventChars} characters`,
      );
    }
  };

  const flushEvent = (): boolean => {
    const raw = eventData.trim();
    eventData = "";
    if (!raw || raw === "[DONE]") return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CodexWebError(
        "invalid-json",
        "Codex returned malformed SSE JSON",
      );
    }
    return processEvent(parsed, state, options.maxAnswerChars);
  };

  const processLine = (rawLine: string): boolean => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "") return flushEvent();
    if (line.startsWith("data:")) appendEventData(line.slice(5).trimStart());
    return false;
  };

  try {
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      options.onActivity();
      totalBytes += value.byteLength;
      if (totalBytes > options.maxStreamBytes) {
        throw new CodexWebError(
          "stream-too-large",
          `Codex response exceeded ${options.maxStreamBytes} bytes`,
        );
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > options.maxEventChars && !buffer.includes("\n")) {
        throw new CodexWebError(
          "line-too-large",
          `Codex SSE line exceeded ${options.maxEventChars} characters`,
        );
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!processLine(line)) continue;
        stopped = true;
        break;
      }
    }

    if (!stopped) {
      buffer += decoder.decode();
      if (buffer && processLine(buffer)) stopped = true;
      if (!stopped && eventData && flushEvent()) stopped = true;
    }
  } finally {
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // The parser is already returning a bounded result/error.
      }
    }
    abortSignal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }

  if (!state.terminal) {
    throw new CodexWebError(
      "missing-terminal-event",
      "Codex stream ended without a terminal response event",
    );
  }
  return state;
};

const createAbortScope = (
  userSignal: AbortSignal | undefined,
  totalTimeoutMs: number,
  idleTimeoutMs: number,
): {
  signal: AbortSignal;
  activity: () => void;
  getKind: () => AbortKind | undefined;
  cleanup: () => void;
} => {
  const controller = createAbortController();
  const userAbortSignal = asAbortEventSignal(userSignal);
  let kind: AbortKind | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = (nextKind: AbortKind): void => {
    if (controller.signal.aborted) return;
    kind = nextKind;
    controller.abort();
  };
  const onUserAbort = (): void => abort("user");
  userAbortSignal?.addEventListener("abort", onUserAbort, { once: true });
  if (userAbortSignal?.aborted) abort("user");

  const totalTimer = setTimeout(() => abort("total-timeout"), totalTimeoutMs);
  const activity = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort("idle-timeout"), idleTimeoutMs);
  };
  activity();

  return {
    signal: controller.signal,
    activity,
    getKind: () => kind,
    cleanup: () => {
      clearTimeout(totalTimer);
      if (idleTimer) clearTimeout(idleTimer);
      userAbortSignal?.removeEventListener("abort", onUserAbort);
    },
  };
};

const abortError = (kind: AbortKind | undefined): CodexWebError => {
  if (kind === "user")
    return new CodexWebError("aborted", "Codex web request was aborted");
  if (kind === "idle-timeout") {
    return new CodexWebError(
      "idle-timeout",
      "Codex web response timed out while idle",
    );
  }
  return new CodexWebError(
    "total-timeout",
    "Codex web request exceeded its time limit",
  );
};

const buildRequestBody = (
  request: CodexWebRequest,
): Record<string, unknown> => ({
  model: request.modelId,
  instructions: request.instructions,
  input: [
    {
      role: "user",
      content: [{ type: "input_text", text: request.prompt }],
    },
  ],
  tools: [{ type: "web_search" }],
  include: ["web_search_call.action.sources"],
  tool_choice: "required",
  parallel_tool_calls: true,
  text: { verbosity: "low" },
  store: false,
  stream: true,
});

const requestCodexWeb = async (
  request: CodexWebRequest,
  options: CodexWebClientOptions = {},
): Promise<CodexWebResult> => {
  if (
    typeof request.modelId !== "string" ||
    request.modelId.length < 1 ||
    request.modelId.length > MAX_MODEL_ID_LENGTH
  ) {
    throw new CodexWebError(
      "invalid-model",
      "Current Codex model id is invalid",
    );
  }
  if (
    !Number.isInteger(request.maxSources) ||
    request.maxSources < 1 ||
    request.maxSources > 8
  ) {
    throw new CodexWebError(
      "invalid-source-limit",
      "maxSources must be between 1 and 8",
    );
  }

  const fetchImpl = options.fetch ?? fetch;
  const scope = createAbortScope(
    request.signal,
    options.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
  );

  try {
    const response = await fetchImpl(CODEX_RESPONSES_ENDPOINT, {
      method: "POST",
      headers: buildCodexAuthHeaders(request.auth),
      body: JSON.stringify(buildRequestBody(request)),
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: scope.signal,
    });
    scope.activity();

    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cleanup failure; no upstream body is surfaced.
      }
      const requestId = sanitizeDiagnostic(
        response.headers.get("x-request-id") ??
          response.headers.get("request-id"),
      );
      const retryAfter = sanitizeDiagnostic(
        response.headers.get("retry-after"),
      );
      const suffix = [
        requestId ? `request id ${requestId}` : undefined,
        retryAfter ? `retry after ${retryAfter}` : undefined,
      ]
        .filter(Boolean)
        .join(", ");
      throw new CodexWebError(
        "http-error",
        `Codex web request failed with HTTP ${response.status}${suffix ? ` (${suffix})` : ""}`,
      );
    }
    const contentType = response.headers.get("content-type")?.toLowerCase();
    // The Codex backend can omit Content-Type on a valid chunked SSE response.
    // A missing header is accepted only if parseSse validates the bounded body
    // and observes both completed search evidence and a terminal response.
    if (contentType && !contentType.includes("text/event-stream")) {
      try {
        await response.body?.cancel();
      } catch {
        // Ignore cleanup failure.
      }
      throw new CodexWebError(
        "invalid-content-type",
        "Codex web endpoint returned a non-streaming response",
      );
    }
    if (!response.body) {
      throw new CodexWebError(
        "missing-body",
        "Codex web endpoint returned no response body",
      );
    }

    const parsed = await parseSse(response.body, {
      maxStreamBytes: options.maxStreamBytes ?? MAX_STREAM_BYTES,
      maxEventChars: options.maxEventChars ?? MAX_SSE_EVENT_CHARS,
      maxAnswerChars: options.maxAnswerChars ?? MAX_ANSWER_CHARS,
      onActivity: scope.activity,
      signal: scope.signal,
    });
    const answer = parsed.answer.trim();
    if (!answer)
      throw new CodexWebError(
        "empty-answer",
        "Codex web search returned no answer",
      );
    if (!parsed.searchCompleted) {
      throw new CodexWebError(
        "ungrounded-response",
        "Codex answered without a completed native web search",
      );
    }

    const requiredUrl = request.requiredUrl
      ? normalizeProviderSourceUrl(request.requiredUrl)
      : undefined;
    if (request.requiredUrl && !requiredUrl) {
      throw new CodexWebError(
        "invalid-required-url",
        "The required source URL is not a validated public HTTPS URL",
      );
    }

    let sources: CodexWebSource[];
    if (requiredUrl) {
      sources = parsed.citedSources.filter(
        (source) => source.url === requiredUrl,
      );
      if (sources.length === 0) {
        throw new CodexWebError(
          "source-mismatch",
          "Codex did not cite the exact requested HTTPS URL",
        );
      }
      sources = sources.slice(0, 1);
    } else {
      const prioritized = [
        ...parsed.citedSources,
        ...parsed.sources.filter(
          (source) => !parsed.citedSourceKeys.has(source.url),
        ),
      ];
      sources = prioritized.slice(0, request.maxSources);
      if (parsed.citedSources.length === 0) {
        throw new CodexWebError(
          "missing-citations",
          "Codex web search returned no validated citations for its answer",
        );
      }
    }

    return {
      answer,
      queries: parsed.queries.slice(0, 8),
      sources,
    };
  } catch (error) {
    if (isAborted(scope.signal)) throw abortError(scope.getKind());
    if (error instanceof CodexWebError) throw error;
    throw new CodexWebError(
      "network-error",
      `Codex web request could not be completed${
        error instanceof Error && error.name === "TypeError" ? "" : " safely"
      }`,
    );
  } finally {
    scope.cleanup();
  }
};

export {
  buildCodexAuthHeaders,
  CODEX_RESPONSES_ENDPOINT,
  CodexWebError,
  requestCodexWeb,
};
export type {
  CodexAuthInput,
  CodexWebClientOptions,
  CodexWebRequest,
  CodexWebResult,
  CodexWebSource,
  FetchLike,
};
