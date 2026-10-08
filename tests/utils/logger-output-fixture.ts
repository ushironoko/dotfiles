import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger, type Logger } from "../../src/utils/logger";
import { createCommandContext } from "../../src/utils/command-helpers";

export const captureLogger = (scenario: string) => {
  const root = mkdtempSync(join(tmpdir(), "dotfiles-logger-output-"));
  const env = {
    HOME: root,
    PATH: root,
    NODE_ENV: "test",
    NO_COLOR: "1",
    PI_CODING_AGENT_DIR: join(root, "agent"),
    PI_OFFLINE: "1",
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  const argv = [process.execPath, fileURLToPath(import.meta.url), scenario];
  try {
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const record = {
      argv,
      cwd: root,
      env,
      deadline_ms: 10000,
      exit_code: result.status,
      signal: result.signal,
      timeout: Boolean(
        result.error &&
          "code" in result.error &&
          result.error.code === "ETIMEDOUT",
      ),
      driver_error: result.error?.message ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
    const evidence = process.env.CLI_LOGGER_EVIDENCE_DIR;
    if (evidence) {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(
        join(evidence, `${scenario}-${randomUUID()}.json`),
        JSON.stringify(record, null, 2),
      );
    }
    if (result.error) throw result.error;
    return record;
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false, `Fixture cleanup failed: ${root}`);
  }
};

const emit = (logger: Logger) => {
  logger.info("INFO_MARKER");
  logger.success("SUCCESS_MARKER");
  logger.action("ACTION_MARKER", "DETAIL_MARKER");
  logger.debug("DEBUG_MARKER");
  logger.warn("WARN_MARKER");
  logger.error("ERROR_MARKER");
};

const transitions = (logger: Logger, other: Logger) => {
  logger.debug("HIDDEN_BEFORE");
  logger.info("PLAIN_BEFORE");
  logger.setVerbose(true);
  logger.setDryRun(true);
  logger.debug("VISIBLE_DURING");
  logger.info("DRY_DURING");
  logger.success("DRY_SUCCESS");
  logger.action("DRY_ACTION", "DRY_DETAIL");
  other.debug("OTHER_HIDDEN");
  other.info("OTHER_PLAIN");
  other.success("OTHER_SUCCESS");
  other.action("OTHER_ACTION", "OTHER_DETAIL");
  logger.setVerbose(false);
  logger.setDryRun(false);
  logger.debug("HIDDEN_AFTER");
  logger.info("PLAIN_AFTER");
  logger.success("PLAIN_SUCCESS");
  logger.action("PLAIN_ACTION", "PLAIN_DETAIL");
};

if (import.meta.main) {
  switch (process.argv[2]) {
    case "default": {
      emit(createLogger());
      break;
    }
    case "plain": {
      emit(createLogger(false, false));
      break;
    }
    case "verbose": {
      emit(createLogger(true, false));
      break;
    }
    case "dry": {
      emit(createLogger(false, true));
      break;
    }
    case "combined": {
      emit(createLogger(true, true));
      break;
    }
    case "context-plain": {
      emit(createCommandContext({ verbose: false, dryRun: false }).logger);
      break;
    }
    case "context-verbose": {
      emit(createCommandContext({ verbose: true, dryRun: false }).logger);
      break;
    }
    case "context-dry": {
      emit(createCommandContext({ verbose: false, dryRun: true }).logger);
      break;
    }
    case "context-combined": {
      emit(createCommandContext({ verbose: true, dryRun: true }).logger);
      break;
    }
    case "transitions": {
      transitions(createLogger(false, false), createLogger(false, false));
      break;
    }
    case "context-transitions": {
      transitions(
        createCommandContext({ verbose: false, dryRun: false }).logger,
        createCommandContext({ verbose: false, dryRun: false }).logger,
      );
      break;
    }
    default: {
      throw new Error("Unknown logger fixture scenario");
    }
  }
}
