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
      .toEqual({ status: 409, body: { error: { code: "Conflict", message: "Request conflicts with the current state", details: { reason: "overlap" } } } });
    expect(mapError(new Conflict("stale", { reason: "stale_revision", currentRevision: 3 })).body.error.details)
      .toEqual({ reason: "stale_revision", currentRevision: 3 });
    expect(mapError(new Error("password=hunter2"))).toEqual({ status: 500, body: { error: { code: "Internal", message: "Internal error", details: {} } } });
  });

  it("replaces pg error text with a fixed message per code", () => {
    const pgText = 'duplicate key value violates unique constraint "crm_contacts_pkey" Key (tenant_id, id)=(1a2b, 3c4d) already exists.';
    const errors = [
      new Conflict(pgText, { postgresCode: "23505", constraint: "crm_contacts_pkey" }),
      new Conflict(pgText, { reason: "id_in_use" }),
      new ActionError("ValidationFailed", pgText),
      new NotFound(pgText),
      new TenantDenied(pgText),
      new IdempotencyConflict(pgText),
    ];
    for (const error of errors) {
      const text = JSON.stringify(mapError(error).body);
      expect(text).not.toMatch(/Key \(|tenant_id|crm_contacts_pkey|23505|duplicate key/);
    }
    expect(mapError(errors[0]).body.error).toEqual({
      code: "Conflict", message: "Request conflicts with the current state", details: { reason: "concurrent_update" },
    });
  });

  it("passes only allowlisted conflict reasons", () => {
    for (const reason of ["slot_unavailable", "overlap", "stale_revision", "id_in_use", "idempotency_key_reused",
      "binding_mismatch", "concurrent_update", "split_identity", "identity_mismatch", "last_owner", "member_exists"])
      expect(mapError(new Conflict("x", { reason })).body.error.details).toEqual({ reason });
    expect(mapError(new Conflict("x", { reason: "Key (tenant_id)=(abc) exists" })).body.error.details).toEqual({ reason: "conflict" });
    expect(mapError(new Conflict("x", { reason: "constraint_crm_deals_pkey" })).body.error.details).toEqual({ reason: "conflict" });
  });
});
