# ast-grep Rule Reference

## Rule Categories

- **Atomic Rules**: Match individual nodes by intrinsic properties (`pattern`, `kind`, `regex`)
- **Relational Rules**: Match by position relative to other nodes (`inside`, `has`, `precedes`, `follows`)
- **Composite Rules**: Combine rules with logic (`all`, `any`, `not`, `matches`)

A node matches a rule if it satisfies ALL fields (implicit AND).

## Atomic Rules

### pattern

Match by code pattern. Two forms:

**String form:**

```yaml
pattern: console.log($ARG)
```

**Object form** (for ambiguous patterns):

```yaml
pattern:
  selector: field_definition
  context: "class { $F }"
```

- `selector`: Pinpoints specific part of parsed pattern
- `context`: Provides surrounding code for correct parsing
- `strictness`: `cst` | `smart` | `ast` | `relaxed` | `signature`

### kind

Match by tree-sitter node type name:

```yaml
kind: call_expression
kind: function_declaration
kind: arrow_function
```

Use `--debug-query=cst` to discover correct kind names.

### regex

Match node text with Rust regex:

```yaml
regex: ^use.*
```

Not a "positive" rule — combine with `kind` or `pattern`.

### nthChild

Match by position within parent's children:

```yaml
nthChild: 1          # First child
nthChild: "2n+1"     # Odd children (An+B formula)
nthChild:
  position: 1
  reverse: true      # Count from end
  ofRule:             # Filter siblings before counting
    kind: call_expression
```

## Relational Rules

### has

Target node must have a descendant matching the sub-rule:

```yaml
has:
  pattern: await $EXPR
  stopBy: end
```

### inside

Target node must be inside a node matching the sub-rule:

```yaml
inside:
  kind: method_definition
  stopBy: end
```

### precedes / follows

Target must appear before/after a node matching the sub-rule:

```yaml
precedes:
  pattern: return $VAL
follows:
  pattern: import $M from '$P'
```

### stopBy (CRITICAL)

Controls search termination for relational rules:

| Value                  | Behavior                                    |
| ---------------------- | ------------------------------------------- |
| `"neighbor"` (default) | Stop at first non-matching surrounding node |
| `"end"`                | Search to root (`inside`) or leaf (`has`)   |
| Rule object            | Stop when surrounding node matches the rule |

**Always use `stopBy: end`** unless you have a specific reason not to.

### field

Specifies a sub-node field (only for `inside` and `has`):

```yaml
has:
  field: operator
  pattern: $$OP
```

## Composite Rules

### all (AND)

All sub-rules must match. **Order is guaranteed** — important for metavariable dependencies:

```yaml
all:
  - kind: call_expression
  - pattern: console.log($ARG)
```

### any (OR)

Any sub-rule must match:

```yaml
any:
  - pattern: console.log($$$)
  - pattern: console.warn($$$)
  - pattern: console.error($$$)
```

### not (NOT)

Sub-rule must NOT match:

```yaml
not:
  pattern: console.log($ARG)
```

### matches

Reference a predefined utility rule:

```yaml
matches: my-utility-rule-id
```

## Metavariables

| Syntax           | Captures    | Matches                                      |
| ---------------- | ----------- | -------------------------------------------- |
| `$VAR`           | Yes (named) | Single named AST node                        |
| `$$VAR`          | Yes         | Single unnamed node (operators, punctuation) |
| `$_` / `$_VAR`   | No          | Single node (wildcard)                       |
| `$$$` / `$$$VAR` | Yes         | Zero or more nodes                           |

**Rules:**

- Valid: `$META`, `$META_VAR`, `$_`, `$$$ARGS`
- Invalid: `$invalid`, `$123`, `$KEBAB-CASE`
- Reuse: `$A == $A` matches self-comparison only
- Must be sole content of an AST node: `obj.on$EVENT` does NOT work

## CLI Usage for Rules

### Rule file

```bash
ast-grep scan --rule rule.yml /path/to/project
```

### Inline rules

```bash
ast-grep scan --inline-rules "id: my-rule
language: typescript
rule:
  pattern: console.log(\$$$)" /path/to/project
```

Note: Escape `$` as `\$` in double-quoted shell strings.

### Test with stdin

```bash
echo "const x = await fetch();" | ast-grep scan --inline-rules "id: test
language: typescript
rule:
  pattern: await \$EXPR" --stdin
```

### JSON output

```bash
ast-grep scan --rule rule.yml --json /path/to/project
```

## Troubleshooting

1. **No match**: Use `--debug-query=cst` to see actual AST structure
2. **Relational rule misses**: Add `stopBy: end`
3. **Wrong kind**: Check tree-sitter grammar via `--debug-query=cst`
4. **Metavariable not working**: Ensure it's sole content of its AST node
5. **Complex pattern fails**: Break into sub-rules with `all`
