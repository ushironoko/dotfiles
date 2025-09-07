#!/usr/bin/env bash

# Session start hook: Read unread HANDOVER.md entries and mark them as read

if [ ! -f ./HANDOVER.md ]; then
  exit 0
fi

# Check if there are any unread entries
if grep -q "read: false" ./HANDOVER.md 2>/dev/null; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════════"
  echo "                     📋 SESSION HANDOVER DETECTED                    "
  echo "═══════════════════════════════════════════════════════════════════"
  echo ""
  
  # Extract session information from the unread entry
  SESSION_ID=$(grep -A1 "read: false" ./HANDOVER.md | grep "session_id:" | head -1 | sed 's/.*session_id: *//')
  CREATED=$(grep -B1 "read: false" ./HANDOVER.md | grep "created:" | head -1 | sed 's/.*created: *//')
  
  if [ ! -z "$SESSION_ID" ]; then
    echo "📌 Previous Session: $SESSION_ID"
    echo "🕐 Created: $CREATED"
    echo ""
  fi
  
  echo "───────────────────────────────────────────────────────────────────"
  echo ""
  
  # Process the handover content with structured display
  # First, save the content to a temp file for processing
  TEMP_FILE=$(mktemp)
  cat ./HANDOVER.md > "$TEMP_FILE"
  
  # Display sections with appropriate formatting
  while IFS= read -r line; do
    # Highlight critical items
    if echo "$line" | grep -q "🔴"; then
      echo -e "\033[31m$line\033[0m"  # Red for critical
    # Highlight important items
    elif echo "$line" | grep -q "🟡"; then
      echo -e "\033[33m$line\033[0m"  # Yellow for important
    # Highlight success items
    elif echo "$line" | grep -q "🟢"; then
      echo -e "\033[32m$line\033[0m"  # Green for success
    # Highlight section headers
    elif echo "$line" | grep -q "^##"; then
      echo -e "\033[1;36m$line\033[0m"  # Bold cyan for headers
    # Highlight task status
    elif echo "$line" | grep -q "^- \[x\]"; then
      echo -e "\033[32m$line\033[0m"  # Green for completed tasks
    elif echo "$line" | grep -q "^- \[ \]"; then
      echo -e "\033[33m$line\033[0m"  # Yellow for pending tasks
    # Regular output
    else
      echo "$line"
    fi
  done < "$TEMP_FILE"
  
  rm "$TEMP_FILE"
  
  echo ""
  echo "───────────────────────────────────────────────────────────────────"
  echo ""
  
  # Check for critical items
  if grep -q "🔴" ./HANDOVER.md 2>/dev/null; then
    echo "⚠️  ATTENTION: Critical items found in handover!"
    echo ""
  fi
  
  # Check for unresolved issues
  if grep -q "## Unresolved Issues" ./HANDOVER.md 2>/dev/null; then
    if grep -A5 "## Unresolved Issues" ./HANDOVER.md | grep -q "[A-Za-z]"; then
      echo "⚠️  NOTE: There are unresolved issues from the previous session"
      echo ""
    fi
  fi
  
  # Mark all entries as read
  sed -i 's/read: false/read: true/g' ./HANDOVER.md
  
  echo "✅ Handover information processed successfully"
  echo "📝 All entries have been marked as read"
  echo ""
  echo "═══════════════════════════════════════════════════════════════════"
  echo "        🚀 Ready to continue from the previous session state        "
  echo "═══════════════════════════════════════════════════════════════════"
  echo ""
else
  # All entries have been read
  echo ""
  echo "ℹ️  HANDOVER.md exists - all entries previously processed"
  echo ""
fi

exit 0