import { loadConfig } from "c12";
import type {
  BackupConfig,
  DotfilesConfig,
  FileMapping,
  MCPConfig,
} from "../types/config.js";
import { expandPath } from "../utils/paths.js";
import { join } from "node:path";

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
export const expandMappings = (
  mappings: FileMapping[],
  baseDir: string,
): FileMapping[] =>
  mappings.map((mapping) => ({
    ...mapping,
    source: mapping.source.startsWith("./")
      ? join(baseDir, mapping.source.slice(2))
      : expandPath(mapping.source),
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
export const expandMCPConfig = (
  config: MCPConfig,
  baseDir: string,
): MCPConfig => ({
  ...config,
  sourceFile: config.sourceFile.startsWith("./")
    ? join(baseDir, config.sourceFile.slice(2))
    : expandPath(config.sourceFile),
  targetFile: expandPath(config.targetFile),
});

// ConfigManagerを作成
export const createConfigManager = async (configPath?: string | null) => {
  // dotfilesレポジトリのルートディレクトリを取得
  // bin/dotfiles経由で実行される場合を考慮
  const getDotfilesRoot = () => {
    // import.meta.urlを使用して現在のファイルパスを取得
    const currentFile = new URL(import.meta.url).pathname;
    // src/core/config-manager.ts から 2階層上がルートディレクトリ
    const pathSegments = currentFile.split("/");
    const rootIndex = pathSegments.lastIndexOf("src");
    if (rootIndex > 0) {
      return pathSegments.slice(0, rootIndex).join("/");
    }
    // フォールバック: /home/ushironoko/ghq/github.com/ushironoko/dotfiles
    return expandPath("~/ghq/github.com/ushironoko/dotfiles");
  };

  // configファイルを読み込み
  // configPathが空、null、undefined、またはデフォルトの場合はレポジトリルートを使用
  const { config: loadedConfig } = await loadConfig<DotfilesConfig>({
    name: "dotfiles",
    cwd:
      configPath && configPath !== "./" && configPath !== ""
        ? expandPath(configPath)
        : getDotfilesRoot(),
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
    return expandMappings(config.mappings, getDotfilesRoot());
  };

  const getBackupConfig = (): BackupConfig => {
    return normalizeBackupConfig(config.backup);
  };

  const getMCPConfig = (): MCPConfig | undefined => {
    if (!config.mcp) {
      return undefined;
    }
    return expandMCPConfig(config.mcp, getDotfilesRoot());
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
