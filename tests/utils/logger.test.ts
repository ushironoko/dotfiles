import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger } from "@/utils/logger";

const FIRST_CALL_INDEX = 0;

describe("Logger", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should log info messages", () => {
    const logger = new Logger(false, false);
    logger.info("test message");

    expect(console.log).toHaveBeenCalled();
    const call = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls[FIRST_CALL_INDEX];
    expect(call.join(" ")).toContain("test message");
  });

  it("should prefix dry-run messages", () => {
    const logger = new Logger(false, true);
    logger.info("test message");

    expect(console.log).toHaveBeenCalled();
    const call = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls[FIRST_CALL_INDEX];
    expect(call.join(" ")).toContain("[DRY RUN]");
    expect(call.join(" ")).toContain("test message");
  });

  it("should log debug messages only in verbose mode", () => {
    const logger = new Logger(false, false);
    logger.debug("debug message");
    expect(console.log).not.toHaveBeenCalled();

    const verboseLogger = new Logger(true, false);
    verboseLogger.debug("debug message");
    expect(console.log).toHaveBeenCalled();
  });

  it("should log error messages", () => {
    const logger = new Logger(false, false);
    logger.error("error message");

    expect(console.error).toHaveBeenCalled();
    const call = (console.error as unknown as { mock: { calls: string[][] } }).mock.calls[FIRST_CALL_INDEX];
    expect(call.join(" ")).toContain("error message");
  });

  it("should log warning messages", () => {
    const logger = new Logger(false, false);
    logger.warn("warning message");

    expect(console.warn).toHaveBeenCalled();
    const call = (console.warn as unknown as { mock: { calls: string[][] } }).mock.calls[FIRST_CALL_INDEX];
    expect(call.join(" ")).toContain("warning message");
  });

  it("should prefix action messages in dry-run mode", () => {
    const logger = new Logger(false, true);
    logger.action("Creating", "file.txt");

    expect(console.log).toHaveBeenCalled();
    const call = (console.log as unknown as { mock: { calls: string[][] } }).mock.calls[FIRST_CALL_INDEX];
    expect(call.join(" ")).toContain("[DRY RUN]");
    expect(call.join(" ")).toContain("Creating");
    expect(call.join(" ")).toContain("file.txt");
  });
});