import type { Context } from "hono";
import { UnreadBody, validationError } from "@zs/core";

/** Parse a JSON body; malformed JSON is a 400 with the shared error shape. */
export async function jsonBody(c: Context): Promise<unknown> {
  const type = c.req.header("Content-Type") ?? "";
  if (!/^application\/json\b/i.test(type))
    throw validationError("Invalid request", [{ path: [], message: "Content-Type must be application/json" }]);
  try {
    return await c.req.json();
  } catch {
    throw validationError("Invalid request", [{ path: [], message: "Body is not valid JSON" }]);
  }
}

/**
 * Like `jsonBody`, but a body that cannot be read comes back as an `UnreadBody` for the session to throw
 * after its permission check, so a caller without the permission gets 403, not 400.
 */
export async function deferredJsonBody(c: Context): Promise<unknown> {
  try {
    return await jsonBody(c);
  } catch (error) {
    return new UnreadBody(error);
  }
}

/** The Idempotency-Key header binds a write to one stored action; the session validates it. */
export const idempotencyKey = (c: Context): string | undefined => c.req.header("Idempotency-Key");
