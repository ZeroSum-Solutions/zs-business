import { describe, expect, it } from "vitest";
import { ActionError, Conflict, IdempotencyConflict, NotFound, TenantDenied, uuidSchema } from "@zs/contracts";
import { derivedId, mapError } from "../src/index.js";

describe("derivedId", () => {
  it("is a deterministic valid UUID that changes with any part", () => {
    const id = derivedId("tenant", "key", "booking");
    expect(uuidSchema.parse(id)).toBe(id);
    expect(derivedId("tenant", "key", "booking")).toBe(id);
    expect(derivedId("tenant", "key", "deal")).not.toBe(id);
    expect(derivedId("tenant", "keybooking")).not.toBe(derivedId("tenant", "key", "booking"));
  });
});

describe("mapError", () => {
  it("maps action errors to statuses without leaking SQL details", () => {
    expect(mapError(new ActionError("ValidationFailed", "Invalid request", { issues: [{ path: "a", message: "m" }] })))
      .toEqual({ status: 400, body: { error: { code: "ValidationFailed", message: "Invalid request", details: { issues: [{ path: "a", message: "m" }] } } } });
    expect(mapError(new TenantDenied()).status).toBe(403);
    expect(mapError(new NotFound()).status).toBe(404);
    expect(mapError(new IdempotencyConflict()).body.error.details).toEqual({ reason: "idempotency_key_reused" });
    expect(mapError(new Conflict("Database transaction conflicted", { postgresCode: "23P01", constraint: "bookings_resource_occupied_excl" })))
      .toEqual({ status: 409, body: { error: { code: "Conflict", message: "Database transaction conflicted", details: { reason: "overlap" } } } });
    expect(mapError(new Conflict("stale", { reason: "stale_revision", currentRevision: 3 })).body.error.details)
      .toEqual({ reason: "stale_revision", currentRevision: 3 });
    expect(mapError(new Error("password=hunter2"))).toEqual({ status: 500, body: { error: { code: "Internal", message: "Internal error", details: {} } } });
  });
});
