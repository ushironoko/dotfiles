#!/bin/bash

# Dotfiles initial setup script
# This script installs mise and mise-managed tools, then runs the initial dotfiles installation

set -e

echo "🚀 Dotfiles Initial Setup"
echo ""

# Check if mise is installed
if ! command -v mise &> /dev/null; then
    echo "🔧 mise is not installed. Installing mise..."
    curl -fsSL https://mise.jdx.dev/install.sh | sh
    
    # Add mise to current shell session
    export PATH="$HOME/.local/bin:$PATH"
    
    echo "✅ mise installed successfully"
    echo ""
    
    # Set flag to indicate mise was just installed
    MISE_JUST_INSTALLED=1
fi

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Change to script directory
cd "$SCRIPT_DIR"

# Run mise doctor to verify installation
echo "🔍 Verifying mise installation..."
mise doctor || true  # Continue even if doctor reports warnings

# Note: mise activation is already configured in shell RC files
# But we need to ensure mise is available in current session if just installed
if [ -n "$MISE_JUST_INSTALLED" ]; then
    echo "⚠️  mise was just installed. Please restart your shell or run:"
    echo "   exec \$SHELL"
    echo ""
    echo "Then re-run this script to continue with tool installation."
    exit 0
fi

# Install mise-managed tools (including bun)
echo "📦 Installing mise-managed tools..."
mise install || true  # Continue even if some tools fail to install

echo ""

# Add mise shims to PATH for current session
export PATH="$HOME/.local/share/mise/shims:$PATH"

# Check for existing Bun installation outside of mise
if [[ -d "$HOME/.bun" ]]; then
    echo "⚠️  Existing Bun installation detected at ~/.bun"
    echo "   This may conflict with mise-managed Bun."
    echo "   Consider removing it with: rm -rf ~/.bun"
    echo "   Also check your shell config for Bun-related PATH exports."
    echo ""
    # Continue with warning instead of exiting
fi

# Verify bun is available
if ! command -v bun &> /dev/null; then
    echo "❌ Bun installation failed or not available in PATH"
    echo "   Please check 'mise ls' and ensure bun is installed"
    exit 1
fi

echo "✅ Bun is available at: $(which bun)"

# Install Node.js dependencies using mise-managed bun
echo "📦 Installing Node.js dependencies..."
bun install

# Run the installation
echo ""
echo "🔗 Installing dotfiles..."
bun run src/index.ts install "$@"

echo ""
echo "✨ Dotfiles setup complete!"
echo ""
echo "📝 Next steps:"
echo ""
echo "1. Make sure ~/.local/bin is in your PATH:"
echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
echo ""
echo "2. Reload your shell to activate mise:"
echo "   exec \$SHELL  # or open a new terminal"
echo ""
echo "Then you can use:"
echo "  dotfiles install    # Install/update dotfiles"
echo "  dotfiles restore    # Restore from backup"
echo "  dotfiles list       # List managed files"
echo ""
echo "  mise ls             # List installed tools"
echo "  mise doctor         # Check mise health"
echo "  mise install        # Install/update tools"