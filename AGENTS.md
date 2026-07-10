# Dotfiles repository guidance

This repository is a TypeScript/Bun dotfiles manager. It creates and removes
symlinks, keeps timestamped backups, and merges MCP configuration without
destroying unrelated user state.

## Commands

```bash
bun install
bun test
bun run lint
bun run lint:sh
bun run tsc
bun run run-all
bun run src/index.ts install -d
bun run src/index.ts list --verbose
```

Use Bun because `bun.lock` is present. Do not start a development server.

## Architecture

- `src/index.ts` parses CLI commands with Gunshi.
- `src/commands/` coordinates operations.
- `src/core/` contains config, symlink, backup, MCP merge, and logproxy logic.
- `src/utils/` contains filesystem, path, command, and logging helpers.
- `dotfiles.config.ts` is the typed mapping source of truth.
- `claude/.claude/` and `codex/` are the versioned sources for the two agent
  harnesses. Home-directory files are installed as symlinks.

Preserve unrelated or machine-generated state in `~/.claude`, `~/.codex`, and
`~/.agents`. Never replace those directories wholesale; add selective child
links. `codex/config.toml` is a live file with a clean filter, so portable
settings belong there while machine-local absolute-path tables must remain
unstaged/scrubbed.

Tests use real temporary directories rather than mocked filesystem calls. Keep
new behavior covered at the narrowest relevant layer and clean temporary state.
