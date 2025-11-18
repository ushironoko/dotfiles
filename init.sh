#!/bin/bash

# Dotfiles initial setup script
# This script installs mise and mise-managed tools, then runs the initial dotfiles installation

set -e

# Diagnostic mode
if [ "$1" = "--check" ] || [ "$1" = "--diagnose" ]; then
    echo "🔍 Dotfiles Environment Diagnostics"
    echo "=================================="
    echo ""

    echo "📍 Binary locations:"
    echo "  ~/.local/bin/mise: $([ -f "$HOME/.local/bin/mise" ] && echo "✅ exists" || echo "❌ missing")"

    # Check ~/.bun more intelligently
    if [ -d "$HOME/.bun/bin" ]; then
        echo "  ~/.bun/bin: ⚠️  exists (conflicts with mise-managed bun)"
    elif [ -d "$HOME/.bun" ]; then
        echo "  ~/.bun: ℹ️  exists (cache only, normal for mise)"
    else
        echo "  ~/.bun: ✅ not present"
    fi
    echo ""

    echo "🔧 Command availability:"
    echo "  mise: $(command -v mise &> /dev/null && echo "✅ $(which mise)" || echo "❌ not found in PATH")"
    echo "  bun: $(command -v bun &> /dev/null && echo "✅ $(which bun)" || echo "❌ not found in PATH")"
    echo "  node: $(command -v node &> /dev/null && echo "✅ $(which node)" || echo "❌ not found in PATH")"
    echo ""

    echo "🛤️  PATH configuration:"
    echo "  ~/.local/bin in PATH: $(echo "$PATH" | grep -q "$HOME/.local/bin" && echo "✅ yes" || echo "❌ no")"
    echo "  mise shims in PATH: $(echo "$PATH" | grep -q "$HOME/.local/share/mise/shims" && echo "✅ yes" || echo "❌ no")"
    echo ""

    MISE_ACTIVATED=false
    if command -v mise &> /dev/null; then
        echo "📦 mise status:"
        echo "  Version: $(mise --version 2>&1)"
        echo ""
        echo "  Installed tools:"
        mise list 2>&1 | sed 's/^/    /'
        echo ""
        echo "  Doctor output:"
        # mise doctor returns non-zero exit code when there are warnings
        # Use || true to prevent script from exiting due to set -e
        DOCTOR_OUTPUT=$(mise doctor 2>&1 || true)
        echo "$DOCTOR_OUTPUT" | sed 's/^/    /'

        # Check if mise is activated
        if echo "$DOCTOR_OUTPUT" | grep -q "activated: yes"; then
            MISE_ACTIVATED=true
        fi
    fi

    echo ""
    echo "💡 Recommendations:"

    RECOMMENDATIONS_SHOWN=false

    if ! command -v mise &> /dev/null; then
        if [ -f "$HOME/.local/bin/mise" ]; then
            echo "  • mise is installed but not in PATH"
            if [[ "$SHELL" == *"zsh"* ]]; then
                echo "    Run: source ~/.zshrc"
            elif [[ "$SHELL" == *"bash"* ]]; then
                echo "    Run: source ~/.bashrc"
            else
                echo "    Add to your shell config: export PATH=\"\$HOME/.local/bin:\$PATH\""
            fi
            RECOMMENDATIONS_SHOWN=true
        else
            echo "  • mise is not installed. Run ./init.sh to install"
            RECOMMENDATIONS_SHOWN=true
        fi
    elif [ "$MISE_ACTIVATED" = false ]; then
        echo "  • mise is not activated in your shell"
        if [[ "$SHELL" == *"zsh"* ]]; then
            echo "    Run: source ~/.zshrc"
        elif [[ "$SHELL" == *"bash"* ]]; then
            echo "    Run: source ~/.bashrc"
        else
            echo "    Or run: exec \$SHELL"
        fi
        RECOMMENDATIONS_SHOWN=true
    fi

    if [ -d "$HOME/.bun/bin" ]; then
        echo "  • Remove conflicting ~/.bun/bin directory: rm -rf ~/.bun"
        RECOMMENDATIONS_SHOWN=true
    fi

    if [ "$RECOMMENDATIONS_SHOWN" = false ]; then
        echo "  ✅ No issues found! Your environment is properly configured."
    fi

    exit 0
fi

echo "🚀 Dotfiles Initial Setup"
echo ""

# Define mise binary location
MISE_BIN="$HOME/.local/bin/mise"

# Add ~/.local/bin to PATH if not already present (for current session)
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    export PATH="$HOME/.local/bin:$PATH"
fi

# Check if mise is installed
if ! command -v mise &> /dev/null; then
    # Check if mise binary exists but is not in PATH
    if [ -f "$MISE_BIN" ]; then
        echo "⚠️  mise binary found at $MISE_BIN but not in PATH"
        echo "   Adding to current session..."
        export PATH="$HOME/.local/bin:$PATH"
    else
        echo "🔧 mise is not installed. Installing mise..."

        # Install mise with error checking
        if ! curl -fsSL https://mise.jdx.dev/install.sh | sh; then
            echo "❌ Failed to install mise"
            echo "   Please check your internet connection and try again"
            echo "   Or install manually: https://mise.jdx.dev/getting-started.html"
            exit 1
        fi

        # Verify installation succeeded
        if [ ! -f "$MISE_BIN" ]; then
            echo "❌ mise installation completed but binary not found at $MISE_BIN"
            echo "   Please check the installation logs above for errors"
            exit 1
        fi

        # Add mise to current shell session
        export PATH="$HOME/.local/bin:$PATH"

        echo "✅ mise installed successfully at $MISE_BIN"
        echo ""

        # Set flag to indicate mise was just installed
        MISE_JUST_INSTALLED=1
    fi
fi

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Change to script directory
cd "$SCRIPT_DIR"

# Verify mise is working
echo "🔍 Verifying mise installation..."
if ! mise --version &> /dev/null; then
    echo "❌ mise is installed but not working correctly"
    echo "   Binary location: $MISE_BIN"
    echo "   PATH: $PATH"
    echo ""
    echo "Please run: source ~/.zshrc  # or ~/.bashrc for bash"
    echo "Then try again"
    exit 1
fi

echo "✅ mise version: $(mise --version)"
echo ""

# Run mise doctor for detailed diagnostics
echo "🔍 Running mise doctor..."
if mise doctor; then
    echo "✅ mise doctor passed"
else
    echo "⚠️  mise doctor reported warnings (this may be okay)"
    echo "   You can check 'mise doctor' output above for details"
fi
echo ""

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
# Note: We need to use the config file from this repo since dotfiles aren't symlinked yet
MISE_CONFIG="$SCRIPT_DIR/config/mise/config.toml"

if [ ! -f "$MISE_CONFIG" ]; then
    echo "❌ mise config file not found at: $MISE_CONFIG"
    exit 1
fi

echo "📦 Installing mise-managed tools..."
echo "   Using config: $MISE_CONFIG"
echo "   This may take several minutes..."
echo ""

# Use the config file from this repository
if MISE_CONFIG_DIR="$SCRIPT_DIR/config/mise" mise install; then
    echo "✅ All mise tools installed successfully"
else
    echo "⚠️  Some mise tools may have failed to install"
    echo "   Checking which tools are available..."
    echo ""
    MISE_CONFIG_DIR="$SCRIPT_DIR/config/mise" mise list
    echo ""
    echo "   You can manually install missing tools later with: mise install"
fi

echo ""

# Regenerate shims after installation
echo "🔄 Regenerating mise shims..."
mise reshim

# Add mise shims to PATH for current session
export PATH="$HOME/.local/share/mise/shims:$PATH"

echo ""
echo "📋 Installed tools:"
MISE_CONFIG_DIR="$SCRIPT_DIR/config/mise" mise list
echo ""

# Check for existing Bun installation outside of mise
if [[ -d "$HOME/.bun/bin" ]]; then
    # Real conflict: standalone Bun installation with bin directory
    echo "⚠️  Standalone Bun installation detected at ~/.bun/bin"
    echo "   This will conflict with mise-managed Bun."
    echo ""
    read -p "Remove standalone Bun installation? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "🗑️  Removing ~/.bun..."
        rm -rf "$HOME/.bun"
        echo "✅ Removed ~/.bun"
    else
        echo "⚠️  Continuing with conflicting Bun installation"
        echo "   You may experience PATH conflicts. Consider removing it later with:"
        echo "   rm -rf ~/.bun"
    fi
    echo ""
elif [[ -d "$HOME/.bun" ]]; then
    # Only cache directory exists - this is normal for mise-managed bun
    echo "ℹ️  ~/.bun directory exists (used by mise for package caching)"
fi

# Verify bun is available using mise
echo "🔍 Verifying bun installation..."
if MISE_CONFIG_DIR="$SCRIPT_DIR/config/mise" mise which bun &> /dev/null; then
    BUN_PATH=$(MISE_CONFIG_DIR="$SCRIPT_DIR/config/mise" mise which bun)
    echo "✅ Bun is available at: $BUN_PATH"
else
    echo "❌ Bun installation failed"
    echo ""
    echo "Debug information:"
    echo "  PATH: $PATH"
    echo "  Shims directory: $HOME/.local/share/mise/shims"
    echo "  Shims directory exists: $([ -d "$HOME/.local/share/mise/shims" ] && echo "yes" || echo "no")"
    echo "  Shims directory contents:"
    ls -la "$HOME/.local/share/mise/shims" 2>&1 | sed 's/^/    /' || echo "    (directory not accessible)"
    echo ""
    echo "Installed tools:"
    MISE_CONFIG_DIR="$SCRIPT_DIR/config/mise" mise list 2>&1 | sed 's/^/  /'
    echo ""
    echo "Please check the output above and try running: mise doctor"
    exit 1
fi

# Install Node.js dependencies using mise-managed bun
echo ""
echo "📦 Installing Node.js dependencies..."
"$BUN_PATH" install

# Run the installation
echo ""
echo "🔗 Installing dotfiles..."
echo "   (Existing files will be backed up automatically)"
"$BUN_PATH" run src/index.ts install --force "$@"

echo ""
echo "✨ Dotfiles setup complete!"
echo ""
echo "📝 Next steps:"
echo ""

# Detect current shell and provide appropriate instructions
if [[ "$SHELL" == *"zsh"* ]]; then
    echo "1. Reload your zsh configuration:"
    echo "   source ~/.zshrc"
    echo ""
    echo "   Or start a fresh shell:"
    echo "   exec \$SHELL"
elif [[ "$SHELL" == *"bash"* ]]; then
    echo "1. Reload your bash configuration:"
    echo "   source ~/.bashrc"
    echo ""
    echo "   Or start a fresh shell:"
    echo "   exec \$SHELL"
else
    echo "1. Reload your shell configuration:"
    echo "   exec \$SHELL  # or open a new terminal"
fi

echo ""
echo "2. Verify everything is working:"
echo "   ./init.sh --check  # Run diagnostics"
echo ""
echo "Then you can use:"
echo "  dotfiles install    # Install/update dotfiles"
echo "  dotfiles restore    # Restore from backup"
echo "  dotfiles list       # List managed files"
echo ""
echo "  mise ls             # List installed tools"
echo "  mise doctor         # Check mise health"
echo "  mise install        # Install/update tools"
echo ""
echo "💡 Troubleshooting:"
echo "  If commands are not found, run: ./init.sh --check"