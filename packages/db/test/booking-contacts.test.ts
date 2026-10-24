import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "../src/testing.js";

// booking-customer.md BC-1, BC-2, BC-4, BC-7, BC-10 at the database, as the runtime role.

let database: TestDatabase;
let fixture: TwoTenantFixture;
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

const asA = <T>(work: (tx: import("../src/scoped.js").Transaction) => Promise<T>) => fixture.a.run(work);
const asB = <T>(work: (tx: import("../src/scoped.js").Transaction) => Promise<T>) => fixture.b.run(work);

let slot = 0;
/** A resource-free-standing booking (owner-made unless `website`), with its own resource, one hour apart. */
async function makeBooking(tenantId: string, website = false) {
  const resourceId = randomUUID();
  const bookingId = randomUUID();
  const start = new Date(Date.parse("2026-11-02T10:00:00Z") + (slot++) * 3_600_000);
  const end = new Date(start.getTime() + 1_800_000);
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',30,30,0,0,0,60)`, [tenantId, resourceId]);
    let intake: string | null = null;
    if (website) {
      const page = randomUUID();
      intake = randomUUID();
      await tx.query("INSERT INTO booking_pages (tenant_id,id,title,created_at) VALUES ($1,$2,'Page',now())", [tenantId, page]);
      await tx.query(
        `INSERT INTO intake_items (tenant_id,id,page_id,submitted_name,submitted_email,created_at)
         VALUES ($1,$2,$3,'Web Visitor','visitor@example.com',now())`, [tenantId, intake, page]);
    }
    await tx.query(
      `INSERT INTO bookings (tenant_id,id,resource_id,starts_at,ends_at,occupied_starts_at,occupied_ends_at,created_at,source,intake_item_id)
       VALUES ($1,$2,$3,$4,$5,$4,$5,now(),$6,$7)`, [tenantId, bookingId, resourceId, start, end, website ? "website" : "owner", intake]);
  });
  return bookingId;
}
async function makeContact(tenantId: string, name: string) {
  const id = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,created_at,updated_at)
     VALUES ($1,$2,$3,$4,now(),now())`, [tenantId, id, name, `${id}@example.com`]));
  return id;
}
const rowOf = (tenantId: string, bookingId: string) => fixture.service(async (tx) =>
  (await tx.query("SELECT contact_id, revision, linked_by FROM booking_contacts WHERE tenant_id=$1 AND booking_id=$2", [tenantId, bookingId])).rows[0]);
const insertLink = (tx: import("../src/scoped.js").Transaction, tenantId: string, bookingId: string, contactId: string | null, by = randomUUID()) =>
  tx.query("INSERT INTO booking_contacts (tenant_id,booking_id,contact_id,linked_by) VALUES ($1,$2,$3,$4)", [tenantId, bookingId, contactId, by]);

describe("the table (BC-1)", () => {
  it("holds one row per booking, starting at revision 1, with a null contact allowed", async () => {
    const booking = await makeBooking(fixture.a.tenantId);
    const contact = await makeContact(fixture.a.tenantId, "Ana Ruiz");
    await asA((tx) => insertLink(tx, fixture.a.tenantId, booking, contact));
    expect(await rowOf(fixture.a.tenantId, booking)).toMatchObject({ contact_id: contact, revision: 1 });
    await expect(asA((tx) => insertLink(tx, fixture.a.tenantId, booking, contact))).rejects.toMatchObject({ code: "23505" });
    const bare = await makeBooking(fixture.a.tenantId);
    await asA((tx) => insertLink(tx, fixture.a.tenantId, bare, null));
    expect(await rowOf(fixture.a.tenantId, bare)).toMatchObject({ contact_id: null, revision: 1 });
  });

  it("refuses a row for a booking or contact of another tenant (composite keys)", async () => {
    const aBooking = await makeBooking(fixture.a.tenantId);
    const bContact = await makeContact(fixture.b.tenantId, "Bea Stone");
    await expect(asA((tx) => insertLink(tx, fixture.a.tenantId, aBooking, bContact))).rejects.toMatchObject({ code: "23503" });
    const bBooking = await makeBooking(fixture.b.tenantId);
    const aContact = await makeContact(fixture.a.tenantId, "Ana Two");
    await expect(asA((tx) => insertLink(tx, fixture.a.tenantId, bBooking, aContact))).rejects.toMatchObject({ code: "23503" });
  });

  it("starts at revision 1 and grows by exactly one", async () => {
    const booking = await makeBooking(fixture.a.tenantId);
    const contact = await makeContact(fixture.a.tenantId, "Ana Three");
    await expect(asA((tx) => tx.query(
      "INSERT INTO booking_contacts (tenant_id,booking_id,contact_id,linked_by,revision) VALUES ($1,$2,$3,$4,5)",
      [fixture.a.tenantId, booking, contact, randomUUID()]))).rejects.toMatchObject({ code: "23514", constraint: "booking_contacts_revision_step" });
    await asA((tx) => insertLink(tx, fixture.a.tenantId, booking, contact));
    const move = (revision: number) => asA((tx) => tx.query(
      "UPDATE booking_contacts SET contact_id=NULL, revision=$1 WHERE tenant_id=$2 AND booking_id=$3", [revision, fixture.a.tenantId, booking]));
    for (const revision of [1, 3, 0]) await expect(move(revision)).rejects.toMatchObject({ code: "23514" });
    await move(2);
    expect(await rowOf(fixture.a.tenantId, booking)).toMatchObject({ contact_id: null, revision: 2 });
  });
});

describe("only owner-made bookings (BC-2)", () => {
  it("refuses any row on a website booking, with a contact or without", async () => {
    const booking = await makeBooking(fixture.a.tenantId, true);
    const contact = await makeContact(fixture.a.tenantId, "Ana Four");
    await expect(asA((tx) => insertLink(tx, fixture.a.tenantId, booking, contact)))
      .rejects.toMatchObject({ code: "23514", constraint: "booking_contacts_owner_made" });
    // An empty row would show revision 1 on a booking that has no revision to speak of.
    await expect(asA((tx) => insertLink(tx, fixture.a.tenantId, booking, null)))
      .rejects.toMatchObject({ code: "23514", constraint: "booking_contacts_owner_made" });
    expect(await rowOf(fixture.a.tenantId, booking)).toBeUndefined();
  });
});

describe("deleting a contact (BC-7)", () => {
  it("clears the link, bumps the revision and keeps the booking and the row", async () => {
    const booking = await makeBooking(fixture.a.tenantId);
    const other = await makeBooking(fixture.a.tenantId);
    const gone = await makeContact(fixture.a.tenantId, "Gone Soon");
    const stays = await makeContact(fixture.a.tenantId, "Stays");
    await asA((tx) => insertLink(tx, fixture.a.tenantId, booking, gone));
    await asA((tx) => insertLink(tx, fixture.a.tenantId, other, stays));
    await fixture.service((tx) => tx.query("DELETE FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, gone]));
    expect(await rowOf(fixture.a.tenantId, booking)).toMatchObject({ contact_id: null, revision: 2 });
    expect(await rowOf(fixture.a.tenantId, other)).toMatchObject({ contact_id: stays, revision: 1 });
    expect((await fixture.service((tx) => tx.query("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, booking]))).rowCount).toBe(1);
  });

  it("leaves another tenant's links alone and rolls back with the delete", async () => {
    const aBooking = await makeBooking(fixture.a.tenantId);
    const aContact = await makeContact(fixture.a.tenantId, "Roll Back");
    const bBooking = await makeBooking(fixture.b.tenantId);
    const bContact = await makeContact(fixture.b.tenantId, "Other Tenant");
    await asA((tx) => insertLink(tx, fixture.a.tenantId, aBooking, aContact));
    await asB((tx) => insertLink(tx, fixture.b.tenantId, bBooking, bContact));
    await expect(fixture.service(async (tx) => {
      await tx.query("DELETE FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, aContact]);
      throw new Error("abort");
    })).rejects.toThrow("abort");
    expect(await rowOf(fixture.a.tenantId, aBooking)).toMatchObject({ contact_id: aContact, revision: 1 });
    expect(await rowOf(fixture.b.tenantId, bBooking)).toMatchObject({ contact_id: bContact, revision: 1 });
  });
});

describe("tenancy as the runtime role (BC-10)", () => {
  it("reads only its own tenant's rows", async () => {
    const aBooking = await makeBooking(fixture.a.tenantId);
    const aContact = await makeContact(fixture.a.tenantId, "Visible A");
    await asA((tx) => insertLink(tx, fixture.a.tenantId, aBooking, aContact));
    const bBooking = await makeBooking(fixture.b.tenantId);
    const bContact = await makeContact(fixture.b.tenantId, "Hidden B");
    await asB((tx) => insertLink(tx, fixture.b.tenantId, bBooking, bContact));
    const seenByA = (await asA((tx) => tx.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM booking_contacts"))).rows;
    expect(seenByA).toEqual([{ tenant_id: fixture.a.tenantId }]);
    expect((await asA((tx) => tx.query("SELECT 1 FROM booking_contacts WHERE booking_id=$1", [bBooking]))).rowCount).toBe(0);
  });

  it("cannot change, clear or delete another tenant's row, or write one for it", async () => {
    const bBooking = await makeBooking(fixture.b.tenantId);
    const bContact = await makeContact(fixture.b.tenantId, "Untouchable");
    await asB((tx) => insertLink(tx, fixture.b.tenantId, bBooking, bContact));
    const before = await rowOf(fixture.b.tenantId, bBooking);
    const cleared = await asA((tx) => tx.query(
      "UPDATE booking_contacts SET contact_id=NULL, revision=revision+1 WHERE tenant_id=$1 AND booking_id=$2", [fixture.b.tenantId, bBooking]));
    expect(cleared.rowCount).toBe(0);
    expect(await rowOf(fixture.b.tenantId, bBooking)).toEqual(before);
    const another = await makeBooking(fixture.b.tenantId);
    await expect(asA((tx) => insertLink(tx, fixture.b.tenantId, another, bContact))).rejects.toMatchObject({ code: "42501" });
    await expect(asA((tx) => tx.query("DELETE FROM booking_contacts WHERE tenant_id=$1", [fixture.b.tenantId]))).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot move a row to another booking or tenant, or delete its own", async () => {
    const booking = await makeBooking(fixture.a.tenantId);
    await asA((tx) => insertLink(tx, fixture.a.tenantId, booking, null));
    await expect(asA((tx) => tx.query("UPDATE booking_contacts SET tenant_id=$1 WHERE booking_id=$2", [fixture.b.tenantId, booking])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asA((tx) => tx.query("UPDATE booking_contacts SET booking_id=$1 WHERE booking_id=$2", [randomUUID(), booking])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(asA((tx) => tx.query("DELETE FROM booking_contacts WHERE booking_id=$1", [booking]))).rejects.toMatchObject({ code: "42501" });
  });

  it("denies a connection with no tenant in context", async () => {
    const client = await database.runtimePool.connect();
    try {
      expect((await client.query("SELECT 1 FROM booking_contacts")).rowCount).toBe(0);
      await expect(client.query("INSERT INTO booking_contacts (tenant_id,booking_id,linked_by) VALUES ($1,$2,$3)",
        [fixture.a.tenantId, randomUUID(), randomUUID()])).rejects.toMatchObject({ code: "42501" });
    } finally {
      client.release();
    }
  });
});
