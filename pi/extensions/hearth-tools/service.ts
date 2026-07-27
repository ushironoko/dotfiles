import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { randomUUID } from "node:crypto";
import { createHearthReadTool } from "./adapters";
import type { RuntimeState } from "./index";

export const HEARTH_SERVICE_READY = "pi-hearth-tools:service-ready:v1";
export const HEARTH_SERVICE_REQUEST = "pi-hearth-tools:service-request:v1";

export interface HearthReadService {
  generation: string;
  createReadTool(cwd: string): AgentTool<TSchema, unknown>;
}

interface ServiceRequest {
  requestId: string;
  accept(service: HearthReadService, requestId: string): void;
}

const isRequest = (value: unknown): value is ServiceRequest => {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ServiceRequest>;
  return (
    typeof candidate.requestId === "string" &&
    typeof candidate.accept === "function"
  );
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
      return createHearthReadTool(cwd, current.engine, current.settings);
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
