# Dotfiles

ushironoko's dotfiles management system.

## Setup

```bash
# Initial setup
git clone https://github.com/ushironoko/dotfiles.git
cd dotfiles
./init.sh

# After setup, the dotfiles command is available:
dotfiles install    # Install symlinks
dotfiles list       # List managed files
dotfiles restore    # Restore from backup
dotfiles doctor     # Check environment

# Future updates with ghq (after initial setup):
ghq get ushironoko/dotfiles
cd $(ghq root)/github.com/ushironoko/dotfiles
```

## Commands

### `dotfiles install`

Creates symbolic links from repository to system locations.

- `-d, --dry-run`: Preview changes
- `-f, --force`: Force overwrite
- `-s, --select`: Interactive selection
- `-v, --verbose`: Detailed output

### `dotfiles list`

Shows all managed dotfiles and their status.

- `-v, --verbose`: Detailed information

### `dotfiles restore`

Restores files from backup.

- `-b, --backup <timestamp>`: Specific backup
- `-l, --list`: List available backups
- `-v, --verbose`: Detailed output

### `dotfiles doctor`

Diagnoses environment issues.

- `-c, --check <categories>`: Check specific areas (environment,conflicts,ghq,config,mcp)
- `-v, --verbose`: Detailed diagnostics

### `dotfiles mcpdoc`

Manages MCPDoc documentation sources for llms.txt files.

```bash
# Add a documentation source
dotfiles mcpdoc add "LangGraph" "https://langchain-ai.github.io/langgraph/llms.txt"

# Remove a documentation source
dotfiles mcpdoc remove "LangGraph"

# List all documentation sources
dotfiles mcpdoc list
```

- `--dry-run`: Preview changes without modifying files
- `--verbose`: Show detailed output

## Troubleshooting

Run `dotfiles doctor` to diagnose issues. Common fixes:

```bash
# Remove conflicting Bun installation
rm -rf ~/.bun

# Fix PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
echo 'eval "$(mise activate bash)"' >> ~/.bashrc
exec $SHELL

# Migrate old repos to ghq
./scripts/migrate-to-ghq.sh --dry-run
./scripts/migrate-to-ghq.sh --symlink
```

## Configuration

Edit `dotfiles.config.ts` to manage your files:

- **file**: Single file symlink
- **directory**: Entire directory symlink
- **selective**: Specific files with permissions
