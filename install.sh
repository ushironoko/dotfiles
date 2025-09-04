#!/bin/bash

# Dotfiles Installation Script
# This script creates symbolic links from the home directory to the dotfiles repository

DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Installing dotfiles from $DOTFILES_DIR..."

# Function to create symlink
create_symlink() {
    local source="$1"
    local target="$2"
    
    # Create parent directory if it doesn't exist
    mkdir -p "$(dirname "$target")"
    
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

echo "Dotfiles installation complete!"
echo ""
echo "To reload your shell configuration, run:"
echo "  source ~/.bashrc  # for Bash"
echo "  source ~/.zshrc   # for Zsh"