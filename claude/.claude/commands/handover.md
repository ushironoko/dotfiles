# Save Session Context

Create or update HANDOVER.md for comprehensive session continuity.

## Instructions

1. Check if HANDOVER.md exists in the project root
2. If it exists and has `read: false`, update that entry to `read: true`
3. Create a new handover entry with YAML frontmatter:

```yaml
---
created: [current timestamp in ISO 8601 format]
read: false
session_id: [generate unique session ID like session_YYYYMMDD_HHMMSS]
---
```

## Required Sections (include ALL):

### 1. Environment & Setup

- Working directory path
- Git branch and status
- Runtime versions (Bun/Node.js)
- Recent package installations or updates

### 2. Session Summary

- Main objectives of this session
- Key accomplishments
- Time spent on major tasks

### 3. Current Tasks (from TodoWrite)

- Export complete TodoWrite list with statuses
- Include task descriptions and current state
- Note any blocked or pending tasks

### 4. Files Modified/Reviewed

- List all files that were:
  - Created
  - Modified
  - Deleted
  - Extensively reviewed/analyzed
- Include brief description of changes

### 5. Commands Executed

- Important commands run during session
- Test results (if any)
- Build/lint/typecheck outcomes

### 6. Technical Context

- Architecture decisions made
- Patterns or conventions discovered
- Dependencies added/removed
- Configuration changes

### 7. Unresolved Issues

- Error messages not yet resolved
- Warnings that need attention
- Technical debt identified
- Questions for next session

### 8. Important Discoveries

- Key insights about the codebase
- Useful patterns found
- Performance considerations noted
- Security concerns identified

### 9. Next Session Priorities

- Immediate tasks to continue
- Recommended order of operations
- Prerequisites or blockers to address
- Estimated time for completion

### 10. Additional Notes

- User preferences discovered
- Communication style notes
- Project-specific conventions
- Useful resources or documentation links

## Format Guidelines:

- Use clear hierarchical structure with markdown headers
- Include code blocks for commands/errors
- Use emoji indicators for priority:
  - 🔴 Critical/Blocking
  - 🟡 Important/Warning
  - 🟢 Info/Success
  - 🔵 Note/Reference
- Keep descriptions concise but complete
- Include file paths as `path/to/file.ext`

## Example Entry Structure:

```markdown
---
created: 2025-01-07T15:30:00Z
read: false
session_id: session_20250107_153000
---

# Session Handover - session_20250107_153000

## Environment & Setup

- **Working Directory**: `/home/user/dev/project`
- **Git Branch**: `feature/handover-improvements`
- **Bun Version**: 1.1.42
- **Uncommitted Changes**: 3 files modified, 1 untracked

## Session Summary

**Duration**: ~2 hours
**Main Goal**: Improve handover/takeover workflow
**Result**: Successfully implemented enhanced handover system

## Current Tasks

### In Progress

- 🟡 Implementing structured takeover display (70% complete)
  - Script updated but needs testing

### Completed

- ✅ Updated handover command documentation
- ✅ Added detailed template structure

### Pending

- ⏳ Test the new takeover workflow
- ⏳ Commit changes after testing

[... continue with all sections ...]
```

Save the new entry at the top of HANDOVER.md (prepend, not append).
After creation, display confirmation with entry summary.
