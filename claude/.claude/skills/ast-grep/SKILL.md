---
name: ast-grep
description: "Primary tool for all code exploration and search tasks. Use this skill FIRST whenever searching for function definitions, API call sites, import/export statements, type definitions, or any structural code pattern. Fall back to Grep/ripgrep only when ast-grep yields no results or when searching non-code text (logs, comments, config files, markdown). Also use for structural refactoring via pattern replacement."
allowed-tools: Bash, Read, Grep, Glob
---

# ast-grep — AST-based Code Search & Refactoring

ast-grep is a tree-sitter-based structural code search and rewrite tool. It parses code into an AST before matching, enabling accurate structural searches that regex cannot achieve.

## Command

Binary name: `ast-grep` (installed via mise)

```bash
# If PATH is not set in the shell environment, use the direct path
/Users/ushironoko/.local/share/mise/installs/ubi-ast-grep-ast-grep/0.42.0/ast-grep
```

## When to Use

### ast-grep (default for code exploration)

- Function/method definition search
- Call site detection for specific functions/APIs
- import/export statement search
- Type definition and interface search
- Code smell detection via structural patterns
- Structural refactoring (pattern replacement)

### Fall back to Grep when

- ast-grep returned no results
- Searching non-code text: log messages, comments, config files, markdown

## Workflow

Follow this process for effective ast-grep usage:

### Step 1: Simple Pattern Search (`run -p`)

Start with `run -p` for simple, single-node matches:

```bash
ast-grep run -p 'console.log($$$)' -l ts .
ast-grep run -p 'export const $NAME = ($$$) => $$$' -l ts src/
```

### Step 2: YAML Rules for Complex Searches (`scan --inline-rules`)

When simple patterns are insufficient (relational/composite logic needed), use YAML rules:

```bash
ast-grep scan --inline-rules "id: find-pattern
language: typescript
rule:
  kind: function_declaration
  has:
    pattern: await \$EXPR
    stopBy: end" /path/to/project
```

**Always use `stopBy: end`** for relational rules (`inside`, `has`) to ensure full traversal.

### Step 3: Debug with `--debug-query`

When patterns don't match, inspect the AST structure:

```bash
# See the concrete syntax tree
ast-grep run -p 'your code here' -l ts --debug-query=cst

# See how ast-grep interprets your pattern
ast-grep run -p 'your pattern here' -l ts --debug-query=pattern
```

### Step 4: Rewrite

For refactoring, use `-r` with `run` or `fix` in YAML rules:

```bash
# Preview rewrite
ast-grep run -p 'var $NAME = $VAL' -r 'const $NAME = $VAL' -l js --json .

# Apply interactively
ast-grep run -p 'var $NAME = $VAL' -r 'const $NAME = $VAL' -l js -i .

# Apply all
ast-grep run -p 'var $NAME = $VAL' -r 'const $NAME = $VAL' -l js -U .
```

## CLI Quick Reference

| Command                                                   | Purpose                   |
| --------------------------------------------------------- | ------------------------- |
| `ast-grep run -p '<pattern>' -l <lang> .`                 | Simple pattern search     |
| `ast-grep run -p '<pattern>' -r '<rewrite>' -l <lang> .`  | Pattern search + rewrite  |
| `ast-grep scan --rule rule.yml .`                         | YAML rule-based search    |
| `ast-grep scan --inline-rules "<yaml>" .`                 | Inline YAML rule search   |
| `ast-grep run -p '<pattern>' -l <lang> --debug-query=cst` | Inspect AST structure     |
| `ast-grep run -p '<pattern>' -l <lang> --json .`          | JSON output for pipelines |

## Meta-variables

| Syntax            | Meaning                                      | Example                         |
| ----------------- | -------------------------------------------- | ------------------------------- |
| `$VAR`            | Single named AST node (captured)             | `$NAME`, `$FUNC`                |
| `$$VAR`           | Single unnamed node (operators, punctuation) | `$$OP`                          |
| `$_` / `$_VAR`    | Single node (not captured, matches anything) | Wildcard                        |
| `$$$` / `$$$ARGS` | Zero or more nodes (non-greedy)              | Variadic args, statement blocks |

- Naming: `$` + uppercase letters, underscores, or digits
- Reuse: `$A == $A` matches `x == x` but not `x == y`
- Non-capturing `_` prefix: `$_FUNC($_ARG)` matches any call regardless of name consistency

## Key Principles

- **Start simple**: Try `run -p` first, escalate to YAML rules only when needed
- **Always `stopBy: end`**: Required for `has`/`inside` to search the full subtree
- **Escape `$` in inline-rules**: Use `\$VAR` in double-quoted shell strings
- **Use `--debug-query`**: When patterns don't match, inspect CST to find correct `kind` values
- **Pattern = target language syntax**: Not regex. Write code as it appears in the source.

## Supported Languages

`ts`, `tsx`, `js`, `jsx`, `py`, `rust`, `go`, `java`, `kotlin`, `swift`, `ruby`, `php`, `c`, `cpp`, `css`, `html`, `json`, `yaml`, `bash`, `lua`

## Reference

- `references/rule_reference.md` — YAML rule syntax: atomic, relational, composite rules, metavariables
- `references/patterns.md` — Verified practical patterns for common search tasks
