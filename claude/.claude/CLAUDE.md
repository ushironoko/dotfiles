# PROJECT CONTEXT

## Language & Runtime

- **Language**: TypeScript (ESM modules only)
- **Runtime**: Node.js / Bun
- **Package Manager**: Detected by lock file (pnpm/bun)

## Testing & Quality

- **Test Framework**: Vitest
- **Linter/Formatter**: BiomeJS (default settings)
- **Type Checker**: tsc

## Architecture Principles

- Functional programming (NO classes)
- File-scoped types (NO .d.ts files)
- Language features over libraries

---

# MUST: Critical Constraints

## Absolute Requirements

- **ALWAYS** check for lock files and use the appropriate package manager:
  - If `pnpm-lock.yaml` exists → use `pnpm`
  - If `bun.lockb` exists → use `bun`
  - For new projects → prefer `pnpm`
- **ALWAYS** specify exact versions: `module@5.5.1` (NOT `^5.0.0` or `@latest`)
- **ALWAYS** handle errors with try/catch or await/catch
- **ALWAYS** use ESM imports (NO CommonJS)
- **NEVER** use classes - use functions and objects
- **NEVER** create `.d.ts` files
- **NEVER** suppress errors without handling

## Before ANY Commit

**ALWAYS**

```bash
# Required checks (in order):
1. bun run format    # Code formatted
2. bun run lint      # No lint errors
3. bun run typecheck # No type errors
4. bun test          # All tests must pass
```

## Permission Required

- **ASK** before deleting files or directories
- **ASK** before major architectural changes
- **PRESERVE** content between `###readonly` and `###readonlyend` markers

---

# SHOULD: Best Practices

## Development Workflow

### Task Management

1. **Create task list** - Break down goals into actionable items
2. **Prioritize** - Order by importance and dependencies
3. **Track progress** - Update status after each completion
4. **Use subagents** when applicable:
   - `git` → Git operations
   - `benchmark` → Performance testing
   - `similarity` → Refactoring

### Test-Driven Development (TDD)

```bash
# Follow t_wada's TDD cycle:
1. Write failing test
2. Make it pass (minimal code)
3. Refactor (keep tests green)
4. Run quality checks
5. Commit
```

## Code Style

### TypeScript Conventions

- **Prefer** built-in language features over libraries
- **Use** async/await over callbacks/promises
- **Export** named exports over default exports
- **Type** everything explicitly (avoid `any`)

### File Organization

```
project-root/
├── src/          # Source code
├── tests/        # Test files (*.test.ts)
├── scripts/      # Build/utility scripts
├── lib/          # Compiled output
├── bin/          # Executables
└── docs/         # Documentation
```

### Error Handling Pattern

```typescript
// Async operations
try {
  const result = await operation();
} catch (error) {
  // Handle with context
  throw new Error("Operation failed", { cause: error });
}

// Sync operations
try {
  performAction();
} catch (error) {
  console.error("Action failed:", error);
  // Provide user feedback
}
```

---

# WORKFLOWS

## Starting New Task

```bash
# 1. Understand requirements
# 2. Create task list
# 3. Set up test file
# 4. Implement with TDD
# 5. Run quality checks
```

## Installing Dependencies

```bash
# Detect package manager from lock file
# If pnpm-lock.yaml exists:
pnpm info <package>
pnpm add <package>@1.2.3

# If bun.lockb exists:
bun info <package>
bun add <package>@1.2.3

# Always use exact versions
# Avoid pre-release versions
```

## Running Quality Checks

```bash
# Individual checks
bun test                    # Run tests
bun run lint               # Check code style
bun run format             # Format code
bun run typecheck          # Check types

# Pre-commit check (all-in-one)
bun run prepare
```

---

# TOOLS CONFIGURATION

## Package.json Scripts

```json
{
  "scripts": {
    "test": "vitest",
    "lint": "biome check",
    "format": "biome format --write",
    "typecheck": "tsc --noEmit",
    "prepare": "bun run format && bun run lint && bun run typecheck && bun test"
  }
}
```

## BiomeJS Settings

- **Indentation**: 2 spaces
- **Quotes**: Double quotes
- **Semicolons**: Always
- **Config**: Use defaults (minimal customization)

## Vitest Configuration

- **Test files**: `*.test.ts` (same directory as source)
- **Coverage**: Optional but recommended
- **Watch mode**: Use for TDD

## TypeScript Configuration

- **Module**: ESNext
- **Target**: Based on Node.js version in `.node-version`
- **Strict**: true
- **No emit**: For type checking only

---

# SPECIAL CASES

## Windows Path Conversion

When handling file paths from Windows:

```bash
# Convert Windows path
"C:\Users\user1\Pictures\test.jpg"
# To WSL/Ubuntu mount path
"/mnt/c/Users/user1/Pictures/test.jpg"
```

## Monorepo Support

For monorepo projects:

- Use `packages/` instead of `src/`
- Configure workspaces (pnpm-workspace.yaml or bun workspace)
- Share configs at root level

## Direct TypeScript Execution

```bash
# Try Bun runtime first
bun --bun index.ts

# If fails, use tsx
pnpm dlx tsx index.ts
```
