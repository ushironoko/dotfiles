import { defineConfig } from "./src/types/config";

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
        "commands",
        "hooks",
        "CLAUDE.md",
        "settings.json",
        "statusline.sh",
      ],
      permissions: {
        "statusline.sh": "755",
        "hooks/pre_tool_use/no_default_web_fetch.sh": "755",
      },
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
      source: "./bin/dotfiles",
      target: "~/.local/bin/dotfiles",
      type: "file",
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
