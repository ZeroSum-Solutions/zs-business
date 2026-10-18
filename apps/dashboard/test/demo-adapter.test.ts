import { describe, expect, it } from "vitest";
import { ApiError, isSlotTaken, isStaleRevision } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_PIPELINE, REPAIR_ID, SHOWROOM_ID } from "../src/lib/api/demo/seed";

// Sunday 2026-10-18, 09:00 in New York.
const NOW = new Date("2026-10-18T13:00:00.000Z");

function adapter() {
  let ids = 0;
  return createDemoAdapter({
    clock: { now: () => NOW },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
}

let keys = 0;
/** A fresh caller-owned Idempotency-Key. */
const key = () => ({ idempotencyKey: `test-key-${++keys}` });

const week = { from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z", zone: "America/New_York" };

describe("demo adapter: booking", () => {
  it("lists open slots inside open hours and outside existing bookings", async () => {
    const api = adapter();
    const { slots, timeZone, zone } = await api.getSlots({ resourceId: SHOWROOM_ID, ...week });
    expect(timeZone).toBe("America/New_York");
    expect(zone).toBe("America/New_York");
    expect(slots.length).toBeGreaterThan(10);
    // Tuesday 10:00 local is 14:00 UTC in October (EDT).
    expect(slots[0]).toMatchObject({ startsAt: "2026-10-20T14:00:00.000Z", localStart: "2026-10-20T10:00:00" });
    const booked = await api.listBookings({ resourceId: SHOWROOM_ID, from: week.from, to: week.to });
    for (const booking of booked.items) {
      expect(slots.some((slot) => slot.startsAt === booking.startsAt)).toBe(false);
    }
  });

  it("books a free slot and removes it from the list", async () => {
    const api = adapter();
    const before = await api.getSlots({ resourceId: REPAIR_ID, ...week });
    const slot = before.slots[0]!;
    const record = await api.createBooking({ resourceId: REPAIR_ID, startsAt: slot.startsAt }, key());
    expect(record).toMatchObject({ resourceId: REPAIR_ID, startsAt: slot.startsAt, endsAt: slot.endsAt, status: "confirmed" });
    expect(Date.parse(record.occupiedEndsAt) - Date.parse(record.endsAt)).toBe(record.bufferAfterMinutes * 60000);
    const after = await api.getSlots({ resourceId: REPAIR_ID, ...week });
    expect(after.slots.some((item) => item.startsAt === slot.startsAt)).toBe(false);
  });

  it("returns a 409 conflict when someone else took the slot first", async () => {
    const api = adapter();
    const { slots } = await api.getSlots({ resourceId: SHOWROOM_ID, ...week });
    const slot = slots[0]!;
    api.bookAsSomeoneElse(SHOWROOM_ID, slot.startsAt);
    const error = await api.createBooking({ resourceId: SHOWROOM_ID, startsAt: slot.startsAt }, key()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ kind: "conflict", status: 409, code: "Conflict", reason: "overlap" });
    expect(isSlotTaken(error)).toBe(true);
    expect((error as ApiError).message).toBe("That time was just taken.");
  });

  it("only lets one of two concurrent creates for the same time win", async () => {
    const api = adapter();
    const { slots } = await api.getSlots({ resourceId: SHOWROOM_ID, ...week });
    const startsAt = slots[2]!.startsAt;
    const results = await Promise.allSettled([
      api.createBooking({ resourceId: SHOWROOM_ID, startsAt }, key()),
      api.createBooking({ resourceId: SHOWROOM_ID, startsAt }, key()),
    ]);
    expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((item) => item.status === "rejected");
    expect((rejected as PromiseRejectedResult).reason).toMatchObject({ kind: "conflict" });
  });

  it("replays the same result for the same idempotency key and rejects a reused key", async () => {
    const api = adapter();
    const { slots } = await api.getSlots({ resourceId: SHOWROOM_ID, ...week });
    const input = { resourceId: SHOWROOM_ID, startsAt: slots[1]!.startsAt };
    const first = await api.createBooking(input, { idempotencyKey: "k-1" });
    const replay = await api.createBooking(input, { idempotencyKey: "k-1" });
    expect(replay).toEqual(first);
    await expect(api.createBooking({ ...input, startsAt: slots[3]!.startsAt }, { idempotencyKey: "k-1" }))
      .rejects.toMatchObject({ kind: "conflict", code: "Conflict", reason: "idempotency_key_reused" });
  });

  it("refuses a time outside open hours as an unavailable slot, like the API", async () => {
    const api = adapter();
    // Monday 03:00 in New York.
    await expect(api.createBooking({ resourceId: SHOWROOM_ID, startsAt: "2026-10-19T07:00:00.000Z" }, key()))
      .rejects.toMatchObject({ kind: "conflict", status: 409, reason: "slot_unavailable" });
  });
});

describe("demo adapter: CRM", () => {
  it("finds the existing customer for a known email instead of creating a duplicate", async () => {
    const api = adapter();
    const before = await api.listContacts();
    const result = await api.createOrFindContact({ displayName: "Marguerite O.", email: "  Marguerite.Okafor@EXAMPLE.com ", phone: null }, key());
    expect(result.created).toBe(false);
    expect(result.contact.displayName).toBe("Marguerite Okafor");
    expect((await api.listContacts()).items).toHaveLength(before.items.length);
  });

  it("creates a new customer and finds them by search", async () => {
    const api = adapter();
    const result = await api.createOrFindContact({ displayName: "Lior Benzaquen", email: "lior.b@example.com", phone: "+1 (646) 555-0177" }, key());
    expect(result.created).toBe(true);
    expect(result.contact.phone).toBe("+16465550177");
    const found = await api.listContacts({ search: "benzaq" });
    expect(found.items.map((item) => item.id)).toEqual([result.contact.id]);
    expect(found.incomplete).toBe(false);
  });

  it("rejects a contact with no email or phone", async () => {
    const api = adapter();
    await expect(api.createOrFindContact({ displayName: "No details", email: null, phone: null }, key()))
      .rejects.toMatchObject({ kind: "validation" });
  });

  it("points a bad email at the email field, as the API's issue paths do", async () => {
    const api = adapter();
    const error = await api.createOrFindContact({ displayName: null, email: "not-an-email", phone: null }, key()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "validation", status: 400, code: "ValidationFailed", field: "email" });
  });

  it("moves a deal and bumps its revision", async () => {
    const api = adapter();
    const [deal] = (await api.listDeals()).items;
    const moved = await api.moveDealStage({
      dealId: deal!.id, pipelineId: DEMO_PIPELINE.id, stageId: DEMO_PIPELINE.stages[4]!.id, expectedRevision: deal!.revision,
    }, key());
    expect(moved.stageId).toBe(DEMO_PIPELINE.stages[4]!.id);
    expect(moved.revision).toBe(deal!.revision + 1);
  });

  it("returns a 409 conflict for a stale revision", async () => {
    const api = adapter();
    const [deal] = (await api.listDeals()).items;
    api.editDealElsewhere(deal!.id);
    const error = await api.moveDealStage({
      dealId: deal!.id, pipelineId: DEMO_PIPELINE.id, stageId: DEMO_PIPELINE.stages[1]!.id, expectedRevision: deal!.revision,
    }, key()).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "conflict", status: 409, code: "Conflict", details: { reason: "stale_revision", currentRevision: deal!.revision + 1 } });
    expect(isStaleRevision(error)).toBe(true);
  });
});

describe("demo adapter: lost responses", () => {
  it("applies a write whose response is lost, and replays it for a retry with the same key", async () => {
    const api = adapter();
    const { slots } = await api.getSlots({ resourceId: SHOWROOM_ID, ...week });
    const startsAt = slots[0]!.startsAt;
    api.loseNextResponse();
    const lost = await api.createBooking({ resourceId: SHOWROOM_ID, startsAt }, { idempotencyKey: "k1" }).catch((caught: unknown) => caught);
    expect(lost).toMatchObject({ kind: "network" });
    const replay = await api.createBooking({ resourceId: SHOWROOM_ID, startsAt }, { idempotencyKey: "k1" });
    expect(replay.startsAt).toBe(startsAt);
    // A new key for the same time is a second booking, which overlaps the first.
    const second = await api.createBooking({ resourceId: SHOWROOM_ID, startsAt }, { idempotencyKey: "k2" }).catch((caught: unknown) => caught);
    expect(isSlotTaken(second)).toBe(true);
    expect(api.writeLog()).toEqual([
      { operation: "booking.create", idempotencyKey: "k1", outcome: "applied" },
      { operation: "booking.create", idempotencyKey: "k1", outcome: "replayed" },
      { operation: "booking.create", idempotencyKey: "k2", outcome: "rejected" },
    ]);
  });

  it("fails every call while offline without touching the data", async () => {
    const api = adapter();
    api.setOffline(true);
    await expect(api.listDeals()).rejects.toMatchObject({ kind: "network" });
    await expect(api.createOrFindContact({ displayName: null, email: "a@example.com", phone: null }, key())).rejects.toMatchObject({ kind: "network" });
    api.setOffline(false);
    expect(api.writeLog()).toEqual([]);
  });

  it("refuses a write without a caller-owned Idempotency-Key instead of making one up", async () => {
    const api = adapter();
    const { slots } = await api.getSlots({ resourceId: SHOWROOM_ID, ...week });
    // @ts-expect-error: the key is required; this is the call a forgetful caller would make.
    await expect(api.createBooking({ resourceId: SHOWROOM_ID, startsAt: slots[0]!.startsAt })).rejects.toBeInstanceOf(TypeError);
    await expect(api.createBooking({ resourceId: SHOWROOM_ID, startsAt: slots[0]!.startsAt }, { idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError);
    expect(api.writeLog()).toEqual([]);
  });
});
