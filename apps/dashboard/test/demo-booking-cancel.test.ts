// The demo adapter keeps the API's cancel rules (booking.md B-29..B-35): a cancelled booking leaves the
// default list and frees its time, a replayed key answers once, a second key says already_cancelled,
// an ended booking is booking_over, and an unknown booking is 404.
import { describe, expect, it } from "vitest";
import { cancelBookingResultSchema } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { SHOWROOM_ID } from "../src/lib/api/demo/seed";

const NOW = new Date("2026-10-18T13:00:00.000Z");
function adapter(now = NOW) {
  let ids = 0;
  return createDemoAdapter({
    clock: { now: () => now },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
}
let keys = 0;
const key = () => ({ idempotencyKey: `cancel-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
const MISSING = "0b0b0b0b-1c1c-4d2d-8e3e-4f4f4f4f4f4f";

async function bookFree(api: ReturnType<typeof adapter>) {
  const { slots } = await api.getSlots({
    resourceId: SHOWROOM_ID, from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z", zone: "America/New_York",
  });
  return api.createBooking({ resourceId: SHOWROOM_ID, startsAt: slots[0]!.startsAt }, key());
}
const listed = async (api: ReturnType<typeof adapter>, status?: "confirmed" | "cancelled" | "all") =>
  (await api.listBookings({ resourceId: SHOWROOM_ID, ...(status ? { status } : {}) })).items.map((item) => item.id);

describe("demo adapter: cancelling a booking", () => {
  it("moves it off the default list, keeps it under cancelled and all, and frees the time", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    expect(await listed(api)).toContain(booking.id);
    const done = cancelBookingResultSchema.parse(await api.cancelBooking({ bookingId: booking.id, reason: "Owner away" }, key()));
    expect(done).toMatchObject({ booking: { id: booking.id, status: "cancelled" }, reason: "Owner away", customerNotice: "no_customer" });
    expect(await listed(api)).not.toContain(booking.id);
    expect(await listed(api, "cancelled")).toContain(booking.id);
    expect(await listed(api, "all")).toContain(booking.id);
    expect(await api.getBooking(booking.id)).toMatchObject({ cancellationReason: "Owner away" });
    // The same time books again.
    const again = await api.createBooking({ resourceId: SHOWROOM_ID, startsAt: booking.startsAt }, key());
    expect(again.id).not.toBe(booking.id);
  });

  it("replays one key, and says already_cancelled for a new key", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const same = key();
    const first = await api.cancelBooking({ bookingId: booking.id }, same);
    expect(await api.cancelBooking({ bookingId: booking.id }, same)).toEqual(first);
    expect(await api.cancelBooking({ bookingId: booking.id, reason: "Later" }, key())).toMatchObject({
      customerNotice: "already_cancelled", reason: null, cancelledAt: first.cancelledAt,
    });
    expect(await failure(api.cancelBooking({ bookingId: booking.id, reason: "Other" }, same))).toMatchObject({ details: { reason: "idempotency_key_reused" } });
  });

  it("queues an email for a linked customer with an address, and respects notifyCustomer false", async () => {
    const api = adapter();
    const contact = (await api.listContacts({})).items.find((item) => item.email)!;
    const [one, two] = [await bookFree(api), await api.createBooking({
      resourceId: SHOWROOM_ID,
      startsAt: (await api.getSlots({ resourceId: SHOWROOM_ID, from: "2026-10-20T04:00:00.000Z", to: "2026-10-27T04:00:00.000Z", zone: "America/New_York" })).slots[3]!.startsAt,
    }, key())];
    for (const booking of [one, two]) await api.linkBookingContact({ bookingId: booking.id, contactId: contact.id, expectedRevision: 0 }, key());
    expect((await api.cancelBooking({ bookingId: one.id }, key())).customerNotice).toBe("queued");
    expect((await api.cancelBooking({ bookingId: two.id, notifyCustomer: false }, key())).customerNotice).toBe("off");
  });

  it("refuses a booking that has ended, rejects a bad body, and answers 404 for an unknown booking", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const later = adapter(new Date(Date.parse(booking.endsAt) + 60_000));
    const old = (await later.listBookings({})).items.find((item) => item.endsAt < new Date(Date.parse(booking.endsAt) + 60_000).toISOString());
    expect(old).toBeDefined();
    expect(await failure(later.cancelBooking({ bookingId: old!.id }, key()))).toMatchObject({ kind: "conflict", details: { reason: "booking_over" } });
    expect(await failure(api.cancelBooking({ bookingId: booking.id, reason: "x".repeat(501) }, key()))).toMatchObject({ kind: "validation" });
    expect(await failure(api.cancelBooking({ bookingId: MISSING }, key()))).toMatchObject({ kind: "not_found" });
    expect((await api.getBooking(booking.id)).status).toBe("confirmed");
  });

  it("a website request stops showing its booking once the booking is cancelled (B-32)", async () => {
    const api = adapter();
    const withBooking = (await api.listIntakeItems({})).items.filter((item) => item.booking);
    expect(withBooking.length).toBeGreaterThan(0);
    const item = withBooking[0]!;
    await api.cancelBooking({ bookingId: item.booking!.id, notifyCustomer: false }, key());
    expect((await api.listIntakeItems({})).items.find((row) => row.id === item.id)?.booking).toBeNull();
  });

  it("fingerprints the canonical request and accepts an upper-case booking ID (B-29)", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const same = { idempotencyKey: "canonical-key" };
    const first = await api.cancelBooking({ bookingId: booking.id.toUpperCase() }, same);
    const again = await api.cancelBooking({ bookingId: booking.id, reason: null, notifyCustomer: true }, same);
    expect(again).toEqual(first);
  });

  it("treats a placeholder address as no email (D-1)", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const { contact } = await api.createOrFindContact({ displayName: "Placeholder", email: "nobody@placeholder.invalid", phone: null }, key());
    const detail = await api.getBooking(booking.id);
    await api.linkBookingContact({ bookingId: booking.id, contactId: contact.id, expectedRevision: detail.customerRevision }, key());
    expect((await api.cancelBooking({ bookingId: booking.id }, key())).customerNotice).toBe("no_email");
  });
});
