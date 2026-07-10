#!/usr/bin/env bash
# Prefer project-local package scripts over ad-hoc package runner invocations.
# This is self-contained so Codex does not depend on ~/.claude being installed.
set -euo pipefail

INPUT=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || exit 0
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0
case "$CMD" in *npm-script-skip*) exit 0 ;; esac

printf '%s' "$CMD" | grep -qE '(^|[;&|[:space:](])(npx|pnpx|bunx|bun[[:space:]]+x|(pnpm|yarn)[[:space:]]+(dlx|exec)|npm[[:space:]]+exec)([[:space:]]|$)' || exit 0

TARGETS=$(printf '%s' "$CMD" | awk '
  function stripver(s) {
    if (s ~ /^@/) { if (match(s, /@[^@]*$/) && RSTART > 1) s = substr(s, 1, RSTART - 1) }
    else sub(/@.*$/, "", s)
    return s
  }
  function binname(s) { sub(/^.*\//, "", s); return s }
  {
    gsub(/[;|&()`]/, " ")
    gsub(/["'\'']/, "")
    n = split($0, t, /[[:space:]]+/)
    for (i = 1; i <= n; i++) {
      r = 0
      if (t[i] == "npx" || t[i] == "pnpx" || t[i] == "bunx") r = i
      else if (t[i] == "bun" && t[i+1] == "x") r = i + 1
      else if ((t[i] == "pnpm" || t[i] == "yarn") && (t[i+1] == "dlx" || t[i+1] == "exec")) r = i + 1
      else if (t[i] == "npm" && t[i+1] == "exec") r = i + 1
      if (!r) continue
      for (j = r + 1; j <= n; j++) {
        tok = t[j]
        if (tok == "" || tok == "--") continue
        if (tok ~ /^--package=/) { sub(/^--package=/, "", tok); print binname(stripver(tok)); break }
        if (tok == "-p" || tok == "--package") { print binname(stripver(t[j+1])); break }
        if (tok ~ /^-/) continue
        print binname(stripver(tok)); break
      }
      i = j
    }
  }' | sort -u | grep -v '^$') || exit 0
[ -n "$TARGETS" ] || exit 0

CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null) || exit 0
[ -n "$CWD" ] && [ -d "$CWD" ] || CWD=$PWD
DIR=$CWD
PKG=""
while :; do
  [ -f "$DIR/package.json" ] && { PKG="$DIR/package.json"; break; }
  [ "$DIR" = "/" ] && break
  DIR=$(dirname "$DIR")
done
[ -n "$PKG" ] || exit 0

PKGDIR=$(dirname "$PKG")
PM="npm run"
if [ -f "$PKGDIR/bun.lock" ] || [ -f "$PKGDIR/bun.lockb" ]; then PM="bun run"
elif [ -f "$PKGDIR/pnpm-lock.yaml" ]; then PM="pnpm run"
elif [ -f "$PKGDIR/yarn.lock" ]; then PM="yarn run"
fi

MATCHES=$(jq -r --arg bins "$TARGETS" --arg pm "$PM" '
  ($bins | split("\n") | map(select(length > 0)) | unique) as $targets
  | (.scripts // {}) | to_entries
  | [ .[] as $e
      | ($e.value | [splits("[^[:alnum:]@/_.-]+")] | map(select(length > 0))) as $words
      | $targets[] as $t
      | select(($e.key == $t) or (($words | index($t)) != null))
      | "  " + $pm + " " + $e.key + "  (" + ($e.value | .[0:80]) + ")"
    ] | unique | .[]
' "$PKG" 2>/dev/null) || exit 0
[ -n "$MATCHES" ] || exit 0

BINS=$(printf '%s' "$TARGETS" | tr '\n' ' ')

jq -n --arg matches "$MATCHES" --arg pm "$PM" --arg bins "$BINS" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("パッケージランナー経由の実行 (" + $bins + ") を検出しましたが、このプロジェクトの package.json に同等の npm script が定義されています。バージョンとオプションをプロジェクト設定に揃えるため、npm script を優先してください:\n" + $matches + "\n追加の引数が必要な場合は `" + $pm + " <script> -- <args>` を使用してください。npm script で実現できない場合のみ、コマンド末尾に `# npm-script-skip` を付けて再実行してください。")
  },
  systemMessage: ("⚠ npm script優先: " + $bins + " は package.json の script で実行できます")
}'
