---
name: pr-review
description: Gather comprehensive GitHub PR information using gh CLI. Use when reviewing PRs, checking CI/GitHub Actions status, analyzing review comments, understanding PR context, checking merge status, or examining related issues.
---

# PR Review

Gather and summarize comprehensive information about a GitHub Pull Request.

## When to Use

- Reviewing a PR (own or others')
- Checking PR status (CI, reviews, merge state)
- Understanding PR context and related issues
- Analyzing review comments

## Prerequisites

- `gh` CLI installed and authenticated
- Inside a git repository

## Quick Start

```bash
# Current branch's PR
gh pr view --json number,title,state,author,url

# Specific PR
gh pr view <NUMBER> --json number,title,state,author,url
```

## Step-by-Step Process

### 1. Identify Target PR

```bash
# Get current branch
git branch --show-current

# Check if PR exists for current branch
gh pr view --json number,title,body,author,state,url,baseRefName,headRefName
```

For a specific PR number or URL:

```bash
gh pr view <PR_NUMBER_OR_URL> --json number,title,body,author,state,url,baseRefName,headRefName
```

### 2. Check Merge Status

```bash
gh pr view --json mergeable,mergeStateStatus,reviewDecision
```

Key fields:

- `mergeable`: Can be merged without conflicts
- `mergeStateStatus`: CLEAN, UNSTABLE, DIRTY, etc.
- `reviewDecision`: APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED

### 3. Fetch Related Issues

```bash
# Get issues that will be closed by this PR
gh pr view --json closingIssuesReferences

# View specific issue details
gh issue view <ISSUE_NUMBER> --json number,title,body,labels,state
```

Also parse PR body for issue references like `#123`, `fixes #456`, `closes #789`.

### 4. Check CI Status (GitHub Actions)

```bash
# Summary of all checks
gh pr checks

# Detailed status with conclusions
gh pr view --json statusCheckRollup
```

If checks failed:

```bash
# List workflow runs
gh run list --branch <BRANCH_NAME>

# View failed run logs
gh run view <RUN_ID> --log-failed
```

### 5. Fetch Review Comments

```bash
# All comments on PR
gh pr view --comments

# Review status summary
gh pr view --json reviews,reviewRequests
```

For detailed inline comments:

```bash
# Get repository info first
gh repo view --json owner,name

# Then fetch comments via API
gh api repos/{owner}/{repo}/pulls/{pull_number}/comments
gh api repos/{owner}/{repo}/pulls/{pull_number}/reviews
```

### 6. Get Commit History

```bash
gh pr view --json commits
```

### 7. Preview Changes

```bash
# Statistics
gh pr view --json additions,deletions,changedFiles

# File-level diff stats
gh pr diff --stat

# Full diff (use judiciously for large PRs)
gh pr diff
```

## Output Format

Present findings in this structure:

```markdown
## PR Summary

- **PR #<number>**: <title>
- **Author**: @<username>
- **State**: Open/Merged/Closed
- **Base**: <base> <- <head>
- **URL**: <url>

## Merge Status

- **Mergeable**: Yes/No/Unknown
- **Conflicts**: None / Has conflicts
- **Review Decision**: Approved / Changes Requested / Pending

## Related Issues

- #<number>: <title> (<state>)

## CI Status

- ✅ <check_name>: Success
- ❌ <check_name>: Failed - <reason>
- ⏳ <check_name>: In Progress

## Reviews

- Approved: <count>
- Changes Requested: <count>
- Pending: <count>

## Unresolved Comments

1. **@<reviewer>** on `<file>:<line>`
   > <comment>

## Commits (<count>)

1. `<sha>` - <message>

## Changes

- Files: <count>
- Additions: +<count>
- Deletions: -<count>
```

## Error Handling

| Error             | Action                      |
| ----------------- | --------------------------- |
| No PR for branch  | Suggest `gh pr create`      |
| PR not found      | Verify PR number/URL        |
| Permission denied | Check `gh auth status`      |
| Rate limited      | Wait or use `--limit` flags |

## Tips

- For large PRs, use `gh pr diff --stat` first to identify key files
- Use `gh pr checks --watch` to monitor CI in real-time
- Filter reviews: `gh api` with `?state=pending` query param
