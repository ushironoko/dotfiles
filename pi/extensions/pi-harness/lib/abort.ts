export interface ActiveAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface AbortControllerLike {
  readonly signal: AbortSignal & ActiveAbortSignal;
  abort(): void;
}

type AbortControllerFactory = () => unknown;

export const isAbortSignal = (
  value: unknown,
): value is AbortSignal & ActiveAbortSignal =>
  typeof value === "object" &&
  value !== null &&
  "aborted" in value &&
  typeof value.aborted === "boolean" &&
  "addEventListener" in value &&
  typeof value.addEventListener === "function" &&
  "removeEventListener" in value &&
  typeof value.removeEventListener === "function";

/** Creates a validated controller whose abort method keeps its native receiver. */
export const createAbortController = (
  factory: AbortControllerFactory = () => new AbortController(),
): AbortControllerLike => {
  const controller = factory();
  if (
    typeof controller !== "object" ||
    controller === null ||
    !("abort" in controller) ||
    typeof controller.abort !== "function" ||
    !("signal" in controller) ||
    !isAbortSignal(controller.signal)
  ) {
    throw new Error("AbortController is unavailable");
  }
  const { abort, signal } = controller;
  return {
    signal,
    abort: () => Reflect.apply(abort, controller, []),
  };
};

/** Graceful variant for optional UI bridges that can operate without abort. */
export const tryCreateAbortController = (
  factory?: AbortControllerFactory,
): AbortControllerLike | undefined => {
  try {
    return factory === undefined
      ? createAbortController()
      : createAbortController(factory);
  } catch {
    return undefined;
  }
};
