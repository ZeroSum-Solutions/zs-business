// The demo adapter's business profile keeps the API's rules (business-profile.md BP-5..BP-7, BP-11):
// anyone reads it, only an owner saves, a save names the revision it started from, field errors
// name their path, and a replayed key answers once.
import { describe, expect, it } from "vitest";
import { businessProfileSchema } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_BUSINESS } from "../src/lib/api/demo/seed";

const NOW = new Date("2026-10-23T10:00:00.000Z");
const adapter = () => createDemoAdapter({ clock: { now: () => NOW } });
let keys = 0;
const key = () => ({ idempotencyKey: `business-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);

describe("demo adapter: business profile", () => {
  it("starts as a new business does: the name, US dollars, nothing else, revision 1", async () => {
    const profile = businessProfileSchema.parse(await adapter().getBusiness());
    expect(profile).toEqual({
      displayName: DEMO_BUSINESS, legalName: null, phoneE164: null, timeZone: null, currency: "USD", postalAddress: null,
      revision: 1, updatedAt: NOW.toISOString(),
    });
  });

  it("saves legal name, zone and currency at revision 2, and the read returns them", async () => {
    const api = adapter();
    const saved = await api.updateBusiness({ expectedRevision: 1, changes: { legalName: "Halden & Rowe Ltd", timeZone: "Europe/London", currency: "EUR" } }, key());
    expect(saved).toMatchObject({ legalName: "Halden & Rowe Ltd", timeZone: "Europe/London", currency: "EUR", revision: 2, displayName: DEMO_BUSINESS });
    expect(await api.getBusiness()).toEqual(saved);
  });

  it("clears a field with null and keeps one it does not name", async () => {
    const api = adapter();
    await api.updateBusiness({ expectedRevision: 1, changes: { phoneE164: "+442079460000", legalName: "Halden & Rowe Ltd" } }, key());
    const cleared = await api.updateBusiness({ expectedRevision: 2, changes: { phoneE164: null } }, key());
    expect(cleared).toMatchObject({ phoneE164: null, legalName: "Halden & Rowe Ltd", revision: 3 });
  });

  it("refuses a stale revision with the current one", async () => {
    const api = adapter();
    api.editBusinessElsewhere();
    const error = await failure(api.updateBusiness({ expectedRevision: 1, changes: { currency: "GBP" } }, key()));
    expect(error).toMatchObject({ kind: "conflict", reason: "stale_revision", details: { currentRevision: 2 } });
    expect((await api.getBusiness()).currency).toBe("USD");
  });

  it("answers a staff member's save with 403 and still lets them read", async () => {
    const api = adapter();
    api.actAs("staff");
    expect(await failure(api.updateBusiness({ expectedRevision: 1, changes: { currency: "GBP" } }, key()))).toMatchObject({ kind: "forbidden", status: 403 });
    expect((await api.getBusiness()).revision).toBe(1);
  });

  it("names the path of a bad zone, currency or phone", async () => {
    const api = adapter();
    for (const [changes, path] of [
      [{ timeZone: "Mars/Base" }, "changes.timeZone"],
      [{ currency: "XXZ" }, "changes.currency"],
      [{ phoneE164: "020 7946 0000" }, "changes.phoneE164"],
    ] as const) {
      const error = await failure(api.updateBusiness({ expectedRevision: 1, changes } as never, key()));
      expect(error, path).toMatchObject({ kind: "validation", details: { issues: [{ path }] } });
    }
    expect((await api.getBusiness()).revision).toBe(1);
  });

  it("applies a save once when the same key is sent again, and refuses the key for another body", async () => {
    const api = adapter();
    const options = key();
    const first = await api.updateBusiness({ expectedRevision: 1, changes: { currency: "EUR" } }, options);
    const again = await api.updateBusiness({ expectedRevision: 1, changes: { currency: "EUR" } }, options);
    expect(again).toEqual(first);
    expect((await api.getBusiness()).revision).toBe(2);
    expect(await failure(api.updateBusiness({ expectedRevision: 1, changes: { currency: "GBP" } }, options))).toMatchObject({ reason: "idempotency_key_reused" });
  });

  it("is in memory: a new adapter starts from the sample again", async () => {
    const first = adapter();
    await first.updateBusiness({ expectedRevision: 1, changes: { displayName: "Changed" } }, key());
    expect((await adapter().getBusiness()).displayName).toBe(DEMO_BUSINESS);
  });
});
