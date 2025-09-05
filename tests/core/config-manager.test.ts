import { mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createConfigManager } from "../../src/core/config-manager";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

const SINGLE_MAPPING = 1;
const FIRST_MAPPING_INDEX = 0;
const KEEP_LAST_BACKUPS = 5;

describe("ConfigManager", () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `test-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    configPath = join(tempDir, "dotfiles.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("should load valid configuration", async () => {
    const config = {
      mappings: [
        {
          source: "./shell/.bashrc",
          target: "~/.bashrc",
          type: "file",
        },
      ],
      backup: {
        directory: "~/.dotfiles_backup",
        keepLast: 5,
      },
    };

    await writeFile(configPath, JSON.stringify(config));

    const manager = createConfigManager(configPath);
    await manager.load();

    const mappings = manager.getMappings();
    expect(mappings).toHaveLength(SINGLE_MAPPING);
    expect(mappings[FIRST_MAPPING_INDEX].type).toBe("file");

    const backupConfig = manager.getBackupConfig();
    expect(backupConfig.keepLast).toBe(KEEP_LAST_BACKUPS);
  });

  it("should throw error for invalid configuration", async () => {
    const invalidConfig = {
      mappings: "not-an-array",
      backup: {},
    };

    await writeFile(configPath, JSON.stringify(invalidConfig));

    const manager = createConfigManager(configPath);
    await expect(manager.load()).rejects.toThrow(
      "Invalid config: mappings must be an array",
    );
  });

  it("should throw error for missing required fields", async () => {
    const invalidConfig = {
      mappings: [
        {
          source: "./shell/.bashrc",
          // missing target
          type: "file",
        },
      ],
      backup: {
        directory: "~/.dotfiles_backup",
      },
    };

    await writeFile(configPath, JSON.stringify(invalidConfig));

    const manager = createConfigManager(configPath);
    await expect(manager.load()).rejects.toThrow(
      "Invalid mapping: source and target are required",
    );
  });

  it("should expand paths correctly", async () => {
    const config = {
      mappings: [
        {
          source: "./shell/.bashrc",
          target: "~/.bashrc",
          type: "file",
        },
      ],
      backup: {
        directory: "~/.dotfiles_backup",
      },
    };

    await writeFile(configPath, JSON.stringify(config));

    const manager = createConfigManager(configPath);
    await manager.load();

    const mappings = manager.getMappings();
    const homeDir = process.env.HOME || "";
    expect(mappings[FIRST_MAPPING_INDEX].target).toBe(`${homeDir}/.bashrc`);
    expect(mappings[FIRST_MAPPING_INDEX].target).not.toContain("~");
  });
});
