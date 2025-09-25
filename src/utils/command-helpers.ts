import { baseCommandArgs } from "../types/command.js";
import { createLogger, type Logger } from "./logger.js";

interface CommandOptions {
  verbose: boolean;
  dryRun: boolean;
}

interface CommandContext {
  logger: Logger;
}

// Export define directly from gunshi for type safety
export { define } from "gunshi";
export { baseCommandArgs };

export const createCommandContext = (
  options: CommandOptions,
): CommandContext => {
  const logger = createLogger(options.verbose, options.dryRun);
  return {
    logger,
  };
};
