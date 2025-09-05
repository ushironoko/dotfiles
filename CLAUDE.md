# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a dotfiles repository that manages personal Unix system configurations through symbolic links. The repository contains configuration files for shells (bash, zsh), Git, Claude CLI, and other developer tools.

## Common Commands

### Installation and Setup
```bash
# Install all dotfiles (creates symlinks and backups)
./install.sh

# Restore from backup (interactive)
./restore.sh

# Restore from specific backup
./restore.sh 20250905_125854
```

### Testing Changes
```bash
# After modifying install.sh, test installation
rm -f ~/.bashrc ~/.zshrc ~/.gitconfig  # Remove test symlinks
./install.sh                            # Re-run installation
ls -la ~/ | grep '^l'                  # Verify symlinks created
```

## Architecture and Key Files

### Installation System (`install.sh`)
- **Backup mechanism**: Creates timestamped backups in `~/.dotfiles_backup/` before overwriting
- **`create_symlink()` function**: Core function at line 18 that handles all symlink creation
- **MCP Server merging**: `merge_claude_mcp_servers()` at line 48 merges `claude/dot_claude.json` into `~/.claude.json`
- **Conditional linking**: Checks for directory existence before linking (e.g., Fish config at line 141)

### Restoration System (`restore.sh`)  
- Interactive backup selection with numbered list
- Restores files from `~/.dotfiles_backup/` directories
- Preserves directory structure when restoring

### Claude Configuration Strategy
Only these files from `claude/.claude/` are symlinked:
- `agents/`, `commands/`, `CLAUDE.md`, `settings.json`, `statusline.sh`

These remain local only:
- `.credentials.json`, `settings.local.json` (credentials)
- `projects/`, `todos/`, `shell-snapshots/` (dynamic data)
- `.mcp.json` (MCP configuration with secrets)

### MCP Server Configuration
The `claude/dot_claude.json` file contains MCP server definitions that are merged into `~/.claude.json` during installation. This allows tracking MCP configurations without exposing the full `.claude.json` file with API keys.

## Security Guidelines

### Files That Must Never Be Committed
The `.gitignore` enforces these patterns:
- `config/gh/` - GitHub CLI OAuth tokens
- `*_token*`, `credentials*`, `secrets*` - Any credential files
- `.env`, `.envrc` - Environment variables
- `*.key`, `*.pem` - Cryptographic keys

### Before Adding New Files
1. Check for API keys, tokens, or passwords
2. Review file for personal information (emails, usernames in configs)
3. Test installation on a clean system
4. Verify no sensitive data in git history

## Adding New Configurations

### For a new dotfile in home directory
```bash
# 1. Move file to repository
mv ~/.newconfig ~/dev/dotfiles/shell/.newconfig

# 2. Add to install.sh (after line 117 for shell configs)
create_symlink "$DOTFILES_DIR/shell/.newconfig" "$HOME/.newconfig"

# 3. Test and commit
./install.sh
git add shell/.newconfig install.sh
git commit -m "Add .newconfig"
```

### For a new .config subdirectory
```bash
# 1. Move directory to repository
mv ~/.config/toolname ~/dev/dotfiles/config/toolname

# 2. Add to install.sh (after line 144 for config items)
create_symlink "$DOTFILES_DIR/config/toolname" "$HOME/.config/toolname"

# 3. Test and commit
./install.sh
git add config/toolname install.sh
git commit -m "Add toolname configuration"
```

### For partial directory management (like Claude)
When only specific files from a directory should be managed:
1. Create directory structure in repository
2. Use a loop in `install.sh` to link individual files (see lines 126-132)
3. Document which files are managed vs local in this file

## Repository Structure

```
dotfiles/
├── shell/              # Shell configs symlinked to ~/
│   ├── .bashrc
│   ├── .profile
│   └── .zshrc
├── git/                # Git configuration
│   └── .gitconfig
├── claude/             # Claude CLI configuration
│   ├── .claude/        # Partial management (see above)
│   └── dot_claude.json # MCP servers configuration
├── config/             # ~/.config/ contents
│   ├── fish/          # Fish shell (optional)
│   ├── git/           # Git config dir
│   ├── mise/          # Mise tool configuration
│   └── starship.toml  # Starship prompt
├── install.sh          # Main installation script
├── restore.sh          # Backup restoration script
└── CLAUDE.md          # This file
```