// Business profile (docs/requirements/business-profile.md BP-5..BP-9, BP-12) through the session
// and the dispatcher under the runtime role: one profile per tenant, owners write it with a
// compare-and-set revision, any member reads it, and the display name keeps tenants.name in step.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, type MemberRole } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createSession, type EdgeDependencies, type Session } from "../src/index.js";

const START = Date.parse("2026-10-23T09:00:00.000Z");
let now = START;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantId: string;
let owner: string;
let staff: string;
let ownerB: string;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenant = tenantId): Session => createSession(deps(), { tenantId: tenant, actorId });
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[]) =>
  service(async (tx) => (await tx.query(sql, params)).rows as T[]);

async function addMember(tenant: string, role: MemberRole) {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return userId;
}
async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantId = fixture.a.tenantId;
  owner = await addMember(tenantId, "owner");
  staff = await addMember(tenantId, "staff");
  ownerB = await addMember(fixture.b.tenantId, "owner");
});
afterAll(async () => { await database?.close(); });

describe("reading the profile (BP-1, BP-5)", () => {
  it("gives every member the profile that came with the tenant", async () => {
    const expected = { displayName: "Tenant A", legalName: null, phoneE164: null, timeZone: null, currency: "USD", postalAddress: null, description: null, services: [], revision: 1 };
    expect(await sessionFor(owner).getBusiness()).toMatchObject(expected);
    expect(await sessionFor(staff).getBusiness()).toMatchObject(expected);
    // Nothing else about the tenant rides along.
    expect(Object.keys(await sessionFor(staff).getBusiness()).sort()).toEqual([
      "currency", "description", "displayName", "factMarks", "hours", "legalName", "phoneE164", "policies", "postalAddress", "revision",
      "services", "timeZone", "tone", "updatedAt",
    ]);
  });
});

describe("updating the profile (BP-6, BP-7, BP-9)", () => {
  it("saves a subset, bumps the revision, and the next read returns the values", async () => {
    now = START + 1_000;
    const saved = await sessionFor(owner).updateBusiness({
      expectedRevision: 1,
      changes: { legalName: "Halden & Rowe Ltd", timeZone: "Europe/London", currency: "EUR", phoneE164: "+442079460000",
        postalAddress: { line1: "1 High St", city: "London", postalCode: "N1 9GU", country: "GB" } },
    }, randomUUID());
    expect(saved.result).toEqual({
      displayName: "Tenant A", legalName: "Halden & Rowe Ltd", phoneE164: "+442079460000", timeZone: "Europe/London", currency: "EUR",
      postalAddress: { line1: "1 High St", city: "London", postalCode: "N1 9GU", country: "GB" },
      description: null, services: [], hours: null, tone: null, policies: [],
      // BP-19: the time zone is a company fact, so the save marks it with the owner's membership.
      factMarks: { timeZone: { setBy: expect.any(String), setAt: new Date(now).toISOString(), revision: 2 } },
      revision: 2, updatedAt: new Date(now).toISOString(),
    });
    expect(await sessionFor(staff).getBusiness()).toEqual(saved.result);
    expect((await rows<{ updated_by: string }>("SELECT updated_by FROM business_profiles WHERE tenant_id=$1", [tenantId]))[0]!.updated_by).toBe(owner);
  });

  it("a replay with the same key returns the first result and changes nothing more", async () => {
    const key = randomUUID();
    const body = { expectedRevision: 2, changes: { legalName: "Halden Rowe Limited" } };
    const first = await sessionFor(owner).updateBusiness(body, key);
    const again = await sessionFor(owner).updateBusiness(body, key);
    expect(again).toEqual(first);
    expect(first.result.revision).toBe(3);
    expect((await sessionFor(owner).getBusiness()).revision).toBe(3);
  });

  it("a stale revision is a Conflict with the current revision and writes nothing", async () => {
    const stale = await rejection(sessionFor(owner).updateBusiness({ expectedRevision: 1, changes: { currency: "GBP" } }, randomUUID()));
    expect(stale).toMatchObject({ code: "Conflict", details: { reason: "stale_revision", currentRevision: 3 } });
    expect(await sessionFor(owner).getBusiness()).toMatchObject({ currency: "EUR", revision: 3 });
  });

  it("clears the fields that may be cleared and never the display name or currency", async () => {
    const cleared = await sessionFor(owner).updateBusiness(
      { expectedRevision: 3, changes: { legalName: null, phoneE164: null, timeZone: null, postalAddress: null } }, randomUUID());
    expect(cleared.result).toMatchObject({ legalName: null, phoneE164: null, timeZone: null, postalAddress: null, currency: "EUR", revision: 4 });
    for (const changes of [{ displayName: null }, { currency: null }]) {
      expect(await rejection(sessionFor(owner).updateBusiness({ expectedRevision: 4, changes }, randomUUID())))
        .toMatchObject({ code: "ValidationFailed" });
    }
  });

  it("names the field for a time zone or currency outside the lists", async () => {
    const zone = await rejection(sessionFor(owner).updateBusiness({ expectedRevision: 4, changes: { timeZone: "Mars/Base" } }, randomUUID()));
    expect(zone).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.timeZone" }] } });
    const money = await rejection(sessionFor(owner).updateBusiness({ expectedRevision: 4, changes: { currency: "XXZ" } }, randomUUID()));
    expect(money).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.currency" }] } });
    expect((await sessionFor(owner).getBusiness()).revision).toBe(4);
  });

  it("renames tenants.name with the display name in the same step (BP-9)", async () => {
    const saved = await sessionFor(owner).updateBusiness({ expectedRevision: 4, changes: { displayName: "  Halden & Rowe  " } }, randomUUID());
    expect(saved.result).toMatchObject({ displayName: "Halden & Rowe", revision: 5 });
    expect((await rows<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId]))[0]!.name).toBe("Halden & Rowe");
    expect((await sessionFor(owner).me({ profile: true })).businessName).toBe("Halden & Rowe");
    // Tenant B keeps its own name.
    expect((await rows<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [fixture.b.tenantId]))[0]!.name).toBe("Tenant B");
  });

  it("changing only the currency leaves the tenant name alone", async () => {
    await sessionFor(owner).updateBusiness({ expectedRevision: 5, changes: { currency: "USD" } }, randomUUID());
    expect((await rows<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId]))[0]!.name).toBe("Halden & Rowe");
  });
});

describe("who may write (BP-6) and tenancy (BP-12)", () => {
  it("refuses staff, who still read", async () => {
    const before = await sessionFor(staff).getBusiness();
    expect(await rejection(sessionFor(staff).updateBusiness({ expectedRevision: before.revision, changes: { currency: "GBP" } }, randomUUID())))
      .toMatchObject({ code: "TenantDenied" });
    expect(await sessionFor(staff).getBusiness()).toEqual(before);
  });

  it("never lets tenant B's owner read or change tenant A's profile", async () => {
    const a = await sessionFor(owner).getBusiness();
    const b = await sessionFor(ownerB, fixture.b.tenantId).getBusiness();
    expect(b).toMatchObject({ displayName: "Tenant B", revision: 1 });
    expect(b).not.toEqual(a);
    // Tenant A's owner is no member of B.
    expect(await rejection(sessionFor(owner, fixture.b.tenantId).getBusiness())).toMatchObject({ code: "TenantDenied" });
    expect(await rejection(sessionFor(owner, fixture.b.tenantId).updateBusiness({ expectedRevision: 1, changes: { currency: "GBP" } }, randomUUID())))
      .toMatchObject({ code: "TenantDenied" });
    expect(await sessionFor(ownerB, fixture.b.tenantId).getBusiness()).toEqual(b);
  });
});

describe("description and services (BP-13, BP-14)", () => {
  const actionRows = (type: string, tenant = tenantId) => rows<{ id: string; result: Record<string, unknown> }>(
    "SELECT id, result FROM actions WHERE tenant_id=$1 AND action_type=$2", [tenant, type]);

  it("saves both through the profile action, and the next read by any member returns them", async () => {
    const before = await sessionFor(owner).getBusiness();
    const saved = await sessionFor(owner).updateBusiness({
      expectedRevision: before.revision,
      changes: { description: "  Fine jewelry since 1952.  ", services: [" Repairs ", "Resizing", "Bridal consultation"] },
    }, randomUUID());
    expect(saved.result).toMatchObject({
      description: "Fine jewelry since 1952.", services: ["Repairs", "Resizing", "Bridal consultation"], revision: before.revision + 1,
    });
    expect(await sessionFor(staff).getBusiness()).toEqual(saved.result);
  });

  it("writes the action and its outbox event in the same transaction, and a replay writes neither again", async () => {
    const before = await sessionFor(owner).getBusiness();
    const key = randomUUID();
    const body = { expectedRevision: before.revision, changes: { description: "Second wording." } };
    const first = await sessionFor(owner).updateBusiness(body, key);
    const events = async () => rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox o JOIN actions a ON a.tenant_id=o.tenant_id AND a.id=o.action_id WHERE o.tenant_id=$1 AND a.idempotency_key=$2",
      [tenantId, key]);
    expect(await events()).toEqual([{ n: 1 }]);
    expect(await sessionFor(owner).updateBusiness(body, key)).toEqual(first);
    expect(await events()).toEqual([{ n: 1 }]);
    expect((await sessionFor(owner).getBusiness()).revision).toBe(before.revision + 1);
  });

  it("replays a save stored before the two fields existed with them empty, not as an invalid result", async () => {
    const before = await sessionFor(owner).getBusiness();
    const key = randomUUID();
    const body = { expectedRevision: before.revision, changes: { legalName: "Old Wording Ltd" } };
    const first = await sessionFor(owner).updateBusiness(body, key);
    // What an older server stored: the result without description and services.
    await fixture.service((tx) => tx.query(
      "UPDATE actions SET result = result - 'description' - 'services' WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, key]));
    const replay = await sessionFor(owner).updateBusiness(body, key);
    expect(replay.actionId).toBe(first.actionId);
    expect(replay.result).toMatchObject({ legalName: "Old Wording Ltd", revision: first.result.revision, description: null, services: [] });
  });

  it("clears the description with null and the services with [], and keeps what the change does not name", async () => {
    const before = await sessionFor(owner).getBusiness();
    const cleared = await sessionFor(owner).updateBusiness({ expectedRevision: before.revision, changes: { description: null } }, randomUUID());
    expect(cleared.result).toMatchObject({ description: null, services: before.services });
    const none = await sessionFor(owner).updateBusiness({ expectedRevision: before.revision + 1, changes: { services: [] } }, randomUUID());
    expect(none.result).toMatchObject({ description: null, services: [] });
  });

  it("names the field for a duplicate service, too many services or a blank description, and writes nothing", async () => {
    const before = await sessionFor(owner).getBusiness();
    const refuse = (changes: Record<string, unknown>) => rejection(sessionFor(owner).updateBusiness(
      { expectedRevision: before.revision, changes } as never, randomUUID()));
    expect(await refuse({ services: ["Repairs", "repairs"] })).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.services" }] } });
    expect(await refuse({ services: Array.from({ length: 21 }, (_, i) => `S${i}`) })).toMatchObject({ code: "ValidationFailed" });
    expect(await refuse({ description: "   " })).toMatchObject({ code: "ValidationFailed", details: { issues: [{ path: "changes.description" }] } });
    expect(await sessionFor(owner).getBusiness()).toEqual(before);
  });

  it("refuses staff, who still read the two fields", async () => {
    const before = await sessionFor(staff).getBusiness();
    expect(await rejection(sessionFor(staff).updateBusiness({ expectedRevision: before.revision, changes: { description: "Hijacked" } }, randomUUID())))
      .toMatchObject({ code: "TenantDenied" });
    expect(await sessionFor(staff).getBusiness()).toEqual(before);
  });

  it("keeps tenant B's description and services apart from tenant A's", async () => {
    const a = await sessionFor(owner).getBusiness();
    const b = await sessionFor(ownerB, fixture.b.tenantId).getBusiness();
    expect(b).toMatchObject({ description: null, services: [], revision: 1 });
    const saved = await sessionFor(ownerB, fixture.b.tenantId).updateBusiness(
      { expectedRevision: 1, changes: { description: "Tenant B only.", services: ["Only B"] } }, randomUUID());
    expect(saved.result).toMatchObject({ description: "Tenant B only.", services: ["Only B"] });
    expect(await sessionFor(owner).getBusiness()).toEqual(a);
    expect((await actionRows("business.profile.update", fixture.b.tenantId)).length).toBe(1);
  });
});
