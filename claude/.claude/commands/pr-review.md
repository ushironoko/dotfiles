---
name: pr-review
description: Review GitHub PR with context
match:
  - regex: "^/pr-review"
---

Launch the pr-review subagent to gather comprehensive information about a PR.

The subagent will:

1. Check PR basic information (title, description, author)
2. Fetch related issue context
3. Check GitHub Actions status
4. Retrieve review comments and discussions
5. Show commit history
6. Preview changes and diff
7. Check merge status
8. Provide a structured summary
