import { createConsola } from "consola";
import { colors } from "consola/utils";

export const createLogger = (verbose = false, dryRun = false) => {
  let isDryRun = dryRun;

  const consola = createConsola({
    level: verbose ? 4 : 3,
    formatOptions: {
      date: false,
      colors: true,
    },
  });

  const wrapWithDryRun = (fn: Function) => {
    return (...args: unknown[]) => {
      if (isDryRun) {
        fn(colors.blue("[DRY RUN]"), ...args);
      } else {
        fn(...args);
      }
    };
  };

  const error = consola.error.bind(consola);
  const warn = consola.warn.bind(consola);
  const info = wrapWithDryRun(consola.info.bind(consola));
  const debug = consola.debug.bind(consola);
  const success = wrapWithDryRun(consola.success.bind(consola));

  const action = (actionName: string, detail: string): void => {
    const prefix = isDryRun ? colors.blue("[DRY RUN] ") : "";
    consola.log(colors.cyan("→"), prefix + colors.bold(actionName), detail);
  };

  const setVerbose = (newVerbose: boolean): void => {
    consola.level = newVerbose ? 4 : 3;
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

export type Logger = ReturnType<typeof createLogger>;
