---
name: create-pr
description: "Create a pull request from current changes. Use when the user requests PR creation, pushing changes for review, or submitting work for code review."
allowed-tools: Bash(git status *), Bash(git log *), Bash(git diff *), Bash(git add *), Bash(git commit *), Bash(git push *), Bash(git checkout *), Bash(git branch *), Bash(gh pr create *), Bash(gh repo view *)
---

## Execution Flow

### Phase 1: Assess Current State

Run in parallel:

```bash
git status -u
git diff
git diff --cached
git log --oneline -5
git branch --show-current
```

If on `main` or `master`, create a feature branch first:

```bash
git checkout -b <descriptive-branch-name>
```

### Phase 2: Stage and Commit

1. Stage relevant files by name (avoid `git add -A` to prevent accidental inclusion of sensitive files like `.env`):

```bash
git add <file1> <file2> ...
```

2. Analyze changes and create commit:
   - Follow the repository's existing commit message style
   - Focus on "why" not "what"
   - **NEVER** include private repo names, org names, client names, or internal tool names

### Phase 3: Safety Verification

**Before pushing**, verify the target repository:

```bash
gh repo view --json nameWithOwner,isFork,parent
```

Present to the user via AskUserQuestion:

- Target repository: `<owner/repo>`
- Branch: `<source>` → `<target>`
- If fork: confirm PR targets the user's own repo, NOT upstream

**Wait for explicit user approval before proceeding.**

### Phase 4: Push and Create PR

```bash
git push -u origin <branch-name>
```

For forks, use `-R <owner/repo>` explicitly:

```bash
gh pr create --title "<title>" --body "<body>"
```

- Title: under 70 characters
- Body: derive from diff context and commit history — adapt format to the nature of the changes
- **NEVER** include private information in title or body

### Phase 5: Report

Return the PR URL to the user.

## Error Handling

| Situation            | Response                                                 |
| -------------------- | -------------------------------------------------------- |
| No changes to commit | Inform user, skip commit                                 |
| On main/master       | Create feature branch first                              |
| Push rejected        | Check remote, suggest pull or ask user about force-push  |
| Fork detected        | Use `gh pr create -R <owner/repo>` to target user's repo |
| gh auth failure      | Guide user to run `gh auth login`                        |
