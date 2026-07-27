import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { randomUUID } from "node:crypto";
import { createHearthReadTool } from "./adapters";
import type { RuntimeState } from "./index";

export const HEARTH_SERVICE_READY = "pi-hearth-tools:service-ready:v1";
export const HEARTH_SERVICE_REQUEST = "pi-hearth-tools:service-request:v1";
export const HEARTH_INVALIDATE_REQUEST =
  "pi-hearth-tools:invalidate-request:v1";

const INVALIDATION_BROKERS = Symbol.for(
  "ushironoko.pi-hearth-tools.invalidation-brokers.v1",
);

export interface HearthReadService {
  generation: string;
  createReadTool(cwd: string): AgentTool<TSchema, unknown>;
}

interface ServiceRequest {
  requestId: string;
  accept(service: HearthReadService, requestId: string): void;
}

interface InvalidationRequest {
  accept(operation: Promise<void>): void;
}

interface InvalidationBroker {
  current: () => Promise<void>;
}

interface GlobalWithInvalidationBrokers {
  [INVALIDATION_BROKERS]?: WeakMap<object, InvalidationBroker>;
}

const isRequest = (value: unknown): value is ServiceRequest => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ServiceRequest>;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.accept === "function"
  );
};

const isInvalidationRequest = (
  value: unknown,
): value is InvalidationRequest => {
  if (value === null || typeof value !== "object") return false;
  return typeof (value as Partial<InvalidationRequest>).accept === "function";
};

export const registerHearthInvalidationService = (
  pi: ExtensionAPI,
  clearCaches: () => Promise<void>,
): void => {
  const host = globalThis as GlobalWithInvalidationBrokers;
  const brokers =
    host[INVALIDATION_BROKERS] ?? new WeakMap<object, InvalidationBroker>();
  host[INVALIDATION_BROKERS] = brokers;
  const eventBus = pi.events as object;
  const existing = brokers.get(eventBus);
  if (existing !== undefined) {
    existing.current = clearCaches;
    return;
  }

  const broker: InvalidationBroker = { current: clearCaches };
  brokers.set(eventBus, broker);
  pi.events.on(HEARTH_INVALIDATE_REQUEST, (value) => {
    if (isInvalidationRequest(value)) value.accept(broker.current());
  });
};

export const registerHearthReadService = (
  pi: ExtensionAPI,
  state: () => RuntimeState | undefined,
): { announce(): void; dispose(): void } => {
  const generation = randomUUID();
  const service: HearthReadService = {
    generation,
    createReadTool(cwd) {
      const current = state();
      if (current === undefined)
        throw new Error("Hearth Engine is not initialized");
      return createHearthReadTool(
        cwd,
        current.runtime.engine,
        current.settings,
        current.runtime.gate,
      );
    },
  };
  const dispose = pi.events.on(HEARTH_SERVICE_REQUEST, (value) => {
    if (!isRequest(value) || state() === undefined) return;
    value.accept(service, value.requestId);
  });
  return {
    announce() {
      if (state() !== undefined) pi.events.emit(HEARTH_SERVICE_READY, service);
    },
    dispose,
  };
};
