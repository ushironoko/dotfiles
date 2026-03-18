# ast-grep Verified Pattern Reference

All patterns below have been tested and confirmed working with ast-grep 0.42.0.

## Simple Pattern Search (`run -p`)

### Function & Method Search

```bash
# Exported arrow functions
ast-grep run -p 'export const $NAME = ($$$) => $$$' -l ts .

# Exported function declarations
ast-grep run -p 'export function $NAME($$$) { $$$ }' -l ts .

# Async functions
ast-grep run -p 'async function $NAME($$$) { $$$ }' -l ts .
```

### Import / Export

```bash
# Named imports
ast-grep run -p 'import { $$$NAMES } from "$MODULE"' -l ts .

# Dynamic imports
ast-grep run -p 'await import($PATH)' -l ts .
```

Note: `import $NAME from "$MODULE"` matches BOTH default and named imports. Use `kind: import_statement` with relational rules if you need to distinguish.

### Call Sites

```bash
# Any console.log
ast-grep run -p 'console.log($$$)' -l ts .

# Single-arg console.log
ast-grep run -p 'console.log($ARG)' -l ts .

# Multi-arg console.log
ast-grep run -p 'console.log($FIRST, $$$REST)' -l ts .
```

### Type Definitions

```bash
# Type aliases
ast-grep run -p 'type $NAME = $$$' -l ts .

# Interfaces
ast-grep run -p 'interface $NAME { $$$ }' -l ts .

# Exported types
ast-grep run -p 'export type $NAME = $$$' -l ts .

# Typed const declarations
ast-grep run -p 'const $NAME: $TYPE = $VAL' -l ts .
```

Note: Generic type patterns like `Promise<$T>` do NOT work as simple patterns because ast-grep parses them as `instantiation_expression`, not `generic_type`. Use `kind: generic_type` with YAML rules instead (see below).

### Error Handling

```bash
# Try-catch (full form — "catch" alone is invalid as a pattern)
ast-grep run -p 'try { $$$ } catch($E) { $$$ }' -l ts .
```

### Const with await

```bash
ast-grep run -p 'const $_ = await $EXPR' -l ts .
```

### Self-comparison (bug detection)

```bash
ast-grep run -p '$X === $X' -l ts .
```

### Refactoring

```bash
# var → const (preview with --json, apply with -U)
ast-grep run -p 'var $NAME = $VAL' -r 'const $NAME = $VAL' -l js .

# Optional chaining
ast-grep run -p '$A && $A.$B' -r '$A?.$B' -l ts .

# forEach → for...of
ast-grep run -p '$ARR.forEach(($ITEM) => { $$$ })' -r 'for (const $ITEM of $ARR) { $$$ }' -l ts .

# String concat → template literal
ast-grep run -p '$A + $B' -r '`${$A}${$B}`' -l ts .
```

### Testing (Vitest / Jest)

```bash
ast-grep run -p 'describe($DESC, () => { $$$ })' -l ts .
ast-grep run -p 'it($DESC, () => { $$$ })' -l ts .
ast-grep run -p 'test($DESC, () => { $$$ })' -l ts .
ast-grep run -p 'expect($VAL).toBe($$$)' -l ts .
```

## YAML Rule Search (`scan --inline-rules`)

Use YAML rules when you need relational (`has`/`inside`) or composite (`all`/`any`/`not`) logic.

### Find async functions containing await

```bash
ast-grep scan --inline-rules "id: async-await
language: typescript
rule:
  kind: function_declaration
  has:
    pattern: await \$EXPR
    stopBy: end" .
```

### Find console.log inside functions

```bash
ast-grep scan --inline-rules "id: console-in-fn
language: typescript
rule:
  pattern: console.log(\$\$\$)
  inside:
    kind: function_declaration
    stopBy: end" .
```

### Find async functions WITHOUT try-catch

```bash
ast-grep scan --inline-rules "id: async-no-trycatch
language: typescript
rule:
  all:
    - kind: function_declaration
    - has:
        pattern: await \$EXPR
        stopBy: end
    - not:
        has:
          kind: try_statement
          stopBy: end" .
```

### Find any console method

```bash
ast-grep scan --inline-rules "id: console-any
language: typescript
rule:
  any:
    - pattern: console.log(\$\$\$)
    - pattern: console.warn(\$\$\$)
    - pattern: console.error(\$\$\$)" .
```

### Find generic types by name (e.g., Promise)

```bash
ast-grep scan --inline-rules "id: promise-type
language: typescript
rule:
  kind: generic_type
  has:
    field: name
    regex: ^Promise$" .
```

### Find all generic types

```bash
ast-grep scan --inline-rules "id: generic-types
language: typescript
rule:
  kind: generic_type" .
```

### Find type alias declarations (via kind)

```bash
ast-grep scan --inline-rules "id: type-aliases
language: typescript
rule:
  kind: type_alias_declaration" .
```

## JSON Output + jq

```bash
# Extract meta-variables from matches
ast-grep run -p 'import { $$$NAMES } from "$MODULE"' -l ts --json . | jq '.[0].metaVariables'

# List matched file paths only
ast-grep run -p 'console.log($$$)' -l ts --json . | jq -r '.[].file' | sort -u
```

## Debugging

```bash
# Inspect AST structure (find correct `kind` values)
ast-grep run -p 'your code here' -l ts --debug-query=cst

# See how ast-grep interprets your pattern
ast-grep run -p 'your pattern' -l ts --debug-query=pattern
```
