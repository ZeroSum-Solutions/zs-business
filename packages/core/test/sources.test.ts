// M3b source records (docs/requirements/approvals.md F-1..F-8), under the runtime role:
// observe, keep the newest observation, freshness against the injected clock, ownership.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NotFound, TenantDenied, ValidationFailed, type MemberRole } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createSession, requireFresh, type EdgeDependencies, type Session } from "../src/index.js";

const START = Date.parse("2026-10-19T08:00:00.000Z");
let now = START;
const clock = { now: () => new Date(now) };
const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let owner: string;
let staff: string;
let contactId: string;
let intakeItemId: string;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenant = tenantId): Session => createSession(deps(), { tenantId: tenant, actorId });

async function addMember(tenant: string, role: MemberRole): Promise<string> {
  const userId = randomUUID();
  const memberId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, memberId, `${role}-${memberId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}

/** A contact of tenant A, created through the owner session. */
async function newContact(): Promise<string> {
  return (await sessionFor(owner).upsertContact({ displayName: "Mira Rowe", email: `${randomUUID()}@haldenrowe.example` }, randomUUID()))
    .result.contact.id;
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  owner = await addMember(tenantId, "owner");
  staff = await addMember(tenantId, "staff");
  contactId = await newContact();
  const pageId = randomUUID();
  intakeItemId = randomUUID();
  await fixture.service(async (tx) => {
    await tx.query("INSERT INTO booking_pages (tenant_id,id,title,published,created_at) VALUES ($1,$2,'Book',true,$3)", [tenantId, pageId, new Date(START)]);
    await tx.query(
      `INSERT INTO intake_items (tenant_id,id,page_id,submitted_name,submitted_email,created_at)
       VALUES ($1,$2,$3,'Ada','ada@haldenrowe.example',$4)`, [tenantId, intakeItemId, pageId, new Date(START)]);
  });
});
afterAll(async () => { await database?.close(); });
beforeEach(() => { now = START + 24 * 60 * 60_000; });

describe("observe (F-4, F-5)", () => {
  it("records the first observation, then keeps only newer ones", async () => {
    const id = await newContact();
    const subject = { type: "contact" as const, id };
    const first = await sessionFor(owner).observeSource({ subject, source: "website", sourceRef: "page-1", observedAt: at(10) }, randomUUID());
    expect(first.result).toMatchObject({
      applied: true,
      record: { tenantId, subject, source: "website", sourceRef: "page-1", observedAt: at(10), freshUntil: null, fresh: true, revision: 1, recordedBy: owner },
    });
    const newer = await sessionFor(staff).observeSource({ subject, source: "website", observedAt: at(20), freshForMinutes: 60 }, randomUUID());
    expect(newer.result).toMatchObject({
      applied: true,
      record: { id: first.result.record.id, observedAt: at(20), freshUntil: at(80), sourceRef: null, revision: 2, recordedBy: owner },
    });
    // A late or out-of-order observation changes nothing.
    for (const observedAt of [at(20), at(15)]) {
      const late = await sessionFor(owner).observeSource({ subject, source: "website", sourceRef: "late", observedAt }, randomUUID());
      expect(late.result).toEqual({ applied: false, record: newer.result.record });
    }
    // Another source is another record.
    const other = await sessionFor(owner).observeSource({ subject, source: "import" }, randomUUID());
    expect(other.result.record).toMatchObject({ source: "import", observedAt: new Date(now).toISOString(), revision: 1 });
    expect(other.result.record.id).not.toBe(first.result.record.id);
    const list = await sessionFor(owner).listSources({ subjectType: "contact", subjectId: id });
    expect(list.items.map((record) => record.source)).toEqual(["import", "website"]);
  });

  it("replays with the same key", async () => {
    const subject = { type: "contact" as const, id: await newContact() };
    const key = randomUUID();
    const first = await sessionFor(owner).observeSource({ subject, source: "owner", observedAt: at(5) }, key);
    now += 60_000;
    expect(await sessionFor(owner).observeSource({ subject, source: "owner", observedAt: at(5) }, key)).toEqual(first);
    await expect(sessionFor(owner).observeSource({ subject, source: "owner", observedAt: at(6) }, key))
      .rejects.toMatchObject({ code: "IdempotencyConflict" });
  });

  it("serializes concurrent observations of one subject and source", async () => {
    const subject = { type: "contact" as const, id: await newContact() };
    const results = await Promise.all([1, 2, 3, 4].map((minute) =>
      sessionFor(owner).observeSource({ subject, source: "google_calendar", observedAt: at(minute) }, randomUUID())));
    expect(new Set(results.map((out) => out.result.record.id)).size).toBe(1);
    const [stored] = (await sessionFor(owner).listSources({ subjectType: "contact", subjectId: subject.id })).items;
    expect(stored!.observedAt).toBe(at(4));
    expect(stored!.revision).toBe(results.filter((out) => out.result.applied).length);
  });

  it("keeps updated_at at or after recorded_at when lock order differs from clock order", async () => {
    // B read the clock at 11s and inserted first; A read it at 10s (or runs on a lagging
    // worker) and takes the lock second with a newer observation.
    const subject = { type: "contact" as const, id: await newContact() };
    now = START + 11_000;
    const b = await sessionFor(owner).observeSource({ subject, source: "website", observedAt: at(0) }, randomUUID());
    now = START + 10_000;
    const a = await sessionFor(owner).observeSource({ subject, source: "website", observedAt: new Date(START + 8_000).toISOString() }, randomUUID());
    expect(a.result).toMatchObject({ applied: true, record: { id: b.result.record.id, revision: 2, observedAt: new Date(START + 8_000).toISOString() } });
    const [row] = (await fixture.service((tx) => tx.query<{ recorded_at: Date; updated_at: Date }>(
      "SELECT recorded_at, updated_at FROM source_records WHERE id=$1", [b.result.record.id]))).rows;
    expect(row!.updated_at.getTime()).toBe(row!.recorded_at.getTime());
    expect(row!.recorded_at.getTime()).toBe(START + 11_000);
  });

  it("refuses observations from the future, bad names and bad bounds", async () => {
    const subject = { type: "contact" as const, id: contactId };
    await expect(sessionFor(owner).observeSource({ subject, source: "owner", observedAt: new Date(now + 1).toISOString() }, randomUUID()))
      .rejects.toBeInstanceOf(ValidationFailed);
    for (const body of [
      { subject, source: "Website" },
      { subject, source: "a".repeat(64) },
      { subject, source: "owner", freshForMinutes: 0 },
      { subject, source: "owner", freshForMinutes: 525_601 },
      { subject, source: "owner", sourceRef: "" },
      { subject: { type: "tenant", id: tenantId }, source: "owner" },
      { subject, source: "owner", sourceRecordId: randomUUID() },
    ]) await expect(sessionFor(owner).observeSource(body, randomUUID())).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});

describe("freshness (F-6)", () => {
  it("is fresh until fresh_until, against the injected clock", async () => {
    const subject = { type: "contact" as const, id: await newContact() };
    now = START + 30 * 60_000;
    await sessionFor(owner).observeSource({ subject, source: "website", observedAt: at(0), freshForMinutes: 60 }, randomUUID());
    const read = (instant: number) => database.db.tenant(tenantId, (tx) => requireFresh(tx, tenantId, subject, new Date(instant)));
    await expect(read(START + 60 * 60_000 - 1)).resolves.toMatchObject({ source: "website", fresh: true });
    await expect(read(START + 60 * 60_000)).rejects.toMatchObject({ code: "Conflict", details: { reason: "stale_source" } });
    now = START + 60 * 60_000;
    expect((await sessionFor(owner).listSources({ subjectType: "contact", subjectId: subject.id })).items[0]!.fresh).toBe(false);
    // A newer observation from any source makes the subject fresh again; `source` narrows the check.
    now = START + 90 * 60_000;
    await sessionFor(owner).observeSource({ subject, source: "owner" }, randomUUID());
    await expect(read(now)).resolves.toMatchObject({ source: "owner", freshUntil: null });
    await expect(database.db.tenant(tenantId, (tx) => requireFresh(tx, tenantId, subject, new Date(now), { source: "website" })))
      .rejects.toMatchObject({ details: { reason: "stale_source" } });
  });

  it("has nothing fresh for a subject with no record", async () => {
    await expect(database.db.tenant(tenantId, (tx) => requireFresh(tx, tenantId, { type: "contact", id: contactId }, new Date(START))))
      .rejects.toMatchObject({ details: { reason: "stale_source" } });
  });
});

describe("subjects and permissions (F-2, F-7)", () => {
  it("needs the subject's permission: staff may record contacts, not intake items", async () => {
    await expect(sessionFor(staff).observeSource({ subject: { type: "contact", id: contactId }, source: "owner" }, randomUUID())).resolves.toBeDefined();
    await expect(sessionFor(staff).observeSource({ subject: { type: "intake_item", id: intakeItemId }, source: "website" }, randomUUID()))
      .rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(staff).listSources({ subjectType: "intake_item", subjectId: intakeItemId })).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(owner).observeSource({ subject: { type: "intake_item", id: intakeItemId }, source: "website" }, randomUUID()))
      .resolves.toMatchObject({ result: { applied: true } });
    await expect(sessionFor(randomUUID()).observeSource({ subject: { type: "contact", id: contactId }, source: "owner" }, randomUUID()))
      .rejects.toBeInstanceOf(TenantDenied);
  });

  it("refuses a subject that does not exist in the tenant", async () => {
    const outsider = await addMember(fixture.b.tenantId, "owner");
    const b = sessionFor(outsider, fixture.b.tenantId);
    for (const subject of [{ type: "contact" as const, id: contactId }, { type: "deal" as const, id: randomUUID() }])
      await expect(b.observeSource({ subject, source: "owner" }, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(b.listSources({ subjectType: "contact", subjectId: contactId })).rejects.toBeInstanceOf(NotFound);
    await expect(sessionFor(owner).listSources({ subjectType: "booking", subjectId: randomUUID() })).rejects.toBeInstanceOf(NotFound);
  });
});

describe("the table under the runtime role (F-8)", () => {
  it("cannot delete records, move them to another subject or rewrite who recorded them", async () => {
    await sessionFor(owner).observeSource({ subject: { type: "contact", id: contactId }, source: "fixed" }, randomUUID());
    for (const sql of [
      "DELETE FROM source_records WHERE subject_id=$1",
      "UPDATE source_records SET subject_id=gen_random_uuid() WHERE subject_id=$1",
      "UPDATE source_records SET recorded_by=gen_random_uuid() WHERE subject_id=$1",
      "UPDATE source_records SET source='other' WHERE subject_id=$1",
    ]) await expect(fixture.a.run((tx) => tx.query(sql, [contactId])), sql).rejects.toMatchObject({ code: "42501" });
    await expect(fixture.b.run((tx) => tx.query("SELECT * FROM source_records WHERE subject_id=$1", [contactId])))
      .resolves.toMatchObject({ rowCount: 0 });
  });
});
