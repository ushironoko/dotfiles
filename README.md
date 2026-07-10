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

- `-d, --dryRun`: Preview changes
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

## Troubleshooting

### Quick Diagnostics

If you're having issues with the initial setup, run the diagnostic tool:

```bash
./init.sh --check
```

This will show:

- Binary locations (mise, bun, node)
- Command availability in PATH
- mise installation status
- Installed tools
- Recommendations for fixing issues

### Common Issues

Run `dotfiles doctor` to diagnose issues. Common fixes:

```bash
# If mise commands are not found after installation
# Make sure ~/.local/bin is in your PATH and restart shell
export PATH="$HOME/.local/bin:$PATH"
exec $SHELL

# Remove conflicting Bun installation
rm -rf ~/.bun

# Fix PATH permanently
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

## Codex harness

The versioned [Codex harness](codex/README.md) installs global instructions,
native custom agents, lifecycle hooks, command restrictions, and the shared
Claude skills alongside `~/.codex/config.toml`. Each component is linked
selectively so Codex runtime state and bundled skills remain intact. After hook
changes, review and trust them with `/hooks` in Codex.

### Live config (`~/.codex/config.toml`)

`~/.codex/config.toml` is symlinked to `codex/config.toml`, but codex rewrites
that file at runtime, filling it with machine-local state — `[projects."<path>"]`
trust levels (absolute paths, including private/client repo names), `[mcp_servers.*]`
tables wired to Codex.app paths, `[marketplaces.*]` sources, the `notify` helper
path, per-repo `[desktop...perPath]` prefs, and `[hooks.state]` approval hashes.
A git **clean filter**
(`codex-scrub`, `codex/scrub-config.awk`) drops anything carrying a quoted
absolute path, every `[projects.*]`/`[mcp_servers.*]` table, and the complete
`[hooks.state]` tree at `git add` time. The path rule remains content-based so
unknown machine state is scrubbed by default; URLs and relative paths are kept.
The working tree keeps the live file untouched, so codex keeps functioning.

The filter driver lives in `.git/config` (never committed), so it must be
registered once per clone:

```bash
bun run setup:git-filters   # also run automatically by init.sh and run-all
```

`init.sh` runs it on initial setup and `bun run run-all` runs it before every
pre-commit check, so under normal use no manual step is needed. If you commit
`codex/config.toml` on a fresh clone without it, trust state would leak — the
filter is set to `required = true` to fail loudly if the scrubber ever errors.
