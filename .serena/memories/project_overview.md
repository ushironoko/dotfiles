# Dotfiles Project Overview

## Project Purpose
This is a personal dotfiles management tool written in TypeScript that manages Unix system configurations through symbolic links. It provides a modern TypeScript/Bun-based replacement for traditional Bash-based dotfiles management scripts.

## Tech Stack
- **Runtime**: Bun for fast TypeScript execution
- **Language**: TypeScript with ESM modules
- **CLI Framework**: Gunshi (0.26.3) for type-safe command definitions
- **Testing**: Bun test framework
- **Linting**: OXC (oxlint 0.15.2) - high performance linter
- **Type Checking**: TypeScript compiler (tsgo)
- **Logging**: consola (3.2.3) for terminal output
- **Configuration**: c12 (3.2.0) for smart config loading
- **Object Merging**: defu (6.1.4) for deep object merging

## Key Features
- Symbolic link management with backup functionality
- Configuration file management across different categories (shell, git, claude, etc.)
- MCP (Model Context Protocol) server configuration merging
- Backup and restore functionality
- Modern CLI interface with type safety

## Project Structure
```
src/
├── types/           # Type definitions
├── utils/           # Utility functions (fs, logger, paths)
├── core/            # Core business logic (managers)
├── commands/        # CLI command implementations
└── index.ts         # Main entry point

tests/
├── utils/           # Tests for utility functions
├── core/            # Tests for core modules  
└── commands/        # Tests for CLI commands
```