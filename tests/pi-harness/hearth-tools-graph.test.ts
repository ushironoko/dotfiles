import { afterEach, describe, expect, test } from "bun:test";
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

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Hearth graph integration", () => {
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
