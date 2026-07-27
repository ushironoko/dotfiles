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
  createHearthEditDefinition,
  createHearthGrepDefinition,
  createHearthReadDefinition,
  createHearthWriteDefinition,
} from "../../pi/extensions/hearth-tools/adapters";
import type { PiToolSettings } from "../../pi/extensions/hearth-tools/engine";

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

const context = { model: undefined } as never;

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
    await mkdir(join(cwd, "src"));
    await writeFile(join(cwd, "src", "a.ts"), "needle\n");
    await writeFile(join(cwd, "src", "a.md"), "needle\n");
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
        const block = update.content[0];
        if (block?.type === "text") updates.push(block.text);
      },
      context,
    );
    expect(result.content[0]).toEqual({ type: "text", text: "yes" });
    expect(updates.join("\n")).toContain("yes");
    expect((await hearth.readAsync({ path })).content).toBe("new\n");
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

  test("bash treats a signal exit like pi's null exit code", async () => {
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
});
