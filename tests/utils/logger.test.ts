import { describe, expect, it } from "bun:test";
import { createLogger } from "../../src/utils/logger";

describe("createLogger", () => {
  it("should create logger with all required methods", () => {
    const logger = createLogger(false, false);

    expect(typeof logger.error).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.success).toBe("function");
    expect(typeof logger.action).toBe("function");
    expect(typeof logger.setVerbose).toBe("function");
    expect(typeof logger.setDryRun).toBe("function");
  });

  it("should handle verbose mode", () => {
    const logger = createLogger(true, false);
    // Just ensure it creates without error
    expect(logger).toBeDefined();
  });

  it("should handle dry-run mode", () => {
    const logger = createLogger(false, true);
    // Just ensure it creates without error
    expect(logger).toBeDefined();
  });

  it("should handle combined verbose and dry-run mode", () => {
    const logger = createLogger(true, true);
    // Just ensure it creates without error
    expect(logger).toBeDefined();
  });

  it("should allow changing verbose mode", () => {
    const logger = createLogger(false, false);
    logger.setVerbose(true);
    // Just ensure it works without error
    expect(logger).toBeDefined();
  });

  it("should allow changing dry-run mode", () => {
    const logger = createLogger(false, false);
    logger.setDryRun(true);
    // Just ensure it works without error
    expect(logger).toBeDefined();
  });
});
