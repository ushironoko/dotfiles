---
name: takeover
description: Load handover memory.
color: blue
---

# Read Session Handover

Read the previously saved session handover from Serena memory and mark it as read.

## Instructions

1. Use `mcp__serena__read_memory` with memory_file_name "handover"
2. Display the handover content with proper formatting
3. After successfully reading:
   - Update the handover memory to add a "READ" marker at the top
   - Include read timestamp: `📖 READ: YYYY-MM-DD HH:MM:SS`
   - Preserve all original content below the marker
4. If no handover exists, inform the user to run /handover first
5. If handover is already marked as read, show when it was last read

## Usage

Simply run `/takeover` to read the most recent session handover.

## Read Status Indicators

- 🆕 Fresh handover (not yet read)
- 📖 Read handover (shows read timestamp)
- ⚠️ Multiple reads (shows all read timestamps)

## Example Output

```
📖 READ: 2025-01-08 16:00:00
---
[Original handover content follows...]
```

## Notes

- Reads from memories/handover.md
- Automatically marks as read after displaying
- Read status persists across sessions
- Use /handover command to save/update the handover (will reset read status)
