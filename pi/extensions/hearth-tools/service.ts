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
export const HEARTH_EXTERNAL_WRITER_REQUEST =
  "pi-hearth-tools:external-writer-request:v1";

const INVALIDATION_BROKERS = Symbol.for(
  "ushironoko.pi-hearth-tools.invalidation-brokers.v2",
);

export interface HearthReadService {
  generation: string;
  createReadTool(cwd: string): AgentTool<TSchema, unknown>;
}

export interface ExternalWriterLease {
  ready: Promise<void>;
  complete: Promise<void>;
}

export interface HearthInvalidationHandlers {
  clearCaches(): Promise<void>;
  protectExternalWriter(finished: Promise<void>): ExternalWriterLease;
}

export interface HearthInvalidationRegistration {
  activate(handlers: HearthInvalidationHandlers): void;
}

interface ServiceRequest {
  requestId: string;
  accept(service: HearthReadService, requestId: string): void;
}

interface InvalidationRequest {
  accept(operation: Promise<void>): void;
}

interface ExternalWriterRequest {
  finished: Promise<void>;
  accept(lease: ExternalWriterLease): void;
}

interface InvalidationBroker {
  current?: HearthInvalidationHandlers;
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

const isExternalWriterRequest = (
  value: unknown,
): value is ExternalWriterRequest => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ExternalWriterRequest>;
  return (
    candidate.finished instanceof Promise &&
    typeof candidate.accept === "function"
  );
};

export const registerHearthInvalidationService = (
  pi: ExtensionAPI,
): HearthInvalidationRegistration => {
  const host = globalThis as GlobalWithInvalidationBrokers;
  const brokers =
    host[INVALIDATION_BROKERS] ?? new WeakMap<object, InvalidationBroker>();
  host[INVALIDATION_BROKERS] = brokers;
  const eventBus = pi.events as object;
  let broker = brokers.get(eventBus);
  if (broker === undefined) {
    broker = {};
    brokers.set(eventBus, broker);
    pi.events.on(HEARTH_INVALIDATE_REQUEST, (value) => {
      const current = broker?.current;
      if (current !== undefined && isInvalidationRequest(value)) {
        value.accept(current.clearCaches());
      }
    });
    pi.events.on(HEARTH_EXTERNAL_WRITER_REQUEST, (value) => {
      const current = broker?.current;
      if (current !== undefined && isExternalWriterRequest(value)) {
        value.accept(current.protectExternalWriter(value.finished));
      }
    });
  }

  return {
    activate(handlers) {
      if (broker !== undefined) broker.current = handlers;
    },
  };
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
        current.graph,
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
