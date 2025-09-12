---
name: handover
description: Save current tasks memories.
color: blue
---

# Save Session Handover

Save comprehensive session context to Serena memory for seamless continuation.

## Instructions

1. **Thoroughly collect all session information:**
   - Session metadata (timestamp, duration, working directory, git branch)
   - Main objectives, accomplishments, and progress percentage
   - Complete TodoWrite task list with exact statuses
   - All files touched (created/modified/deleted/reviewed) with line counts
   - Technical decisions with rationale
   - Full command history with outputs/results
   - User preferences, instructions, and communication patterns
   - All errors, warnings, and edge cases encountered
   - Detailed next steps with time estimates

2. **Format with clear hierarchy and visual indicators:**
   - 🔴 Critical/Blocking issues requiring immediate attention
   - 🟡 Important/Warning items that need consideration
   - 🟢 Info/Success completed items and achievements
   - 🔵 Note/Reference for context and documentation
   - 🟣 Discovery/Learning for new insights
   - ⚡ Performance/Optimization notes
   - 🔒 Security considerations

3. **Save to Serena memory:**
   - Use `mcp__serena__write_memory` with memory name "handover"
   - Include session ID for tracking: `session_YYYYMMDD_HHMMSS`

## Required Sections (ALL must be included)

### 1. Session Metadata

- **Session ID**: Unique identifier
- **Started**: ISO 8601 timestamp
- **Duration**: Time spent
- **Working Directory**: Full path
- **Git Status**: Branch, uncommitted changes, remote status
- **Environment**: OS, runtime versions, tool versions

### 2. Session Summary

- **Primary Goal**: What user wanted to achieve
- **Achievement Level**: Percentage complete with breakdown
- **Key Accomplishments**: Bullet list with impact
- **Session Type**: Feature/Bug/Refactor/Research/Documentation

### 3. Task Management (TodoWrite Export)

- **Completed Tasks**: Full list with completion times
- **In Progress**: Current task with percentage complete
- **Pending**: Queued tasks with priority levels
- **Blocked**: Tasks with blocking reasons
- **Deferred**: Tasks postponed with reasons

### 4. File Operations

#### Created Files

- Path, purpose, line count, key content

#### Modified Files

- Path, changes summary, diff stats (+/- lines)
- Before/after key sections for context

#### Deleted Files

- Path, reason for deletion, content summary if relevant

#### Reviewed Files

- Path, purpose of review, key findings

### 5. Technical Context

#### Architecture Decisions

- Decision, rationale, alternatives considered, impact

#### Dependencies

- Added: package@version, purpose, size impact
- Updated: from→to version, breaking changes
- Removed: package, replacement strategy

#### Configuration Changes

- File, setting, old→new value, reason

#### Code Patterns

- Patterns discovered/implemented
- Conventions followed/established
- Anti-patterns avoided

### 6. Command History

#### Git Operations

```bash
# Include full commands with outputs
git status
git diff
git log --oneline -5
```

#### Build/Test/Lint

```bash
# Include results and any failures
bun test
bun run lint
bun run tsc
```

#### System Commands

```bash
# File operations, searches, etc.
```

### 7. User Context

#### Communication Preferences

- Language, tone, detail level
- Response format preferences

#### Project-Specific Instructions

- Special requirements
- Conventions to follow
- Tools to use/avoid

#### Discovered Preferences

- Workflow patterns
- Decision criteria
- Quality standards

### 8. Issues & Resolutions

#### Resolved Issues

- Issue, root cause, solution, prevention

#### Unresolved Issues

- 🔴 Blocking issues with error details
- 🟡 Warnings with context
- 🔵 Questions for clarification

#### Edge Cases

- Scenario, handling, future considerations

### 9. Performance & Optimization

- Bottlenecks identified
- Optimizations applied
- Metrics (before/after)
- Further optimization opportunities

### 10. Security Considerations

- Vulnerabilities addressed
- Secrets handling
- Permission changes
- Security best practices applied

### 11. Learning & Discoveries

- New tools/techniques learned
- Codebase insights
- Documentation gaps found
- Improvement suggestions

### 12. Next Session Roadmap

#### Immediate Priorities (Next 30 min)

1. Task, estimated time, prerequisites

#### Short-term Goals (Next session)

- Goals with success criteria

#### Long-term Considerations

- Technical debt items
- Refactoring opportunities
- Feature enhancements

#### Prerequisites & Blockers

- External dependencies
- User decisions needed
- Technical limitations

### 13. Session Artifacts

- Test results location
- Log files generated
- Documentation created
- Screenshots/diagrams paths

### 14. Rollback Information

- How to undo changes if needed
- Backup locations
- Recovery procedures

## Output Format Example

```markdown
# Session Handover - session_20250108_143000

## 1. Session Metadata

- **Session ID**: session_20250108_143000
- **Started**: 2025-01-08T14:30:00Z
- **Duration**: 2h 15m
- **Working Directory**: /home/user/dev/project
- **Git Status**: main branch, 3 files modified, ahead by 2 commits
- **Environment**: Ubuntu 22.04, Bun 1.1.42, Node 20.x

## 2. Session Summary

- **Primary Goal**: Migrate handover system to Serena memory
- **Achievement Level**: 85% complete
  - ✅ File migration (100%)
  - ✅ Command updates (100%)
  - 🟡 Testing (50%)
  - ⏳ Documentation (70%)
    ...
```

## Notes

- Be exhaustive - better to have too much information than too little
- Include actual command outputs, not just commands
- Preserve exact error messages and stack traces
- Note any assumptions made during the session
- This will overwrite existing handover.md in memories (and reset read status)
- Use /takeover command to read the saved handover (automatically marks as read)
- New handover creation resets any previous read markers
