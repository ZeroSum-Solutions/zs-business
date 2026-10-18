import type { Context } from "hono";
import { validationError } from "@zs/core";

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

/** The Idempotency-Key header binds a write to one stored action; the session validates it. */
export const idempotencyKey = (c: Context): string | undefined => c.req.header("Idempotency-Key");
