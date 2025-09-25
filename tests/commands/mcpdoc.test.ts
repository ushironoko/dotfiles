import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createMCPDocManager } from "../../src/core/mcpdoc-manager";
import { Logger } from "../../src/utils/logger";

describe("mcpdoc command", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    // Save original HOME
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    // Restore original HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
  });

  const setupTestEnvironment = async () => {
    // Create a temporary directory for test files
    const tempDir = await mkdtemp(join(tmpdir(), "mcpdoc-test-"));

    // Create a mock logger
    const mockLogger = {
      info: mock(() => {}),
      success: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
      setLevel: mock(() => {}),
      trace: mock(() => {}),
    } as unknown as Logger;

    return { tempDir, mockLogger };
  };

  const cleanupTestEnvironment = async (tempDir: string) => {
    await rm(tempDir, { recursive: true, force: true });
  };

  describe("mcpdoc-manager", () => {
    it("should initialize with empty sources", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);
        const sources = await manager.getSources();

        expect(sources).toEqual([]);
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should add a new documentation source", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        await manager.addSource(
          "Test Docs",
          "https://example.com/llms.txt",
          false,
        );

        const sources = await manager.getSources();
        expect(sources).toHaveLength(1);
        expect(sources[0]).toEqual({
          name: "Test Docs",
          llms_txt: "https://example.com/llms.txt",
        });
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should prevent duplicate names", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        await manager.addSource(
          "Test Docs",
          "https://example.com/llms.txt",
          false,
        );

        // Try to add with same name but different URL
        await manager.addSource(
          "Test Docs",
          "https://another.com/llms.txt",
          false,
        );

        const sources = await manager.getSources();
        expect(sources).toHaveLength(1); // Should still be just one
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Source with name "Test Docs" already exists',
        );
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should prevent duplicate URLs", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        await manager.addSource(
          "Docs 1",
          "https://example.com/llms.txt",
          false,
        );

        // Try to add with same URL but different name
        await manager.addSource(
          "Docs 2",
          "https://example.com/llms.txt",
          false,
        );

        const sources = await manager.getSources();
        expect(sources).toHaveLength(1); // Should still be just one
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'URL already configured with name "Docs 1"',
        );
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should remove a documentation source", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        await manager.addSource(
          "Test Docs",
          "https://example.com/llms.txt",
          false,
        );

        await manager.removeSource("Test Docs", false);

        const sources = await manager.getSources();
        expect(sources).toEqual([]);
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should handle removing non-existent source gracefully", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        await manager.removeSource("Non-existent", false);

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Source "Non-existent" not found',
        );
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should handle multiple sources", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        const testSources: { name: string; url: string }[] = [
          {
            name: "Test Source 1",
            url: "https://example.com/source1/llms.txt",
          },
          {
            name: "Test Source 2",
            url: "https://example.org/source2/llms.txt",
          },
          { name: "Test Source 3", url: "https://test.com/source3/llms.txt" },
        ];

        for (const source of testSources) {
          await manager.addSource(source.name, source.url, false);
        }

        const sources = await manager.getSources();
        expect(sources).toHaveLength(3);

        // Remove one source
        await manager.removeSource("Test Source 2", false);

        const updatedSources = await manager.getSources();
        expect(updatedSources).toHaveLength(2);
        expect(updatedSources.map((s) => s.name)).toEqual([
          "Test Source 1",
          "Test Source 3",
        ]);
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should handle dry-run mode for add", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        await manager.addSource(
          "Test Docs",
          "https://example.com/llms.txt",
          true, // dry-run
        );

        const sources = await manager.getSources();
        expect(sources).toEqual([]); // Should not actually add

        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.stringContaining("[Dry Run] Would add documentation source"),
        );
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should handle dry-run mode for remove", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        // First add a source (not dry-run)
        await manager.addSource(
          "Test Docs",
          "https://example.com/llms.txt",
          false,
        );

        // Then try to remove in dry-run mode
        await manager.removeSource("Test Docs", true);

        const sources = await manager.getSources();
        expect(sources).toHaveLength(1); // Should still exist

        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.stringContaining(
            "[Dry Run] Would remove documentation source",
          ),
        );
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should persist sources to file", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        const testSource = {
          name: "Persistent Docs",
          url: "https://persistent.com/llms.txt",
        };

        await manager.addSource(testSource.name, testSource.url, false);

        // Create a new manager instance to test persistence
        const newManager = await createMCPDocManager(mockLogger, tempDir);
        const sources = await newManager.getSources();

        expect(sources).toHaveLength(1);
        expect(sources[0].name).toEqual(testSource.name);
        expect(sources[0].llms_txt).toEqual(testSource.url);
      } finally {
        await cleanupTestEnvironment(tempDir);
      }
    });

    it("should validate JSON structure when reading corrupted file", async () => {
      const { tempDir, mockLogger } = await setupTestEnvironment();
      try {
        const manager = await createMCPDocManager(mockLogger, tempDir);

        // Add a valid source first
        await manager.addSource("Test", "https://test.com/llms.txt", false);

        // Corrupt the file
        const configPath = manager.getSourcesFilePath();
        await writeFile(configPath, "not valid json", "utf8");

        // Create new manager and try to read
        const newManager = await createMCPDocManager(mockLogger, tempDir);
        const sources = await newManager.getSources();

        expect(sources).toEqual([]); // Should return empty array on error
        expect(mockLogger.error).toHaveBeenCalled();
      } finally {
        // Ensure the corrupted file is cleaned up
        await cleanupTestEnvironment(tempDir);
        // Extra safety: restore original HOME in case it wasn't restored properly
        if (originalHome !== undefined) {
          process.env.HOME = originalHome;
        }
      }
    });
  });
});
