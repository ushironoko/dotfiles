#!/usr/bin/env bash

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

# パスが取得できない場合は通過
if [[ -z "$file_path" ]]; then
  exit 0
fi

if [[ "$file_path" == /* ]] || \
   [[ "$file_path" == ~/* ]]; then

  cat >&2 <<EOF
ERROR: Cannot modify files using absolute paths.
Blocked path: $file_path
Please use project-relative paths instead.
Example:
  - Instead of: /home/user/project/config.json or ~/config.json
  - Use: ./config.json or config/settings.json
EOF
  exit 2
fi

exit 0