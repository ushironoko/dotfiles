import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  collectViolations,
  EXTENSION_ROOT,
} from "../../scripts/check-pi-imports";

const rel = "features/demo/index.ts";
const abs = join(EXTENSION_ROOT, rel);
const check = (source: string): string[] => collectViolations(rel, abs, source);

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
});
