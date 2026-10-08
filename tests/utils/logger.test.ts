import { describe, expect, it } from "bun:test";
import { captureLogger } from "./logger-output-fixture";
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
    const result = captureLogger("verbose");
    expect(result.exit_code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe(
      "[info] INFO_MARKER\n[success] SUCCESS_MARKER\n[log] → ACTION_MARKER DETAIL_MARKER\n[debug] DEBUG_MARKER\n",
    );
    expect(result.stderr).toBe("[warn] WARN_MARKER\n[error] ERROR_MARKER\n");
  });

  it("should handle dry-run mode", () => {
    const result = captureLogger("dry");
    expect(result.exit_code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe(
      "[info] [DRY RUN] INFO_MARKER\n[success] [DRY RUN] SUCCESS_MARKER\n[log] → [DRY RUN] ACTION_MARKER DETAIL_MARKER\n",
    );
    expect(result.stderr).toBe("[warn] WARN_MARKER\n[error] ERROR_MARKER\n");
    expect(result.stdout + result.stderr).not.toContain("DEBUG_MARKER");
  });

  it("should handle combined verbose and dry-run mode", () => {
    const result = captureLogger("combined");
    expect(result.exit_code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe(
      "[info] [DRY RUN] INFO_MARKER\n[success] [DRY RUN] SUCCESS_MARKER\n[log] → [DRY RUN] ACTION_MARKER DETAIL_MARKER\n[debug] DEBUG_MARKER\n",
    );
    expect(result.stderr).toBe("[warn] WARN_MARKER\n[error] ERROR_MARKER\n");
    expect(result.stdout).not.toContain("[DRY RUN] DEBUG_MARKER");
  });

  it("should allow changing verbose mode", () => {
    const result = captureLogger("transitions");
    expect(result.exit_code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe(
      "[info] PLAIN_BEFORE\n[debug] VISIBLE_DURING\n[info] [DRY RUN] DRY_DURING\n[success] [DRY RUN] DRY_SUCCESS\n[log] → [DRY RUN] DRY_ACTION DRY_DETAIL\n[info] OTHER_PLAIN\n[success] OTHER_SUCCESS\n[log] → OTHER_ACTION OTHER_DETAIL\n[info] PLAIN_AFTER\n[success] PLAIN_SUCCESS\n[log] → PLAIN_ACTION PLAIN_DETAIL\n",
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain("HIDDEN");
  });

  it("should allow changing dry-run mode", () => {
    const result = captureLogger("transitions");
    expect(result.exit_code).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("[info] PLAIN_BEFORE\n");
    expect(result.stdout).toContain(
      "[info] [DRY RUN] DRY_DURING\n[success] [DRY RUN] DRY_SUCCESS\n[log] → [DRY RUN] DRY_ACTION DRY_DETAIL\n",
    );
    expect(result.stdout).toContain(
      "[info] PLAIN_AFTER\n[success] PLAIN_SUCCESS\n[log] → PLAIN_ACTION PLAIN_DETAIL\n",
    );
    expect(result.stdout).toContain(
      "[info] OTHER_PLAIN\n[success] OTHER_SUCCESS\n[log] → OTHER_ACTION OTHER_DETAIL\n",
    );
    expect(result.stdout).not.toContain("[DRY RUN] OTHER");
    expect(result.stderr).toBe("");
  });

  it("should observe plain and default output without debug", () => {
    for (const scenario of ["plain", "default"]) {
      const result = captureLogger(scenario);
      expect(result.exit_code).toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stdout).toBe(
        "[info] INFO_MARKER\n[success] SUCCESS_MARKER\n[log] → ACTION_MARKER DETAIL_MARKER\n",
      );
      expect(result.stderr).toBe("[warn] WARN_MARKER\n[error] ERROR_MARKER\n");
      expect(result.stdout + result.stderr).not.toContain("DEBUG_MARKER");
      expect(result.stdout + result.stderr).not.toContain("[DRY RUN]");
    }
  });
});
