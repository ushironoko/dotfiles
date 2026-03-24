# The 5 principles you must follow

```
Terms
- ALWAYS: It is assigned to items that must be complied with
- NEVER: It is assigned to things that must never be done
```

# 1. User Communications

- **ALWAYS** Utilize `dig` skills to gather information

# 2. Critical Constraints

## All time requirements

- **ALWAYS** Regarding technology, always research and apply the latest best practices. Do not rely solely on your own knowledge to make decisions 
- **ALWAYS** Before PlanExit, review the created plan file using the `plan-review` skill before showing it to the user
- **ALWAYS** Use `start-work` skill for non-trivial changes
- **ALWAYS** Use `ast-grep` skill for any code research in codebases
- **ALWAYS** Be mindful of `Agent Skills`. The user expects you to make full use of the skills.
- **ALWAYS** It is important to keep the SOLID principles in mind, but you should always avoid OOP. Functional programming and data-oriented design are more modern and are guidelines you should always keep in mind
- **ALWAYS** Specify exact versions: `module@5.5.1` (NOT `^5.0.0` or `@latest`)
- **NEVER** Suppress errors without handling
- **NEVER** Commit to git until explicitly instructed by the user
- **NEVER** In code comments, write only "why it is necessary." Do not write what is already obvious from the code

## TypeScript Projects
- **ALWAYS** Check for lock files and use the appropriate package manager:
  - If `pnpm-lock.yaml` exists → use `pnpm`
  - If `bun.lock` exists → use `bun`
- **ALWAYS** Use ESM imports (NO CommonJS)
- **ALWAYS** Use functional programming, e.g. Use function composition
- **NEVER** Use global state and singleton pattern
- **NEVER** Use classes
- **NEVER** Create `.d.ts` files
- **NEVER** Run development server startup commands in any workflow

# 3. Safety Rules for PRs and Commits (CRITICAL — Violations directly lead to data leak incidents)

## Absolute Rules for Creating PRs

- **NEVER** execute gh pr create before performing the following:
  1. Verify the target repository using gh repo view --json nameWithOwner
  2. In the case of a fork, confirm that the PR is directed to the user's own repository and not the upstream repository
  3. Present the target repository name and branch name to the user and obtain explicit approval before execution
- **NEVER** create a PR without user approval
- In a forked repository, explicitly specify the user's repository using gh pr create -R <owner/repo>

## Protection of Confidential Information in Commit Messages and PR Descriptions

- **NEVER** Include the following in commit messages, PR descriptions, or CLAUDE.md:
  - Private repository names
  - Company names, organization names, team names, or client names
  - Specific project information such as project-specific names, file counts, or build statistics
  - Internal tool names or infrastructure information
- **ALWAYS** Write commit messages using only generic technical terms.
- These rules also apply to the content, examples, and comments within CLAUDE.md itself

# 4. Workflow Principles

**ALWAYS** Always use `start-work` skill

## exceptions

- Simply tasks(e.g. typo fix, document updates, etc.)

# 5. SPECIAL CASES

## Windows Path Conversion

- **ALWAYS** When handling file paths from Windows:

```bash
# Convert Windows path
"C:\Users\user1\Pictures\test.jpg"
# To WSL/Ubuntu mount path
"/mnt/c/Users/user1/Pictures/test.jpg"
```

