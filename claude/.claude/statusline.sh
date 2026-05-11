#!/bin/bash
input=$(cat)
datetime=$(date '+%Y/%m/%d %H:%M:%S')

CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
USED_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // empty')

CONTEXT_DISPLAY=""
if [ -n "$USED_PCT" ]; then
    # Add auto-compact buffer (16.5%) to show effective usage
    ADJUSTED_PCT=$(echo "$USED_PCT + 16.5" | bc)
    USED_INT=$(printf "%.0f" "$ADJUSTED_PCT")

    if [ "$USED_INT" -gt 100 ]; then
        USED_INT=100
    fi

    REMAINING_INT=$((100 - USED_INT))

    FILLED=$((REMAINING_INT / 10))
    EMPTY=$((10 - FILLED))
    BAR=""
    for ((i=0; i<FILLED; i++)); do BAR+="█"; done
    for ((i=0; i<EMPTY; i++)); do BAR+="░"; done

    if [ "$REMAINING_INT" -ge 30 ]; then
        CONTEXT_DISPLAY="\033[32m${BAR} ${REMAINING_INT}%\033[0m"
    elif [ "$REMAINING_INT" -ge 10 ]; then
        CONTEXT_DISPLAY="\033[33m${BAR} ${REMAINING_INT}%\033[0m"
    else
        CONTEXT_DISPLAY="\033[31m${BAR} ${REMAINING_INT}%\033[0m"
    fi
fi

GIT_BRANCH=""
if git rev-parse --git-dir > /dev/null 2>&1; then
    BRANCH=$(git branch --show-current 2>/dev/null)
    if [ -n "$BRANCH" ]; then
        GIT_BRANCH=" | $BRANCH"
    fi
fi

# Checks section: render lint/typecheck/test from cache if available.
# Quietly omitted when the lib or jq is missing so the rest of the statusline
# keeps working on minimal systems.
CHECKS_DISPLAY=""
LIB_PATH="${STATUSLINE_LIB:-$HOME/.claude/hooks/lib/statusline_checks_lib.sh}"
if [ -n "$CURRENT_DIR" ] && [ -f "$LIB_PATH" ] && command -v jq > /dev/null 2>&1; then
    # shellcheck disable=SC1090
    source "$LIB_PATH"
    PROJECT_ROOT=$(find_project_root "$CURRENT_DIR")
    if [ -n "$PROJECT_ROOT" ]; then
        CACHE_FILE=$(cache_file_path "$PROJECT_ROOT")
        if [ -f "$CACHE_FILE" ]; then
            CACHE_CONTENT=$(cat "$CACHE_FILE" 2>/dev/null)
            if printf '%s' "$CACHE_CONTENT" | jq -e . > /dev/null 2>&1; then
                LABEL=$(printf '%s' "$CACHE_CONTENT" | jq -r '.label // empty')
                LINT_ST=$(printf '%s' "$CACHE_CONTENT" | jq -r '.checks.lint.status // "skipped"')
                TC_ST=$(printf '%s' "$CACHE_CONTENT" | jq -r '.checks.typecheck.status // "skipped"')
                TEST_ST=$(printf '%s' "$CACHE_CONTENT" | jq -r '.checks.test.status // "skipped"')
                if [ "$LINT_ST" != "skipped" ] || [ "$TC_ST" != "skipped" ] || [ "$TEST_ST" != "skipped" ]; then
                    LINT_G=$(status_to_glyph "$LINT_ST")
                    TC_G=$(status_to_glyph "$TC_ST")
                    TEST_G=$(status_to_glyph "$TEST_ST")
                    CHECKS_DISPLAY=" | ${LABEL} L${LINT_G} T${TC_G} X${TEST_G}"
                fi
            fi
        fi
    fi
fi

OUTPUT="${CURRENT_DIR##*/}${GIT_BRANCH}${CHECKS_DISPLAY}"
if [ -n "$CONTEXT_DISPLAY" ]; then
    OUTPUT="$OUTPUT | $CONTEXT_DISPLAY"
fi
OUTPUT="$OUTPUT | $datetime"

echo -e "$OUTPUT"
