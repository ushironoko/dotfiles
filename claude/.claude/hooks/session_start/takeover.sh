#!/usr/bin/env bash

# Post-compact hook: Read HANDOVER.md if it exists and prompt AI to review it

if [ ! -f ./HANDOVER.md ]; then
  # No handover file, nothing to do
  exit 0
fi

# Use user-prompt-submit-hook to ensure the AI reads and acknowledges the handover
cat << 'EOF' >&2
<user-prompt-submit-hook>
A HANDOVER.md file was found from the previous conversation. Please:

1. Read the ./HANDOVER.md file using the Read tool
2. Acknowledge the project status and pending tasks
3. Continue working based on the handover information
4. Consider removing or updating HANDOVER.md once you've processed it

This ensures continuity after the conversation was compacted.
</user-prompt-submit-hook>
EOF

exit 0