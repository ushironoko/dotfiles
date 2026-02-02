# PROJECT CONTEXT

## Language & Runtime

- **Language**: TypeScript (ESM modules only)
- **Runtime**: Node.js / Bun
- **Package Manager**: Detected by lock file (pnpm/bun)

## Testing & Quality

- **Test Framework**: Vitest / Bun test (built in runtime)
- **Linter/Formatter**: BiomeJS (default settings) / OXCLint & Prettier
- **Type Checker**: typescript-native (a.k.a tsgo: https://github.com/microsoft/typescript-go)

## Architecture Principles

- Functional programming (NO classes)
- File-scoped types (NO .d.ts files)
- Language features over libraries

## User Communications

- **ALWAYS** Only use Japanese. User is Japanese.
- **ALWAYS** Force yourself to write down your thoughts.

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
- **NEVER** commit to git until explicitly instructed by the user
- **NEVER** run development server startup commands in any workflow
- **ALWAYS** use `jj-workspace` skill for non-trivial changes (multiple files, new features, refactoring)

## Before ANY Commit

**ALWAYS**

```bash
# Required checks (in order):
1. bun run format    # Code formatted
2. bun run lint      # No lint errors
3. bun run tsc # No type errors
4. bun test          # All tests must pass
```

## Permission Required

- **ASK** before deleting files or directories
- **ASK** before major architectural changes
- **PRESERVE** content between `###readonly` and `###readonlyend` markers

---

# SHOULD: Best Practices

## Development Workflow

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
bun run tsc          # Check types

# Pre-commit check (all-in-one)
bun run prepare
```

## Jujutsu Workspace Workflow

**MUST**: 軽微な修正以外の実装作業は、必ずjj workspaceで作業ディレクトリを分離する。

### 適用条件

- Plan mode終了後、コード変更を伴う実装を開始する時
- 新しいブランチで作業を開始する時

### 除外条件

- 単一ファイルの軽微な修正（typo、コメント追加等）
- READMEやドキュメントのみの変更
- プロジェクトのCLAUDE.mdで除外指定がある場合

### ワークフロー

1. `jj-workspace` スキルを参照してworkspaceを作成
2. 作成したworkspaceディレクトリで作業を継続
3. 作業完了後、ユーザーに削除確認
4. 確認後、workspaceを削除してメインリポジトリに戻る

### 補足: Colocatedモード

- jj workspaceはcolocatedモードで作成され、git互換を維持
- `jj`コマンドと`git`コマンドの両方が使用可能
- 他のgit利用者との協業に支障なし

---

# TOOLS CONFIGURATION

## Package.json Scripts

```json
{
  "scripts": {
    "test": "vitest",
    "lint": "biome check",
    "format": "biome format --write",
    "tsc": "tsc --noEmit",
    "prepare": "bun run format && bun run lint && bun run tsc && bun test"
  }
}
```

## formatter Settings

- **Indentation**: 2 spaces
- **Quotes**: Double quotes
- **Semicolons**: Always
- **Config**: Use defaults (minimal customization)

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
bunx --bun index.ts

# If fails, use tsx
pnpm dlx tsx index.ts
```
