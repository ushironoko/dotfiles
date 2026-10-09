import { loadConfig } from "c12";
import type {
  BackupConfig,
  DotfilesConfig,
  FileMapping,
  MCPConfig,
} from "../types/config.js";
import { expandPath } from "../utils/paths.js";
import { statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
interface ConfigManagerOptions {
  requireConfig?: boolean;
}

export const createConfigManager = async (
  configPath?: string | null,
  options: ConfigManagerOptions = {},
) => {
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

  const hasExplicitPath = Boolean(configPath && configPath !== "./");
  const selectedPath =
    hasExplicitPath && configPath ? expandPath(configPath) : getDotfilesRoot();
  const isConfigFile = statSync(selectedPath, {
    throwIfNoEntry: false,
  })?.isFile();

  const { config: loadedConfig } = await loadConfig<DotfilesConfig>({
    name: "dotfiles",
    cwd: isConfigFile ? dirname(selectedPath) : selectedPath,
    configFile: isConfigFile ? basename(selectedPath) : undefined,
    configFileRequired: Boolean(options.requireConfig && hasExplicitPath),
    defaults: {
      mappings: [], // デフォルトは空配列
      backup: {
        directory: "~/.dotfiles_backup",
        keepLast: DEFAULT_KEEP_LAST,
        compress: false,
      },
    },
  }).catch((error: unknown) => {
    if (options.requireConfig && hasExplicitPath) {
      throw new Error(
        `Failed to resolve configuration ${selectedPath}: ${error}`,
        {
          cause: error,
        },
      );
    }
    throw error;
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
