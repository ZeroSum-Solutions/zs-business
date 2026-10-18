import { describe, expect, it } from "vitest";
import { createMemoryRateLimiter } from "../src/public/limiter.js";

describe("in-memory rate limiter (public-intake.md P-10)", () => {
  it("charges every bucket or none, and reopens after the window", () => {
    let now = 0;
    const limiter = createMemoryRateLimiter({ now: () => new Date(now) });
    const small = { limit: 1, windowMs: 1000 };
    const large = { limit: 5, windowMs: 10_000 };
    expect(limiter.take([{ key: "a", rule: small }, { key: "t", rule: large }])).toEqual({ ok: true });
    now = 400;
    expect(limiter.take([{ key: "a", rule: small }, { key: "t", rule: large }])).toEqual({ ok: false, retryAfterSeconds: 1 });
    // The refusal did not charge "t": four more fit.
    for (let i = 0; i < 4; i++) expect(limiter.take([{ key: `b${i}`, rule: small }, { key: "t", rule: large }]).ok).toBe(true);
    expect(limiter.take([{ key: "c", rule: small }, { key: "t", rule: large }])).toEqual({ ok: false, retryAfterSeconds: 10 });
    now = 1000;
    expect(limiter.take([{ key: "a", rule: small }]).ok).toBe(true);
  });
});
