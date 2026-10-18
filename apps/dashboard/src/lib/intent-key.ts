import { useState } from "react";
import { isApiError } from "./api/errors";
import { newId as defaultNewId } from "./id";

/**
 * One Idempotency-Key per write intent. The intent is the full request payload (for a deal
 * move: deal, expected revision and target stage), so a retry of the same write replays
 * the first attempt on the server instead of making a second one, and any change to the
 * payload gets a fresh key instead of `idempotency_key_reused`.
 */
export interface IntentKeys {
  /** The key for this payload: the same one until that attempt settles, a new one for a new payload. */
  keyFor(payload: unknown): string;
  /** Call when an attempt ends. A definitive answer frees the key; a lost one keeps it for the retry. */
  settle(payload: unknown, error?: unknown): void;
}

/** Same JSON for the same data, whatever the property order. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/**
 * True when the server answered for good: success or a 4xx. A network failure, a 5xx or an
 * unreadable body may hide a committed write, so the next try must reuse the key.
 */
export function isDefinitive(error: unknown): boolean {
  if (error === undefined || error === null) return true;
  if (!isApiError(error)) return false;
  if (error.kind === "network" || error.kind === "invalid_response") return false;
  return error.status !== null && error.status >= 400 && error.status < 500;
}

export function createIntentKeys(newId: () => string = defaultNewId): IntentKeys {
  const pending = new Map<string, string>();
  return {
    keyFor(payload) {
      const print = fingerprint(payload);
      let key = pending.get(print);
      if (!key) {
        key = newId();
        pending.set(print, key);
      }
      return key;
    },
    settle(payload, error) {
      if (isDefinitive(error)) pending.delete(fingerprint(payload));
    },
  };
}

/** Intent keys that live as long as the component, for one write path. */
export function useIntentKey(): IntentKeys {
  const [keys] = useState(() => createIntentKeys());
  return keys;
}
