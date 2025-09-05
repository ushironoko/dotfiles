import { readFile } from "fs/promises";
import { BackupConfig, DotfilesConfig, FileMapping, MCPConfig } from "../types/config";
import { expandPath } from "../utils/paths";
import { fileExists } from "../utils/fs";

export class ConfigManager {
  private config: DotfilesConfig | undefined;
  private configPath: string;

  constructor(configPath = "./config/dotfiles.json") {
    this.configPath = expandPath(configPath);
  }

  async load(): Promise<void> {
    if (!(await fileExists(this.configPath))) {
      throw new Error(`Configuration file not found: ${this.configPath}`);
    }

    const content = await readFile(this.configPath, "utf8");
    this.config = JSON.parse(content);
    this.validateConfig();
  }

  private validateConfig(): void {
    if (!this.config) {
      throw new Error("Configuration not loaded");
    }

    if (!this.config.mappings || !Array.isArray(this.config.mappings)) {
      throw new Error("Invalid config: mappings must be an array");
    }

    for (const mapping of this.config.mappings) {
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

    if (!this.config.backup || !this.config.backup.directory) {
      throw new Error("Invalid config: backup.directory is required");
    }
  }

  getMappings(): FileMapping[] {
    if (!this.config) {
      throw new Error("Configuration not loaded");
    }

    return this.config.mappings.map(mapping => ({
      ...mapping,
      source: expandPath(mapping.source),
      target: expandPath(mapping.target),
    }));
  }

  getBackupConfig(): BackupConfig {
    if (!this.config) {
      throw new Error("Configuration not loaded");
    }

    const DEFAULT_KEEP_LAST = 10;
    return {
      ...this.config.backup,
      compress: this.config.backup.compress || false,
      directory: expandPath(this.config.backup.directory),
      keepLast: this.config.backup.keepLast || DEFAULT_KEEP_LAST,
    };
  }

  getMCPConfig(): MCPConfig | undefined {
    if (!this.config) {
      throw new Error("Configuration not loaded");
    }

    if (!this.config.mcp) {
      return undefined;
    }

    return {
      ...this.config.mcp,
      sourceFile: expandPath(this.config.mcp.sourceFile),
      targetFile: expandPath(this.config.mcp.targetFile),
    };
  }

  getConfig(): DotfilesConfig {
    if (!this.config) {
      throw new Error("Configuration not loaded");
    }
    return this.config;
  }
}