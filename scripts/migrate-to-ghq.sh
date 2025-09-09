#!/bin/bash

# ghq Migration Script
# Migrates existing Git repositories to ghq structure
# Usage: ./migrate-to-ghq.sh [--dry-run] [--symlink] [source_directory]

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default values
DRY_RUN=false
CREATE_SYMLINKS=false
SOURCE_DIR="${1:-$HOME/dev}"
GHQ_ROOT="${GHQ_ROOT:-$HOME/ghq}"
PROCESSED_COUNT=0
SKIPPED_COUNT=0
ERROR_COUNT=0

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --symlink)
      CREATE_SYMLINKS=true
      shift
      ;;
    --help)
      echo "Usage: $0 [--dry-run] [--symlink] [source_directory]"
      echo ""
      echo "Options:"
      echo "  --dry-run    Show what would be done without making changes"
      echo "  --symlink    Create symlinks in original location after migration"
      echo "  --help       Show this help message"
      echo ""
      echo "Arguments:"
      echo "  source_directory    Directory containing repositories to migrate (default: ~/dev)"
      echo ""
      echo "Environment:"
      echo "  GHQ_ROOT    Target ghq root directory (default: ~/ghq)"
      exit 0
      ;;
    *)
      SOURCE_DIR="$1"
      shift
      ;;
  esac
done

# Functions
log_info() {
  echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
  echo -e "${GREEN}✓${NC} $1"
}

log_warning() {
  echo -e "${YELLOW}⚠${NC} $1"
}

log_error() {
  echo -e "${RED}✗${NC} $1"
}

# Get repository host and path from git remote
get_repo_info() {
  local repo_path="$1"
  local remote_url
  
  # Try to get origin remote URL
  remote_url=$(cd "$repo_path" && git remote get-url origin 2>/dev/null || echo "")
  
  if [[ -z "$remote_url" ]]; then
    # Try any remote if origin doesn't exist
    remote_url=$(cd "$repo_path" && git remote -v | head -1 | awk '{print $2}' 2>/dev/null || echo "")
  fi
  
  if [[ -z "$remote_url" ]]; then
    echo ""
    return
  fi
  
  # Parse URL to get host and path
  # Handle different URL formats
  if [[ "$remote_url" =~ ^https?://([^/]+)/(.+)(\.git)?$ ]]; then
    # HTTPS URL
    local host="${BASH_REMATCH[1]}"
    local path="${BASH_REMATCH[2]}"
    path="${path%.git}"  # Remove .git suffix if present
    echo "$host/$path"
  elif [[ "$remote_url" =~ ^git@([^:]+):(.+)(\.git)?$ ]]; then
    # SSH URL
    local host="${BASH_REMATCH[1]}"
    local path="${BASH_REMATCH[2]}"
    path="${path%.git}"  # Remove .git suffix if present
    echo "$host/$path"
  elif [[ "$remote_url" =~ ^([^@]+)@([^:]+):(.+)(\.git)?$ ]]; then
    # Other SSH format
    local host="${BASH_REMATCH[2]}"
    local path="${BASH_REMATCH[3]}"
    path="${path%.git}"  # Remove .git suffix if present
    echo "$host/$path"
  else
    echo ""
  fi
}

# Check if directory is a git repository
is_git_repo() {
  [[ -d "$1/.git" ]] || [[ -f "$1/.git" ]]  # .git can be a file for submodules
}

# Migrate a single repository
migrate_repo() {
  local repo_path="$1"
  local repo_name=$(basename "$repo_path")
  
  if ! is_git_repo "$repo_path"; then
    log_warning "Skipping $repo_name: Not a git repository"
    ((SKIPPED_COUNT++)) || true
    return
  fi
  
  local repo_info=$(get_repo_info "$repo_path")
  
  if [[ -z "$repo_info" ]]; then
    log_warning "Skipping $repo_name: Could not determine remote URL"
    ((SKIPPED_COUNT++)) || true
    return
  fi
  
  local target_path="$GHQ_ROOT/$repo_info"
  
  # Check if target already exists
  if [[ -e "$target_path" ]]; then
    log_warning "Skipping $repo_name: Already exists at $target_path"
    ((SKIPPED_COUNT++)) || true
    return
  fi
  
  log_info "Migrating: $repo_path -> $target_path"
  
  if [[ "$DRY_RUN" == "false" ]]; then
    # Create target directory
    mkdir -p "$(dirname "$target_path")"
    
    # Move repository
    mv "$repo_path" "$target_path"
    
    # Create symlink if requested
    if [[ "$CREATE_SYMLINKS" == "true" ]]; then
      ln -s "$target_path" "$repo_path"
      log_info "Created symlink: $repo_path -> $target_path"
    fi
    
    log_success "Migrated: $repo_name"
  else
    log_info "[DRY-RUN] Would migrate: $repo_path -> $target_path"
    if [[ "$CREATE_SYMLINKS" == "true" ]]; then
      log_info "[DRY-RUN] Would create symlink: $repo_path -> $target_path"
    fi
  fi
  
  ((PROCESSED_COUNT++)) || true
}

# Main execution
main() {
  log_info "Starting ghq migration"
  log_info "Source directory: $SOURCE_DIR"
  log_info "Target ghq root: $GHQ_ROOT"
  
  if [[ "$DRY_RUN" == "true" ]]; then
    log_warning "Running in DRY-RUN mode - no changes will be made"
  fi
  
  if [[ "$CREATE_SYMLINKS" == "true" ]]; then
    log_info "Will create symlinks in original locations"
  fi
  
  echo ""
  
  # Check if source directory exists
  if [[ ! -d "$SOURCE_DIR" ]]; then
    log_error "Source directory does not exist: $SOURCE_DIR"
    exit 1
  fi
  
  # Check if ghq is installed (try mise first, then regular path)
  if command -v mise &> /dev/null; then
    # Activate mise to get ghq in PATH
    eval "$(mise activate bash)"
  fi
  
  if ! command -v ghq &> /dev/null; then
    log_warning "ghq is not installed or not in PATH"
    echo "Install ghq first with: mise use -g ghq@latest"
    echo "Or install from: https://github.com/x-motemen/ghq"
    exit 1
  fi
  
  # Create ghq root if it doesn't exist
  if [[ ! -d "$GHQ_ROOT" ]]; then
    if [[ "$DRY_RUN" == "false" ]]; then
      mkdir -p "$GHQ_ROOT"
      log_info "Created ghq root directory: $GHQ_ROOT"
    else
      log_info "[DRY-RUN] Would create ghq root directory: $GHQ_ROOT"
    fi
  fi
  
  # Find all directories in source (max depth 2 to avoid deep scanning)
  log_info "Scanning for repositories..."
  echo ""
  
  # Process immediate subdirectories
  for dir in "$SOURCE_DIR"/*; do
    if [[ -d "$dir" ]]; then
      migrate_repo "$dir"
    fi
  done
  
  # Also check one level deeper (for organized structures like ~/dev/work/*)
  for parent in "$SOURCE_DIR"/*; do
    if [[ -d "$parent" ]] && [[ ! -L "$parent" ]]; then  # Skip symlinks
      for dir in "$parent"/*; do
        if [[ -d "$dir" ]] && is_git_repo "$dir"; then
          migrate_repo "$dir"
        fi
      done
    fi
  done
  
  echo ""
  log_info "Migration complete!"
  log_success "Processed: $PROCESSED_COUNT repositories"
  
  if [[ $SKIPPED_COUNT -gt 0 ]]; then
    log_warning "Skipped: $SKIPPED_COUNT items"
  fi
  
  if [[ $ERROR_COUNT -gt 0 ]]; then
    log_error "Errors: $ERROR_COUNT"
  fi
  
  if [[ "$DRY_RUN" == "true" ]]; then
    echo ""
    log_info "This was a dry run. To perform actual migration, run without --dry-run"
  fi
  
  # Show next steps
  echo ""
  log_info "Next steps:"
  echo "  1. Verify migrated repositories: ghq list"
  echo "  2. Update your shell configuration if needed"
  echo "  3. Test repository access with: gcd (if you have ghq functions set up)"
  
  if [[ "$CREATE_SYMLINKS" == "false" ]] && [[ "$DRY_RUN" == "false" ]]; then
    echo ""
    log_warning "Note: Original directories have been moved. Update any scripts or"
    log_warning "bookmarks that reference the old paths, or run with --symlink to"
    log_warning "create compatibility symlinks."
  fi
}

# Run main function
main