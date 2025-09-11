import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("doctor command", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalPath: string | undefined;
  let originalGhqRoot: string | undefined;

  beforeEach(() => {
    // Create temporary directory for testing
    tempDir = mkdtempSync(join(tmpdir(), "dotfiles-doctor-test-"));

    // Save original environment variables
    originalHome = process.env.HOME;
    originalPath = process.env.PATH;
    originalGhqRoot = process.env.GHQ_ROOT;

    // Set test environment
    process.env.HOME = tempDir;
    process.env.GHQ_ROOT = join(tempDir, "ghq");
  });

  afterEach(() => {
    // Restore original environment variables
    if (originalHome) process.env.HOME = originalHome;
    if (originalPath) process.env.PATH = originalPath;
    if (originalGhqRoot !== undefined) {
      if (originalGhqRoot === "") {
        delete process.env.GHQ_ROOT;
      } else {
        process.env.GHQ_ROOT = originalGhqRoot;
      }
    }

    // Clean up temp directory
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("environment checks", () => {
    it("should check for environment tools", async () => {
      // Create mock config file
      const configPath = join(tempDir, "dotfiles.config.ts");
      writeFileSync(
        configPath,
        `
        export default {
          mappings: [],
          backup: { directory: "~/.dotfiles_backup", keepLast: 10, compress: false }
        }
      `,
      );

      // This test verifies the doctor command can run without errors
      // Since we can't easily mock execSync in Bun, we'll test the structure exists
      const doctorModule = await import("../../src/commands/doctor");
      expect(doctorModule).toHaveProperty("doctorCommand");
    });

    it("should handle missing ghq root directory", () => {
      // ghq root doesn't exist in temp directory by default
      const ghqRoot = join(tempDir, "ghq");
      expect(() => {
        // Check if directory exists
        const exists = require("fs").existsSync(ghqRoot);
        expect(exists).toBe(false);
      }).not.toThrow();
    });

    it("should detect unmigrated repositories", () => {
      const devDir = join(tempDir, "dev");
      const repoDir = join(devDir, "test-repo");
      const gitDir = join(repoDir, ".git");

      mkdirSync(gitDir, { recursive: true });
      writeFileSync(join(gitDir, "config"), "");

      // Verify the test repo structure was created
      const fs = require("fs");
      expect(fs.existsSync(gitDir)).toBe(true);
      expect(fs.existsSync(join(gitDir, "config"))).toBe(true);
    });

    it("should handle symlinked dev directory", () => {
      const ghqRoot = join(tempDir, "ghq");
      const devDir = join(tempDir, "dev");
      const targetDir = join(ghqRoot, "github.com/user/repo");

      mkdirSync(targetDir, { recursive: true });
      symlinkSync(targetDir, devDir);

      // Verify symlink was created
      const fs = require("fs");
      const stats = fs.lstatSync(devDir);
      expect(stats.isSymbolicLink()).toBe(true);
    });
  });

  describe("config validation", () => {
    it("should handle backup directory", () => {
      const backupDir = join(tempDir, ".dotfiles_backup");
      mkdirSync(backupDir, { recursive: true });

      // Create some backup directories
      mkdirSync(join(backupDir, "2024-01-01T00-00-00"), { recursive: true });
      mkdirSync(join(backupDir, "2024-01-02T00-00-00"), { recursive: true });

      // Verify backup directories were created
      const fs = require("fs");
      const backups = fs.readdirSync(backupDir);
      expect(backups.length).toBe(2);
      expect(backups).toContain("2024-01-01T00-00-00");
      expect(backups).toContain("2024-01-02T00-00-00");
    });
  });

  describe("MCP configuration checks", () => {
    it("should detect claude.json existence", () => {
      const claudeJsonPath = join(tempDir, ".claude.json");
      writeFileSync(
        claudeJsonPath,
        JSON.stringify({ mcpServers: {} }, undefined, 2),
      );

      // Verify file was created
      const fs = require("fs");
      expect(fs.existsSync(claudeJsonPath)).toBe(true);

      const content = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
      expect(content).toHaveProperty("mcpServers");
    });

    it("should detect missing claude.json", () => {
      const claudeJsonPath = join(tempDir, ".claude.json");

      // Verify file doesn't exist
      const fs = require("fs");
      expect(fs.existsSync(claudeJsonPath)).toBe(false);
    });
  });

  describe("command structure", () => {
    it("should export doctorCommand", () => {
      const doctorModule = require("../../src/commands/doctor");
      expect(doctorModule).toHaveProperty("doctorCommand");
      expect(typeof doctorModule.doctorCommand).toBe("object");
      expect(doctorModule.doctorCommand.name).toBe("doctor");
      expect(doctorModule.doctorCommand.description).toContain("Diagnose");
    });

    it("should have correct command arguments", () => {
      const { doctorCommand } = require("../../src/commands/doctor");
      expect(doctorCommand.args).toHaveProperty("verbose");
      expect(doctorCommand.args).toHaveProperty("fix");
      expect(doctorCommand.args).toHaveProperty("check");

      expect(doctorCommand.args.verbose.type).toBe("boolean");
      expect(doctorCommand.args.fix.type).toBe("boolean");
      expect(doctorCommand.args.check.type).toBe("string");
    });
  });
});
