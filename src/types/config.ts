interface DotfilesConfig {
  mappings: FileMapping[];
  backup: BackupConfig;
  mcp?: MCPConfig;
  // Environment-specific overrides
  $development?: Partial<DotfilesConfig>;
  $production?: Partial<DotfilesConfig>;
  $test?: Partial<DotfilesConfig>;
}

interface FileMapping {
  source: string;
  target: string;
  type: "file" | "directory" | "selective";
  include?: string[];
  files?: string[]; // Alternative to include for backward compatibility
  exclude?: string[];
  permissions?: string | Record<string, string>;
}

interface BackupConfig {
  directory: string;
  keepLast?: number;
  compress?: boolean;
}

interface BackupInfo {
  name: string;
  path: string;
  date: Date;
}

interface MCPConfig {
  sourceFile: string;
  targetFile: string;
  mergeKey: string;
  backupDir?: string;
}

interface SymlinkOptions {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
}

interface SymlinkStatus {
  exists: boolean;
  isSymlink: boolean;
  targetExists?: boolean;
  pointsToCorrectTarget?: boolean;
}

interface RestoreOptions {
  backup?: string;
  interactive?: boolean;
  partial?: string[];
  dryRun?: boolean;
  verbose?: boolean;
}

interface InstallOptions {
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  config?: string;
  select?: boolean;
}

// Helper function for type-safe config definition
const defineConfig = (config: DotfilesConfig): DotfilesConfig => {
  return config;
};

export {
  defineConfig,
  type DotfilesConfig,
  type FileMapping,
  type BackupConfig,
  type BackupInfo,
  type MCPConfig,
  type SymlinkOptions,
  type SymlinkStatus,
  type RestoreOptions,
  type InstallOptions,
};
