// The demo adapter keeps the API's booking customer rules (booking-customer.md BC-2..BC-6): a link
// is compare-and-set on the booking's revision, an unlink clears it, a website booking refuses a
// link, an unknown booking or customer is 404, and a replayed key answers once.
import { describe, expect, it } from "vitest";
import { bookingContactResultSchema } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { SHOWROOM_ID } from "../src/lib/api/demo/seed";

const NOW = new Date("2026-10-18T13:00:00.000Z");
function adapter() {
  let ids = 0;
  return createDemoAdapter({
    clock: { now: () => NOW },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
}
let keys = 0;
const key = () => ({ idempotencyKey: `bc-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
const MISSING = "0b0b0b0b-1c1c-4d2d-8e3e-4f4f4f4f4f4f";

async function bookFree(api: ReturnType<typeof adapter>) {
  const { slots } = await api.getSlots({
    resourceId: SHOWROOM_ID, from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z", zone: "America/New_York",
  });
  return api.createBooking({ resourceId: SHOWROOM_ID, startsAt: slots[0]!.startsAt }, key());
}
async function someContact(api: ReturnType<typeof adapter>) {
  const { items } = await api.listContacts({});
  return items[0]!;
}

describe("demo adapter: the booking customer link", () => {
  it("a new booking has no customer and revision 0; a link shows the contact on the list and the detail", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const before = await api.getBooking(booking.id);
    expect(before).toMatchObject({ customer: null, customerRevision: 0 });
    const ana = await someContact(api);
    const linked = bookingContactResultSchema.parse(await api.linkBookingContact({ bookingId: booking.id, contactId: ana.id, expectedRevision: 0 }, key()));
    expect(linked).toEqual({
      bookingId: booking.id, customer: { contactId: ana.id, name: ana.displayName, status: "linked" }, revision: 1,
    });
    expect(await api.getBooking(booking.id)).toMatchObject({ customerRevision: 1, customer: { contactId: ana.id } });
    const listed = (await api.listBookings({ resourceId: SHOWROOM_ID })).items.find((item) => item.id === booking.id);
    expect(listed?.customer).toEqual({ contactId: ana.id, name: ana.displayName, status: "linked" });
  });

  it("a stale revision is a 409 with the current one; unlink clears; a pre-unlink revision stays stale", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const [first, second] = (await api.listContacts({})).items;
    await api.linkBookingContact({ bookingId: booking.id, contactId: first!.id, expectedRevision: 0 }, key());
    const stale = await failure(api.linkBookingContact({ bookingId: booking.id, contactId: second!.id, expectedRevision: 0 }, key()));
    expect(stale).toMatchObject({ kind: "conflict", status: 409, details: { reason: "stale_revision", currentRevision: 1 } });
    const cleared = await api.unlinkBookingContact({ bookingId: booking.id, expectedRevision: 1 }, key());
    expect(cleared).toEqual({ bookingId: booking.id, customer: null, revision: 2 });
    expect(await api.getBooking(booking.id)).toMatchObject({ customer: null, customerRevision: 2 });
    expect(await failure(api.linkBookingContact({ bookingId: booking.id, contactId: second!.id, expectedRevision: 1 }, key())))
      .toMatchObject({ details: { reason: "stale_revision", currentRevision: 2 } });
    expect((await api.linkBookingContact({ bookingId: booking.id, contactId: second!.id, expectedRevision: 2 }, key())).revision).toBe(3);
  });

  it("naming the same customer again, or clearing none, changes nothing", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const ana = await someContact(api);
    await api.linkBookingContact({ bookingId: booking.id, contactId: ana.id, expectedRevision: 0 }, key());
    expect((await api.linkBookingContact({ bookingId: booking.id, contactId: ana.id, expectedRevision: 1 }, key())).revision).toBe(1);
    await api.unlinkBookingContact({ bookingId: booking.id, expectedRevision: 1 }, key());
    expect((await api.unlinkBookingContact({ bookingId: booking.id, expectedRevision: 2 }, key())).revision).toBe(2);
  });

  it("refuses a website booking with intake_booking, and an unknown booking or customer with 404", async () => {
    const api = adapter();
    const website = (await api.listBookings({})).items.find((item) => item.source === "website")!;
    const ana = await someContact(api);
    expect(await failure(api.linkBookingContact({ bookingId: website.id, contactId: ana.id, expectedRevision: 0 }, key())))
      .toMatchObject({ kind: "conflict", details: { reason: "intake_booking" } });
    const booking = await bookFree(api);
    expect(await failure(api.linkBookingContact({ bookingId: MISSING, contactId: ana.id, expectedRevision: 0 }, key()))).toMatchObject({ kind: "not_found" });
    expect(await failure(api.linkBookingContact({ bookingId: booking.id, contactId: MISSING, expectedRevision: 0 }, key()))).toMatchObject({ kind: "not_found" });
    expect(await failure(api.getBooking(MISSING))).toMatchObject({ kind: "not_found" });
  });

  it("replays one key once, and refuses the same key with another payload", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const [first, second] = (await api.listContacts({})).items;
    const options = key();
    const input = { bookingId: booking.id, contactId: first!.id, expectedRevision: 0 };
    const one = await api.linkBookingContact(input, options);
    expect(await api.linkBookingContact(input, options)).toEqual(one);
    expect(api.writeLog().filter((write) => write.operation === "booking.contact.link").map((write) => write.outcome)).toEqual(["applied", "replayed"]);
    expect(await failure(api.linkBookingContact({ ...input, contactId: second!.id }, options)))
      .toMatchObject({ details: { reason: "idempotency_key_reused" } });
  });

  it("filters by contact, and an owner link replaces the seed's label", async () => {
    const api = adapter();
    const labelled = (await api.listBookings({})).items.find((item) => item.source === "owner" && item.contactName);
    expect(labelled).toBeDefined();
    const ana = await someContact(api);
    await api.linkBookingContact({ bookingId: labelled!.id, contactId: ana.id, expectedRevision: 0 }, key());
    const mine = (await api.listBookings({ contactId: ana.id })).items;
    expect(mine.map((item) => item.id)).toContain(labelled!.id);
    expect(mine.find((item) => item.id === labelled!.id)?.contactName).toBeNull();
    await api.unlinkBookingContact({ bookingId: labelled!.id, expectedRevision: 1 }, key());
    expect((await api.listBookings({ contactId: ana.id })).items.map((item) => item.id)).not.toContain(labelled!.id);
    // Cleared on purpose: the old label does not come back.
    expect((await api.listBookings({})).items.find((item) => item.id === labelled!.id)?.contactName).toBeNull();
  });

  it("failNextBookingLink makes one link fail before it saves; the retry with the same key applies", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const ana = await someContact(api);
    const input = { bookingId: booking.id, contactId: ana.id, expectedRevision: 0 };
    const options = key();
    api.failNextBookingLink();
    expect(await failure(api.linkBookingContact(input, options))).toMatchObject({ kind: "network" });
    expect(await api.getBooking(booking.id)).toMatchObject({ customer: null, customerRevision: 0 });
    expect((await api.linkBookingContact(input, options)).revision).toBe(1);
    // Only the one call failed.
    expect((await api.unlinkBookingContact({ bookingId: booking.id, expectedRevision: 1 }, key())).revision).toBe(2);
  });

  it("raceNextBookingLink lets someone else link first: the link is stale, and a read gives the revision to retry with", async () => {
    const api = adapter();
    const booking = await bookFree(api);
    const ana = (await api.listContacts({})).items[0]!;
    const input = { bookingId: booking.id, contactId: ana.id, expectedRevision: 0 };
    api.raceNextBookingLink();
    expect(await failure(api.linkBookingContact(input, key()))).toMatchObject({ details: { reason: "stale_revision", currentRevision: 1 } });
    const now = await api.getBooking(booking.id);
    expect(now.customerRevision).toBe(1);
    expect(now.customer?.contactId).not.toBe(ana.id);
    expect((await api.linkBookingContact({ ...input, expectedRevision: now.customerRevision }, key())).revision).toBe(2);
  });
});
