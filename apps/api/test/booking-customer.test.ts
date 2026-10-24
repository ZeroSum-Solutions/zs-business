import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  bookingContactOutputSchema,
  bookingDetailSchema,
  bookingPageSchema,
  createBookingOutputSchema,
} from "@zs/contracts";
import { call, createApiHarness, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";

// booking-customer.md BC-3..BC-6, BC-10 over HTTP, as zs_runtime on a real database: a staff member
// books and links Ana Ruiz, the list and detail show her as linked, a stale revision conflicts, an
// unlink clears her, and tenant B gets 404 for tenant A's booking.
let h: ApiHarness;
let staff: MemberSetup;
beforeAll(async () => {
  h = await createApiHarness();
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
});
afterAll(async () => { await h?.close(); });

const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
async function book(startsAt: string, member: Pick<MemberSetup, "token"> = h.a) {
  const response = await call(h.app, "POST", "/v1/booking/bookings", {
    token: member.token, key: randomUUID(), body: { resourceId: h.a.resourceId, startsAt },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return createBookingOutputSchema.parse(response.body).result.id;
}
async function newContact(displayName: string, member: Pick<MemberSetup, "token"> = h.a) {
  const response = await call(h.app, "POST", "/v1/crm/contacts", {
    token: member.token, key: randomUUID(), body: { displayName, email: `${randomUUID().slice(0, 8)}@example.com` },
  });
  expect(response.status, JSON.stringify(response.body)).toBeLessThan(300);
  return (response.body as { result: { contact: { id: string } } }).result.contact.id;
}
const link = (id: string, body: unknown, member: Pick<MemberSetup, "token"> = h.a, key: string | null = randomUUID()) =>
  call(h.app, "POST", `/v1/booking/bookings/${id}/contact/link`, { token: member.token, body, ...(key === null ? {} : { key }) });
const unlink = (id: string, body: unknown, member: Pick<MemberSetup, "token"> = h.a, key: string | null = randomUUID()) =>
  call(h.app, "POST", `/v1/booking/bookings/${id}/contact/unlink`, { token: member.token, body, ...(key === null ? {} : { key }) });
const detail = async (id: string, member: Pick<MemberSetup, "token"> = h.a) =>
  call(h.app, "GET", `/v1/booking/bookings/${id}`, { token: member.token });

describe("the booking customer link over HTTP", () => {
  it("a staff member books at 10:00 and links Ana Ruiz; the list and the detail show her as linked", async () => {
    const id = await book("2026-10-19T10:00:00.000Z", staff);
    const ana = await newContact("Ana Ruiz", staff);
    const before = bookingDetailSchema.parse((await detail(id, staff)).body);
    expect(before).toMatchObject({ customer: null, customerRevision: 0 });

    const linked = await link(id, { contactId: ana, expectedRevision: 0 }, staff);
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(bookingContactOutputSchema.parse(linked.body).result).toEqual({
      bookingId: id, customer: { contactId: ana, name: "Ana Ruiz", status: "linked" }, revision: 1,
    });
    const listed = bookingPageSchema.parse((await call(h.app, "GET", "/v1/booking/bookings?limit=100", { token: staff.token })).body);
    expect(listed.items.find((item) => item.id === id)?.customer).toEqual({ contactId: ana, name: "Ana Ruiz", status: "linked" });
    expect(bookingDetailSchema.parse((await detail(id, staff)).body)).toMatchObject({ customer: { name: "Ana Ruiz" }, customerRevision: 1 });
    // The contact page filter.
    const byContact = bookingPageSchema.parse((await call(h.app, "GET", `/v1/booking/bookings?contactId=${ana}&limit=100`, { token: staff.token })).body);
    expect(byContact.items.map((item) => item.id)).toEqual([id]);
  });

  it("a stale revision is 409 with the current one; an unlink returns the booking to no customer", async () => {
    const id = await book("2026-10-19T11:00:00.000Z");
    const [ana, ben] = [await newContact("Ana R"), await newContact("Ben O")];
    expect((await link(id, { contactId: ana, expectedRevision: 0 })).status).toBe(200);
    const stale = await link(id, { contactId: ben, expectedRevision: 0 });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 1 } });

    // An unlink that read the booking before anyone linked it (revision 0) is stale, not malformed.
    const staleUnlink = await unlink(id, { expectedRevision: 0 });
    expect(staleUnlink.status).toBe(409);
    expect(errorOf(staleUnlink)).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 1 } });

    const cleared = await unlink(id, { expectedRevision: 1 });
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(bookingContactOutputSchema.parse(cleared.body).result).toEqual({ bookingId: id, customer: null, revision: 2 });
    expect(bookingDetailSchema.parse((await detail(id)).body)).toMatchObject({ customer: null, customerRevision: 2 });
    // The revision read before the unlink stays stale after a relink.
    expect((await link(id, { contactId: ben, expectedRevision: 1 })).status).toBe(409);
    expect((await link(id, { contactId: ben, expectedRevision: 2 })).status).toBe(200);
  });

  it("replays a link with the same key once", async () => {
    const id = await book("2026-10-19T12:00:00.000Z");
    const ana = await newContact("Replay Ana");
    const key = randomUUID();
    const first = await link(id, { contactId: ana, expectedRevision: 0 }, h.a, key);
    const again = await link(id, { contactId: ana, expectedRevision: 0 }, h.a, key);
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.body).toEqual(first.body);
  });

  it("refuses a missing key, a bad body and an unknown field with 400", async () => {
    const id = await book("2026-10-19T13:00:00.000Z");
    const ana = await newContact("Body Ana");
    expect((await link(id, { contactId: ana, expectedRevision: 0 }, h.a, null)).status).toBe(400);
    expect((await link(id, { contactId: ana }, h.a)).status).toBe(400);
    expect((await link(id, { contactId: ana, expectedRevision: 0, bookingId: id }, h.a)).status).toBe(400);
    expect((await unlink(id, { expectedRevision: -1 }, h.a)).status).toBe(400);
    expect((await link("not-an-id", { contactId: ana, expectedRevision: 0 }, h.a)).status).toBe(400);
  });

  it("is 404 for tenant B on tenant A's booking, on every route", async () => {
    const id = await book("2026-10-19T14:00:00.000Z");
    const ana = await newContact("Tenant A Ana");
    expect((await link(id, { contactId: ana, expectedRevision: 0 })).status).toBe(200);
    const bContact = await newContact("Tenant B Bea", h.b);

    for (const response of [
      await link(id, { contactId: bContact, expectedRevision: 0 }, h.b),
      await unlink(id, { expectedRevision: 1 }, h.b),
      await detail(id, h.b),
    ]) {
      expect(response.status, JSON.stringify(response.body)).toBe(404);
      expect(errorOf(response).code).toBe("NotFound");
    }
    // Tenant B's list of tenant A's contact is empty, and tenant A is untouched.
    const none = bookingPageSchema.parse((await call(h.app, "GET", `/v1/booking/bookings?contactId=${ana}&limit=100`, { token: h.b.token })).body);
    expect(none.items).toEqual([]);
    expect(bookingDetailSchema.parse((await detail(id)).body)).toMatchObject({ customer: { contactId: ana }, customerRevision: 1 });
  });
});
