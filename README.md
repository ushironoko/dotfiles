# Dotfiles

ushironoko's dotfiles management system.

## Quick Start

```bash
# Clone the repository
git clone https://github.com/ushironoko/dotfiles.git
cd dotfiles

# Run initial setup
./init.sh

# After setup, you can use:
dotfiles install    # Install/update dotfiles
dotfiles restore    # Restore from backup
dotfiles list       # List managed files
```

## Requirements

- macOS or Linux
- Bun (automatically installed by init.sh if not present)

## What it does

- Creates symbolic links from your dotfiles to system locations
- Backs up existing files before replacing them
- Merges MCP server configurations for `~/.claude.json`
- Manages shell configs, git settings, and various tool configurations
