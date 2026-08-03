import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  GraphDepEdge,
  GraphMeta,
  GraphResult,
  GraphSymbol,
  HearthEngine,
} from "@hearthdev/napi";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { HearthAccessGate } from "./engine";

export const HEARTH_GRAPH_TOOL_NAME = "hearth_graph";

const AUTO_INDEX_BATCH_SIZE = 128;
const AUTO_INDEX_SENTINEL = "__pi_hearth_graph_auto_index__";
const DEFAULT_RESULT_LIMIT = 50;
const MAX_RESULT_LIMIT = 200;
const DEFAULT_GRAPH_DEPTH = 1;
const MAX_GRAPH_DEPTH = 4;
const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_BYTES = 32 * 1024;
const OUTPUT_NOTICE_RESERVE_BYTES = 256;
const MAX_CONTENT_LINES = MAX_OUTPUT_LINES - 1;
const MAX_CONTENT_BYTES = MAX_OUTPUT_BYTES - OUTPUT_NOTICE_RESERVE_BYTES;
const MAX_FIELD_LENGTH = 500;
const MAX_PATH_LENGTH = 4_096;
const MAX_SYMBOL_TEXT_LENGTH = 512;

const GRAPH_OPERATIONS = [
  "symbols",
  "outline",
  "search",
  "definitions",
  "deps",
  "rdeps",
  "neighborhood",
  "status",
] as const;

type GraphOperation = (typeof GRAPH_OPERATIONS)[number];

const GraphParameters = {
  type: "object",
  properties: {
    operation: {
      type: "string",
      enum: GRAPH_OPERATIONS,
      description: "Graph query to run",
    },
    path: {
      type: "string",
      minLength: 1,
      maxLength: MAX_PATH_LENGTH,
      description:
        "Project-relative or absolute file path for symbols, outline, deps, rdeps, or neighborhood",
    },
    query: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SYMBOL_TEXT_LENGTH,
      description: "Symbol-name query for search",
    },
    name: {
      type: "string",
      minLength: 1,
      maxLength: MAX_SYMBOL_TEXT_LENGTH,
      description: "Exact symbol name for definitions",
    },
    depth: {
      type: "integer",
      minimum: 1,
      maximum: MAX_GRAPH_DEPTH,
      description:
        "Traversal depth for deps, rdeps, or neighborhood (default: 1)",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_RESULT_LIMIT,
      description:
        "Maximum symbol results for search or definitions (default: 50)",
    },
    verify: {
      type: "boolean",
      description:
        "Use the source-text verification backstop for reverse dependencies (default: true)",
    },
  },
  required: ["operation"],
  additionalProperties: false,
} as const;

export interface HearthGraphObserverStatus {
  observedFiles: number;
  pendingFiles: number;
  failedFiles: number;
  indexing: boolean;
  projectComplete: boolean;
  lastError?: string;
}

export interface HearthGraphObserverLike {
  observe(paths: readonly string[]): void;
}

export interface HearthGraphRuntime extends HearthGraphObserverLike {
  flush(signal?: AbortSignal): Promise<void>;
  runQuery<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  markProjectComplete(clearAutoFailures?: boolean): void;
  dispose(): void;
  status(): HearthGraphObserverStatus;
}

interface NativeAbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

interface ObservableAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

const nativeAbortController = (): NativeAbortController => {
  const Constructor =
    globalThis.AbortController as unknown as new () => NativeAbortController;
  return new Constructor();
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const abortedError = (): Error => new Error("Operation aborted");

const waitAbortable = async <T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> => {
  if (signal === undefined) return operation;
  const observable = signal as unknown as ObservableAbortSignal;
  if (observable.aborted) throw abortedError();

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortedError());
    observable.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort !== undefined) {
      observable.removeEventListener("abort", onAbort);
    }
  }
};

const boundedField = (value: string): string => {
  const escaped = value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r", String.raw`\r`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\t", String.raw`\t`);
  return escaped.length <= MAX_FIELD_LENGTH
    ? escaped
    : `${escaped.slice(0, MAX_FIELD_LENGTH)}…`;
};

const withinRoot = (root: string, input: string): string | undefined => {
  const absolute = resolve(root, input);
  const rel = relative(root, absolute);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel)
  ) {
    return undefined;
  }
  return absolute;
};

/**
 * Incrementally warms Hearth graph state from files the agent has observed.
 * Failures are retained for diagnostics but never reject the originating file
 * tool. Explicit graph queries call flush() before reading graph state.
 */
export class HearthGraphObserver implements HearthGraphRuntime {
  private readonly pending = new Set<string>();
  private readonly observed = new Set<string>();
  private readonly failures = new Map<string, string>();
  private readonly controller = nativeAbortController();
  private graphTail: Promise<void> = Promise.resolve();
  private running?: Promise<void>;
  private disposed = false;
  private projectComplete = false;
  private unexpectedError?: string;

  constructor(
    private readonly root: string,
    private readonly engine: HearthEngine,
    private readonly gate: HearthAccessGate,
  ) {}

  observe(paths: readonly string[]): void {
    if (this.disposed) return;
    let accepted = false;
    for (const path of paths) {
      const absolute = withinRoot(this.root, path);
      if (absolute === undefined) continue;
      accepted = true;
      this.observed.add(absolute);
      this.pending.add(absolute);
    }
    if (accepted) this.projectComplete = false;
    this.ensureRunning();
  }

  async flush(signal?: AbortSignal): Promise<void> {
    while (!this.disposed) {
      this.ensureRunning();
      const { running } = this;
      if (running === undefined) return;
      await waitAbortable(running, signal);
    }
  }

  runQuery<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const scheduled = this.graphTail.then(async () => {
      if (
        signal !== undefined &&
        (signal as unknown as ObservableAbortSignal).aborted
      ) {
        throw abortedError();
      }
      return operation();
    });
    this.graphTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return waitAbortable(scheduled, signal);
  }

  markProjectComplete(clearAutoFailures = false): void {
    this.projectComplete = true;
    if (clearAutoFailures) this.failures.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending.clear();
    this.controller.abort();
  }

  status(): HearthGraphObserverStatus {
    let lastFailure: string | undefined;
    for (const failure of this.failures.values()) lastFailure = failure;
    const lastError = this.unexpectedError ?? lastFailure;
    return {
      observedFiles: this.observed.size,
      pendingFiles: this.pending.size,
      failedFiles: this.failures.size,
      indexing: this.running !== undefined,
      projectComplete: this.projectComplete,
      ...(lastError === undefined ? {} : { lastError }),
    };
  }

  private ensureRunning(): void {
    if (
      this.disposed ||
      this.pending.size === 0 ||
      this.running !== undefined
    ) {
      return;
    }
    const running = this.run();
    this.running = running;
    void running.then(
      () => this.finishRun(running),
      (error) => {
        this.unexpectedError = boundedField(errorMessage(error));
        this.finishRun(running);
      },
    );
  }

  private finishRun(running: Promise<void>): void {
    if (this.running === running) this.running = undefined;
    this.ensureRunning();
  }

  private async run(): Promise<void> {
    while (!this.disposed && this.pending.size > 0) {
      const files = [...this.pending].slice(0, AUTO_INDEX_BATCH_SIZE);
      for (const file of files) this.pending.delete(file);
      try {
        await this.runQuery(
          () =>
            this.gate.shared(async () => {
              await this.engine.graphDefinitionsAsync(
                {
                  root: this.root,
                  name: AUTO_INDEX_SENTINEL,
                  files,
                  hidden: true,
                  respectGitignore: true,
                  followSymlinks: false,
                },
                this.controller.signal,
              );
            }),
          this.controller.signal,
        );
        for (const file of files) this.failures.delete(file);
        // A caller-supplied file view is intentionally partial even when all
        // observed files were indexed successfully.
        this.projectComplete = false;
      } catch (error) {
        if (!this.disposed) {
          const message = boundedField(errorMessage(error));
          for (const file of files) this.failures.set(file, message);
        }
      }
    }
  }
}

const requiredText = (
  value: string | undefined,
  field: "path" | "query" | "name",
  operation: GraphOperation,
): string => {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${field} is required for ${operation}`);
  }
  return value;
};

const baseParams = (root: string) => ({
  root,
  hidden: true,
  respectGitignore: true,
  followSymlinks: false,
});

const runGraphQuery = async (
  engine: HearthEngine,
  root: string,
  operation: GraphOperation,
  params: {
    path?: string;
    query?: string;
    name?: string;
    depth?: number;
    limit?: number;
    verify?: boolean;
  },
  signal: AbortSignal | undefined,
): Promise<GraphResult> => {
  const common = baseParams(root);
  switch (operation) {
    case "symbols": {
      return engine.graphSymbolsAsync(
        {
          ...common,
          path: requiredText(params.path, "path", operation),
        },
        signal,
      );
    }
    case "outline": {
      return engine.graphOutlineAsync(
        {
          ...common,
          path: requiredText(params.path, "path", operation),
        },
        signal,
      );
    }
    case "search": {
      return engine.graphSearchAsync(
        {
          ...common,
          query: requiredText(params.query, "query", operation),
          limit: params.limit ?? DEFAULT_RESULT_LIMIT,
        },
        signal,
      );
    }
    case "definitions": {
      return engine.graphDefinitionsAsync(
        {
          ...common,
          name: requiredText(params.name, "name", operation),
          limit: params.limit ?? DEFAULT_RESULT_LIMIT,
        },
        signal,
      );
    }
    case "deps": {
      return engine.graphDepsAsync(
        {
          ...common,
          path: requiredText(params.path, "path", operation),
          depth: params.depth ?? DEFAULT_GRAPH_DEPTH,
        },
        signal,
      );
    }
    case "rdeps": {
      return engine.graphRdepsAsync(
        {
          ...common,
          path: requiredText(params.path, "path", operation),
          depth: params.depth ?? DEFAULT_GRAPH_DEPTH,
          verify: params.verify ?? true,
        },
        signal,
      );
    }
    case "neighborhood": {
      return engine.graphNeighborhoodAsync(
        {
          ...common,
          path: requiredText(params.path, "path", operation),
          depth: params.depth ?? DEFAULT_GRAPH_DEPTH,
        },
        signal,
      );
    }
    case "status": {
      return engine.graphStatusAsync(common, signal);
    }
  }
};

const displayPath = (root: string, path: string): string => {
  const rel = relative(root, path);
  const display =
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
      ? rel.replaceAll("\\", "/")
      : path;
  return boundedField(display);
};

const symbolLine = (root: string, symbol: GraphSymbol): string =>
  `${displayPath(root, symbol.path)}:${symbol.line}:${symbol.column} ${boundedField(symbol.kind)} ${boundedField(symbol.name)}`;

const edgeLine = (root: string, edge: GraphDepEdge): string =>
  `${displayPath(root, edge.from)}:${edge.line} --${boundedField(edge.kind)} ${boundedField(edge.specifier)}--> ${displayPath(root, edge.to)} [${edge.guarantee}]`;

const metaLine = (
  meta: GraphMeta,
  observer: HearthGraphObserverStatus,
): string => {
  const guarantee = observer.projectComplete ? meta.guarantee : "approximate";
  const scope = observer.projectComplete ? "project" : "observed-partial";
  const indexed = observer.projectComplete
    ? `${meta.indexedFiles}/${meta.universeFiles}`
    : `${meta.indexedFiles} lastSweepFiles=${meta.universeFiles}`;
  return `graph guarantee=${guarantee} scope=${scope} indexed=${indexed} unsupported=${meta.unsupportedFiles} oversize=${meta.oversizeFiles} swept=${meta.swept} sweepAgeMs=${meta.sweepAgeMs}`;
};

export interface HearthGraphFormatResult {
  text: string;
  truncated: boolean;
  outputLines: number;
  outputBytes: number;
  omittedRows: number;
}

class GraphOutputBuilder {
  private readonly lines: string[] = [];
  private bytes = 0;
  private omittedRows = 0;
  private truncated = false;

  add(line: string): boolean {
    const lineBytes =
      Buffer.byteLength(line, "utf8") + (this.lines.length === 0 ? 0 : 1);
    if (
      this.truncated ||
      this.lines.length >= MAX_CONTENT_LINES ||
      this.bytes + lineBytes > MAX_CONTENT_BYTES
    ) {
      this.truncated = true;
      this.omittedRows += 1;
      return false;
    }
    this.lines.push(line);
    this.bytes += lineBytes;
    return true;
  }

  addRows<T>(rows: readonly T[], format: (row: T) => string): void {
    if (this.truncated) {
      this.omittedRows += rows.length;
      return;
    }
    for (const [index, row] of rows.entries()) {
      if (this.add(format(row))) continue;
      this.omittedRows += rows.length - index - 1;
      return;
    }
  }

  finish(): HearthGraphFormatResult {
    const output = [...this.lines];
    if (this.truncated) {
      output.push(`[Graph output truncated: ${this.omittedRows} rows omitted]`);
    }
    const text = output.join("\n");
    return {
      text,
      truncated: this.truncated,
      outputLines: output.length,
      outputBytes: Buffer.byteLength(text, "utf8"),
      omittedRows: this.omittedRows,
    };
  }
}

export const formatGraphResult = (
  root: string,
  operation: GraphOperation,
  result: GraphResult,
  observer: HearthGraphObserverStatus,
): HearthGraphFormatResult => {
  const formatted = new GraphOutputBuilder();
  formatted.add(metaLine(result.meta, observer));
  formatted.add(
    `observed files=${observer.observedFiles} pending=${observer.pendingFiles} failed=${observer.failedFiles} indexing=${observer.indexing}`,
  );
  if (observer.lastError !== undefined) {
    formatted.add(`auto-index lastError=${boundedField(observer.lastError)}`);
  }

  switch (operation) {
    case "symbols": {
      const output = result.symbols;
      if (output === undefined)
        throw new Error("Hearth graph symbols result missing");
      formatted.add(
        `symbols ${displayPath(root, output.path)} (${output.symbols.length})`,
      );
      formatted.addRows(output.symbols, (symbol) => symbolLine(root, symbol));
      break;
    }
    case "outline": {
      const output = result.outline;
      if (output === undefined)
        throw new Error("Hearth graph outline result missing");
      formatted.add(
        `outline ${displayPath(root, output.path)} (${output.symbols.length})`,
      );
      formatted.addRows(
        output.symbols,
        (symbol) =>
          `${"  ".repeat(Math.min(symbol.depth, 12))}${symbolLine(root, symbol)}`,
      );
      break;
    }
    case "search": {
      const output = result.search;
      if (output === undefined)
        throw new Error("Hearth graph search result missing");
      formatted.add(
        `search results (${output.symbols.length}) limitReached=${output.limitReached}`,
      );
      formatted.addRows(output.symbols, (symbol) => symbolLine(root, symbol));
      break;
    }
    case "definitions": {
      const output = result.definitions;
      if (output === undefined) {
        throw new Error("Hearth graph definitions result missing");
      }
      formatted.add(
        `definitions (${output.symbols.length}) limitReached=${output.limitReached}`,
      );
      formatted.addRows(output.symbols, (symbol) => symbolLine(root, symbol));
      break;
    }
    case "deps": {
      const output = result.deps;
      if (output === undefined)
        throw new Error("Hearth graph deps result missing");
      formatted.add(
        `dependencies ${displayPath(root, output.node.path)} (${output.edges.length})`,
      );
      formatted.addRows(output.edges, (edge) => edgeLine(root, edge));
      formatted.addRows(
        output.unresolved,
        (unresolved) =>
          `unresolved:${unresolved.line} ${boundedField(unresolved.specifier)} (${boundedField(unresolved.reason)})`,
      );
      formatted.add(
        `coverage analyzed=${output.coverage.analyzed} stubs=${output.coverage.stubs}`,
      );
      break;
    }
    case "rdeps": {
      const output = result.rdeps;
      if (output === undefined)
        throw new Error("Hearth graph rdeps result missing");
      formatted.add(
        `reverse dependencies ${displayPath(root, output.node.path)} (${output.importers.length}) verified=${output.verified}`,
      );
      formatted.addRows(
        output.importers,
        (importer) =>
          `${displayPath(root, importer.node.path)}:${importer.line}${importer.specifier === undefined ? "" : ` ${boundedField(importer.specifier)}`} [${importer.guarantee}]`,
      );
      formatted.add(
        `coverage analyzed=${output.coverage.analyzed} stubs=${output.coverage.stubs}`,
      );
      break;
    }
    case "neighborhood": {
      const output = result.neighborhood;
      if (output === undefined) {
        throw new Error("Hearth graph neighborhood result missing");
      }
      formatted.add(
        `neighborhood ${displayPath(root, output.center.path)} nodes=${output.nodes.length} edges=${output.edges.length}`,
      );
      formatted.addRows(
        output.nodes,
        (node) =>
          `node ${displayPath(root, node.path)} language=${node.language ?? "unknown"} indexed=${node.indexed}`,
      );
      formatted.addRows(output.edges, (edge) => edgeLine(root, edge));
      formatted.add(
        `coverage analyzed=${output.coverage.analyzed} stubs=${output.coverage.stubs}`,
      );
      break;
    }
    case "status": {
      const output = result.status;
      if (output === undefined)
        throw new Error("Hearth graph status result missing");
      formatted.add(
        `status built=${output.built} building=${output.building} pending=${output.pendingFiles} stale=${output.staleFiles} failed=${output.failedFiles}`,
      );
      formatted.add(
        `topology symbols=${output.symbols} edges=${output.edges} components=${output.components}`,
      );
      formatted.addRows(
        output.languages,
        (language) =>
          `language ${boundedField(language.language)} files=${language.files} symbols=${language.symbols}`,
      );
      break;
    }
  }

  return formatted.finish();
};

export const createHearthGraphDefinition = (
  root: string,
  engine: HearthEngine,
  gate: HearthAccessGate,
  observer: HearthGraphRuntime,
): ToolDefinition<typeof GraphParameters, Record<string, unknown>> =>
  defineTool({
    name: HEARTH_GRAPH_TOOL_NAME,
    label: "Hearth Graph",
    description:
      "Query the current project module graph and symbol index. Supports symbols, outlines, symbol search, definitions, dependencies, reverse dependencies, neighborhoods, and build status.",
    promptSnippet:
      "Query the Hearth project symbol index and module dependency graph",
    promptGuidelines: [
      "Use hearth_graph after locating relevant files when symbol definitions or module dependency direction would reduce further text searching.",
      "Treat approximate graph guarantees and unresolved imports as incomplete evidence; confirm consequential conclusions with read or grep.",
      "Graph paths are restricted to the current project and traversal depth is bounded.",
    ],
    executionMode: "sequential",
    parameters: GraphParameters,
    async execute(_id, params, signal) {
      await observer.flush(signal);
      const result = await observer.runQuery(
        () =>
          gate.shared(() =>
            runGraphQuery(engine, root, params.operation, params, signal),
          ),
        signal,
      );
      if (params.operation !== "status") {
        observer.markProjectComplete(result.meta.guarantee === "exact");
      }
      const observerStatus = observer.status();
      const effectiveGuarantee = observerStatus.projectComplete
        ? result.meta.guarantee
        : "approximate";
      const formatted = formatGraphResult(
        root,
        params.operation,
        result,
        observerStatus,
      );
      return {
        content: [{ type: "text", text: formatted.text }],
        details: {
          operation: params.operation,
          nativeMeta: result.meta,
          effectiveGuarantee,
          scope: observerStatus.projectComplete
            ? "project"
            : "observed-partial",
          observer: observerStatus,
          truncated: formatted.truncated,
          outputLines: formatted.outputLines,
          outputBytes: formatted.outputBytes,
          omittedRows: formatted.omittedRows,
        },
      };
    },
  });
