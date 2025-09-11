import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createLogger, type Logger } from "../src/utils/logger";

interface TestLoggerOptions {
  verbose?: boolean;
  dryRun?: boolean;
}

/**
 * Creates a unique temporary directory for testing
 * @param prefix - Prefix for the directory name
 * @param subdirs - Optional subdirectories to create
 * @returns Path to the created directory
 */
export const setupTestDirectory = async (
  prefix: string,
  subdirs?: string[],
): Promise<string> => {
  const dir = await fs.mkdtemp(join(tmpdir(), `${prefix}-`));

  if (subdirs) {
    await Promise.all(
      subdirs.map((subdir) => fs.mkdir(join(dir, subdir), { recursive: true })),
    );
  }

  return dir;
};

/**
 * Removes a test directory and all its contents
 * @param dir - Directory path to remove
 */
export const cleanupTestDirectory = async (dir: string): Promise<void> => {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Silently ignore errors (e.g., directory doesn't exist)
  }
};

/**
 * Creates a logger instance for testing
 * @param options - Logger configuration options
 * @returns Logger instance
 */
export const createTestLogger = (options?: TestLoggerOptions): Logger => {
  return createLogger(options?.verbose ?? false, options?.dryRun ?? false);
};

/**
 * Creates a test file with specified content
 * @param path - File path
 * @param content - File content
 */
export const createTestFile = async (
  path: string,
  content: string,
): Promise<void> => {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, content);
};

/**
 * Creates a symbolic link for testing
 * @param target - Target path
 * @param link - Link path
 */
export const createTestSymlink = async (
  target: string,
  link: string,
): Promise<void> => {
  await fs.symlink(target, link);
};
