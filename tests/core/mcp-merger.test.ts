import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createMCPMerger, type MCPMerger } from "../../src/core/mcp-merger";
import { createLogger } from "../../src/utils/logger";
import { fileExists } from "../../src/utils/fs";

describe("MCPMerger", () => {
  let testDir: string;
  let merger: MCPMerger;
  let logger: ReturnType<typeof createLogger>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `mcp-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    
    logger = createLogger(false, false);
    merger = createMCPMerger(logger, {
      sourceFile: join(testDir, "source.json"),
      targetFile: join(testDir, "target.json"),
      backupDir: join(testDir, "backup"),
      mergeKey: "mcpServers",
    });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("merge", () => {
    it("should merge mcpServers from source to target", async () => {
      const sourceData = {
        mcpServers: {
          server1: { command: "cmd1" },
          server2: { command: "cmd2" },
        },
      };
      
      const targetData = {
        existingKey: "value",
        mcpServers: {
          oldServer: { command: "old" },
        },
      };
      
      await fs.writeFile(
        join(testDir, "source.json"),
        JSON.stringify(sourceData, undefined, 2)
      );
      await fs.writeFile(
        join(testDir, "target.json"),
        JSON.stringify(targetData, undefined, 2)
      );
      
      await merger.merge();
      
      const resultContent = await fs.readFile(join(testDir, "target.json"), "utf8");
      const result = JSON.parse(resultContent);
      
      expect(result.existingKey).toBe("value");
      expect(result.mcpServers).toEqual(sourceData.mcpServers);
    });

    it("should create target file if it doesn't exist", async () => {
      const sourceData = {
        mcpServers: {
          server1: { command: "cmd1" },
        },
      };
      
      await fs.writeFile(
        join(testDir, "source.json"),
        JSON.stringify(sourceData, undefined, 2)
      );
      
      await merger.merge();
      
      expect(await fileExists(join(testDir, "target.json"))).toBe(true);
      
      const resultContent = await fs.readFile(join(testDir, "target.json"), "utf8");
      const result = JSON.parse(resultContent);
      
      expect(result.mcpServers).toEqual(sourceData.mcpServers);
    });

    it("should skip merge if source file doesn't exist", async () => {
      const targetData = {
        existingKey: "value",
      };
      
      await fs.writeFile(
        join(testDir, "target.json"),
        JSON.stringify(targetData, undefined, 2)
      );
      
      await merger.merge();
      
      const resultContent = await fs.readFile(join(testDir, "target.json"), "utf8");
      const result = JSON.parse(resultContent);
      
      expect(result).toEqual(targetData);
    });

    it("should handle missing merge key in source", async () => {
      const sourceData = {
        otherKey: "value",
      };
      
      const targetData = {
        existingKey: "value",
        mcpServers: {
          oldServer: { command: "old" },
        },
      };
      
      await fs.writeFile(
        join(testDir, "source.json"),
        JSON.stringify(sourceData, undefined, 2)
      );
      await fs.writeFile(
        join(testDir, "target.json"),
        JSON.stringify(targetData, undefined, 2)
      );
      
      await merger.merge();
      
      const resultContent = await fs.readFile(join(testDir, "target.json"), "utf8");
      const result = JSON.parse(resultContent);
      
      expect(result).toEqual(targetData);
    });

    it("should handle malformed JSON gracefully", async () => {
      await fs.writeFile(join(testDir, "source.json"), "{ invalid json }");
      await fs.writeFile(join(testDir, "target.json"), "{}");
      
      const result = await merger.merge();
      expect(result).toBeUndefined();
    });

    it("should handle dry run mode", async () => {
      const sourceData = {
        mcpServers: {
          server1: { command: "cmd1" },
        },
      };
      
      const targetData = {
        mcpServers: {
          oldServer: { command: "old" },
        },
      };
      
      await fs.writeFile(
        join(testDir, "source.json"),
        JSON.stringify(sourceData, undefined, 2)
      );
      await fs.writeFile(
        join(testDir, "target.json"),
        JSON.stringify(targetData, undefined, 2)
      );
      
      await merger.merge(true);
      
      const resultContent = await fs.readFile(join(testDir, "target.json"), "utf8");
      const result = JSON.parse(resultContent);
      
      expect(result.mcpServers).toEqual(targetData.mcpServers);
    });
  });

  describe("backup", () => {
    it("should create backup of target file", async () => {
      const targetData = {
        existingKey: "value",
      };
      
      await fs.mkdir(join(testDir, "backup"), { recursive: true });
      await fs.writeFile(
        join(testDir, "target.json"),
        JSON.stringify(targetData, undefined, 2)
      );
      
      await merger.backup();
      
      const backupFiles = await fs.readdir(join(testDir, "backup"));
      expect(backupFiles).toHaveLength(1);
      expect(backupFiles[0]).toMatch(/^\.claude\.json\.\d+$/);
      
      const backupContent = await fs.readFile(
        join(testDir, "backup", backupFiles[0]),
        "utf8"
      );
      const backup = JSON.parse(backupContent);
      
      expect(backup).toEqual(targetData);
    });

    it("should skip backup if target doesn't exist", async () => {
      await fs.mkdir(join(testDir, "backup"), { recursive: true });
      
      await merger.backup();
      
      const backupFiles = await fs.readdir(join(testDir, "backup"));
      expect(backupFiles).toHaveLength(0);
    });

    it("should skip backup if backup already exists", async () => {
      const targetData = { key: "value" };
      
      await fs.mkdir(join(testDir, "backup"), { recursive: true });
      await fs.writeFile(
        join(testDir, "target.json"),
        JSON.stringify(targetData, undefined, 2)
      );
      
      // Create first backup
      await merger.backup();
      const files1 = await fs.readdir(join(testDir, "backup"));
      expect(files1).toHaveLength(1);
      
      // Try to create another backup (should skip)
      await merger.backup();
      const files2 = await fs.readdir(join(testDir, "backup"));
      expect(files2).toHaveLength(1);
    });

    it("should handle dry run mode", async () => {
      const targetData = { key: "value" };
      
      await fs.mkdir(join(testDir, "backup"), { recursive: true });
      await fs.writeFile(
        join(testDir, "target.json"),
        JSON.stringify(targetData, undefined, 2)
      );
      
      await merger.backup(true);
      
      const backupFiles = await fs.readdir(join(testDir, "backup"));
      expect(backupFiles).toHaveLength(0);
    });
  });

  describe("integration", () => {
    it("should backup and merge in sequence", async () => {
      const sourceData = {
        mcpServers: {
          newServer: { command: "new" },
        },
      };
      
      const targetData = {
        existingKey: "value",
        mcpServers: {
          oldServer: { command: "old" },
        },
      };
      
      await fs.mkdir(join(testDir, "backup"), { recursive: true });
      await fs.writeFile(
        join(testDir, "source.json"),
        JSON.stringify(sourceData, undefined, 2)
      );
      await fs.writeFile(
        join(testDir, "target.json"),
        JSON.stringify(targetData, undefined, 2)
      );
      
      // First backup, then merge
      await merger.backup();
      await merger.merge();
      
      // Check backup was created
      const backupFiles = await fs.readdir(join(testDir, "backup"));
      expect(backupFiles).toHaveLength(1);
      
      const backupContent = await fs.readFile(
        join(testDir, "backup", backupFiles[0]),
        "utf8"
      );
      const backup = JSON.parse(backupContent);
      expect(backup).toEqual(targetData);
      
      // Check merge was successful
      const resultContent = await fs.readFile(join(testDir, "target.json"), "utf8");
      const result = JSON.parse(resultContent);
      expect(result.existingKey).toBe("value");
      expect(result.mcpServers).toEqual(sourceData.mcpServers);
    });
  });
});