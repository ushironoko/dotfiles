#!/bin/bash

# TypeScript version of dotfiles restoration
# This wrapper script ensures Bun is installed and runs the TypeScript implementation

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "Bun is not installed. Please install it first:"
    echo "  curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

# Get the directory of this script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Run the TypeScript implementation
cd "$SCRIPT_DIR"
bun run src/index.ts restore "$@"