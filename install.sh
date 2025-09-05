#!/bin/bash

# Dotfiles Installation Script
# This script creates symbolic links from the home directory to the dotfiles repository

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP_DIR="$HOME/.dotfiles_backup/$(date +%Y%m%d_%H%M%S)"

echo "Installing dotfiles from $DOTFILES_DIR..."

# Create backup directory
if [ ! -d "$BACKUP_DIR" ]; then
    mkdir -p "$BACKUP_DIR"
    echo "Created backup directory: $BACKUP_DIR"
fi

# Function to create symlink with backup
create_symlink() {
    local source="$1"
    local target="$2"
    
    # Create parent directory if it doesn't exist
    mkdir -p "$(dirname "$target")"
    
    # Backup existing file/directory if it exists and is not a symlink
    if [ -e "$target" ] && [ ! -L "$target" ]; then
        echo "Backing up existing $target to $BACKUP_DIR"
        # Calculate relative path from HOME for backup structure
        local relative_path="${target#$HOME/}"
        local backup_path="$BACKUP_DIR/$relative_path"
        mkdir -p "$(dirname "$backup_path")"
        cp -r "$target" "$backup_path"
        echo "  Backed up to $backup_path"
    fi
    
    # Remove existing file/directory if it exists
    if [ -e "$target" ] || [ -L "$target" ]; then
        echo "Removing existing $target"
        rm -rf "$target"
    fi
    
    # Create symlink
    ln -s "$source" "$target"
    echo "Linked $source -> $target"
}

# Function to merge mcpServers from dot_claude.json into ~/.claude.json
merge_claude_mcp_servers() {
    local dot_claude_file="$DOTFILES_DIR/claude/dot_claude.json"
    local claude_config="$HOME/.claude.json"
    
    # Check if dot_claude.json exists
    if [ ! -f "$dot_claude_file" ]; then
        echo "Warning: $dot_claude_file not found, skipping MCP servers merge"
        return
    fi
    
    # Check if ~/.claude.json exists (should be created by Claude CLI)
    if [ ! -f "$claude_config" ]; then
        echo "Error: $claude_config not found. Please ensure Claude CLI is installed first."
        return 1
    fi
    
    # Backup ~/.claude.json before modification
    if [ -f "$claude_config" ]; then
        local backup_path="$BACKUP_DIR/.claude.json"
        cp "$claude_config" "$backup_path"
        echo "Backed up $claude_config to $backup_path"
    fi
    
    # Try to use jq for merging
    if command -v jq >/dev/null 2>&1; then
        echo "Merging MCP servers from dot_claude.json into ~/.claude.json using jq..."
        # Extract mcpServers from dot_claude.json and merge into ~/.claude.json
        jq -s '.[0] * {mcpServers: .[1].mcpServers}' "$claude_config" "$dot_claude_file" > "${claude_config}.tmp" && \
        mv "${claude_config}.tmp" "$claude_config"
        echo "MCP servers configuration merged successfully"
    # Fallback to Python if jq is not available
    elif command -v python3 >/dev/null 2>&1; then
        echo "Merging MCP servers from dot_claude.json into ~/.claude.json using Python..."
        python3 - <<EOF
import json
import sys

try:
    # Read the existing ~/.claude.json
    with open('$claude_config', 'r') as f:
        claude_config = json.load(f)
    
    # Read the dot_claude.json
    with open('$dot_claude_file', 'r') as f:
        dot_claude = json.load(f)
    
    # Merge mcpServers
    claude_config['mcpServers'] = dot_claude.get('mcpServers', {})
    
    # Write back to ~/.claude.json
    with open('$claude_config', 'w') as f:
        json.dump(claude_config, f, indent=2)
    
    print("MCP servers configuration merged successfully")
except Exception as e:
    print(f"Error merging MCP servers: {e}", file=sys.stderr)
    sys.exit(1)
EOF
    else
        echo "Warning: Neither jq nor python3 found. Cannot merge MCP servers configuration."
        echo "Please install jq or python3 to enable automatic MCP servers configuration."
        return 1
    fi
}

# Shell configurations
echo "Setting up shell configurations..."
create_symlink "$DOTFILES_DIR/shell/.bashrc" "$HOME/.bashrc"
create_symlink "$DOTFILES_DIR/shell/.profile" "$HOME/.profile"
create_symlink "$DOTFILES_DIR/shell/.zshrc" "$HOME/.zshrc"

# Git configuration
echo "Setting up Git configuration..."
create_symlink "$DOTFILES_DIR/git/.gitconfig" "$HOME/.gitconfig"

# Claude configuration
echo "Setting up Claude configuration..."
# Only link essential Claude files - other files should remain in ~/.claude
for file in agents commands CLAUDE.md settings.json statusline.sh; do
    # Ensure statusline.sh has execute permissions before creating symlink
    if [ "$file" = "statusline.sh" ] && [ -f "$DOTFILES_DIR/claude/.claude/$file" ]; then
        chmod +x "$DOTFILES_DIR/claude/.claude/$file"
    fi
    create_symlink "$DOTFILES_DIR/claude/.claude/$file" "$HOME/.claude/$file"
done

# Merge MCP servers configuration from dot_claude.json
merge_claude_mcp_servers

# .config directory contents
echo "Setting up .config directory contents..."
mkdir -p "$HOME/.config"
# Only link if the directory exists in dotfiles
if [ -d "$DOTFILES_DIR/config/fish" ]; then
    create_symlink "$DOTFILES_DIR/config/fish" "$HOME/.config/fish"
fi
create_symlink "$DOTFILES_DIR/config/git" "$HOME/.config/git"
# Note: gh config contains OAuth tokens and should not be tracked in dotfiles

# Starship configuration
create_symlink "$DOTFILES_DIR/config/starship.toml" "$HOME/.config/starship.toml"

# Mise configuration
create_symlink "$DOTFILES_DIR/config/mise" "$HOME/.config/mise"

echo "Dotfiles installation complete!"
echo ""
echo "To reload your shell configuration, run:"
echo "  source ~/.bashrc  # for Bash"
echo "  source ~/.zshrc   # for Zsh"