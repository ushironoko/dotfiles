/**
 * Enforces the pi-harness self-containment rule: the extension is loaded via
 * a symlink under ~/.pi/agent/extensions, so it must not import repo code
 * outside its own directory. Allowed imports:
 *   (a) relative paths that stay inside pi/extensions/pi-harness
 *   (b) node: builtins
 *   (c) typebox (runtime, ships with pi)
 *   (d) @earendil-works/* — type-only imports (import type ...)
 */
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const EXTENSION_ROOT = resolve(import.meta.dir, "../pi/extensions/pi-harness");
const IMPORT_PATTERN = /^import\s+(type\s+)?[^"']*["']([^"']+)["'];?\s*$/gm;

const violations: string[] = [];
const glob = new Glob("**/*.ts");

for await (const file of glob.scan(EXTENSION_ROOT)) {
  const filePath = join(EXTENSION_ROOT, file);
  const source = await readFile(filePath, "utf8");
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const isTypeOnly = match[1] !== undefined;
    const specifier = match[2];
    if (specifier === undefined) continue;

    if (specifier.startsWith("node:")) continue;
    if (specifier === "typebox" || specifier.startsWith("typebox/")) continue;
    if (specifier.startsWith("@earendil-works/")) {
      if (!isTypeOnly) {
        violations.push(
          `${file}: runtime import of ${specifier} (type-only imports allowed)`,
        );
      }
      continue;
    }
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(filePath), specifier);
      if (relative(EXTENSION_ROOT, target).startsWith("..")) {
        violations.push(
          `${file}: relative import escapes the extension root (${specifier})`,
        );
      }
      continue;
    }
    violations.push(`${file}: disallowed bare import ${specifier}`);
  }
}

if (violations.length > 0) {
  console.error("check-pi-imports: self-containment violations:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log("check-pi-imports: OK");
