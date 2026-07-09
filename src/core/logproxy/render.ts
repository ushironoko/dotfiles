// 記録した文脈レコードを人間が読める形にレンダリングする純粋ロジック。
// text（俯瞰＋全文）/ md（構造化）/ json（レコードそのもの）。
import type { RequestParams, RequestRecord, ResponseRecord } from "./types.js";

export type RenderFormat = "text" | "json" | "md";

/** turn は 1-based。未指定は最後のターン。範囲外は undefined。 */
export const selectRequestTurn = (
  requests: RequestRecord[],
  turn?: number,
): RequestRecord | undefined => {
  if (requests.length === 0) return undefined;
  if (turn === undefined) return requests[requests.length - 1];
  if (turn < 1 || turn > requests.length) return undefined;
  return requests[turn - 1];
};

const asRec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const systemText = (system: unknown): string => {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system.map((b) => str(asRec(b)?.["text"])).join("\n\n");
  }
  return system === undefined ? "" : JSON.stringify(system, null, 2);
};

const renderBlock = (block: unknown): string => {
  const r = asRec(block);
  if (!r) return typeof block === "string" ? block : JSON.stringify(block);
  const t = r["type"];
  if (t === "text") return str(r["text"]);
  if (t === "thinking") return `[thinking] ${str(r["thinking"])}`;
  if (t === "tool_use") {
    return `[tool_use name=${str(r["name"])} id=${str(r["id"])}]\n${JSON.stringify(r["input"] ?? {}, null, 2)}`;
  }
  if (t === "tool_result") {
    const c = r["content"];
    const body = typeof c === "string" ? c : JSON.stringify(c, null, 2);
    return `[tool_result tool_use_id=${str(r["tool_use_id"])}]\n${body}`;
  }
  if (t === "image") return "[image]";
  return `[${str(t) || "block"}] ${JSON.stringify(r)}`;
};

const renderContent = (content: unknown): string => {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(renderBlock).join("\n");
  return JSON.stringify(content, null, 2);
};

const renderParams = (p: RequestParams): string => {
  const parts: string[] = [];
  if (p.max_tokens !== undefined) parts.push(`max_tokens=${p.max_tokens}`);
  if (p.temperature !== undefined) parts.push(`temperature=${p.temperature}`);
  if (p.top_p !== undefined) parts.push(`top_p=${p.top_p}`);
  if (p.stream !== undefined) parts.push(`stream=${p.stream}`);
  if (p.thinking !== undefined)
    parts.push(`thinking=${JSON.stringify(p.thinking)}`);
  if (p.tool_choice !== undefined)
    parts.push(`tool_choice=${JSON.stringify(p.tool_choice)}`);
  if (p.betas !== undefined) parts.push(`betas=${JSON.stringify(p.betas)}`);
  return parts.join(" ");
};

const renderUsage = (res: ResponseRecord | undefined): string => {
  if (!res) return "(no response record)";
  const u = res.usage;
  const tok = u
    ? `in=${u.input_tokens ?? "?"} out=${u.output_tokens ?? "?"} cacheR=${u.cache_read_input_tokens ?? 0} cacheW=${u.cache_creation_input_tokens ?? 0}`
    : "usage=?";
  return `status=${res.status} ${tok} stop=${res.stop_reason ?? "?"}${res.aborted ? " (aborted)" : ""}`;
};

const renderMarkdown = (
  req: RequestRecord,
  res: ResponseRecord | undefined,
): string => {
  const sys = systemText(req.system);
  const tools = req.tools ?? [];
  const messages = req.messages ?? [];
  const toolLines = tools.map((t) => {
    const r = asRec(t);
    return `- **${str(r?.["name"]) || "?"}** — ${str(r?.["description"])}`;
  });
  const msgBlocks = messages.map(
    (m, i) =>
      `### [${i + 1}] ${str(asRec(m)?.["role"]) || "?"}\n\n${renderContent(asRec(m)?.["content"])}`,
  );
  return [
    `# context snapshot — ${req.session_id}`,
    `model: \`${req.model ?? "?"}\` · ts: ${req.ts} · ${renderParams(req.params)}`,
    `stats: tools=${req.stats.num_tools} messages=${req.stats.num_messages} system=${req.stats.system_chars}c bytes=${req.stats.approx_bytes}`,
    ``,
    `## System (${sys.length} chars)`,
    ``,
    sys,
    ``,
    `## Tools (${tools.length})`,
    ``,
    toolLines.join("\n"),
    ``,
    `## Messages (${messages.length})`,
    ``,
    msgBlocks.join("\n\n"),
    ``,
    `## Response`,
    ``,
    renderUsage(res),
    ``,
  ].join("\n");
};

const renderText = (
  req: RequestRecord,
  res: ResponseRecord | undefined,
): string => {
  const sys = systemText(req.system);
  const tools = req.tools ?? [];
  const messages = req.messages ?? [];
  const bar = (label: string): string => `──── ${label} ────`;
  const toolLines = tools.map((t) => {
    const r = asRec(t);
    const desc = str(r?.["description"]).replace(/\n/g, "\n  ");
    return `• ${str(r?.["name"]) || "?"}\n  ${desc}`;
  });
  const msgLines = messages.map(
    (m, i) =>
      `[${i + 1}] ${str(asRec(m)?.["role"]) || "?"}\n${renderContent(asRec(m)?.["content"])}`,
  );
  return [
    `═══ context snapshot ═══`,
    `session:  ${req.session_id}`,
    `model:    ${req.model ?? "?"}`,
    `ts:       ${req.ts}`,
    `endpoint: ${req.endpoint}`,
    `params:   ${renderParams(req.params)}`,
    `stats:    tools=${req.stats.num_tools} messages=${req.stats.num_messages} system=${req.stats.system_chars}c bytes=${req.stats.approx_bytes}`,
    ``,
    bar(`SYSTEM (${sys.length} chars)`),
    sys,
    ``,
    bar(`TOOLS (${tools.length})`),
    toolLines.join("\n"),
    ``,
    bar(`MESSAGES (${messages.length})`),
    msgLines.join("\n\n"),
    ``,
    bar(`RESPONSE`),
    renderUsage(res),
  ].join("\n");
};

export const renderContext = (
  req: RequestRecord,
  res: ResponseRecord | undefined,
  format: RenderFormat,
): string => {
  if (format === "json") return JSON.stringify(req, null, 2);
  if (format === "md") return renderMarkdown(req, res);
  return renderText(req, res);
};
