#!/bin/bash
input=$(cat)

CURRENT_DIR=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')
USED_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
MODEL_NAME=$(echo "$input" | jq -r '.model.display_name // empty')
SESSION_ID=$(echo "$input" | jq -r '.session_id // empty')

MODEL_DISPLAY=""
if [ -n "$MODEL_NAME" ]; then
    # Strip a trailing context-window qualifier like " (1M context)" so the
    # statusline shows just the model name (e.g. "Opus 4.8").
    MODEL_NAME=$(printf '%s' "$MODEL_NAME" | sed -E 's/ *\([^)]*context[^)]*\)$//I')
    MODEL_DISPLAY="\033[36m${MODEL_NAME}\033[0m"
fi

CONTEXT_DISPLAY=""
if [ -n "$USED_PCT" ]; then
    # Remaining context relative to the full window, matching /context's
    # free-space figure (no auto-compact buffer adjustment).
    USED_INT=$(printf "%.0f" "$USED_PCT")

    if [ "$USED_INT" -gt 100 ]; then
        USED_INT=100
    fi

    REMAINING_INT=$((100 - USED_INT))

    if [ "$REMAINING_INT" -ge 30 ]; then
        CONTEXT_DISPLAY="\033[32m${REMAINING_INT}%\033[0m"
    elif [ "$REMAINING_INT" -ge 10 ]; then
        CONTEXT_DISPLAY="\033[33m${REMAINING_INT}%\033[0m"
    else
        CONTEXT_DISPLAY="\033[31m${REMAINING_INT}%\033[0m"
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

# Session ID section: the session UUID from the statusline input, useful for
# --resume and transcript lookup. Omitted when the client doesn't send it.
SESSION_DISPLAY=""
if [ -n "$SESSION_ID" ]; then
    SESSION_DISPLAY=" | \033[90m${SESSION_ID}\033[0m"
fi

DIR_NAME="${CURRENT_DIR##*/}"
if [ -n "$ORG_REPO" ]; then
    OUTPUT="${ORG_REPO} | ${DIR_NAME}${GIT_BRANCH}${GIT_DIFF}${SESSION_DISPLAY}"
else
    OUTPUT="${DIR_NAME}${GIT_BRANCH}${GIT_DIFF}${SESSION_DISPLAY}"
fi
if [ -n "$MODEL_DISPLAY" ]; then
    OUTPUT="$OUTPUT | $MODEL_DISPLAY"
fi
if [ -n "$CONTEXT_DISPLAY" ]; then
    OUTPUT="$OUTPUT | $CONTEXT_DISPLAY"
fi

echo -e "$OUTPUT"
