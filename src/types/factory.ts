// Factory pattern types and helpers

import type { Logger } from "../utils/logger.js";

export interface FactoryContext<T = unknown> {
  logger: Logger;
  config?: T;
}

export type FactoryFunction<T, R> = (context: FactoryContext<T>) => R;

export interface Factory<T> {
  create: FactoryFunction<unknown, T>;
}

// Helper for creating typed factories
export const defineFactory = <T, R>(
  fn: (logger: Logger, config?: T) => R,
): ((logger: Logger, config?: T) => R) => {
  return fn;
};
