# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

A dotfiles management system written in TypeScript/Bun that creates symbolic links between configuration files and their system locations. Uses c12 for configuration loading with TypeScript support, environment-specific overrides, and type safety. Supports backups, restoration, and merging of MCP server configurations.

## Development Commands

```bash
# Install dependencies
bun install

# Run tests (72 tests across 7 files)
bun test
bun test tests/core/symlink-manager.test.ts  # Run single test file

# Linting and formatting
bun run lint       # Run oxlint
bun run lint:fix   # Auto-fix lint issues

# Type checking (using tsgo --noEmit)
bun run typecheck

# Pre-commit check (runs format, lint, typecheck, and tests)
bun run prepare

# Development/manual execution
bun run src/index.ts install --dry-run  # Preview installation
bun run src/index.ts restore            # Restore from backup
bun run src/index.ts list --verbose     # List symlinks with status

# Run with environment-specific config
NODE_ENV=development bun run src/index.ts list
```

## High-Level Architecture

The application follows a modular architecture with clear separation between CLI commands, core business logic, and utilities. All modules use ESM imports and are strongly typed with TypeScript.

### Command Flow

1. **CLI Entry** (`src/index.ts`) → Parses command using Gunshi CLI framework
2. **Command Handler** (`src/commands/*.ts`) → Orchestrates core modules
3. **Core Modules** (`src/core/*.ts`) → Executes business logic
4. **Utils** (`src/utils/*.ts`) → Provides cross-cutting functionality

### Core Module Responsibilities

- **ConfigManager**: Loads and validates configuration using c12. Supports TypeScript config files with type safety and environment-specific overrides.
- **SymlinkManager**: Creates symlinks with support for three mapping types:
  - `file`: Direct file-to-file symlink
  - `directory`: Entire directory symlink
  - `selective`: Cherry-pick specific files from a directory with optional permissions
- **BackupManager**: Creates timestamped backups (format: `YYYY-MM-DDTHH-MM-SS`) in `~/.dotfiles_backup`. Manages retention policy (keepLast setting).
- **MCPMerger**: Merges `mcpServers` configuration from `claude/dot_claude.json` to `~/.claude.json`. Prevents duplicate entries and handles backup creation.

### Configuration Structure (`dotfiles.config.ts`)

The main configuration file uses TypeScript with the `defineConfig` helper for type safety. It supports three types of mappings:

- **file**: Single file symlink (`"type": "file"`)
- **directory**: Entire directory symlink (`"type": "directory"`)
- **selective**: Specific files from a directory (`"type": "selective"` with `"include": []` array and optional `"permissions": {}`)

MCP configuration merging is handled separately via the `mcp` key, which specifies source/target files and the merge key (`mcpServers`).

## Key Implementation Notes

### Binary Execution

The `bin/` directory contains executable wrappers that import the TypeScript source directly:

```bash
#!/usr/bin/env bun
import "../src/index.ts";
```

These are symlinked to `~/.local/bin/` for global access.

### Testing Strategy

- Tests use temporary directories created with `mkdtemp` for isolation
- Each test cleans up its temporary files
- Mock filesystem operations are avoided in favor of real file operations in temp directories

### Error Handling Pattern

Commands use consistent error handling with colored output:

- Success: Green checkmarks with consola success messages
- Warnings: Yellow warnings with consola warn messages
- Errors: Red errors with consola error messages
- Verbose mode provides detailed operation logs (level 4)

### MCP Server Merging

The MCPMerger handles special logic for `.claude.json` using `defu` for deep object merging:

1. Reads existing target file or creates new one
2. Uses `defu` to deeply merge `mcpServers` arrays, preventing duplicates through custom array merging logic
3. Creates backup before modifying target
4. Preserves all other keys in target file (API keys, settings) through `defu`'s non-destructive merge behavior

## Research and Documentation

### Research Directory

The `research/` directory contains technical investigation results and migration guides. These documents are:

- Indexed in gistdex for searchable access via MCP
- Available for querying through the gistdex MCP server
- Used to store architectural decisions and technology evaluations

### Gistdex Integration

The project uses gistdex MCP for knowledge management:

- **queries.md**: Contains example queries for efficiently searching indexed documentation
- **Research documents**: Automatically indexed for semantic search
- **Access method**: Use `mcp__gistdex__gistdex_query` to retrieve indexed information

Example queries:

```
# Search for c12 configuration migration information
c12 migration JSON to TypeScript

# Find environment-specific configuration details
c12 $development $production environment
```
