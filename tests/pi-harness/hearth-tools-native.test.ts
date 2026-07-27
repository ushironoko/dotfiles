import { afterEach, describe, expect, test } from "bun:test";
import {
  generateDiffString,
  generateUnifiedPatch,
} from "@earendil-works/pi-coding-agent";
import { HearthEngine, type ShellSpec } from "@hearthdev/napi";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("edit patch formatting matches pi for a one-line deletion", async () => {
    const cwd = await root();
    const path = join(cwd, "delete.txt");
    await writeFile(path, "a\nb\n");
    const edit = createHearthEditDefinition(cwd, engine(cwd));

    const result = await edit.execute(
      "edit-delete",
      {
        path: "delete.txt",
        edits: [{ oldText: "b\n", newText: "" }],
      },
      undefined,
      undefined,
      context,
    );

    expect(result.details?.diff).toBe(generateDiffString("a\nb\n", "a\n").diff);
    expect(result.details?.patch).toBe(
      generateUnifiedPatch("delete.txt", "a\nb\n", "a\n"),
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
});
