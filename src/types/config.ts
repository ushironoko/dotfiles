export interface DotfilesConfig {
  mappings: FileMapping[];
  backup: BackupConfig;
  mcp?: MCPConfig;
}

export interface FileMapping {
  source: string;
  target: string;
  type: "file" | "directory" | "selective";
  include?: string[];
  files?: string[]; // Alternative to include for backward compatibility
  exclude?: string[];
  permissions?: string | { [key: string]: string };
}

export interface BackupConfig {
  directory: string;
  keepLast?: number;
  compress?: boolean;
}

export interface BackupInfo {
  name: string;
  path: string;
  date: Date;
}

export interface MCPConfig {
  sourceFile: string;
  targetFile: string;
  mergeKey: string;
  backupDir?: string;
}

export interface SymlinkOptions {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
}

export interface SymlinkStatus {
  exists: boolean;
  isSymlink: boolean;
  targetExists?: boolean;
  pointsToCorrectTarget?: boolean;
}

export interface RestoreOptions {
  backup?: string;
  interactive?: boolean;
  partial?: string[];
  dryRun?: boolean;
  verbose?: boolean;
}

export interface InstallOptions {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  config?: string;
}