import { describe, expect, it } from "vitest";
import {
  actionCommandSchema,
  jsonValueSchema,
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

describe("Postgres JSON boundary", () => {
  it.each(["\u0000", "\ud800", "\udfff"])(
    "rejects text Postgres cannot store: %j",
    (value) => {
      expect(jsonValueSchema.safeParse({ note: value }).success).toBe(false);
    },
  );
  it("bounds recursive input before parsing and rejects cycles", () => {
    let nested: unknown = 0;
    for (let i = 0; i < 100; i++) nested = [nested];
    expect(jsonValueSchema.safeParse(nested).success).toBe(false);
    expect(jsonValueSchema.safeParse("x".repeat(300000)).success).toBe(false);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(jsonValueSchema.safeParse(cyclic).success).toBe(false);
  });
  it("accepts valid unicode and ordinary nested JSON", () => {
    expect(
      jsonValueSchema.parse({ emoji: "😀", nested: [null, true, 1, "text"] }),
    ).toEqual({ emoji: "😀", nested: [null, true, 1, "text"] });
  });
});
