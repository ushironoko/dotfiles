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
    # Add auto-compact buffer (22.5%) to show effective usage
    ADJUSTED_PCT=$(echo "$USED_PCT + 22.5" | bc)
    USED_INT=$(printf "%.0f" "$ADJUSTED_PCT")

    # Cap at 100%
    if [ "$USED_INT" -gt 100 ]; then
        USED_INT=100
    fi

    # Build progress bar (10 chars width)
    FILLED=$((USED_INT / 10))
    EMPTY=$((10 - FILLED))
    BAR=""
    for ((i=0; i<FILLED; i++)); do BAR+="█"; done
    for ((i=0; i<EMPTY; i++)); do BAR+="░"; done

    # Color coding based on adjusted percentage
    if [ "$USED_INT" -le 70 ]; then
        # Normal: green
        CONTEXT_DISPLAY="\033[32m[${BAR}] ${USED_INT}%\033[0m"
    elif [ "$USED_INT" -le 90 ]; then
        # Warning: yellow
        CONTEXT_DISPLAY="\033[33m[${BAR}] ${USED_INT}%\033[0m"
    else
        # Critical: red
        CONTEXT_DISPLAY="\033[31m[${BAR}] ${USED_INT}%\033[0m"
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
    OUTPUT="$OUTPUT | $CONTEXT_DISPLAY"
fi
OUTPUT="$OUTPUT | $datetime"

echo -e "$OUTPUT"
