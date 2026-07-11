import { defineConfig } from "./src/types/config";

const codexAgentFiles = [
  "codex-poc.toml",
  "codex-reviewer.toml",
  "codex-runner.toml",
  "comment-reviewer.toml",
  "rust-reviewer.toml",
  "similarity.toml",
  "tdd-reviewer.toml",
];

const codexHookFiles = [
  "lib/statusline_checks_lib.sh",
  "lib/statusline_checks_run.sh",
  "lib/trusted_project.sh",
  "permission_request/asuku.sh",
  "post_tool_use/coding_cycle.sh",
  "post_tool_use/type_safety_check.sh",
  "pre_tool_use/bit_command_policy.sh",
  "pre_tool_use/npm_script_preference.sh",
  "session_start/statusline_checks.sh",
  "stop/asuku_notification.sh",
  "stop/statusline_checks.sh",
  "task_completed/bit_issue_update.sh",
  "user_prompt_submit/ultracode_context.sh",
  "worktree/create.sh",
  "worktree/remove.sh",
];

const sharedAgentSkills = [
  "create-pr",
  "dig",
  "empirical-prompt-tuning",
  "html-to-svg",
  "octorus",
  "output-learn",
  "plan-review",
  "restoring-session",
  "smart-compact",
  "start-work",
  "write-session",
];

export default defineConfig({
  mappings: [
    {
      source: "./shell/.bashrc",
      target: "~/.bashrc",
      type: "file",
    },
    {
      source: "./shell/.profile",
      target: "~/.profile",
      type: "file",
    },
    {
      source: "./shell/.zshrc",
      target: "~/.zshrc",
      type: "file",
    },
    {
      source: "./git/.gitconfig",
      target: "~/.gitconfig",
      type: "file",
    },
    {
      source: "./claude/.claude",
      target: "~/.claude",
      type: "selective",
      include: [
        "agents",
        "hooks",
        "skills",
        "CLAUDE.md",
        "settings.json",
        "statusline.sh",
      ],
      permissions: {
        "statusline.sh": "755",
        "hooks/post_tool_use/coding_cycle.sh": "755",
      },
    },
    {
      // codex rewrites this file at runtime, filling it with machine-local
      // state (absolute paths: [projects.*] trust, [mcp_servers.*], marketplace
      // sources, notify, perPath). The codex-scrub git clean filter
      // (.gitattributes + scripts/setup-git-filters.sh) drops anything with a
      // quoted absolute path at commit time, so only portable settings are versioned.
      source: "./codex/config.toml",
      target: "~/.codex/config.toml",
      type: "file",
    },
    {
      source: "./codex/AGENTS.md",
      target: "~/.codex/AGENTS.md",
      type: "file",
    },
    {
      source: "./codex/agents",
      target: "~/.codex/agents",
      type: "selective",
      include: codexAgentFiles,
    },
    {
      source: "./codex/hooks.json",
      target: "~/.codex/hooks.json",
      type: "file",
    },
    {
      source: "./codex/hooks",
      target: "~/.codex/hooks",
      type: "selective",
      include: codexHookFiles,
    },
    {
      source: "./codex/rules/harness.rules",
      target: "~/.codex/rules/harness.rules",
      type: "file",
    },
    {
      // Codex discovers personal skills under ~/.agents/skills and follows
      // symlinked skill directories. Reuse the Claude skill source so both
      // harnesses stay in sync without replacing Codex's bundled skills.
      source: "./claude/.claude/skills",
      target: "~/.agents/skills",
      type: "selective",
      include: sharedAgentSkills,
    },
    {
      source: "./config/git",
      target: "~/.config/git",
      type: "directory",
    },
    {
      source: "./config/starship.toml",
      target: "~/.config/starship.toml",
      type: "file",
    },
    {
      source: "./config/mise",
      target: "~/.config/mise",
      type: "directory",
    },
    {
      source: "./config/ghq",
      target: "~/.config/ghq",
      type: "directory",
    },
    {
      source: "./config/ghostty",
      target: "~/.config/ghostty",
      type: "directory",
    },
    {
      source: "./config/helix",
      target: "~/.config/helix",
      type: "directory",
    },
    {
      source: "./config/yazi",
      target: "~/.config/yazi",
      type: "directory",
    },
    {
      source: "./config/octorus",
      target: "~/.config/octorus",
      type: "directory",
    },
    {
      source: "./config/zellij",
      target: "~/.config/zellij",
      type: "directory",
    },
    {
      source: "./bin/dotfiles",
      target: "~/.local/bin/dotfiles",
      type: "file",
    },
    {
      source: "./bin/svgshow",
      target: "~/.local/bin/svgshow",
      type: "file",
    },
    {
      source: "./config/abbrs",
      target: "~/.config/abbrs",
      type: "directory",
    },
  ],
  backup: {
    directory: "~/.dotfiles_backup",
    keepLast: 10,
    compress: false,
  },
  mcp: {
    sourceFile: "./claude/dot_claude.json",
    targetFile: "~/.claude.json",
    mergeKey: "mcpServers",
  },

  // Environment-specific overrides
  $development: {
    backup: {
      directory: "~/.dotfiles_backup",
      keepLast: 20, // Keep more backups in development
      compress: false,
    },
  },

  $production: {
    backup: {
      directory: "~/.dotfiles_backup",
      keepLast: 10,
      compress: true, // Enable compression in production
    },
  },

  $test: {
    backup: {
      directory: "/tmp/dotfiles_backup_test",
      keepLast: 5,
      compress: false,
    },
  },
});
