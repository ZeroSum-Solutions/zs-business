import { describe, expect, it } from "vitest";
import { ApiError, demoError } from "../src/lib/api/errors";
import { createIntentKeys, fingerprint, isDefinitive } from "../src/lib/intent-key";

function keys() {
  let ids = 0;
  return createIntentKeys(() => `key-${++ids}`);
}

const booking = { resourceId: "showroom", startsAt: "2026-10-20T14:00:00.000Z" };
const lost = new ApiError("network", "offline");

describe("intent keys", () => {
  it("gives the same payload the same key until it settles", () => {
    const intents = keys();
    expect(intents.keyFor(booking)).toBe("key-1");
    expect(intents.keyFor({ ...booking })).toBe("key-1");
    intents.settle(booking);
    expect(intents.keyFor(booking)).toBe("key-2");
  });

  it("gives a different payload a new key", () => {
    const intents = keys();
    const first = intents.keyFor(booking);
    // Another calendar at the same instant is another booking.
    expect(intents.keyFor({ ...booking, resourceId: "repair" })).not.toBe(first);
    expect(intents.keyFor({ ...booking, startsAt: "2026-10-20T15:00:00.000Z" })).not.toBe(first);
  });

  it("keys a deal move by deal, expected revision and target stage", () => {
    const intents = keys();
    const move = { dealId: "d1", pipelineId: "p1", stageId: "deposit", expectedRevision: 3 };
    const first = intents.keyFor(move);
    expect(intents.keyFor({ ...move, expectedRevision: 4 })).not.toBe(first);
    expect(intents.keyFor({ ...move, stageId: "delivered" })).not.toBe(first);
    expect(intents.keyFor({ ...move, dealId: "d2" })).not.toBe(first);
    expect(intents.keyFor(move)).toBe(first);
  });

  it("keeps the key after a lost response or a 5xx, and frees it after a definitive answer", () => {
    const intents = keys();
    const first = intents.keyFor(booking);
    intents.settle(booking, lost);
    expect(intents.keyFor(booking)).toBe(first);
    intents.settle(booking, new ApiError("server", "boom", 503));
    expect(intents.keyFor(booking)).toBe(first);
    intents.settle(booking, demoError("Conflict", { reason: "overlap" }));
    expect(intents.keyFor(booking)).not.toBe(first);
  });

  it("settling one payload leaves another pending one alone", () => {
    const intents = keys();
    const other = { ...booking, resourceId: "repair" };
    const a = intents.keyFor(booking);
    const b = intents.keyFor(other);
    intents.settle(booking);
    expect(intents.keyFor(other)).toBe(b);
    expect(intents.keyFor(booking)).not.toBe(a);
  });
});

describe("fingerprint", () => {
  it("ignores property order at every depth", () => {
    expect(fingerprint({ a: 1, b: { c: 2, d: [1, { e: 3, f: 4 }] } })).toBe(fingerprint({ b: { d: [1, { f: 4, e: 3 }], c: 2 }, a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});

describe("isDefinitive", () => {
  it("treats success and 4xx as final, and network, 5xx and bad bodies as unknown", () => {
    expect(isDefinitive(undefined)).toBe(true);
    expect(isDefinitive(null)).toBe(true);
    expect(isDefinitive(demoError("ValidationFailed"))).toBe(true);
    expect(isDefinitive(demoError("Conflict", { reason: "stale_revision" }))).toBe(true);
    expect(isDefinitive(lost)).toBe(false);
    expect(isDefinitive(new ApiError("server", "boom", 500))).toBe(false);
    expect(isDefinitive(new ApiError("invalid_response", "bad", 200))).toBe(false);
    expect(isDefinitive(new Error("thrown by code"))).toBe(false);
  });
});
