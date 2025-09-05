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

export class Logger {
  private level: LogLevel;
  private isDryRun: boolean;

  constructor(verbose = false, dryRun = false) {
    this.level = verbose ? LogLevel.DEBUG : LogLevel.INFO;
    this.isDryRun = dryRun;
  }

  error(message: string): void {
    if (this.level >= LogLevel.ERROR) {
      console.error(chalk.red("✗"), message);
    }
  }

  warn(message: string): void {
    if (this.level >= LogLevel.WARN) {
      console.warn(chalk.yellow("⚠"), message);
    }
  }

  info(message: string): void {
    if (this.level >= LogLevel.INFO) {
      const prefix = this.isDryRun ? chalk.blue("[DRY RUN] ") : "";
      console.log(chalk.green("✓"), prefix + message);
    }
  }

  debug(message: string): void {
    if (this.level >= LogLevel.DEBUG) {
      console.log(chalk.gray("→"), message);
    }
  }

  success(message: string): void {
    console.log(chalk.green.bold("✓"), chalk.green(message));
  }

  action(action: string, detail: string): void {
    const prefix = this.isDryRun ? chalk.blue("[DRY RUN] ") : "";
    console.log(chalk.cyan("→"), prefix + chalk.bold(action), detail);
  }

  setVerbose(verbose: boolean): void {
    this.level = verbose ? LogLevel.DEBUG : LogLevel.INFO;
  }

  setDryRun(dryRun: boolean): void {
    this.isDryRun = dryRun;
  }
}