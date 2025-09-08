export const LogMessages = {
  // Installation messages
  STARTING_INSTALLATION: "Starting dotfiles installation...",
  CREATING_BACKUP: "Creating backup of existing files...",
  REMOVING_DESELECTED: "Removing deselected symlinks...",
  CREATING_SYMLINKS: "Creating symlinks...",
  MERGING_MCP: "Merging MCP server configuration...",
  INSTALLATION_COMPLETE: "Dotfiles installation complete!",
  DRY_RUN_NOTICE: "This was a dry run - no changes were made",

  // Restoration messages
  STARTING_RESTORATION: "Starting dotfiles restoration...",
  NO_BACKUPS_FOUND: "No backups found",
  AVAILABLE_BACKUPS: "Available backups:",
  RESTORATION_CANCELLED: "Restoration cancelled",
  INVALID_SELECTION: "Invalid selection",
  NO_BACKUP_SPECIFIED: "No backup specified",
  RESTORATION_COMPLETE: "Restoration complete!",

  // Selection messages
  ITEMS_TO_INSTALL: "Items to install:",
  ITEMS_TO_REMOVE: "Items to remove:",

  // Shell reload instructions
  RELOAD_INSTRUCTIONS: {
    HEADER: "To reload your shell configuration, run:",
    BASH: "  source ~/.bashrc  # for Bash",
    ZSH: "  source ~/.zshrc   # for Zsh",
  },

  // Action messages
  action: {
    removing: (target: string) => `Removing ${target}`,
    removingSymlink: (target: string) => `Removing symlink: ${target}`,
    removingFileOrDir: (target: string) =>
      `Removing existing file/directory: ${target}`,
    creatingSymlink: (source: string, target: string) =>
      `Creating symlink ${source} -> ${target}`,
    settingPermissions: (permission: string, path: string) =>
      `Setting permissions ${permission} on ${path}`,
    backingUp: (source: string, target: string) =>
      `Backing up ${source} -> ${target}`,
    restoring: (file: string, target: string) =>
      `Restoring ${file} -> ${target}`,
    removingOldBackup: (backup: string) => `Removing old backup ${backup}`,
    mergingMcp: (source: string, target: string) =>
      `Merging MCP servers from ${source} to ${target}`,
  },

  // Warning messages
  warning: {
    symlinkExists: (target: string) => `Symlink already exists: ${target}`,
    targetExists: (target: string) =>
      `Target already exists and is not a symlink: ${target}`,
    notSymlink: (target: string) => `Target is not a symlink: ${target}`,
    targetNotFound: (target: string) => `Target does not exist: ${target}`,
    mcpSourceNotFound: (file: string) => `MCP source file not found: ${file}`,
    noMcpServers: (key: string) => `No ${key} found in source file`,
    noBackupDir: "No backup directory configured",
    restorationWarning: "WARNING: This will overwrite existing files!",
  },

  // Info messages
  info: {
    processingSelective: (target: string) =>
      `Processing selective symlinks for ${target}`,
    filesToLink: (files: string) => `  Files to link: ${files}`,
    creatingBackup: (dir: string) => `Creating backup in ${dir}`,
    restoringBackup: (name: string) => `Restoring from backup: ${name}`,
    creatingTargetFile: (file: string) => `Creating target file: ${file}`,
    foundSymlinks: (count: number) => `Found ${count} existing symlinks`,
    selectedItems: (selected: number, deselected: number) =>
      `${selected} items selected, ${deselected} items deselected`,
    groupCount: (type: string, count: number) => `  ${type}: ${count}`,
    itemWithFiles: (target: string, count: number) =>
      `    + ${target} (${count} files)`,
    itemAdd: (target: string) => `    + ${target}`,
    itemRemove: (target: string) => `    - ${target}`,
  },

  // Error messages
  error: {
    installationFailed: (message: string) => `Installation failed: ${message}`,
    restorationFailed: (message: string) => `Restoration failed: ${message}`,
    listFailed: (error: unknown) => `Failed to list dotfiles: ${error}`,
    mcpMergeFailed: (message: string) =>
      `Failed to merge MCP configuration: ${message}`,
  },

  // Success messages
  success: {
    mcpMerged: "MCP servers configuration merged successfully",
    restoreCompleted: "Restore completed",
  },

  // Debug messages
  debug: {
    skippingBackup: (source: string) =>
      `Skipping backup - file not found: ${source}`,
    noMcpTarget: "No MCP target file to backup",
    backupExists: "Backup already exists, skipping",
  },
};
