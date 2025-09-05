#!/bin/bash

# Dotfiles Backup Restoration Script
# This script restores backed up dotfiles from a backup directory

BACKUP_BASE_DIR="$HOME/.dotfiles_backup"

# Function to list available backups
list_backups() {
    echo "Available backups:"
    echo ""
    
    if [ ! -d "$BACKUP_BASE_DIR" ]; then
        echo "No backup directory found at $BACKUP_BASE_DIR"
        return 1
    fi
    
    local backups=($(ls -1d "$BACKUP_BASE_DIR"/*/ 2>/dev/null | sort -r))
    
    if [ ${#backups[@]} -eq 0 ]; then
        echo "No backups found"
        return 1
    fi
    
    local i=1
    for backup in "${backups[@]}"; do
        local backup_name=$(basename "$backup")
        local backup_date=$(echo "$backup_name" | sed 's/\([0-9]\{4\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)_\([0-9]\{2\}\)\([0-9]\{2\}\)\([0-9]\{2\}\)/\1-\2-\3 \4:\5:\6/')
        echo "  [$i] $backup_date (directory: $backup_name)"
        ((i++))
    done
    
    echo ""
    return 0
}

# Function to restore files from backup
restore_backup() {
    local backup_dir="$1"
    
    if [ ! -d "$backup_dir" ]; then
        echo "Error: Backup directory not found: $backup_dir"
        exit 1
    fi
    
    echo "Restoring from backup: $(basename "$backup_dir")"
    echo ""
    
    # Find all files in the backup directory
    while IFS= read -r -d '' file; do
        # Calculate the target path by removing the backup directory prefix
        local relative_path="${file#$backup_dir/}"
        local target_path="$HOME/$relative_path"
        
        echo "Restoring: $relative_path"
        
        # Create parent directory if needed
        mkdir -p "$(dirname "$target_path")"
        
        # Remove existing file/symlink
        if [ -e "$target_path" ] || [ -L "$target_path" ]; then
            rm -rf "$target_path"
        fi
        
        # Copy the backed up file
        cp -r "$file" "$target_path"
        echo "  Restored to: $target_path"
        
    done < <(find "$backup_dir" -mindepth 1 -type f -print0 2>/dev/null)
    
    # Also handle directories
    while IFS= read -r -d '' dir; do
        # Calculate the target path by removing the backup directory prefix
        local relative_path="${dir#$backup_dir/}"
        local target_path="$HOME/$relative_path"
        
        # Skip if this is a file (already handled above)
        if [ -f "$dir" ]; then
            continue
        fi
        
        # Only restore empty directories or directories with special files
        if [ "$(ls -A "$dir" 2>/dev/null)" ]; then
            continue
        fi
        
        echo "Restoring empty directory: $relative_path"
        mkdir -p "$target_path"
        
    done < <(find "$backup_dir" -mindepth 1 -type d -print0 2>/dev/null)
    
    echo ""
    echo "Restoration complete!"
}

# Main script
echo "Dotfiles Backup Restoration Tool"
echo "================================="
echo ""

# Check if a specific backup directory was provided as argument
if [ -n "$1" ]; then
    if [ "$1" == "--help" ] || [ "$1" == "-h" ]; then
        echo "Usage: $0 [backup_directory]"
        echo ""
        echo "Options:"
        echo "  backup_directory  Full path to backup directory or backup timestamp"
        echo "                    (e.g., 20250905_125854)"
        echo ""
        echo "If no directory is specified, you will be prompted to choose from available backups."
        exit 0
    fi
    
    # Check if it's a full path or just a timestamp
    if [[ "$1" == /* ]]; then
        BACKUP_DIR="$1"
    else
        BACKUP_DIR="$BACKUP_BASE_DIR/$1"
    fi
    
    if [ ! -d "$BACKUP_DIR" ]; then
        echo "Error: Specified backup directory not found: $BACKUP_DIR"
        exit 1
    fi
    
    echo "Selected backup: $(basename "$BACKUP_DIR")"
    echo ""
    read -p "Are you sure you want to restore this backup? This will overwrite existing files! (y/N): " confirm
    
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        restore_backup "$BACKUP_DIR"
    else
        echo "Restoration cancelled."
    fi
else
    # Interactive mode - list backups and let user choose
    if ! list_backups; then
        exit 1
    fi
    
    # Get list of backups for selection
    backups=($(ls -1d "$BACKUP_BASE_DIR"/*/ 2>/dev/null | sort -r))
    
    read -p "Select backup number to restore (or 'q' to quit): " selection
    
    if [ "$selection" == "q" ] || [ "$selection" == "Q" ]; then
        echo "Restoration cancelled."
        exit 0
    fi
    
    # Validate selection
    if ! [[ "$selection" =~ ^[0-9]+$ ]]; then
        echo "Error: Invalid selection"
        exit 1
    fi
    
    index=$((selection - 1))
    if [ $index -lt 0 ] || [ $index -ge ${#backups[@]} ]; then
        echo "Error: Selection out of range"
        exit 1
    fi
    
    BACKUP_DIR="${backups[$index]}"
    
    echo ""
    echo "Selected: $(basename "$BACKUP_DIR")"
    echo ""
    echo "WARNING: This will overwrite the following files:"
    echo ""
    
    # Show files that will be restored
    while IFS= read -r -d '' file; do
        local relative_path="${file#$BACKUP_DIR/}"
        echo "  ~/$relative_path"
    done < <(find "$BACKUP_DIR" -mindepth 1 -type f -print0 2>/dev/null | head -z -20)
    
    local file_count=$(find "$BACKUP_DIR" -mindepth 1 -type f 2>/dev/null | wc -l)
    if [ "$file_count" -gt 20 ]; then
        echo "  ... and $((file_count - 20)) more files"
    fi
    
    echo ""
    read -p "Are you sure you want to restore this backup? (y/N): " confirm
    
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        restore_backup "$BACKUP_DIR"
    else
        echo "Restoration cancelled."
    fi
fi