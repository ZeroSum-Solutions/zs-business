import { describe, expect, it } from "vitest";
import {
  actionCommandSchema,
  BindingMismatch,
  Conflict,
  IdempotencyConflict,
  NotImplemented,
  TenantDenied,
  ValidationFailed,
} from "../src/index.js";

describe("action boundary", () => {
  it("rejects malformed commands before dispatch", () => {
    expect(
      actionCommandSchema.safeParse({ actionType: "", payload: undefined })
        .success,
    ).toBe(false);
  });
  it("exposes stable typed error codes", () => {
    for (const [ErrorType, code] of [
      [NotImplemented, "NotImplemented"],
      [IdempotencyConflict, "IdempotencyConflict"],
      [BindingMismatch, "BindingMismatch"],
      [TenantDenied, "TenantDenied"],
      [Conflict, "Conflict"],
      [ValidationFailed, "ValidationFailed"],
    ] as const) {
      expect(new ErrorType("test")).toMatchObject({ code, name: code });
      expect(new ErrorType("test")).toBeInstanceOf(Error);
    }
  });
});
