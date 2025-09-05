import chalk from "chalk";

const LOG_LEVEL_ERROR = 0;
const LOG_LEVEL_WARN = 1;
const LOG_LEVEL_INFO = 2;
const LOG_LEVEL_DEBUG = 3;

export enum LogLevel {
  ERROR = LOG_LEVEL_ERROR,
  WARN = LOG_LEVEL_WARN,
  INFO = LOG_LEVEL_INFO,
  DEBUG = LOG_LEVEL_DEBUG,
}

// ファクトリー関数：Loggerを作成
export const createLogger = (verbose = false, dryRun = false) => {
  let level = verbose ? LogLevel.DEBUG : LogLevel.INFO;
  let isDryRun = dryRun;

  const error = (message: string): void => {
    if (level >= LogLevel.ERROR) {
      console.error(chalk.red("✗"), message);
    }
  };

  const warn = (message: string): void => {
    if (level >= LogLevel.WARN) {
      console.warn(chalk.yellow("⚠"), message);
    }
  };

  const info = (message: string): void => {
    if (level >= LogLevel.INFO) {
      const prefix = isDryRun ? chalk.blue("[DRY RUN] ") : "";
      console.log(chalk.green("✓"), prefix + message);
    }
  };

  const debug = (message: string): void => {
    if (level >= LogLevel.DEBUG) {
      console.log(chalk.gray("→"), message);
    }
  };

  const success = (message: string): void => {
    console.log(chalk.green.bold("✓"), chalk.green(message));
  };

  const action = (actionName: string, detail: string): void => {
    const prefix = isDryRun ? chalk.blue("[DRY RUN] ") : "";
    console.log(chalk.cyan("→"), prefix + chalk.bold(actionName), detail);
  };

  const setVerbose = (newVerbose: boolean): void => {
    level = newVerbose ? LogLevel.DEBUG : LogLevel.INFO;
  };

  const setDryRun = (newDryRun: boolean): void => {
    isDryRun = newDryRun;
  };

  return {
    error,
    warn,
    info,
    debug,
    success,
    action,
    setVerbose,
    setDryRun,
  };
};

// 型エクスポート
export type Logger = ReturnType<typeof createLogger>;