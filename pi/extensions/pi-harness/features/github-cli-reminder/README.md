# GitHub CLI reminder

This feature injects a hidden custom message on the first parent-session
`before_agent_start` event. The persisted message tells the model to inspect
GitHub repositories, issues, and pull requests with `gh repo`, `gh issue`,
`gh pr`, or `gh api`, while leaving `web_fetch` available for non-GitHub public
pages.

Later turns reuse that message from session context instead of persisting a new
copy. The handler checks pi's active branch entries, so resume/reload does not
add a duplicate, while compaction or tree navigation to a branch without the
entry causes the next user-prompt run to refresh it.

The reminder is a soft policy only. It does not block tool calls.

The umbrella extension registers the feature only when `config.isChild` is
false. Child pi processes therefore keep their existing safety hooks without
receiving duplicate parent guidance. Real pi collects custom messages from all
`before_agent_start` handlers, so hook-bridge context and this reminder are both
preserved.
