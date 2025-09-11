import { define } from "gunshi";
import { baseCommandArgs } from "../types/command.js";
import { createLogger, type Logger } from "./logger.js";

type AdditionalArgs = Record<
  string,
  {
    default?: unknown;
    description: string;
    short?: string;
    type: "string" | "boolean" | "number";
  }
>;

interface CommandDefinition<T extends AdditionalArgs = AdditionalArgs> {
  name: string;
  description: string;
  additionalArgs?: T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (ctx: any) => Promise<void> | void;
}

interface CommandOptions {
  verbose: boolean;
  dryRun: boolean;
}

interface CommandContext {
  logger: Logger;
}

export const defineCommandWithBase = <T extends AdditionalArgs>(
  definition: CommandDefinition<T>,
) => {
  return define({
    name: definition.name,
    description: definition.description,
    args: {
      ...baseCommandArgs,
      ...definition.additionalArgs,
    },
    run: definition.run,
  });
};

export const createCommandContext = (
  options: CommandOptions,
): CommandContext => {
  const logger = createLogger(options.verbose, options.dryRun);
  return {
    logger,
  };
};
