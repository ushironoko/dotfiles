# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a dotfiles repository that manages personal Unix system configurations through symbolic links. The repository contains configuration files for shells (bash, zsh), Git, Claude CLI, and other developer tools.

## Installation and Testing

### Primary Installation Method
```bash
./install.sh
```
This script creates symbolic links from the home directory to files in this repository. It automatically detects the repository location using `DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"`.

### Testing Installation
To test the installation script after making changes:
1. Remove existing symlinks manually
2. Run `./install.sh` from the repository directory
3. Verify symlinks with `ls -la ~/.<filename>`

## Important Security Considerations

### Files That Must Never Be Included
- **OAuth tokens**: Never include files containing authentication tokens (e.g., `~/.config/gh/hosts.yml`)
- **SSH keys**: Private keys should never be tracked
- **API credentials**: Files like `.claude.json` containing API keys must remain local
- **MCP configurations**: `.mcp.json` files should not be symlinked or tracked

The `.gitignore` already excludes sensitive patterns like `*_token*`, `credentials*`, `secrets*`, and `config/gh/`.

## Architecture Decisions

### Partial Directory Management
For the Claude configuration (`~/.claude/`), only specific files are managed:
- `agents/`, `commands/`, `CLAUDE.md`, `settings.json` are symlinked
- Dynamic directories (`projects/`, `todos/`, `shell-snapshots/`) remain local
- Credential files (`.credentials.json`, `settings.local.json`) stay in the original location

### Symlink Strategy
The installation script uses a `create_symlink()` function that:
1. Creates parent directories if needed
2. Removes existing files/symlinks before creating new ones
3. Provides feedback for each operation

## Adding New Dotfiles

When adding a new configuration file:
1. Move the file to the appropriate category directory (`shell/`, `git/`, `config/`)
2. Update `install.sh` to include the new symlink
3. Test the installation script before committing
4. Check for sensitive information before adding to the repository

## Common Operations

### Update dotfiles from upstream
```bash
git pull origin main
```

### Verify current symlinks
```bash
ls -la ~/ | grep '^l'  # Show all symlinks in home
```

### Remove all symlinks (for testing)
```bash
# Example for shell configs
rm ~/.bashrc ~/.profile ~/.zshrc
cp ~/dev/dotfiles/shell/.* ~/
```

## Repository Structure Notes

- `shell/`: Shell configurations that are directly symlinked to `~/`
- `git/`: Git global configuration
- `claude/.claude/`: Partial Claude CLI configuration (selective files only)
- `config/`: Contents for `~/.config/` directory (excluding sensitive directories like `gh/`)
- Fish shell configuration directory may not exist - the install script checks before linking