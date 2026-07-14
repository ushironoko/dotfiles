import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectViolations,
  EXTENSION_ROOT,
  scanExtension,
} from "../../scripts/check-pi-imports";

const rel = "features/demo/index.ts";
const abs = join(EXTENSION_ROOT, rel);
const check = (source: string): string[] => collectViolations(rel, abs, source);

const fixtureRoot = async (): Promise<string> =>
  realpath(await mkdtemp(join(tmpdir(), "pi-imports-")));

describe("check-pi-imports self-containment analysis", () => {
  test.each([
    'import { x } from "./sibling";',
    'import { a } from "../other/mod";',
    'import { readFile } from "node:fs";',
    // Type-only @earendil-works imports are erased → allowed.
    'import type { T } from "@earendil-works/pi-ai";',
    // Multi-line import stays inside the root.
    'import {\n  a,\n  b,\n} from "./multi";',
    // A string that merely looks like an import must not be flagged.
    `const s = 'import defu from "defu"';`,
    // A commented-out import must not be flagged.
    '// import defu from "defu";\n/* import x from "bar"; */',
  ])("accepts: %s", (source) => {
    expect(check(source)).toEqual([]);
  });

  test("flags a bare runtime import", () => {
    expect(check('import defu from "defu";')[0]).toContain(
      "disallowed bare import defu",
    );
  });

  test("flags a runtime @earendil-works import", () => {
    expect(check('import { x } from "@earendil-works/pi-ai";')[0]).toContain(
      "runtime import of @earendil-works",
    );
  });

  test("flags a relative import that escapes the extension root", () => {
    expect(check('import { x } from "../../../outside/thing";')[0]).toContain(
      "escapes the extension root",
    );
  });

  test("flags a literal dynamic import of a bare specifier", () => {
    expect(check('const m = await import("defu");')[0]).toContain(
      "disallowed bare import defu",
    );
  });

  test("flags a literal require of a bare specifier", () => {
    expect(check('const r = require("defu");')[0]).toContain(
      "disallowed bare import defu",
    );
  });

  test.each([
    'const p = "defu";\nconst m = await import(p);',
    'const p = "x";\nconst r = require(p);',
    'const p = "x";\nconst rr = require.resolve(p);',
  ])("fails closed on a non-literal dynamic call: %s", (source) => {
    expect(check(source).some((v) => v.includes("non-literal"))).toBe(true);
  });

  test("fails closed on an unparseable file", () => {
    expect(check("import { from 'broken")[0]).toContain("could not parse");
  });

  test("does not flag import.meta or import inside a comment", () => {
    expect(
      check("const d = import.meta.dir; // import defu from 'defu'"),
    ).toEqual([]);
  });

  test.each([
    'import { createRequire } from "node:module";',
    "const r = createRequire(import.meta.url);",
    "const r = Module.createRequire(import.meta.url);",
  ])("flags createRequire (import-gate bypass): %s", (source) => {
    expect(check(source).some((v) => v.includes("createRequire"))).toBe(true);
  });

  test.each([
    'const s = "createRequire is a function";',
    "// createRequire(import.meta.url)",
    "const myCreateRequireHelper = () => 1;",
  ])(
    "does not flag createRequire in a string/comment/identifier: %s",
    (source) => {
      expect(check(source)).toEqual([]);
    },
  );
});

describe("check-pi-imports scanExtension enumeration", () => {
  test("analyzes dotfile .ts and rejects escaping/broken symlinks", async () => {
    const root = await fixtureRoot();
    const outside = await fixtureRoot();
    await writeFile(join(outside, "external.ts"), "export const x = 1;\n");

    // A normal file with a clean import → no violation.
    await writeFile(
      join(root, "normal.ts"),
      'import { readFile } from "node:fs";\n',
    );
    // A DOTFILE .ts with a bare import → must be scanned (default glob skips it).
    await writeFile(join(root, ".hidden.ts"), 'import defu from "defu";\n');
    // A file inside a subdirectory.
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "sub", "ok.ts"), 'import { a } from "./x";\n');
    await writeFile(join(root, "sub", "x.ts"), "export const a = 1;\n");
    // A symlink whose target escapes the root.
    await symlink(join(outside, "external.ts"), join(root, "escape.ts"));
    // A broken symlink.
    await symlink(join(root, "does-not-exist.ts"), join(root, "broken.ts"));
    // An internal symlink (points inside the root) is fine.
    await symlink(join(root, "normal.ts"), join(root, "alias.ts"));

    const violations = await scanExtension(root);
    const joined = violations.join("\n");

    expect(joined).toContain(".hidden.ts");
    expect(joined).toContain("disallowed bare import defu");
    expect(joined).toContain("escape.ts");
    expect(joined).toContain("escapes the extension root");
    expect(joined).toContain("broken.ts");
    expect(joined).toContain("broken symlink");
    // The clean and internal-symlink files produce no violation.
    expect(joined).not.toContain("normal.ts");
    expect(joined).not.toContain("alias.ts");
    expect(joined).not.toContain("sub/ok.ts");
  });

  test("a clean tree yields no violations", async () => {
    const root = await fixtureRoot();
    await writeFile(join(root, "a.ts"), 'import { x } from "./b";\n');
    await writeFile(join(root, "b.ts"), "export const x = 1;\n");
    expect(await scanExtension(root)).toEqual([]);
  });
});
