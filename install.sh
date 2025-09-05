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
for file in agents commands CLAUDE.md settings.json; do
    create_symlink "$DOTFILES_DIR/claude/.claude/$file" "$HOME/.claude/$file"
done

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