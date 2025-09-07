#!/usr/bin/env bash

# Check if HANDOVER.md already exists
if [ -f ./HANDOVER.md ]; then
  exit 0
fi

# Use user-prompt-submit-hook format to ensure the message is treated as user input
cat << 'EOF' >&2
<user-prompt-submit-hook>
The compact operation requires a HANDOVER.md file. Please create ./HANDOVER.md with the following information:

1. Current project status and context
2. Pending tasks and their priority
3. Important technical details or decisions
4. Any warnings or blockers

This ensures continuity when the conversation is compacted.
</user-prompt-submit-hook>
EOF

exit 2
