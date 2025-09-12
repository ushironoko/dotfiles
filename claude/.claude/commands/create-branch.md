---
name: create-branch
description: Create git branches and organize commits
match:
  - regex: "^/create-branch"
---

Launch the git subagent to organize the current changes into appropriate branches and commits.

The git subagent will:

1. Check current uncommitted changes
2. Create appropriate branches based on the changes
3. Split changes into logical commits with descriptive messages
4. Provide a summary upon completion
