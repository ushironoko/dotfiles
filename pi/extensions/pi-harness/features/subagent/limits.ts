/**
 * Bounds shared by the subagent tool's runtime enforcement (index.ts) and its
 * model-facing parameter schema (pi/schemas/subagent.ts, baked into
 * parameters.generated.ts as maxItems). Single source of truth so the schema's
 * advertised cap can never drift from the cap the handler actually enforces.
 */
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CHAIN_DEPTH = 8; // matches MAX_PARALLEL_TASKS
