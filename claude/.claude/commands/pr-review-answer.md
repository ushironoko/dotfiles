---
name: pr-review-answer
description: Address PR review comments
match:
  - regex: "^/pr-review-answer"
---

Launch the pr-review-answer subagent to fetch and address review comments on the current branch's PR.

The subagent will:

1. Check the PR associated with the current branch
2. Fetch all review comments on the PR
3. Analyze each comment and implement necessary changes
4. Commit and push changes appropriately
5. Provide a completion report
