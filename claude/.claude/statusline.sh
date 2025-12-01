#!/bin/bash
# Read JSON input from stdin
input=$(cat)
datetime=`date '+%Y/%m/%d %H:%M:%S'`

# Extract values using jq
MODEL_DISPLAY=$(echo "$input" | jq -r '.model.display_name')
CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir')
CCUSAGE=$(echo "$input" | bunx --bun ccusage@latest statusline)

# Show git branch if in a git repo
GIT_BRANCH=""
if git rev-parse --git-dir > /dev/null 2>&1; then
    BRANCH=$(git branch --show-current 2>/dev/null)
    if [ -n "$BRANCH" ]; then
        GIT_BRANCH=" | 🌿 $BRANCH"
    fi
fi

echo "${CURRENT_DIR##*/}$GIT_BRANCH $CCUSAGE | $datetime"
