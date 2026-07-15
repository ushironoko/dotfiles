# Codex harness

This directory is the versioned Codex counterpart of `claude/.claude`.
`dotfiles.config.ts` installs each durable component separately so Codex's
runtime databases, plugin cache, bundled skills, and generated rules remain
untouched.

| Source                      | Installed location             |
| --------------------------- | ------------------------------ |
| `config.toml`               | `~/.codex/config.toml`         |
| `AGENTS.md`                 | `~/.codex/AGENTS.md`           |
| `agents/`                   | `~/.codex/agents/`             |
| `hooks.json`                | `~/.codex/hooks.json`          |
| `hooks/`                    | `~/.codex/hooks/`              |
| `rules/harness.rules`       | `~/.codex/rules/harness.rules` |
| `../claude/.claude/skills/` | `~/.agents/skills/`            |

The three directory rows are installed as selective child links, so existing
custom agents, hooks, and skills with other names can coexist. Preview the
deployment with `bun run src/index.ts install -d` before applying it.

## Lifecycle mapping

| Claude event        | Codex implementation                                        |
| ------------------- | ----------------------------------------------------------- |
| `PreToolUse`        | Native `PreToolUse` adapters                                |
| `PermissionRequest` | Native `PermissionRequest` adapter                          |
| `PostToolUse`       | Native `PostToolUse` adapters for `apply_patch`             |
| `SessionStart`      | Native hook; long checks self-background                    |
| `UserPromptSubmit`  | Native hook with Codex-native ultracode context             |
| `Stop`              | Native hook; long checks self-background                    |
| `Notification`      | TUI notifications plus the `Stop` notification adapter      |
| `TaskCompleted`     | Explicit task-complete command after parent verification    |
| `WorktreeCreate`    | Native App worktree, or explicit create-and-reopen adapter  |
| `WorktreeRemove`    | Native cleanup, or confirmed clean managed-worktree adapter |

The Codex-native ultracode hook ignores prompts when
`PI_CODING_AGENT=true`. pi sets that marker on its subprocesses and handles the
prompt through pi-harness, preventing a delegated Codex CLI from starting a
second orchestration layer. Direct Codex CLI sessions still receive the native
ultracode context.

Codex 0.144.1 does not provide the last four Claude event names, asynchronous
command handlers, or command-rendered status lines. The compatibility layer
preserves their outcomes without registering unsupported handlers. The TUI
status line therefore uses built-in Codex items; lint/typecheck/test state is
still refreshed by the lifecycle checks but cannot be injected into that footer.

User hooks are global, so the formatter and background quality checks fail
closed unless the current path is covered by a `trust_level = "trusted"` project
in the live Codex config. Missing Bun/TOML support, a missing config, or a
parse error means repository-defined commands are skipped. `SubagentStop` is
not used for task closure because the event does not prove successful
completion.

The explicit worktree adapter cannot move an already-running CLI/local session
into the returned path. Continue in a native Codex Worktree task or reopen that
path as the workspace. Explicit removal requires prior user approval, a
harness-owned marker in the shared Git directory, a clean worktree, and
`confirmed: true`; it never force-removes a worktree.

## Agent synchronization

Four specialist Claude agents are translated without changing their instruction
bodies. The three `codex-*` bridge agents are converted to native Codex roles so
they do not recursively invoke another Codex process. Their names remain stable
for existing skills.

```bash
bun run sync:codex-agents
bun run check:codex-agents
bun run check:codex-rules
```

After installing or changing command hooks, review and trust their current hash
with `/hooks` in Codex CLI or the Hooks screen in the app. Do not bypass hook
trust persistently.
