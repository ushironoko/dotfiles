import { readFile } from "fs/promises";
import { BackupConfig, DotfilesConfig, FileMapping, MCPConfig } from "../types/config";
import { expandPath } from "../utils/paths";
import { fileExists } from "../utils/fs";

const DEFAULT_KEEP_LAST = 10;

// 純粋関数：設定の検証
export const validateConfig = (config: unknown): config is DotfilesConfig => {
  const c = config as DotfilesConfig;
  
  if (!c.mappings || !Array.isArray(c.mappings)) {
    throw new Error("Invalid config: mappings must be an array");
  }

  for (const mapping of c.mappings) {
    if (!mapping.source || !mapping.target) {
      throw new Error("Invalid mapping: source and target are required");
    }

    if (!["file", "directory", "selective"].includes(mapping.type)) {
      throw new Error(`Invalid mapping type: ${mapping.type}`);
    }

    if ("selective" === mapping.type && !mapping.include) {
      throw new Error("Selective mapping requires 'include' array");
    }
  }

  if (!c.backup || !c.backup.directory) {
    throw new Error("Invalid config: backup.directory is required");
  }
  
  return true;
};

// 純粋関数：マッピングのパスを展開
export const expandMappings = (mappings: FileMapping[]): FileMapping[] =>
  mappings.map(mapping => ({
    ...mapping,
    source: expandPath(mapping.source),
    target: expandPath(mapping.target),
  }));

// 純粋関数：バックアップ設定の正規化
export const normalizeBackupConfig = (config: BackupConfig): BackupConfig => ({
  ...config,
  compress: config.compress || false,
  directory: expandPath(config.directory),
  keepLast: config.keepLast || DEFAULT_KEEP_LAST,
});

// 純粋関数：MCP設定のパスを展開
export const expandMCPConfig = (config: MCPConfig): MCPConfig => ({
  ...config,
  sourceFile: expandPath(config.sourceFile),
  targetFile: expandPath(config.targetFile),
});

// ファクトリー関数：ConfigManagerを作成
export const createConfigManager = (configPath = "./config/dotfiles.json") => {
  let config: DotfilesConfig | undefined;
  const expandedPath = expandPath(configPath);

  const load = async (): Promise<void> => {
    if (!(await fileExists(expandedPath))) {
      throw new Error(`Configuration file not found: ${expandedPath}`);
    }

    const content = await readFile(expandedPath, "utf8");
    const parsed = JSON.parse(content);
    if (!validateConfig(parsed)) {
      throw new Error("Invalid configuration");
    }
    config = parsed;
  };

  const getMappings = (): FileMapping[] => {
    if (!config) {
      throw new Error("Configuration not loaded");
    }
    return expandMappings(config.mappings);
  };

  const getBackupConfig = (): BackupConfig => {
    if (!config) {
      throw new Error("Configuration not loaded");
    }
    return normalizeBackupConfig(config.backup);
  };

  const getMCPConfig = (): MCPConfig | undefined => {
    if (!config) {
      throw new Error("Configuration not loaded");
    }
    
    if (!config.mcp) {
      return undefined;
    }
    
    return expandMCPConfig(config.mcp);
  };

  const getConfig = (): DotfilesConfig => {
    if (!config) {
      throw new Error("Configuration not loaded");
    }
    return config;
  };

  return {
    load,
    getMappings,
    getBackupConfig,
    getMCPConfig,
    getConfig,
  };
};

