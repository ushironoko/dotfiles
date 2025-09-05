# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a dotfiles repository that manages personal Unix system configurations through symbolic links. The repository is currently transitioning from Bash scripts to a TypeScript implementation for improved maintainability and testing.

## Current Implementation Status

### ✅ TypeScript Implementation (New - Primary)
The repository now has a complete TypeScript implementation that provides feature parity with the legacy Bash scripts:

- **Runtime**: Bun (ALWAYS use Bun, never npm/pnpm)
- **Package Manager**: Bun (`bun add`, `bun install`, `bun run`)
- **Linting**: OXC (`bun run lint`) - 0 errors, warnings are acceptable for magic numbers in tests
- **Testing**: Vitest (`bun run test`) - 72 tests, all passing
- **Type Checking**: TypeScript (`bun run typecheck`) - 0 errors

### 🔄 Migration Status
- ✅ Core functionality implemented in TypeScript
- ✅ All legacy features ported
- ✅ Comprehensive test coverage
- ⚠️ Legacy Bash scripts still available in `legacy/` directory
- 🎯 Next: Production testing and gradual transition

## TypeScript Architecture

### Core Modules (`src/core/`)

#### SymlinkManager (`symlink-manager.ts`)
- `createSymlink(source, target, force, dryRun)` - Creates individual symlinks
- `createMultipleSymlinks(mappings[], options)` - Batch symlink creation
- `checkSymlinkStatus(target, source)` - Verifies symlink integrity
- Supports three mapping types: `file`, `directory`, `selective`

#### BackupManager (`backup-manager.ts`)
- `createBackup(paths[], dryRun)` - Creates timestamped backups
- `listBackups()` - Returns BackupInfo[] with metadata
- `restoreBackup(name, targetPaths?, dryRun)` - Restores from backup
- `cleanOldBackups(dryRun)` - Removes old backups based on keepLast setting
- Timestamp format: `YYYY-MM-DDTHH-MM-SS`

#### MCPMerger (`mcp-merger.ts`)
- `merge(dryRun)` - Merges mcpServers configuration
- `backup(dryRun)` - Creates backup of target file
- Special handling for `.claude.json` files
- Prevents duplicate backups

#### ConfigManager (`config-manager.ts`)
- `loadConfig(path?)` - Loads configuration from JSON
- `validateConfig(config)` - Validates configuration schema
- Default configuration fallback

### CLI Commands (`src/commands/`)

```bash
# Install command
bun run src/index.ts install [options]
  --config, -c    # Custom config file path
  --dry-run, -d   # Preview changes without applying
  --force, -f     # Overwrite existing files
  --verbose, -v   # Detailed output

# Restore command  
bun run src/index.ts restore [options]
  --backup, -b    # Specific backup name
  --interactive, -i # Interactive selection mode
  --partial, -p   # Restore specific paths only
  --dry-run, -d   # Preview restore
  --verbose, -v   # Detailed output

# List command
bun run src/index.ts list [options]
  --config, -c    # Custom config file
  --verbose, -v   # Show detailed status
```

### Configuration (`config/dotfiles.json`)

```json
{
  "mappings": [
    {
      "source": "./shell/.bashrc",
      "target": "~/.bashrc",
      "type": "file"
    },
    {
      "source": "./config",
      "target": "~/.config", 
      "type": "directory"
    },
    {
      "source": "./claude/.claude",
      "target": "~/.claude",
      "type": "selective",
      "files": ["agents/", "commands/", "CLAUDE.md", "settings.json", "statusline.sh"]
    }
  ],
  "backup": {
    "directory": "~/.dotfiles_backup",
    "keepLast": 5
  },
  "mcp": {
    "sourceFile": "./claude/dot_claude.json",
    "targetFile": "~/.claude.json",
    "mergeKey": "mcpServers",
    "backupDir": "~/.dotfiles_backup"
  }
}
```

## Development Workflow

### Running Tests
```bash
# Run all tests
bun run test

# Run specific test file
bun test tests/core/backup-manager.test.ts

# Run with coverage
bun test --coverage
```

### Code Quality Checks
```bash
# Run linter (oxlint)
bun run lint

# Auto-fix lint issues
bun run lint:fix

# Type checking
bun run typecheck

# Run all checks
bun run lint && bun run test && bun run typecheck
```

### Common Development Tasks

#### Adding a New Dotfile Configuration
1. Add mapping to `config/dotfiles.json`:
```json
{
  "source": "./path/to/file",
  "target": "~/target/path",
  "type": "file"
}
```
2. Test: `bun run src/index.ts install --dry-run`
3. Apply: `bun run src/index.ts install`

#### Implementing New Features
1. Write tests first in `tests/` directory
2. Implement feature in appropriate module
3. Ensure all checks pass: `bun run lint && bun run test && bun run typecheck`
4. Update this documentation

## Known Issues and TODOs

### Current Limitations
- [ ] Optional directory linking not yet implemented (e.g., Fish config conditional)
- [ ] File preview in restore command limited (legacy shows 20 files)
- [ ] No progress bar for large operations

### Future Enhancements
- [ ] Add `--json` output format for programmatic use
- [ ] Implement `diff` command to show changes before install
- [ ] Add `status` command for comprehensive system state
- [ ] Create GitHub Actions for CI/CD
- [ ] Add performance benchmarks
- [ ] Implement configuration validation CLI tool

## Migration from Legacy

### For Users
```bash
# Use TypeScript version
bun run src/index.ts install

# Or use compiled version (if available)
./install-ts.sh

# Legacy still available
./legacy/install.sh
```

### For Contributors
1. All new features should be implemented in TypeScript
2. Legacy Bash scripts are frozen (no new features)
3. Bug fixes should be applied to TypeScript version only
4. Test coverage must be maintained above 80%

## Type Definitions

Key types are defined in `src/types/config.ts`:

```typescript
interface FileMapping {
  source: string;
  target: string;
  type: "file" | "directory" | "selective";
  files?: string[];  // For selective type
  permissions?: string | { [key: string]: string };
}

interface BackupInfo {
  name: string;
  path: string;
  date: Date;
}

interface SymlinkStatus {
  exists: boolean;
  isSymlink: boolean;
  pointsToCorrectTarget?: boolean;
  targetExists?: boolean;
}
```

## Security Considerations

### Files That Must Never Be Committed
- `config/gh/` - GitHub CLI OAuth tokens
- `*_token*`, `credentials*`, `secrets*` - Any credential files
- `.env`, `.envrc` - Environment variables
- `*.key`, `*.pem` - Cryptographic keys

### MCP Configuration Security
- Source: `claude/dot_claude.json` (safe to commit - no secrets)
- Target: `~/.claude.json` (contains API keys - never commit)
- Merge only touches `mcpServers` key, preserving credentials

## Repository Structure

```
dotfiles/
├── src/                # TypeScript source code
│   ├── index.ts       # CLI entry point
│   ├── commands/      # CLI command implementations
│   ├── core/          # Core business logic
│   ├── utils/         # Utility functions
│   └── types/         # TypeScript type definitions
├── tests/             # Test files (mirrors src/ structure)
├── config/            # Configuration files
│   └── dotfiles.json  # Main configuration
├── legacy/            # Original Bash scripts (frozen)
├── shell/             # Shell configurations
├── git/               # Git configuration
├── claude/            # Claude CLI configuration
├── research/          # Technical research documents
├── package.json       # Node.js dependencies
├── tsconfig.json      # TypeScript configuration
├── vitest.config.ts   # Test configuration
├── .oxlintrc.json     # Linter configuration
└── CLAUDE.md          # This file
```

## Contact and Support

For issues or questions about the TypeScript implementation:
1. Check existing tests for usage examples
2. Review type definitions for API contracts
3. Run with `--verbose` flag for debugging
4. Check legacy implementation for expected behavior

---
*Last updated: 2025-01-09 - TypeScript implementation complete with full test coverage*