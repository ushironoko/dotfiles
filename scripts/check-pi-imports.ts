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
import { lstat, readFile, realpath } from "node:fs/promises";
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

// Runtime import escape hatches the Transpiler cannot verify statically:
//  - import()/require()/require.resolve() with a NON-literal argument (the
//    specifier is unknowable → fail closed), and
//  - any use of `createRequire` (it manufactures a require() the Transpiler's
//    import scan never sees, so a repo-external module could be loaded through
//    it — its mere presence is a violation).
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
    const match = /^(import|require|createRequire)/.exec(source.slice(i));
    if (match) {
      const keyword = match[1];
      // `foo.import`/`foo.require` are property accesses, not the keyword — but
      // `Module.createRequire` IS the escape hatch, so it skips the dot guard.
      const dotOk = keyword === "createRequire" || source[i - 1] !== ".";
      if (
        !isIdentChar(source[i - 1]) &&
        dotOk &&
        !isIdentChar(source[i + keyword.length])
      ) {
        if (keyword === "createRequire") {
          found.push("createRequire()");
          i += keyword.length;
          continue;
        }
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
    }
    i += 1;
  }
  return found;
};

export const collectViolations = (
  relFile: string,
  absFile: string,
  source: string,
  root: string = EXTENSION_ROOT,
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
      if (relative(root, target).startsWith("..")) {
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
      kind === "createRequire()"
        ? `${relFile}: createRequire() bypasses the static import gate (self-containment)`
        : `${relFile}: non-literal ${kind} cannot be verified for self-containment`,
    );
  }

  return violations;
};

/**
 * Enumerate every leaf under `root` — including dotfiles, symlinks, and broken
 * symlinks, which the default glob silently skips — and collect violations:
 *  - a symlink whose target escapes the root pulls in external code (violation);
 *    a broken symlink cannot be verified (fail closed);
 *  - every regular `.ts` file is analyzed for disallowed imports.
 */
export const scanExtension = async (root: string): Promise<string[]> => {
  const violations: string[] = [];
  const glob = new Glob("**/*");
  for await (const entry of glob.scan({
    cwd: root,
    dot: true,
    onlyFiles: false,
    followSymlinks: false,
  })) {
    const absEntry = join(root, entry);
    let info;
    try {
      info = await lstat(absEntry);
    } catch (error) {
      violations.push(`${entry}: could not lstat (${String(error)})`);
      continue;
    }
    if (info.isSymbolicLink()) {
      let target: string;
      try {
        target = await realpath(absEntry);
      } catch {
        violations.push(
          `${entry}: broken symlink (self-containment cannot be verified)`,
        );
        continue;
      }
      if (relative(root, target).startsWith("..")) {
        violations.push(
          `${entry}: symlink escapes the extension root (${target})`,
        );
      }
      // Do not fall through to analyze the target as a normal file.
      continue;
    }
    if (!info.isFile() || !entry.endsWith(".ts")) continue;
    const source = await readFile(absEntry, "utf8");
    violations.push(...collectViolations(entry, absEntry, source, root));
  }
  return violations;
};

if (import.meta.main) {
  const violations = await scanExtension(EXTENSION_ROOT);

  if (violations.length > 0) {
    console.error("check-pi-imports: self-containment violations:");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }

  console.log("check-pi-imports: OK");
}
