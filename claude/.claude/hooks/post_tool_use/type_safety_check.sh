#!/bin/bash
# PostToolUse hook (Write|Edit): detect type-unsafe TypeScript constructs
# in newly written content and feed safer alternatives back to Claude.
# Only inspects the content written by this tool call (not the whole file),
# so pre-existing violations in legacy files are not re-flagged.
set -euo pipefail

jq -c '
def patterns: [
  {re: "\\bas\\s+any\\b",           label: "as any"},
  {re: "\\bas\\s+unknown\\s+as\\b", label: "as unknown as (double assertion)"},
  {re: "<\\s*any\\s*>",             label: "<any> cast"},
  {re: ":\\s*any\\b",               label: ": any annotation"},
  {re: "@ts-(ignore|nocheck)",      label: "@ts-ignore / @ts-nocheck"},
  {re: "\\bas\\s+never\\b",         label: "as never"}
];

(.tool_input.file_path // "") as $file
| select($file | test("\\.(ts|tsx|mts|cts|vue)$"))
| select($file | test("\\.d\\.ts$") | not)
| ( [.tool_input.content, .tool_input.new_string]
    + ((.tool_input.edits // []) | map(.new_string))
    | map(select(. != null))
    | join("\n")
  ) as $content
| ( [ ($content | split("\n"))[] as $line
      | patterns[] as $p
      | select($line | test($p.re))
      | {label: $p.label, text: ($line | sub("^\\s+"; "") | .[0:160])}
    ] | unique
  ) as $hits
| select(($hits | length) > 0)
| {
    decision: "block",
    reason: ("型安全性を損なう構文を検出しました: " + $file + "\n"
      + ($hits | map("  - [" + .label + "] " + .text) | join("\n"))
      + "\nこれらの構文は型チェックを無効化し、型安全性を損ないます。as const / satisfies / type guard function / generics / discriminated union / exhaustive check (never) などの型安全な代替手段で置き換えてください。外部ライブラリの型定義の不備などでやむを得ない場合のみ、理由をコメントで明記した上で使用してください。"),
    systemMessage: ("⚠ 型安全性チェック: 危険な型構文を" + ($hits | length | tostring) + "件検出 (" + ($file | split("/") | last) + ")")
  }
' 2>/dev/null || true
