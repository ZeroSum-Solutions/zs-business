// Small helpers the session factories share. A leaf module: it takes only types from ./session,
// so every session file can import it without a cycle.
import { TenantDenied, type JsonValue } from "@zs/contracts";
import type { Authorize } from "./session.js";

/** Allow only these action types through a direct dispatch; any other is denied as the wrong tenant. */
export const only = (...actionTypes: string[]): Authorize => async (_tx, binding) => {
  if (!actionTypes.includes(binding.actionType)) throw new TenantDenied();
};

/** A parsed value as the JSON a payload carries: optional keys left out are absent, never `undefined`. */
export const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
