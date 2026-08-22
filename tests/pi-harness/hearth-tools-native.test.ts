import { afterEach, describe, expect, test } from "bun:test";
import {
  generateDiffString,
  generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { HearthEngine, type ShellSpec } from "@hearthdev/napi";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHearthBashDefinition,
  createHearthBashOperations,
  createHearthEditDefinition,
  createHearthFindDefinition,
  createHearthGrepDefinition,
  createHearthReadDefinition,
  createHearthWriteDefinition,
} from "../../pi/extensions/hearth-tools/adapters";
import {
  HearthEngineGate,
  type PiToolSettings,
} from "../../pi/extensions/hearth-tools/engine";

const roots: string[] = [];
const root = async (): Promise<string> => {
  const value = await mkdtemp(join(tmpdir(), "pi-hearth-tools-"));
  roots.push(value);
  return value;
};

const shell: ShellSpec = {
  program: "/bin/bash",
  args: ["-c"],
  transport: "arg" as ShellSpec["transport"],
};

const settings: PiToolSettings = {
  imageAutoResize: true,
  shell,
};

const context = {
  model: undefined,
  sessionManager: {
    getSessionId: () => "hearth-tools-test",
    getSessionFile: () => undefined,
  },
} as never;

interface NativeAbortController {
  readonly signal: AbortSignal;
  abort(): void;
}

const nativeAbortController = (): NativeAbortController => {
  const Constructor =
    globalThis.AbortController as unknown as new () => NativeAbortController;
  return new Constructor();
};

const engine = (cwd: string): HearthEngine =>
  new HearthEngine({
    cwd,
    trustCache: true,
    warmShell: true,
    enableOptimizer: false,
    shell,
  });

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Hearth-backed pi tool contracts", () => {
  test("write and read preserve pi output and warm cached bytes", async () => {
    const cwd = await root();
    const hearth = engine(cwd);
    const write = createHearthWriteDefinition(cwd, hearth);
    const read = createHearthReadDefinition(cwd, hearth, settings);

    const written = await write.execute(
      "write-1",
      { path: "nested/file.txt", content: "one\ntwo\nthree\n" },
      undefined,
      undefined,
      context,
    );
    expect(written.content[0]).toEqual({
      type: "text",
      text: "Successfully wrote 14 bytes to nested/file.txt",
    });

    const result = await read.execute(
      "read-1",
      { path: "nested/file.txt", offset: 2, limit: 1 },
      undefined,
      undefined,
      context,
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: "two\n\n[2 more lines in file. Use offset=3 to continue.]",
    });
  });

  test("read and grep report observed files without changing successful results", async () => {
    const cwd = await root();
    const path = join(cwd, "observed.ts");
    await writeFile(path, "export const observed = true;\n");
    const hearth = engine(cwd);
    const observed: string[][] = [];
    const observer = {
      observe(paths: readonly string[]) {
        observed.push([...paths]);
      },
    };

    const read = createHearthReadDefinition(
      cwd,
      hearth,
      settings,
      undefined,
      observer,
    );
    const readResult = await read.execute(
      "read-observed",
      { path: "observed.ts" },
      undefined,
      undefined,
      context,
    );
    expect(readResult.content[0]).toEqual({
      type: "text",
      text: "export const observed = true;\n",
    });

    const grep = createHearthGrepDefinition(cwd, hearth, undefined, observer);
    const grepResult = await grep.execute(
      "grep-observed",
      { pattern: "observed", path: "." },
      undefined,
      undefined,
      context,
    );
    expect(grepResult.content[0]).toEqual({
      type: "text",
      text: "observed.ts:1: export const observed = true;",
    });
    expect(observed).toEqual([[path], [path]]);

    const advisoryRead = createHearthReadDefinition(
      cwd,
      hearth,
      settings,
      undefined,
      {
        observe() {
          throw new Error("graph observer failure");
        },
      },
    );
    await expect(
      advisoryRead.execute(
        "read-advisory",
        { path: "observed.ts" },
        undefined,
        undefined,
        context,
      ),
    ).resolves.toBeDefined();
  });

  test("edit applies multiple original-relative replacements and returns pi details", async () => {
    const cwd = await root();
    const path = join(cwd, "edit.txt");
    await writeFile(path, "one\ntwo\nthree\n");
    const edit = createHearthEditDefinition(cwd, engine(cwd));

    const result = await edit.execute(
      "edit-1",
      {
        path: "edit.txt",
        edits: [
          { oldText: "one", newText: "ONE" },
          { oldText: "three", newText: "THREE" },
        ],
      },
      undefined,
      undefined,
      context,
    );
    expect(await readFile(path, "utf8")).toBe("ONE\ntwo\nTHREE\n");
    expect(result.details?.diff).toBe(
      generateDiffString("one\ntwo\nthree\n", "ONE\ntwo\nTHREE\n").diff,
    );
    expect(result.details?.patch).toBe(
      generateUnifiedPatch(
        "edit.txt",
        "one\ntwo\nthree\n",
        "ONE\ntwo\nTHREE\n",
      ),
    );
    expect(result.details?.firstChangedLine).toBe(1);
  });

  test("edit patch formatting matches pi for deletion edge cases", async () => {
    const cwd = await root();
    const edit = createHearthEditDefinition(cwd, engine(cwd));
    const cases = [
      {
        path: "delete-line.txt",
        before: "a\nb\n",
        oldText: "b\n",
        after: "a\n",
      },
      {
        path: "delete-final.txt",
        before: "a",
        oldText: "a",
        after: "",
      },
    ];

    for (const item of cases) {
      await writeFile(join(cwd, item.path), item.before);
      const result = await edit.execute(
        `edit-${item.path}`,
        {
          path: item.path,
          edits: [{ oldText: item.oldText, newText: "" }],
        },
        undefined,
        undefined,
        context,
      );

      expect(result.details?.diff).toBe(
        generateDiffString(item.before, item.after).diff,
      );
      expect(result.details?.patch).toBe(
        generateUnifiedPatch(item.path, item.before, item.after),
      );
    }
  });

  test("edit accepts an exact whitespace-only target and maps failures", async () => {
    const cwd = await root();
    const path = join(cwd, "spaces.txt");
    await writeFile(path, "   ");
    const edit = createHearthEditDefinition(cwd, engine(cwd));

    await edit.execute(
      "edit-spaces",
      {
        path: "spaces.txt",
        edits: [{ oldText: "   ", newText: "x" }],
      },
      undefined,
      undefined,
      context,
    );
    expect(await readFile(path, "utf8")).toBe("x");

    await expect(
      edit.execute(
        "edit-missing",
        {
          path: "spaces.txt",
          edits: [{ oldText: "missing", newText: "y" }],
        },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(
      "Could not find the exact text in spaces.txt. The old text must match exactly including all whitespace and newlines.",
    );
  });

  test("find preserves Pi output while reusing Hearth's resident walk cache", async () => {
    const cwd = await root();
    await mkdir(join(cwd, "src", "nested"), { recursive: true });
    await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(cwd, ".hidden.ts"), "");
    await writeFile(join(cwd, "src", "a.ts"), "");
    await writeFile(join(cwd, "src", "nested", "b.ts"), "");
    await writeFile(join(cwd, "node_modules", "pkg", "ignored.ts"), "");
    const hearth = engine(cwd);
    const find = createHearthFindDefinition(cwd, hearth);

    const result = await find.execute(
      "find-1",
      { pattern: "*.ts", path: ".", limit: 10 },
      undefined,
      undefined,
      context,
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: [".hidden.ts", "src/a.ts", "src/nested/b.ts"].join("\n"),
    });
    expect(result.details).toBeUndefined();

    const subdirectory = await find.execute(
      "find-subdirectory",
      { pattern: "*.ts", path: "src", limit: 10 },
      undefined,
      undefined,
      context,
    );
    expect(subdirectory.content[0]).toEqual({
      type: "text",
      text: ["a.ts", "nested/b.ts"].join("\n"),
    });
    expect(
      hearth.find({
        pattern: "*.ts",
        path: cwd,
        limit: 10,
        excludeGlobs: ["**/node_modules/**", "**/.git/**"],
      }).walkCacheHit,
    ).toBe(true);
  });

  test("find forwards abort and keeps its Engine lease until native settlement", async () => {
    const cwd = await root();
    let markStarted = (): void => {};
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    let finishFind = (_result: { paths: string[]; root: string }): void => {};
    const nativeFinished = new Promise<{ paths: string[]; root: string }>(
      (resolveFinished) => {
        finishFind = resolveFinished;
      },
    );
    let receivedSignal: AbortSignal | undefined;
    const fakeEngine = {
      findAsync(_params: unknown, signal?: AbortSignal) {
        receivedSignal = signal;
        markStarted();
        return nativeFinished;
      },
    } as unknown as HearthEngine;
    const gate = new HearthEngineGate();
    const find = createHearthFindDefinition(cwd, fakeEngine, gate);
    const controller = nativeAbortController();

    const executing = find.execute(
      "find-abort",
      { pattern: "*.ts", path: ".", limit: 10 },
      controller.signal,
      undefined,
      context,
    );
    await started;
    expect(receivedSignal).toBe(controller.signal);
    controller.abort();
    await expect(executing).rejects.toThrow("Operation aborted");

    let writerRan = false;
    const writer = gate.exclusive(async () => {
      writerRan = true;
    });
    expect(writerRan).toBe(false);
    finishFind({ paths: [], root: cwd });
    await writer;
    expect(writerRan).toBe(true);
  });

  test("grep formats relative paths, context, and a global limit", async () => {
    const cwd = await root();
    await writeFile(join(cwd, "a.txt"), "before\nmatch one\nafter\n");
    await writeFile(join(cwd, "b.txt"), "match two\n");
    const grep = createHearthGrepDefinition(cwd, engine(cwd));

    const result = await grep.execute(
      "grep-1",
      { pattern: "match", path: ".", context: 1, limit: 1 },
      undefined,
      undefined,
      context,
    );
    const text =
      result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("a.txt:2: match one");
    expect(text).toContain("1 matches limit reached");
    expect(result.details?.matchLimitReached).toBe(1);
  });

  test("grep preserves root-relative and negative ripgrep globs", async () => {
    const cwd = await root();
    await mkdir(join(cwd, "src", "nested"), { recursive: true });
    await writeFile(join(cwd, "src", "a.ts"), "needle\n");
    await writeFile(join(cwd, "src", "a.md"), "needle\n");
    await writeFile(join(cwd, "src", "nested", "deep.ts"), "needle\n");
    await writeFile(join(cwd, "src", "README.md"), "needle\n");
    await writeFile(join(cwd, "README.md"), "needle\n");
    await writeFile(join(cwd, "root.ts"), "needle\n");
    const grep = createHearthGrepDefinition(cwd, engine(cwd));

    const relative = await grep.execute(
      "grep-relative",
      { pattern: "needle", path: ".", glob: "src/*.ts" },
      undefined,
      undefined,
      context,
    );
    expect(relative.content[0]).toEqual({
      type: "text",
      text: "src/a.ts:1: needle",
    });

    const rootedPositive = await grep.execute(
      "grep-rooted-positive",
      { pattern: "needle", path: ".", glob: "/src/*.ts" },
      undefined,
      undefined,
      context,
    );
    expect(rootedPositive.content[0]).toEqual({
      type: "text",
      text: "src/a.ts:1: needle",
    });

    const rootedBasename = await grep.execute(
      "grep-rooted-basename",
      { pattern: "needle", path: "src", glob: "/README.md" },
      undefined,
      undefined,
      context,
    );
    expect(rootedBasename.content[0]).toEqual({
      type: "text",
      text: "No matches found",
    });

    const cwdRelative = await grep.execute(
      "grep-cwd-relative",
      { pattern: "needle", path: "src", glob: "src/*.ts" },
      undefined,
      undefined,
      context,
    );
    expect(cwdRelative.content[0]).toEqual({
      type: "text",
      text: "a.ts:1: needle",
    });

    const negative = await grep.execute(
      "grep-negative",
      { pattern: "needle", path: ".", glob: "!*.md" },
      undefined,
      undefined,
      context,
    );
    const negativeText =
      negative.content[0]?.type === "text" ? negative.content[0].text : "";
    expect(negativeText).toContain("root.ts:1: needle");
    expect(negativeText).toContain("src/a.ts:1: needle");
    expect(negativeText).not.toContain("a.md");

    const rootedNegative = await grep.execute(
      "grep-rooted-negative",
      { pattern: "needle", path: ".", glob: "!/src/*.ts" },
      undefined,
      undefined,
      context,
    );
    const rootedText =
      rootedNegative.content[0]?.type === "text"
        ? rootedNegative.content[0].text
        : "";
    expect(rootedText).toContain("root.ts:1: needle");
    expect(rootedText).toContain("src/a.md:1: needle");
    expect(rootedText).toContain("src/nested/deep.ts:1: needle");
    expect(rootedText).not.toContain("src/a.ts");

    const excludedDirectory = await grep.execute(
      "grep-excluded-directory",
      { pattern: "needle", path: ".", glob: "!src/*" },
      undefined,
      undefined,
      context,
    );
    const excludedDirectoryText =
      excludedDirectory.content[0]?.type === "text"
        ? excludedDirectory.content[0].text
        : "";
    expect(excludedDirectoryText).toContain("README.md:1: needle");
    expect(excludedDirectoryText).toContain("root.ts:1: needle");
    expect(excludedDirectoryText).not.toContain("src/");

    for (const glob of ["!src/nested/", "!nested/"]) {
      const directoryOnly = await grep.execute(
        `grep-directory-only-${glob}`,
        { pattern: "needle", path: ".", glob },
        undefined,
        undefined,
        context,
      );
      const directoryOnlyText =
        directoryOnly.content[0]?.type === "text"
          ? directoryOnly.content[0].text
          : "";
      expect(directoryOnlyText).toContain("src/a.ts:1: needle");
      expect(directoryOnlyText).not.toContain("src/nested/deep.ts");
    }

    const rootedFromSubdir = await grep.execute(
      "grep-rooted-subdir",
      { pattern: "needle", path: "src", glob: "!/a.ts" },
      undefined,
      undefined,
      context,
    );
    const rootedFromSubdirText =
      rootedFromSubdir.content[0]?.type === "text"
        ? rootedFromSubdir.content[0].text
        : "";
    expect(rootedFromSubdirText).toContain("a.md:1: needle");
    expect(rootedFromSubdirText).toContain("a.ts:1: needle");

    const explicitFile = await grep.execute(
      "grep-file-glob",
      { pattern: "needle", path: "src/a.ts", glob: "!*.ts" },
      undefined,
      undefined,
      context,
    );
    expect(explicitFile.content[0]).toEqual({
      type: "text",
      text: "a.ts:1: needle",
    });

    const escapedFileGlob = await grep.execute(
      "grep-escaped-file-glob",
      { pattern: "needle", path: "src/a.ts", glob: "!\\[" },
      undefined,
      undefined,
      context,
    );
    expect(escapedFileGlob.content[0]).toEqual({
      type: "text",
      text: "a.ts:1: needle",
    });

    for (const glob of ["![", "![z-a]", "!{a,b", "!a}", "!\\"]) {
      await expect(
        grep.execute(
          `grep-invalid-file-glob-${glob}`,
          { pattern: "needle", path: "src/a.ts", glob },
          undefined,
          undefined,
          context,
        ),
      ).rejects.toThrow(/invalid glob|error parsing glob/);
    }
  });

  test("grep reproduces pi context blocks for adjacent matches", async () => {
    const cwd = await root();
    await writeFile(
      join(cwd, "adjacent.txt"),
      "first\nmatch one\nmatch two\nlast\n",
    );
    const grep = createHearthGrepDefinition(cwd, engine(cwd));

    const result = await grep.execute(
      "grep-adjacent",
      { pattern: "match", path: ".", context: 1 },
      undefined,
      undefined,
      context,
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: [
        "adjacent.txt-1- first",
        "adjacent.txt:2: match one",
        "adjacent.txt-3- match two",
        "adjacent.txt-2- match one",
        "adjacent.txt:3: match two",
        "adjacent.txt-4- last",
      ].join("\n"),
    });

    const limited = await grep.execute(
      "grep-adjacent-limit",
      { pattern: "match", path: ".", context: 1, limit: 1 },
      undefined,
      undefined,
      context,
    );
    const limitedText =
      limited.content[0]?.type === "text" ? limited.content[0].text : "";
    expect(limitedText).toContain(
      [
        "adjacent.txt-1- first",
        "adjacent.txt:2: match one",
        "adjacent.txt-3- match two",
      ].join("\n"),
    );
  });

  test("bounds post-filtered glob candidates and fails closed if underfilled", async () => {
    const cwd = await root();
    let maxTotalCount: number | undefined;
    const fakeEngine = {
      async grepAsync(params: { maxTotalCount?: number }) {
        ({ maxTotalCount } = params);
        return {
          files: [],
          totalMatches: maxTotalCount ?? 0,
          filesSearched: 1,
          walkCacheHit: false,
          limitReached: true,
          root: cwd,
          rootIsDir: true,
        };
      },
    } as unknown as HearthEngine;
    const grep = createHearthGrepDefinition(cwd, fakeEngine);

    await expect(
      grep.execute(
        "grep-negative-bound",
        { pattern: ".", path: ".", glob: "!*.md", limit: 1 },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("Negative glob candidate scan limit reached");
    await expect(
      grep.execute(
        "grep-positive-bound",
        { pattern: ".", path: ".", glob: "src/*.ts", limit: 1 },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("Positive glob candidate scan limit reached");
    expect(maxTotalCount).toBeGreaterThan(0);
    expect(maxTotalCount).toBeLessThanOrEqual(100_000);
  });

  test("grep surfaces a native incomplete-search warning even with no matches", async () => {
    const cwd = await root();
    const fakeEngine = {
      async grepAsync() {
        return {
          files: [],
          totalMatches: 0,
          filesSearched: 1,
          walkCacheHit: false,
          limitReached: false,
          incomplete: true,
          root: cwd,
          rootIsDir: true,
        };
      },
    } as unknown as HearthEngine;
    const grep = createHearthGrepDefinition(cwd, fakeEngine);

    const result = await grep.execute(
      "grep-incomplete",
      { pattern: "missing", path: "." },
      undefined,
      undefined,
      context,
    );

    expect(result.content[0]).toEqual({
      type: "text",
      text: [
        "No matches found",
        "",
        "[Search incomplete: Hearth could not fully search at least one selected file. Use read or narrow the path to verify omitted content]",
      ].join("\n"),
    });
  });

  test("grep maps a pre-aborted request to pi's error", async () => {
    const cwd = await root();
    const controller = nativeAbortController();
    controller.abort();
    const grep = createHearthGrepDefinition(cwd, engine(cwd));

    await expect(
      grep.execute(
        "grep-abort",
        { pattern: "x", path: "." },
        controller.signal,
        undefined,
        context,
      ),
    ).rejects.toThrow("Operation aborted");
  });

  test("bash streams output once, applies prefix, and clears stale cache", async () => {
    const cwd = await root();
    const path = join(cwd, "value.txt");
    await writeFile(path, "old\n");
    const hearth = engine(cwd);
    await hearth.readAsync({ path });
    const bash = createHearthBashDefinition(cwd, hearth, {
      ...settings,
      shellCommandPrefix: "export PREFIXED=yes",
    });
    const updates: string[] = [];

    const result = await bash.execute(
      "bash-1",
      {
        command: `printf "$PREFIXED"; printf 'new\\n' > ${JSON.stringify(path)}`,
      },
      undefined,
      (update) => {
        const [block] = update.content;
        if (block?.type === "text") updates.push(block.text);
      },
      context,
    );
    expect(result.content[0]).toEqual({ type: "text", text: "yes" });
    expect(updates.join("\n")).toContain("yes");
    const reread = await hearth.readAsync({ path });
    expect(reread.content).toBe("new\n");
  });

  test("bash marks output omitted by Hearth's native stream cap", async () => {
    const cwd = await root();
    const fakeEngine = {
      async bashStream(
        _params: unknown,
        onChunk: (chunk: {
          seq: number;
          channel: "stdout";
          text: string;
        }) => void,
      ) {
        onChunk({ seq: 1, channel: "stdout", text: "kept" });
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          aborted: false,
          durationUs: 1,
          chunks: 1,
          outputTruncated: true,
        };
      },
      clearCaches() {
        return { filesInvalidated: 0, walksInvalidated: 0 };
      },
    } as unknown as HearthEngine;
    const operations = createHearthBashOperations(fakeEngine, shell);
    const chunks: Buffer[] = [];

    const result = await operations.exec("printf kept", cwd, {
      onData(data) {
        chunks.push(data);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(
      "kept\n[Hearth native output limit reached; omitted output is unavailable]\n",
    );
  });

  test("bash reports the effective Engine timeout and maps aborts", async () => {
    const cwd = await root();
    const hearth = engine(cwd);
    const bash = createHearthBashDefinition(cwd, hearth, settings, {
      defaultTimeoutMs: 20,
    });

    await expect(
      bash.execute(
        "bash-timeout",
        { command: "sleep 1" },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow("Command timed out after 0.02 seconds");

    const controller = nativeAbortController();
    controller.abort();
    await expect(
      bash.execute(
        "bash-abort",
        { command: "printf never" },
        controller.signal,
        undefined,
        context,
      ),
    ).rejects.toThrow("Command aborted");
  });

  test("bash treats a fresh-shell signal exit like pi's null exit code", async () => {
    const cwd = await root();
    const hearth = new HearthEngine({
      cwd,
      trustCache: true,
      warmShell: false,
      enableOptimizer: false,
      shell,
    });
    const bash = createHearthBashDefinition(cwd, hearth, settings);

    const result = await bash.execute(
      "bash-signal",
      { command: "kill -TERM $$" },
      undefined,
      undefined,
      context,
    );
    expect(result.content[0]).toEqual({
      type: "text",
      text: "(no output)",
    });
  });

  test("bash never retries an indeterminate warm-shell signal", async () => {
    const cwd = await root();
    const pooledShell: ShellSpec = {
      program: "/bin/sh",
      args: ["-c"],
      transport: "arg" as ShellSpec["transport"],
    };
    const hearth = new HearthEngine({
      cwd,
      trustCache: true,
      warmShell: true,
      enableOptimizer: false,
      shell: pooledShell,
    });
    const bash = createHearthBashDefinition(cwd, hearth, {
      ...settings,
      shell: pooledShell,
    });

    await expect(
      bash.execute(
        "bash-warm-signal",
        { command: "kill -9 $$" },
        undefined,
        undefined,
        context,
      ),
    ).rejects.toThrow(
      "Hearth reported an indeterminate command outcome; inspect state before retrying",
    );
  });
});
