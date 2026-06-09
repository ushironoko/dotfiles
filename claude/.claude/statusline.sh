#!/bin/bash
input=$(cat)

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

# Git context. Run via `git -C "$CURRENT_DIR"` so worktrees resolve their own
# HEAD/remote even if the shell CWD differs from the workspace path.
GIT_BRANCH=""
GIT_DIFF=""
ORG_REPO=""
GIT_DIR_ARG="${CURRENT_DIR:-.}"
if git -C "$GIT_DIR_ARG" rev-parse --git-dir > /dev/null 2>&1; then
    BRANCH=$(git -C "$GIT_DIR_ARG" branch --show-current 2>/dev/null)
    if [ -n "$BRANCH" ]; then
        GIT_BRANCH=" | $BRANCH"
    fi
    # Extract org/repo from origin URL. Handles SSH (git@host:org/repo.git)
    # and HTTPS (https://host/org/repo.git). Strips trailing .git, then takes
    # the last "<seg>/<seg>" pair using the final ':' or '/' as separator.
    ORIGIN_URL=$(git -C "$GIT_DIR_ARG" remote get-url origin 2>/dev/null)
    if [ -n "$ORIGIN_URL" ]; then
        TRIMMED_URL="${ORIGIN_URL%.git}"
        CANDIDATE=$(printf '%s' "$TRIMMED_URL" | sed -E 's|^.*[/:]([^/:]+/[^/:]+)$|\1|')
        case "$CANDIDATE" in
            */*) ORG_REPO="$CANDIDATE" ;;
        esac
    fi
    # Local diff vs HEAD (staged + unstaged tracked changes; untracked files
    # are not counted). numstat prints "-" for binary files, so guard before
    # summing. Requires at least one commit; on an empty repo HEAD is absent
    # and the diff is silently skipped.
    DIFF_NUMSTAT=$(git -C "$GIT_DIR_ARG" diff --numstat HEAD 2>/dev/null)
    if [ -n "$DIFF_NUMSTAT" ]; then
        read -r ADDED REMOVED <<EOF
$(printf '%s\n' "$DIFF_NUMSTAT" | awk '{ if ($1 != "-") a += $1; if ($2 != "-") d += $2 } END { print a + 0, d + 0 }')
EOF
        if [ "$ADDED" -gt 0 ] || [ "$REMOVED" -gt 0 ]; then
            GIT_DIFF=" | \033[32m+${ADDED}\033[0m \033[31m-${REMOVED}\033[0m"
        fi
    fi
fi

# Checks section: always render lint/typecheck/test glyphs when a project is
# detected. Cache may be absent (hook hasn't completed) or contain "skipped"
# slots — both states must still be visible to the user. Section is only
# omitted when no project type can be identified, or when prerequisites
# (lib, jq) are missing on minimal systems.
CHECKS_DISPLAY=""
LIB_PATH="${STATUSLINE_LIB:-$HOME/.claude/hooks/lib/statusline_checks_lib.sh}"
if [ -n "$CURRENT_DIR" ] && [ -f "$LIB_PATH" ] && command -v jq > /dev/null 2>&1; then
    # shellcheck disable=SC1090
    source "$LIB_PATH"
    PROJECT_ROOT=$(find_project_root "$CURRENT_DIR")
    if [ -n "$PROJECT_ROOT" ]; then
        LANG_TYPE=$(detect_project_type "$PROJECT_ROOT")
        LABEL=$(project_label "$LANG_TYPE")
        if [ -n "$LABEL" ]; then
            LINT_ST="pending"
            TC_ST="pending"
            TEST_ST="pending"
            CACHE_FILE=$(cache_file_path "$PROJECT_ROOT")
            if [ -f "$CACHE_FILE" ]; then
                CACHE_CONTENT=$(cat "$CACHE_FILE" 2>/dev/null)
                if printf '%s' "$CACHE_CONTENT" | jq -e . > /dev/null 2>&1; then
                    CACHED_LABEL=$(printf '%s' "$CACHE_CONTENT" | jq -r '.label // empty')
                    [ -n "$CACHED_LABEL" ] && LABEL="$CACHED_LABEL"
                    LINT_ST=$(printf '%s' "$CACHE_CONTENT" | jq -r '.checks.lint.status // "pending"')
                    TC_ST=$(printf '%s' "$CACHE_CONTENT" | jq -r '.checks.typecheck.status // "pending"')
                    TEST_ST=$(printf '%s' "$CACHE_CONTENT" | jq -r '.checks.test.status // "pending"')
                fi
            fi
            LINT_G=$(status_to_glyph "$LINT_ST")
            TC_G=$(status_to_glyph "$TC_ST")
            TEST_G=$(status_to_glyph "$TEST_ST")
            CHECKS_DISPLAY=" | ${LABEL} L${LINT_G} T${TC_G} X${TEST_G}"
        fi
    fi
fi

DIR_NAME="${CURRENT_DIR##*/}"
if [ -n "$ORG_REPO" ]; then
    OUTPUT="${ORG_REPO} | ${DIR_NAME}${GIT_BRANCH}${GIT_DIFF}${CHECKS_DISPLAY}"
else
    OUTPUT="${DIR_NAME}${GIT_BRANCH}${GIT_DIFF}${CHECKS_DISPLAY}"
fi
if [ -n "$CONTEXT_DISPLAY" ]; then
    OUTPUT="$OUTPUT | $CONTEXT_DISPLAY"
fi

echo -e "$OUTPUT"
