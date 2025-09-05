#!/bin/bash

# Dotfiles initial setup script
# This script installs Bun (if needed) and runs the initial dotfiles installation

set -e

echo "🚀 Dotfiles Initial Setup"
echo ""

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "📦 Bun is not installed. Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    
    # Add bun to current shell session
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"
    
    echo "✅ Bun installed successfully"
    echo ""
fi

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Change to script directory
cd "$SCRIPT_DIR"

# Install dependencies
echo "📦 Installing dependencies..."
bun install

# Run the installation
echo ""
echo "🔗 Installing dotfiles..."
bun run src/index.ts install "$@"

echo ""
echo "✨ Dotfiles setup complete!"
echo ""
echo "Make sure ~/.local/bin is in your PATH:"
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo ""
echo "Then you can use:"
echo "  dotfiles install    # Install/update dotfiles"
echo "  dotfiles restore    # Restore from backup"
echo "  dotfiles list       # List managed files"