/**
 * Enforces the pi-harness self-containment rule: the extension is loaded via
 * a symlink under ~/.pi/agent/extensions, so it must not import repo code
 * outside its own directory. Allowed runtime imports:
 *   (a) relative paths that stay inside pi/extensions/pi-harness
 *   (b) node: builtins
 *   (c) @earendil-works/* — type-only imports only (erased at runtime)
 *
 * Detection is syntax-aware via Bun.Transpiler (static + dynamic import,
 * require, require.resolve — literal specifiers), so strings/comments never
 * false-positive and multi-line imports are handled. A parse failure fails
 * CLOSED. Non-literal `import()` / `require()` calls cannot be statically
 * verified, so they are reported too. (Type-only imports are erased by the
 * transpiler and never reach the checks.)
 */
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

export const EXTENSION_ROOT = resolve(
  import.meta.dir,
  "../pi/extensions/pi-harness",
);

const transpiler = new Bun.Transpiler({ loader: "ts" });

const skipString = (source: string, start: number, quote: string): number => {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === quote) return i + 1;
    i += 1;
  }
  return i;
};

const skipTemplate = (source: string, start: number): number => {
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i + 1;
    if (c === "$" && source[i + 1] === "{") {
      i = skipBraces(source, i + 2);
      continue;
    }
    i += 1;
  }
  return i;
};

const skipBraces = (source: string, start: number): number => {
  let depth = 1;
  let i = start;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(source, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
};

const isIdentChar = (c: string | undefined): boolean =>
  c !== undefined && /[A-Za-z0-9_$]/.test(c);

// import()/require()/require.resolve() whose argument is NOT a string literal.
// Bun.Transpiler omits these (it only reports literal specifiers), and a
// non-literal specifier cannot be verified, so it fails closed.
const findNonLiteralDynamicCalls = (source: string): string[] => {
  const found: string[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i];
    if (c === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i = skipString(source, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    const match = /^(import|require)/.exec(source.slice(i));
    if (
      match &&
      !isIdentChar(source[i - 1]) &&
      source[i - 1] !== "." &&
      !isIdentChar(source[i + match[0].length])
    ) {
      const keyword = match[1];
      let j = i + keyword.length;
      let kind = keyword === "import" ? "dynamic import()" : "require()";
      if (keyword === "require") {
        const resolveMatch = /^\s*\.\s*resolve\b/.exec(source.slice(j));
        if (resolveMatch) {
          j += resolveMatch[0].length;
          kind = "require.resolve()";
        }
      }
      while (j < n && /\s/.test(source[j])) j += 1;
      if (source[j] === "(") {
        let k = j + 1;
        while (k < n && /\s/.test(source[k])) k += 1;
        const argChar = source[k];
        if (argChar !== '"' && argChar !== "'" && argChar !== "`") {
          found.push(kind);
        }
      }
      i += keyword.length;
      continue;
    }
    i += 1;
  }
  return found;
};

export const collectViolations = (
  relFile: string,
  absFile: string,
  source: string,
): string[] => {
  const violations: string[] = [];

  let specifiers: string[];
  try {
    // scanImports covers static/dynamic import + require; scan adds
    // require.resolve. Merge and dedupe.
    const merged = [
      ...transpiler.scanImports(source),
      ...transpiler.scan(source).imports,
    ];
    const seen = new Set<string>();
    specifiers = [];
    for (const entry of merged) {
      const key = `${entry.kind}\0${entry.path}`;
      if (seen.has(key) || entry.path === "") continue;
      seen.add(key);
      specifiers.push(entry.path);
    }
  } catch (error) {
    // Fail closed: an unparseable file is a violation, not a skip.
    return [
      `${relFile}: could not parse for import analysis (${String(error)})`,
    ];
  }

  for (const specifier of specifiers) {
    if (specifier.startsWith("node:")) continue;
    if (specifier.startsWith("@earendil-works/")) {
      // Only type-only @earendil-works imports are allowed; the transpiler
      // erases those, so anything reaching here is a runtime import.
      violations.push(
        `${relFile}: runtime import of ${specifier} (type-only imports allowed)`,
      );
      continue;
    }
    if (specifier.startsWith(".")) {
      const target = resolve(dirname(absFile), specifier);
      if (relative(EXTENSION_ROOT, target).startsWith("..")) {
        violations.push(
          `${relFile}: relative import escapes the extension root (${specifier})`,
        );
      }
      continue;
    }
    violations.push(`${relFile}: disallowed bare import ${specifier}`);
  }

  for (const kind of findNonLiteralDynamicCalls(source)) {
    violations.push(
      `${relFile}: non-literal ${kind} cannot be verified for self-containment`,
    );
  }

  return violations;
};

if (import.meta.main) {
  const violations: string[] = [];
  const glob = new Glob("**/*.ts");
  for await (const file of glob.scan(EXTENSION_ROOT)) {
    const absFile = join(EXTENSION_ROOT, file);
    const source = await readFile(absFile, "utf8");
    violations.push(...collectViolations(file, absFile, source));
  }

  if (violations.length > 0) {
    console.error("check-pi-imports: self-containment violations:");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }

  console.log("check-pi-imports: OK");
}
