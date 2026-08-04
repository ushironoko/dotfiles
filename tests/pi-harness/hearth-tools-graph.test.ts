import { afterEach, describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  HearthEngine,
  type GraphMeta,
  type GraphResult,
  type GraphSymbol,
  type ShellSpec,
} from "@hearthdev/napi";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HearthEngineGate } from "../../pi/extensions/hearth-tools/engine";
import {
  createHearthGraphDefinition,
  formatGraphResult,
  HearthGraphObserver,
} from "../../pi/extensions/hearth-tools/graph";
import { stripTerminalControls } from "../../pi/extensions/hearth-tools/terminal-text";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), "pi-hearth-graph-"));
  roots.push(value);
  return value;
};

const shell: ShellSpec = {
  program: "/bin/bash",
  args: ["-c"],
  transport: "arg" as ShellSpec["transport"],
};

const engine = (cwd: string): HearthEngine =>
  new HearthEngine({
    cwd,
    trustCache: true,
    warmShell: false,
    enableOptimizer: false,
    shell,
  });

const context = { model: undefined } as never;

interface NativeAbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

const abortController = (): NativeAbortController => {
  const Constructor =
    globalThis.AbortController as unknown as new () => NativeAbortController;
  return new Constructor();
};

const resultText = (
  result: Awaited<
    ReturnType<ReturnType<typeof createHearthGraphDefinition>["execute"]>
  >,
): string => {
  const [content] = result.content;
  return content?.type === "text" ? content.text : "";
};

const ansi = new RegExp(String.raw`\u001B\[[0-9;]*m`, "g");
const visibleText = (text: string): string => text.replace(ansi, "").trimEnd();
const renderTheme = {
  getFgAnsi(color: string) {
    return color === "success" ? "\x1b[32m" : "\x1b[31m";
  },
  fg(_color: string, text: string) {
    return `\x1b[36m${text}\x1b[39m`;
  },
  bold(text: string) {
    return `\x1b[1m${text}\x1b[22m`;
  },
} as Theme;
const renderContext = (
  args: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) =>
  ({
    args,
    toolCallId: "graph-call",
    invalidate() {},
    lastComponent: undefined,
    state: undefined,
    cwd: "/workspace",
    executionStarted: true,
    argsComplete: true,
    isPartial: true,
    expanded: false,
    showImages: true,
    isError: false,
    ...overrides,
  }) as never;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Hearth graph integration", () => {
  test("makes the operation and primary target visible in the call title", () => {
    const tool = createHearthGraphDefinition(
      "/workspace",
      {} as never,
      {} as never,
      {} as never,
    );
    const { renderCall } = tool;
    if (renderCall === undefined)
      throw new Error("missing graph call renderer");
    const args = { operation: "definitions" as const, name: "run" };

    const pending = renderCall(args, renderTheme, renderContext(args));
    expect(visibleText(pending.render(120).join("\n"))).toBe(
      "graph_definitions run",
    );

    const settled = renderCall(
      args,
      renderTheme,
      renderContext(args, { lastComponent: pending, isPartial: false }),
    );
    expect(settled).toBe(pending);
    expect(visibleText(settled.render(120).join("\n"))).toBe(
      "✓ graph_definitions run",
    );
    expect(
      settled.render(20).every((line) => visibleText(line).length <= 20),
    ).toBe(true);
    expect(
      settled.render(1).every((line) => visibleText(line).length <= 1),
    ).toBe(true);

    const depsArgs = { operation: "deps" as const, path: "src/run.ts" };
    const deps = renderCall(depsArgs, renderTheme, renderContext(depsArgs));
    expect(visibleText(deps.render(120).join("\n"))).toBe(
      "graph_deps src/run.ts",
    );

    const rdepsArgs = { operation: "rdeps" as const, path: "src/value.ts" };
    const rdeps = renderCall(rdepsArgs, renderTheme, renderContext(rdepsArgs));
    expect(visibleText(rdeps.render(120).join("\n"))).toBe(
      "graph_rdeps src/value.ts",
    );

    const searchArgs = { operation: "search" as const, query: "graph use" };
    const failed = renderCall(
      searchArgs,
      renderTheme,
      renderContext(searchArgs, { isPartial: false, isError: true }),
    );
    expect(visibleText(failed.render(120).join("\n"))).toBe(
      '✗ graph_search "graph use"',
    );
    expect(tool.renderResult).toBeUndefined();
  });

  test("sanitizes unvalidated call arguments without losing failure feedback", () => {
    const tool = createHearthGraphDefinition(
      "/workspace",
      {} as never,
      {} as never,
      {} as never,
    );
    const { renderCall } = tool;
    if (renderCall === undefined)
      throw new Error("missing graph call renderer");

    expect(
      stripTerminalControls(
        "safe\x1b[31m red\x1b[0m\x1b]2;spoof\x07\u0000\u009dhidden\u009c text",
      ),
    ).toBe("safe red text");

    const unsafeArgs = {
      operation: "search",
      query: "\x1b]2;spoof\x07graph\x1b[31m use\x1b[0m\u0000\u009dhidden\u009c",
    };
    const unsafe = renderCall(
      unsafeArgs as never,
      renderTheme,
      renderContext(unsafeArgs),
    );
    const unsafeRendered = unsafe.render(120).join("\n");
    expect(unsafeRendered).not.toContain("\x1b]2;spoof");
    expect(unsafeRendered).not.toContain("\x07");
    expect(unsafeRendered).not.toContain("\u0000");
    expect(unsafeRendered).not.toContain("hidden");
    expect(visibleText(unsafeRendered)).toBe('graph_search "graph use"');

    const oversizedArgs = {
      operation: "search",
      query: `${"\x1b[31m".repeat(2_000)}tail`,
    };
    const oversized = renderCall(
      oversizedArgs as never,
      renderTheme,
      renderContext(oversizedArgs),
    );
    expect(visibleText(oversized.render(120).join("\n"))).toBe(
      'graph_search "…"',
    );

    const malformedArgs = { operation: "search", query: null };
    const malformed = renderCall(
      malformedArgs as never,
      renderTheme,
      renderContext(malformedArgs, { isPartial: false, isError: true }),
    );
    expect(visibleText(malformed.render(120).join("\n"))).toBe(
      "✗ graph_search",
    );

    const nullArgs = renderCall(
      null as never,
      renderTheme,
      renderContext(
        {},
        {
          args: null,
          isPartial: false,
          isError: true,
        },
      ),
    );
    expect(visibleText(nullArgs.render(120).join("\n"))).toBe("✗ graph_…");

    const invalidOperationArgs = {
      operation: "\x1b]2;spoof\x07search",
      query: "hidden target",
    };
    const invalidOperation = renderCall(
      invalidOperationArgs as never,
      renderTheme,
      renderContext(invalidOperationArgs),
    );
    const invalidOperationRendered = invalidOperation.render(120).join("\n");
    expect(invalidOperationRendered).not.toContain("\x1b]2;spoof");
    expect(visibleText(invalidOperationRendered)).toBe("graph_…");
  });

  test("incrementally indexes observed files and exposes project graph queries", async () => {
    const cwd = await root();
    await mkdir(join(cwd, "src"), { recursive: true });
    const dependency = join(cwd, "src", "value.ts");
    const importer = join(cwd, "src", "run.ts");
    await writeFile(dependency, "export const value = 1;\n");
    await writeFile(
      importer,
      'import { value } from "./value";\nexport function run() { return value; }\n',
    );

    const hearth = engine(cwd);
    const gate = new HearthEngineGate();
    const observer = new HearthGraphObserver(cwd, hearth, gate);
    observer.observe([dependency, join(cwd, "..", "outside.ts")]);
    await observer.flush();

    const partial = await hearth.graphStatusAsync({ root: cwd });
    expect(partial.status?.built).toBe(true);
    expect(partial.status?.indexedFiles).toBe(1);
    expect(observer.status().observedFiles).toBe(1);

    observer.observe([importer]);
    await observer.flush();
    const observedStatus = await hearth.graphStatusAsync({ root: cwd });
    expect(observedStatus.status?.indexedFiles).toBe(2);
    const partialText = formatGraphResult(
      cwd,
      "status",
      observedStatus,
      observer.status(),
    ).text;
    expect(partialText).toContain(
      "guarantee=approximate scope=observed-partial indexed=2 lastSweepFiles=1",
    );
    expect(partialText).not.toContain("indexed=2/1");

    const tool = createHearthGraphDefinition(cwd, hearth, gate, observer);
    const definitions = await tool.execute(
      "graph-definitions",
      { operation: "definitions", name: "run" },
      undefined,
      undefined,
      context,
    );
    const definitionsText = resultText(definitions);
    expect(definitionsText).toContain("definitions (1)");
    expect(definitionsText).toContain("src/run.ts");
    expect(definitionsText).toContain("function run");

    const dependencies = await tool.execute(
      "graph-deps",
      { operation: "deps", path: "src/run.ts" },
      undefined,
      undefined,
      context,
    );
    const dependenciesText = resultText(dependencies);
    expect(dependenciesText).toContain("dependencies src/run.ts");
    expect(dependenciesText).toContain("src/value.ts");
    expect(dependenciesText).toContain("guarantee=exact");

    observer.dispose();
  });

  test("retains failed batches until their files are successfully retried", async () => {
    const cwd = await root();
    const broken = join(cwd, "broken.ts");
    const healthy = join(cwd, "healthy.ts");
    await writeFile(broken, "export const broken = true;\n");
    await writeFile(healthy, "export const healthy = true;\n");
    let brokenFails = true;
    const fakeEngine = {
      async graphDefinitionsAsync(params: { files?: string[] }) {
        if (brokenFails && params.files?.includes(broken)) {
          throw new Error("synthetic graph failure");
        }
        return {};
      },
    } as unknown as HearthEngine;
    const observer = new HearthGraphObserver(
      cwd,
      fakeEngine,
      new HearthEngineGate(),
    );

    observer.observe([broken]);
    await expect(observer.flush()).resolves.toBeUndefined();
    observer.observe([healthy]);
    await observer.flush();
    expect(observer.status()).toMatchObject({
      observedFiles: 2,
      pendingFiles: 0,
      failedFiles: 1,
      indexing: false,
      projectComplete: false,
      lastError: "synthetic graph failure",
    });

    brokenFails = false;
    observer.observe([broken]);
    await observer.flush();
    expect(observer.status().failedFiles).toBe(0);
    expect(observer.status().lastError).toBeUndefined();
  });

  test("lets a graph call stop waiting for session-scoped warmup", async () => {
    const cwd = await root();
    const path = join(cwd, "slow.ts");
    await writeFile(path, "export const slow = true;\n");
    let markStarted = (): void => {};
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let markFinished = (): void => {};
    const finished = new Promise<void>((resolveFinished) => {
      markFinished = resolveFinished;
    });
    const fakeEngine = {
      graphDefinitionsAsync(_params: unknown, signal: AbortSignal | undefined) {
        markStarted();
        return new Promise((_resolve, reject) => {
          if (signal === undefined) return;
          const observable = signal as unknown as {
            addEventListener(
              type: "abort",
              listener: () => void,
              options?: { once?: boolean },
            ): void;
          };
          observable.addEventListener(
            "abort",
            () => {
              reject(new Error("session warmup cancelled"));
              markFinished();
            },
            { once: true },
          );
        });
      },
    } as unknown as HearthEngine;
    const observer = new HearthGraphObserver(
      cwd,
      fakeEngine,
      new HearthEngineGate(),
    );
    observer.observe([path]);
    await started;

    const caller = abortController();
    const draining = observer.flush(caller.signal);
    caller.abort();
    await expect(draining).rejects.toThrow("Operation aborted");

    observer.dispose();
    await finished;
  });

  test("formats huge graph results incrementally within strict output bounds", () => {
    const cwd = "/workspace";
    const symbol: GraphSymbol = {
      name: "repeated_symbol",
      kind: "function",
      path: join(cwd, "src", "module.ts"),
      nodeId: "node",
      line: 1,
      column: 1,
      depth: 0,
    };
    const symbols: GraphSymbol[] = Array.from(
      { length: 150_000 },
      () => symbol,
    );
    const meta: GraphMeta = {
      guarantee: "exact" as GraphMeta["guarantee"],
      root: cwd,
      universeFiles: 150_000,
      indexedFiles: 150_000,
      unsupportedFiles: 0,
      oversizeFiles: 0,
      revalidatedFiles: 150_000,
      reindexedFiles: 150_000,
      swept: true,
      sweepAgeMs: 0,
      walkCacheHit: false,
      repairTruncated: false,
    };
    const result = {
      meta,
      search: { symbols, limitReached: false },
    } satisfies GraphResult;

    const formatted = formatGraphResult(cwd, "search", result, {
      observedFiles: 150_000,
      pendingFiles: 0,
      failedFiles: 0,
      indexing: false,
      projectComplete: true,
    });
    expect(formatted.truncated).toBe(true);
    expect(formatted.omittedRows).toBeGreaterThan(100_000);
    expect(formatted.outputLines).toBeLessThanOrEqual(200);
    expect(formatted.outputBytes).toBeLessThanOrEqual(32 * 1024);
    expect(formatted.text.split("\n")).toHaveLength(formatted.outputLines);
    expect(formatted.text).toContain("Graph output truncated");
  });
});
