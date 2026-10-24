// Booking customer link (docs/requirements/booking-customer.md BC-2..BC-7, BC-10) through the
// session and the dispatcher under the runtime role: link, change, unlink with a compare-and-set
// revision, the reads that show the customer, the website-booking refusal, contact deletion, and
// two-tenant denial. The clock is injected and never moves on its own.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, IdempotencyConflict, type BookingSummary, type MemberRole } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createPublicSession } from "../src/edge/public-session.js";
import { createSession, type EdgeDependencies, type Session } from "../src/index.js";

const START = Date.parse("2026-10-23T09:00:00.000Z");
const clock = { now: () => new Date(START) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let resourceId: string;
let resourceIdB: string;
let pageId: string;
let owner: string;
let staff: string;
let ownerB: string;
let a: Session;
let b: Session;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenantId = fixture.a.tenantId): Session => createSession(deps(), { tenantId, actorId });

async function addMember(tenantId: string, role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}
async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

/** Each booking takes the next free hour, from 2 November on, so none overlaps another. */
let hour = 0;
const nextStart = () => {
  const n = hour++;
  return `2026-11-${String(2 + Math.floor(n / 8)).padStart(2, "0")}T${String(9 + (n % 8)).padStart(2, "0")}:00:00.000Z`;
};
async function book(session: Session = a, resource = resourceId) {
  return (await session.createBooking({ resourceId: resource, startsAt: nextStart() }, randomUUID())).result.id;
}
async function contact(session: Session, displayName: string) {
  return (await session.upsertContact({ displayName, email: `${randomUUID().slice(0, 8)}@example.com` }, randomUUID())).result.contact.id;
}
/** A website booking: it has an intake item, so its customer comes from the intake review. */
async function websiteBooking(): Promise<string> {
  const reply = await createPublicSession(deps(), { tenantId: fixture.a.tenantId, pageId }).request({
    resourceId, startsAt: nextStart(), name: "Web Visitor", email: `${randomUUID().slice(0, 8)}@example.com`, phone: null, notes: null,
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  }, randomUUID());
  return (await fixture.service((tx) => tx.query<{ id: string }>(
    "SELECT id FROM bookings WHERE tenant_id=$1 AND intake_item_id=$2", [fixture.a.tenantId, reply.requestId],
  ))).rows[0]!.id;
}
const summaryOf = async (session: Session, id: string): Promise<BookingSummary> => {
  const found = (await session.listBookings({ limit: 100 })).items.find((item) => item.id === id);
  if (!found) throw new Error("booking missing from the list");
  return found;
};

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  resourceId = randomUUID();
  resourceIdB = randomUUID();
  pageId = randomUUID();
  const weekly = JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })));
  await fixture.service(async (tx) => {
    for (const [tenantId, id] of [[fixture.a.tenantId, resourceId], [fixture.b.tenantId, resourceIdB]] as const) {
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,525600)`, [tenantId, id, weekly]);
    }
    await tx.query(
      "INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
      [fixture.a.tenantId, pageId, new Date(START)],
    );
    await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [fixture.a.tenantId, pageId, resourceId]);
  });
  owner = await addMember(fixture.a.tenantId, "owner");
  staff = await addMember(fixture.a.tenantId, "staff");
  ownerB = await addMember(fixture.b.tenantId, "owner");
  a = sessionFor(staff);
  b = sessionFor(ownerB, fixture.b.tenantId);
});
afterAll(async () => { await database?.close(); });

describe("linking (BC-3, BC-6)", () => {
  it("a staff member links a contact, and the list and the detail show it as linked", async () => {
    const id = await book();
    const ana = await contact(a, "Ana Ruiz");
    expect((await summaryOf(a, id)).customer).toBeNull();
    expect(await a.getBooking(id)).toMatchObject({ id, customer: null, customerRevision: 0 });

    const linked = await a.linkBookingContact(id, { contactId: ana, expectedRevision: 0 }, randomUUID());
    expect(linked.result).toEqual({ bookingId: id, customer: { contactId: ana, name: "Ana Ruiz", status: "linked" }, revision: 1 });
    expect((await summaryOf(a, id)).customer).toEqual({ contactId: ana, name: "Ana Ruiz", status: "linked" });
    expect(await a.getBooking(id)).toMatchObject({ id, source: "owner", customer: { contactId: ana, name: "Ana Ruiz", status: "linked" }, customerRevision: 1 });
    // The row names who linked, from the server's own clock.
    const row = (await fixture.service((tx) => tx.query<{ linked_by: string; linked_at: Date }>(
      "SELECT linked_by, linked_at FROM booking_contacts WHERE tenant_id=$1 AND booking_id=$2", [fixture.a.tenantId, id],
    ))).rows[0]!;
    expect(row.linked_by).toBe(staff);
    expect(row.linked_at.toISOString()).toBe(new Date(START).toISOString());
  });

  it("both roles hold calendar and customers, so an owner links too", async () => {
    const id = await book();
    const ben = await contact(a, "Ben Okafor");
    const linked = await sessionFor(owner).linkBookingContact(id, { contactId: ben, expectedRevision: 0 }, randomUUID());
    expect(linked.result.revision).toBe(1);
  });

  it("shows the contact's current name after a rename", async () => {
    const id = await book();
    const cy = await contact(a, "Cy Dunn");
    await a.linkBookingContact(id, { contactId: cy, expectedRevision: 0 }, randomUUID());
    await fixture.service((tx) => tx.query("UPDATE crm_contacts SET display_name='Cyrus Dunn' WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, cy]));
    expect((await summaryOf(a, id)).customer).toEqual({ contactId: cy, name: "Cyrus Dunn", status: "linked" });
  });

  it("booking.create keeps its payload: a customer rides only on the link (B-17)", async () => {
    const stray = await rejection(a.createBooking({ resourceId, startsAt: nextStart(), contactId: randomUUID() }, randomUUID()));
    expect(stray).toMatchObject({ code: "ValidationFailed" });
  });

  it("refuses a malformed body or revision", async () => {
    const id = await book();
    const ana = await contact(a, "Dee Fox");
    for (const body of [{ contactId: ana }, { contactId: ana, expectedRevision: -1 }, { contactId: "nope", expectedRevision: 0 }, { contactId: ana, expectedRevision: 0, extra: 1 }])
      expect(await rejection(a.linkBookingContact(id, body, randomUUID())), JSON.stringify(body)).toMatchObject({ code: "ValidationFailed" });
    expect(await rejection(a.linkBookingContact("not-an-id", { contactId: ana, expectedRevision: 0 }, randomUUID()))).toMatchObject({ code: "ValidationFailed" });
  });
});

describe("website bookings (BC-2)", () => {
  it("refuse a link with intake_booking and write nothing", async () => {
    const id = await websiteBooking();
    const ana = await contact(a, "Eve Lang");
    const refused = await rejection(a.linkBookingContact(id, { contactId: ana, expectedRevision: 0 }, randomUUID()));
    expect(refused).toMatchObject({ code: "Conflict", details: { reason: "intake_booking" } });
    expect((await fixture.service((tx) => tx.query("SELECT 1 FROM booking_contacts WHERE tenant_id=$1 AND booking_id=$2", [fixture.a.tenantId, id]))).rowCount).toBe(0);
    // It keeps its P-12 customer, and the detail reads it.
    const detail = await a.getBooking(id);
    expect(detail.customer).toMatchObject({ name: "Web Visitor" });
    expect(detail.customer).not.toMatchObject({ status: "linked" });
    expect(detail.customerRevision).toBe(0);
  });

  it("refuse an unlink with intake_booking too, whatever revision it carries", async () => {
    const id = await websiteBooking();
    for (const expectedRevision of [0, 1]) {
      expect(await rejection(a.unlinkBookingContact(id, { expectedRevision }, randomUUID())))
        .toMatchObject({ code: "Conflict", details: { reason: "intake_booking" } });
    }
  });
});

describe("change, clear and the revision (BC-4)", () => {
  it("a second link with the old revision is stale; a change and an unlink each add one", async () => {
    const id = await book();
    const [ana, ben] = [await contact(a, "Fay Hart"), await contact(a, "Gus Ito")];
    await a.linkBookingContact(id, { contactId: ana, expectedRevision: 0 }, randomUUID());
    const stale = await rejection(a.linkBookingContact(id, { contactId: ben, expectedRevision: 0 }, randomUUID()));
    expect(stale).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 1 } });
    expect((await summaryOf(a, id)).customer?.contactId).toBe(ana);

    const changed = await a.linkBookingContact(id, { contactId: ben, expectedRevision: 1 }, randomUUID());
    expect(changed.result).toMatchObject({ customer: { contactId: ben, name: "Gus Ito" }, revision: 2 });

    const cleared = await a.unlinkBookingContact(id, { expectedRevision: 2 }, randomUUID());
    expect(cleared.result).toEqual({ bookingId: id, customer: null, revision: 3 });
    expect((await summaryOf(a, id)).customer).toBeNull();
    // The row stays, with the revision where it was left.
    expect(await a.getBooking(id)).toMatchObject({ customer: null, customerRevision: 3 });

    // A revision read before the unlink is still stale after a relink.
    expect(await rejection(a.linkBookingContact(id, { contactId: ana, expectedRevision: 2 }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 3 } });
    const relinked = await a.linkBookingContact(id, { contactId: ana, expectedRevision: 3 }, randomUUID());
    expect(relinked.result.revision).toBe(4);
    expect(await rejection(a.unlinkBookingContact(id, { expectedRevision: 3 }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 4 } });
  });

  it("changes nothing when the contact is already the customer or there is no customer to clear", async () => {
    const id = await book();
    const hal = await contact(a, "Hal Moon");
    await a.linkBookingContact(id, { contactId: hal, expectedRevision: 0 }, randomUUID());
    const same = await a.linkBookingContact(id, { contactId: hal, expectedRevision: 1 }, randomUUID());
    expect(same.result.revision).toBe(1);
    await a.unlinkBookingContact(id, { expectedRevision: 1 }, randomUUID());
    const again = await a.unlinkBookingContact(id, { expectedRevision: 2 }, randomUUID());
    expect(again.result).toEqual({ bookingId: id, customer: null, revision: 2 });
  });

  it("an unlink with no row at all is stale at revision 0", async () => {
    const id = await book();
    expect(await rejection(a.unlinkBookingContact(id, { expectedRevision: 1 }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 0 } });
  });
});

describe("idempotency (BC-5)", () => {
  it("a replay returns the first result, even after a later change", async () => {
    const id = await book();
    const [ana, ben] = [await contact(a, "Ida Kerr"), await contact(a, "Jon Vale")];
    const key = randomUUID();
    const first = await a.linkBookingContact(id, { contactId: ana, expectedRevision: 0 }, key);
    await a.linkBookingContact(id, { contactId: ben, expectedRevision: 1 }, randomUUID());
    const replay = await a.linkBookingContact(id, { contactId: ana, expectedRevision: 0 }, key);
    expect(replay).toEqual(first);
    expect((await summaryOf(a, id)).customer?.contactId).toBe(ben);
    expect((await a.getBooking(id)).customerRevision).toBe(2);
  });

  it("a key reused for another payload or action is an IdempotencyConflict", async () => {
    const id = await book();
    const [ana, ben] = [await contact(a, "Kim Orr"), await contact(a, "Lee Pak")];
    const key = randomUUID();
    await a.linkBookingContact(id, { contactId: ana, expectedRevision: 0 }, key);
    await expect(a.linkBookingContact(id, { contactId: ben, expectedRevision: 0 }, key)).rejects.toBeInstanceOf(IdempotencyConflict);
    await expect(a.unlinkBookingContact(id, { expectedRevision: 1 }, key)).rejects.toBeInstanceOf(IdempotencyConflict);
  });
});

describe("the contact page filter and contact deletion (BC-6, BC-7)", () => {
  it("lists a contact's bookings: owner links and the website bookings that review matched", async () => {
    const mia = await contact(a, "Mia Noor");
    const mine = await book();
    const other = await book();
    await a.linkBookingContact(mine, { contactId: mia, expectedRevision: 0 }, randomUUID());
    const web = await websiteBooking();
    const item = (await fixture.service((tx) => tx.query<{ id: string }>(
      "SELECT i.id FROM intake_items i JOIN bookings b ON b.tenant_id=i.tenant_id AND b.intake_item_id=i.id WHERE b.tenant_id=$1 AND b.id=$2", [fixture.a.tenantId, web],
    ))).rows[0]!.id;
    await fixture.service((tx) => tx.query("UPDATE intake_items SET contact_id=$3 WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, item, mia]));
    const ids = (await a.listBookings({ contactId: mia, limit: 50 })).items.map((entry) => entry.id);
    expect(ids.sort()).toEqual([mine, web].sort());
    expect(ids).not.toContain(other);
    // A range keeps a booking that began before it and is still running.
    const running = (await a.listBookings({ contactId: mia, from: new Date(Date.parse((await summaryOf(a, mine)).startsAt) + 60_000).toISOString(), limit: 50 })).items;
    expect(running.map((entry) => entry.id)).toContain(mine);
  });

  it("deleting the contact clears the link, bumps the revision and keeps the booking", async () => {
    const id = await book();
    const nan = await contact(a, "Nan Ode");
    await a.linkBookingContact(id, { contactId: nan, expectedRevision: 0 }, randomUUID());
    await fixture.service((tx) => tx.query("DELETE FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, nan]));
    expect(await a.getBooking(id)).toMatchObject({ id, customer: null, customerRevision: 2 });
    expect((await summaryOf(a, id)).customer).toBeNull();
    // The revision read before the delete is stale.
    expect(await rejection(a.unlinkBookingContact(id, { expectedRevision: 1 }, randomUUID())))
      .toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 2 } });
  });

  it("a change that read the old revision cannot win over a contact deletion that commits first (BC-4, BC-7)", async () => {
    for (const change of ["link", "unlink"] as const) {
      const id = await book();
      const [nan, ben] = [await contact(a, `Nan ${change}`), await contact(a, `Ben ${change}`)];
      await a.linkBookingContact(id, { contactId: nan, expectedRevision: 0 }, randomUUID());
      let attempt: Promise<unknown> = Promise.resolve();
      // The delete holds the link row (revision 1 -> 2, uncommitted) while the action reads revision 1
      // and reaches its UPDATE, which must wait for the delete and then find the revision moved on.
      await fixture.service(async (tx) => {
        await tx.query("DELETE FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, nan]);
        attempt = change === "link"
          ? a.linkBookingContact(id, { contactId: ben, expectedRevision: 1 }, randomUUID()).catch((error: unknown) => error)
          : a.unlinkBookingContact(id, { expectedRevision: 1 }, randomUUID()).catch((error: unknown) => error);
        for (let tries = 0; tries < 200; tries += 1) {
          // pg_locks is readable by every role; pg_stat_activity hides other roles' waits.
          const waiting = await tx.query("SELECT 1 FROM pg_locks WHERE NOT granted AND locktype='transactionid'");
          if (waiting.rowCount) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      });
      expect(await attempt).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 2 } });
      expect(await a.getBooking(id)).toMatchObject({ customer: null, customerRevision: 2 });
    }
  });
});

describe("tenancy (BC-3, BC-10)", () => {
  it("tenant B gets NotFound for tenant A's booking, and tenant A's contact is unknown to it", async () => {
    const id = await book();
    const ana = await contact(a, "Ola Pine");
    await a.linkBookingContact(id, { contactId: ana, expectedRevision: 0 }, randomUUID());
    const bContact = await contact(b, "Pat Quinn");

    expect(await rejection(b.linkBookingContact(id, { contactId: bContact, expectedRevision: 0 }, randomUUID()))).toMatchObject({ code: "NotFound" });
    expect(await rejection(b.unlinkBookingContact(id, { expectedRevision: 1 }, randomUUID()))).toMatchObject({ code: "NotFound" });
    expect(await rejection(b.getBooking(id))).toMatchObject({ code: "NotFound" });
    expect((await b.listBookings({ contactId: ana, limit: 50 })).items).toEqual([]);

    // Tenant B's own booking with tenant A's contact: the contact does not exist for B.
    const mine = await book(b, resourceIdB);
    expect(await rejection(b.linkBookingContact(mine, { contactId: ana, expectedRevision: 0 }, randomUUID()))).toMatchObject({ code: "NotFound" });
    // And the other way round.
    expect(await rejection(a.linkBookingContact(mine, { contactId: ana, expectedRevision: 0 }, randomUUID()))).toMatchObject({ code: "NotFound" });
    expect((await fixture.service((tx) => tx.query("SELECT 1 FROM booking_contacts WHERE tenant_id=$1", [fixture.b.tenantId]))).rowCount).toBe(0);
    // Tenant A is untouched.
    expect(await a.getBooking(id)).toMatchObject({ customer: { contactId: ana }, customerRevision: 1 });
  });

  it("a stranger to the tenant is TenantDenied", async () => {
    const id = await book();
    const ana = await contact(a, "Rae Sol");
    const stranger = sessionFor(ownerB, fixture.a.tenantId);
    expect(await rejection(stranger.linkBookingContact(id, { contactId: ana, expectedRevision: 0 }, randomUUID()))).toMatchObject({ code: "TenantDenied" });
    expect(await rejection(stranger.getBooking(id))).toMatchObject({ code: "TenantDenied" });
  });
});
