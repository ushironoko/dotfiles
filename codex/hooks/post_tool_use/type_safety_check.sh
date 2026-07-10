#!/usr/bin/env bash
# Inspect only newly added apply_patch lines for type-unsafe TypeScript syntax.
set -euo pipefail

command -v jq >/dev/null 2>&1 || exit 0

jq -c '
def patterns: [
  {re: "\\bas\\s+any\\b",           label: "as any"},
  {re: "\\bas\\s+unknown\\s+as\\b", label: "as unknown as (double assertion)"},
  {re: "<\\s*any\\s*>",             label: "<any> cast"},
  {re: ":\\s*any\\b",               label: ": any annotation"},
  {re: "@ts-(ignore|nocheck)",        label: "@ts-ignore / @ts-nocheck"},
  {re: "\\bas\\s+never\\b",         label: "as never"}
];

def eligible_file:
  test("\\.(ts|tsx|mts|cts|vue)$") and (test("\\.d\\.ts$") | not);

def header_file:
  if test("^\\*\\*\\* (Add|Update) File: ") then
    sub("^\\*\\*\\* (Add|Update) File: "; "")
  elif startswith("*** Move to: ") then
    sub("^\\*\\*\\* Move to: "; "")
  elif startswith("*** Delete File: ") or startswith("*** End Patch") then
    ""
  else
    null
  end;

def line_hits($file; $text):
  [ patterns[] as $p
    | select($text | test($p.re))
    | {
        file: $file,
        label: $p.label,
        text: ($text | sub("^\\s+"; "") | .[0:160])
      }
  ];

(.tool_input.command // "") as $patch
| reduce (($patch | split("\n"))[]) as $line
    ({file: "", hits: []};
      ($line | header_file) as $header
      | if $header != null then
          .file = $header
        elif ((.file | eligible_file) and ($line | startswith("+"))) then
          . as $state
          | .hits += line_hits($state.file; $line[1:])
        elif ($line | startswith("*** ")) then
          .file = ""
        else
          .
        end
    ) as $patch_result
| (.tool_input.file_path // "") as $legacy_file
| ([.tool_input.content, .tool_input.new_string]
    + ((.tool_input.edits // []) | map(.new_string))
    | map(select(. != null))
    | join("\n")) as $legacy_content
| (($patch_result.hits
    + (if ($legacy_file | eligible_file)
       then line_hits($legacy_file; $legacy_content)
       else []
       end))
   | unique_by([.file, .label, .text])) as $hits
| select(($hits | length) > 0)
| {
    decision: "block",
    reason: ("型安全性を損なう構文をapply_patchの追加行から検出しました:\n"
      + ($hits
        | map("  - " + .file + " [" + .label + "] " + .text)
        | join("\n"))
      + "\nas const / satisfies / type guard / generics / discriminated union / exhaustive check などの型安全な代替へ置き換えてください。やむを得ない場合のみ理由をコメントで明記してください。"),
    systemMessage: ("PostToolUse type safety: " + ($hits | length | tostring) + "件検出")
  }
' 2>/dev/null || true
