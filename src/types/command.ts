// Common command types and constants

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;

export interface BaseCommandArgs {
  config: {
    default: string;
    description: string;
    short: string;
    type: "string";
  };
  verbose: {
    default: boolean;
    description: string;
    short: string;
    type: "boolean";
  };
}

export interface DryRunArg {
  dryRun: {
    default: boolean;
    description: string;
    short: string;
    type: "boolean";
  };
}

export interface ForceArg {
  force: {
    default: boolean;
    description: string;
    short: string;
    type: "boolean";
  };
}

export interface InteractiveArg {
  interactive: {
    default: boolean;
    description: string;
    short: string;
    type: "boolean";
  };
}

export interface SelectArg {
  select: {
    default: boolean;
    description: string;
    short: string;
    type: "boolean";
  };
}

export const baseCommandArgs: BaseCommandArgs = {
  config: {
    default: "./",
    description: "Path to config directory or file",
    short: "c",
    type: "string",
  },
  verbose: {
    default: false,
    description: "Verbose output",
    short: "v",
    type: "boolean",
  },
};

export const dryRunArg: DryRunArg = {
  dryRun: {
    default: false,
    description: "Perform a dry run without making changes",
    short: "d",
    type: "boolean",
  },
};

export const forceArg: ForceArg = {
  force: {
    default: false,
    description: "Force overwrite existing files",
    short: "f",
    type: "boolean",
  },
};

export const interactiveArg: InteractiveArg = {
  interactive: {
    default: true,
    description: "Interactive mode",
    short: "i",
    type: "boolean",
  },
};

export const selectArg: SelectArg = {
  select: {
    default: false,
    description: "Interactively select which files to install",
    short: "s",
    type: "boolean",
  },
};
