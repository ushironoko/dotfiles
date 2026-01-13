#!/bin/bash
# Read JSON input from stdin
input=$(cat)
datetime=$(date '+%Y/%m/%d %H:%M:%S')

# Extract values using jq
CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir')
USED_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
REMAINING_PCT=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')

# Format context usage with color based on usage level
CONTEXT_DISPLAY=""
if [ -n "$USED_PCT" ]; then
    # Round to integer for display
    USED_INT=$(printf "%.0f" "$USED_PCT")
    REMAINING_INT=$(printf "%.0f" "$REMAINING_PCT")

    # Color coding based on remaining context
    if [ "$REMAINING_INT" -le 10 ]; then
        # Critical: red
        CONTEXT_DISPLAY="\033[31m${USED_INT}%\033[0m"
    elif [ "$REMAINING_INT" -le 30 ]; then
        # Warning: yellow
        CONTEXT_DISPLAY="\033[33m${USED_INT}%\033[0m"
    else
        # Normal: green
        CONTEXT_DISPLAY="\033[32m${USED_INT}%\033[0m"
    fi
fi

# Show git branch if in a git repo
GIT_BRANCH=""
if git rev-parse --git-dir > /dev/null 2>&1; then
    BRANCH=$(git branch --show-current 2>/dev/null)
    if [ -n "$BRANCH" ]; then
        GIT_BRANCH=" | $BRANCH"
    fi
fi

# Build output
OUTPUT="${CURRENT_DIR##*/}$GIT_BRANCH"
if [ -n "$CONTEXT_DISPLAY" ]; then
    OUTPUT="$OUTPUT | CTX: $CONTEXT_DISPLAY"
fi
OUTPUT="$OUTPUT | $datetime"

echo -e "$OUTPUT"
