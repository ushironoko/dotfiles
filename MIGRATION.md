# Migration Guide: Bash to TypeScript

This guide explains the migration from the original Bash scripts to the new TypeScript/Bun implementation.

## Overview

The dotfiles management system has been migrated from Bash to TypeScript, running on the Bun runtime. This provides:

- **Type safety**: Full TypeScript type checking prevents runtime errors
- **Better performance**: Bun runtime offers faster execution
- **Improved maintainability**: Modular architecture with clear separation of concerns
- **Enhanced testing**: Comprehensive test suite with Vitest
- **JSON configuration**: External configuration file for easier management

## Comparison

### Old (Bash)
```bash
./install.sh                    # Install dotfiles
./restore.sh                    # Restore from backup (interactive)
./restore.sh 20250905_125854   # Restore specific backup
```

### New (TypeScript)
```bash
./install-ts.sh                # Install dotfiles
./install-ts.sh --dry-run      # Preview changes without applying
./install-ts.sh --force         # Force overwrite existing files
./restore-ts.sh                 # Restore from backup (interactive)
./restore-ts.sh --backup 2025-09-05T06-55-45  # Restore specific backup
bun run src/index.ts list       # List managed dotfiles status
```

## New Features

1. **Dry-run mode**: Preview changes without making them
   ```bash
   ./install-ts.sh --dry-run
   ```

2. **List command**: View status of all managed dotfiles
   ```bash
   bun run src/index.ts list
   ```

3. **JSON configuration**: Edit `config/dotfiles.json` to add/remove dotfiles without code changes

4. **Better logging**: Color-coded output with verbose mode
   ```bash
   ./install-ts.sh --verbose
   ```

5. **Partial restore**: Restore only specific files
   ```bash
   ./restore-ts.sh --partial .bashrc --partial .zshrc
   ```

## Configuration File

The new system uses `config/dotfiles.json` instead of hardcoded paths in the shell script:

```json
{
  "mappings": [
    {
      "source": "./shell/.bashrc",
      "target": "~/.bashrc",
      "type": "file"
    },
    {
      "source": "./claude/.claude",
      "target": "~/.claude",
      "type": "selective",
      "include": ["agents", "commands", "CLAUDE.md", "settings.json", "statusline.sh"],
      "permissions": {
        "statusline.sh": "755"
      }
    }
  ],
  "backup": {
    "directory": "~/.dotfiles_backup",
    "keepLast": 10
  },
  "mcp": {
    "sourceFile": "./claude/dot_claude.json",
    "targetFile": "~/.claude.json",
    "mergeKey": "mcpServers"
  }
}
```

## Directory Structure

```
dotfiles/
├── src/                  # TypeScript source code
│   ├── commands/        # CLI commands (install, restore, list)
│   ├── core/           # Core functionality (config, symlink, backup, mcp)
│   ├── utils/          # Utilities (logger, fs, paths)
│   ├── types/          # TypeScript type definitions
│   └── index.ts        # Main entry point
├── tests/              # Vitest test suite
├── config/             # Configuration files
│   └── dotfiles.json   # Main configuration
├── bin/                # Executable scripts
├── legacy/             # Original Bash scripts (for reference)
│   ├── install.sh
│   └── restore.sh
├── install-ts.sh       # Wrapper for TypeScript install
├── restore-ts.sh       # Wrapper for TypeScript restore
├── install.sh          # Original Bash install (kept for compatibility)
└── restore.sh          # Original Bash restore (kept for compatibility)
```

## Development

### Running Tests
```bash
bun test                # Run all tests
bun test --watch        # Watch mode
```

### Linting
```bash
bun run lint           # Run OXLint
bun run lint:fix       # Auto-fix issues
```

### Type Checking
```bash
bun run typecheck      # Run TypeScript compiler
```

### Development Mode
```bash
bun run dev            # Run CLI in development
bun run dev install --dry-run  # Test commands
```

## Rollback

If you need to rollback to the Bash version:

1. The original scripts are still available:
   - `./install.sh` - Original Bash install script
   - `./restore.sh` - Original Bash restore script

2. These continue to work exactly as before

## Troubleshooting

### Bun not installed
If you see "Bun is not installed", install it with:
```bash
curl -fsSL https://bun.sh/install | bash
```

### Permission denied
Ensure scripts are executable:
```bash
chmod +x install-ts.sh restore-ts.sh bin/*
```

### Module not found
Install dependencies:
```bash
bun install
```

## Benefits of Migration

1. **Type Safety**: TypeScript catches errors at compile time
2. **Modularity**: Clear separation of concerns makes maintenance easier
3. **Testing**: Comprehensive test suite ensures reliability
4. **Performance**: Bun runtime is faster than Bash
5. **JSON Config**: No need to edit code to add new dotfiles
6. **Better UX**: Colored output, dry-run mode, verbose logging
7. **Extensibility**: Easy to add new commands and features