import { loadConfig } from "c12";
import type {
  BackupConfig,
  DotfilesConfig,
  FileMapping,
  MCPConfig,
} from "../types/config.js";
import { expandPath } from "../utils/paths.js";

const DEFAULT_KEEP_LAST = 10;

// 設定の検証
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

    if (mapping.type === "selective" && !mapping.include) {
      throw new Error("Selective mapping requires 'include' array");
    }
  }

  if (!c.backup || !c.backup.directory) {
    throw new Error("Invalid config: backup.directory is required");
  }

  return true;
};

// マッピングのパスを展開
export const expandMappings = (mappings: FileMapping[]): FileMapping[] =>
  mappings.map((mapping) => ({
    ...mapping,
    source: expandPath(mapping.source),
    target: expandPath(mapping.target),
  }));

// バックアップ設定の正規化
export const normalizeBackupConfig = (config: BackupConfig): BackupConfig => ({
  ...config,
  compress: config.compress || false,
  directory: expandPath(config.directory),
  keepLast: config.keepLast || DEFAULT_KEEP_LAST,
});

// MCP設定のパスを展開
export const expandMCPConfig = (config: MCPConfig): MCPConfig => ({
  ...config,
  sourceFile: expandPath(config.sourceFile),
  targetFile: expandPath(config.targetFile),
});

// ConfigManagerを作成
export const createConfigManager = async (configPath?: string) => {
  // configファイルを読み込み
  const { config: loadedConfig } = await loadConfig<DotfilesConfig>({
    name: "dotfiles",
    cwd: configPath ? expandPath(configPath) : process.cwd(),
    defaults: {
      mappings: [], // デフォルトは空配列
      backup: {
        directory: "~/.dotfiles_backup",
        keepLast: DEFAULT_KEEP_LAST,
        compress: false,
      },
    },
  });

  // 検証
  if (!validateConfig(loadedConfig)) {
    throw new Error("Invalid configuration");
  }

  const config = loadedConfig;

  const getMappings = (): FileMapping[] => {
    return expandMappings(config.mappings);
  };

  const getBackupConfig = (): BackupConfig => {
    return normalizeBackupConfig(config.backup);
  };

  const getMCPConfig = (): MCPConfig | undefined => {
    if (!config.mcp) {
      return undefined;
    }
    return expandMCPConfig(config.mcp);
  };

  const getConfig = (): DotfilesConfig => {
    return config;
  };

  return {
    getMappings,
    getBackupConfig,
    getMCPConfig,
    getConfig,
  };
};
