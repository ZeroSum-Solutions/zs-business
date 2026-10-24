// enrichment.md "Acceptance test": the fake adapter and a real local Postgres, through the member
// session, the worker and the approval path.
import { randomUUID } from "node:crypto";
import type { MemberRole } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createEnrichmentSession,
  createEnrichmentWorker,
  createFakeEnrichment,
  createSession,
  creditWallet,
  getWallet,
  type EdgeDependencies,
  type EnrichmentConfigInput,
  type EnrichmentReport,
  type FakeEnrichment,
} from "../../src/index.js";

const START = Date.parse("2026-10-23T09:00:00.000Z");
let now = START;
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantA: string;
let tenantB: string;
let ownerA: string;
let staffA: string;
let ownerB: string;

const baseConfig: EnrichmentConfigInput = { provider: "fake", archiveConfirmedOff: true };
const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const enrichmentFor = (tenant: string, actor: string, config: EnrichmentConfigInput | undefined = baseConfig) =>
  createEnrichmentSession(deps(), { tenantId: tenant, actorId: actor }, config);

async function addMember(tenant: string, role: MemberRole): Promise<string> {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, new Date(START)]));
  return userId;
}

let serial = 0;
async function contact(tenant: string, input: { email?: string | null; phone?: string | null } = {}): Promise<string> {
  const id = randomUUID();
  serial += 1;
  const unique = String(serial).padStart(4, "0");
  await fixture.service((tx) => tx.query(
    `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
     VALUES ($1,$2,'Sam Buyer',$3,$4,$5,$5)`,
    [tenant, id, input.email === undefined ? `sam${unique}@acme.example` : input.email, input.phone === undefined ? `+1415555${unique}` : input.phone, new Date(START)]));
  return id;
}
const fund = (tenant: string, cents: number) => fixture.service((tx) => creditWallet(tx, {
  tenantId: tenant, ledgerId: randomUUID(), amount: cents, idempotencyKey: `credit:${randomUUID()}`, now: new Date(now),
}));
const wallet = (tenant: string) => fixture.service((tx) => getWallet(tx, tenant));
const rows = <T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []) =>
  fixture.service(async (tx) => (await tx.query<T>(sql, params)).rows);

interface Seen { reserved: number; status: string }
function harness(options: Parameters<typeof createFakeEnrichment>[0] = {}, config: EnrichmentConfigInput = baseConfig) {
  const reports: EnrichmentReport[] = [];
  const fake: FakeEnrichment<Seen> = createFakeEnrichment<Seen>({
    ...options,
    async onCall(call) {
      const w = await wallet(call.tenantId);
      const status = (await rows<{ status: string }>("SELECT status FROM enrichment_requests WHERE tenant_id=$1 AND id=$2", [call.tenantId, call.idempotencyKey.replace("enrichment:", "")]))[0]!.status;
      return { reserved: w.reserved, status };
    },
  });
  const worker = createEnrichmentWorker({
    service: fixture.service, port: fake, clock, generateId: randomUUID, report: (event) => reports.push(event),
    config: { workerId: `w-${randomUUID().slice(0, 8)}`, enrichment: config },
  });
  return { fake, worker, reports };
}
const HIT = {
  status: "hit", callId: "call-1", provider: "fake-co", costMicro: 40_000,
  fields: { name: "Acme Inc", industry: "Software", employees: "120", location: "Austin, Texas, United States" },
} as const;

async function freshTenant(name: string): Promise<string> {
  const id = randomUUID();
  await fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [id, name]));
  return id;
}
beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });
beforeEach(async () => {
  // Each test starts with its own tenants, so wallets, caps and contacts never leak between them.
  now += 3 * 24 * 60 * 60 * 1000;
  // The worker claims any tenant's due request, so nothing a failed test left behind may stay due.
  await fixture.service((tx) => tx.query("DELETE FROM enrichment_results"));
  await fixture.service((tx) => tx.query("DELETE FROM enrichment_requests"));
  tenantA = await freshTenant("Tenant A");
  tenantB = await freshTenant("Tenant B");
  ownerA = await addMember(tenantA, "owner");
  staffA = await addMember(tenantA, "staff");
  ownerB = await addMember(tenantB, "owner");
});

describe("the happy path (E-4, E-8, E-10, E-11, E-13, E-14)", () => {
  it("holds, calls once with the cap and tag, captures once, proposes fields, applies two on approval, hides it from tenant B", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA);
    const { fake, worker } = harness({ script: [HIT] });
    const key = randomUUID();
    const requested = await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, key);
    expect(requested.result).toMatchObject({ contactId, status: "pending", domain: "acme.example", priceCents: 5 });
    // The same key replays the same request.
    expect((await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, key)).result.id).toBe(requested.result.id);
    expect(fake.calls).toHaveLength(0);

    await worker.runOnce();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      idempotencyKey: `enrichment:${requested.result.id}`, capHeader: "0.05", tag: tenantA, input: { domain: "acme.example" },
      tool: "treg.companies.enrich",
      seen: { reserved: 5, status: "leased" },
    });
    expect(Object.keys(fake.calls[0]!.input)).toEqual(["domain"]);

    // Captured once: the hold is gone and the balance fell by the price.
    expect(await wallet(tenantA)).toMatchObject({ balance: 995, reserved: 0 });
    expect(await rows("SELECT 1 FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenantA])).toHaveLength(1);
    const request = (await enrichmentFor(tenantA, ownerA).getRequest(requested.result.id));
    expect(request).toMatchObject({ status: "succeeded", reason: null });
    const stored = await rows("SELECT field, value, provider, treg_call_id, approval_id FROM enrichment_results WHERE tenant_id=$1 ORDER BY field", [tenantA]);
    expect(stored.map((row) => row.field)).toEqual(["employees", "industry", "location", "name"]);
    expect(stored.every((row) => row.provider === "fake-co" && row.treg_call_id === "call-1" && row.approval_id)).toBe(true);

    // The contact is unchanged and the profile is empty until an approval runs.
    const detail = await enrichmentFor(tenantA, staffA).getContactEnrichment(contactId);
    expect(detail.profile).toBeNull();
    expect(detail.results).toHaveLength(4);
    const contactRow = (await rows("SELECT display_name, normalized_email, e164_phone FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantA, contactId]))[0];
    expect(contactRow).toMatchObject({ display_name: "Sam Buyer", normalized_email: expect.stringMatching(/^sam\d+@acme\.example$/), e164_phone: expect.stringMatching(/^\+1415555\d+$/) });
    const pending = await rows("SELECT id, action_type, status, summary, payload FROM approvals WHERE tenant_id=$1 ORDER BY summary", [tenantA]);
    expect(pending).toHaveLength(4);
    expect(pending.every((row) => row.action_type === "contact.profile.apply" && row.status === "pending")).toBe(true);
    // E-14: a summary names the field and never the value.
    expect(JSON.stringify(pending.map((row) => row.summary))).not.toMatch(/Acme|Software|Austin/);

    // Approving two fields writes only those two, each with a source record.
    const owner = createSession(deps(), { tenantId: tenantA, actorId: ownerA });
    const wanted = detail.results.filter((result) => result.field === "name" || result.field === "industry");
    for (const result of wanted) await owner.approveApproval(result.approvalId, {}, randomUUID());
    const after = await enrichmentFor(tenantA, ownerA).getContactEnrichment(contactId);
    expect(after.profile).toMatchObject({ companyName: "Acme Inc", companyIndustry: "Software", companyEmployees: null, companyLocation: null });
    const sources = await rows("SELECT source, source_ref FROM source_records WHERE tenant_id=$1 AND subject_id=$2", [tenantA, contactId]);
    expect(sources).toEqual([{ source: "enrichment.treg", source_ref: "call-1" }]);

    // Tenant B reads none of it.
    const other = enrichmentFor(tenantB, ownerB);
    await expect(other.getRequest(requested.result.id)).rejects.toMatchObject({ code: "NotFound" });
    await expect(other.getContactEnrichment(contactId)).rejects.toMatchObject({ code: "NotFound" });
    expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1", [tenantB])).toHaveLength(0);
  });

  it("a staff member may read but not request; the approval of a field is the owner's alone", async () => {
    await fund(tenantA, 100);
    const contactId = await contact(tenantA);
    await expect(enrichmentFor(tenantA, staffA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID())).rejects.toMatchObject({ code: "TenantDenied" });
    await expect(enrichmentFor(tenantA, randomUUID()).getContactEnrichment(contactId)).rejects.toMatchObject({ code: "TenantDenied" });
    await expect(enrichmentFor(tenantA, staffA).getContactEnrichment(contactId)).resolves.toMatchObject({ requests: [] });
  });
});

describe("no call is made (E-5, E-6, E-7, E-8, E-9)", () => {
  async function refused(contactId: string, tenant = tenantA, config: EnrichmentConfigInput = baseConfig, reason?: string) {
    const { fake, worker } = harness({}, config);
    const outcome = enrichmentFor(tenant, ownerA, config).requestEnrichment({ op: "company.enrich", contactId }, randomUUID());
    await expect(outcome).rejects.toMatchObject({ code: "Conflict", details: reason ? { reason } : expect.anything() });
    await worker.runOnce();
    expect(fake.calls).toHaveLength(0);
    expect(await rows("SELECT 1 FROM enrichment_requests WHERE tenant_id=$1", [tenant])).toHaveLength(0);
  }

  it("refuses a +44 phone, a .de domain, an unknown location and a consumer mailbox with no domain", async () => {
    await fund(tenantA, 1000);
    await refused(await contact(tenantA, { phone: "+447700900123" }), tenantA, baseConfig, "enrichment_region_blocked");
    await refused(await contact(tenantA, { email: "ann@firma.de" }), tenantA, baseConfig, "enrichment_region_blocked");
    await refused(await contact(tenantA, { phone: null }), tenantA, baseConfig, "enrichment_region_unknown");
    await refused(await contact(tenantA, { email: "ann@gmail.com" }), tenantA, baseConfig, "enrichment_no_company_domain");
  });

  it("refuses a do_not_enrich contact and an address on the suppression list", async () => {
    await fund(tenantA, 1000);
    const blocked = await contact(tenantA);
    await enrichmentFor(tenantA, staffA).block(blocked, { reason: "asked us not to" }, randomUUID());
    await refused(blocked, tenantA, baseConfig, "enrichment_blocked");
    // Staff may stop it; only an owner may lift it.
    await expect(enrichmentFor(tenantA, staffA).unblock(blocked, randomUUID())).rejects.toMatchObject({ code: "TenantDenied" });
    const suppressed = await contact(tenantA, { email: "ann@suppressed.example" });
    await fixture.service((tx) => tx.query(
      "INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'unsubscribe','test',$3)",
      [tenantA, "ann@suppressed.example", new Date(now)]));
    await refused(suppressed, tenantA, baseConfig, "enrichment_blocked");
  });

  it("an owner's attestation lifts the unknown-location hold, and a later change to the phone clears it (crm.md)", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA, { phone: null });
    await enrichmentFor(tenantA, ownerA).attestRegion(contactId, randomUUID());
    const { fake, worker } = harness();
    await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID());
    await worker.runOnce();
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses when the archive flag is unset, the kill switch is on, or the provider is off", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA);
    await refused(contactId, tenantA, { provider: "fake", archiveConfirmedOff: false }, "enrichment_unavailable");
    await refused(contactId, tenantA, { provider: "fake", archiveConfirmedOff: true, disabled: true }, "enrichment_unavailable");
    await refused(contactId, tenantA, { archiveConfirmedOff: true }, "enrichment_unavailable");
    await expect(createEnrichmentSession(deps(), { tenantId: tenantA, actorId: ownerA }, undefined).requestEnrichment({ op: "company.enrich", contactId }, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict" });
  });

  it("refuses with low funds, and at the daily cap", async () => {
    await fund(tenantB, 4);
    await expect(enrichmentFor(tenantB, ownerB).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantB) }, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "insufficient_funds" } });
    await fund(tenantA, 1000);
    const capped: EnrichmentConfigInput = { ...baseConfig, tenantDailyCap: 1 };
    const { fake, worker } = harness({}, capped);
    const first = await contact(tenantA);
    await enrichmentFor(tenantA, ownerA, capped).requestEnrichment({ op: "company.enrich", contactId: first }, randomUUID());
    await expect(enrichmentFor(tenantA, ownerA, capped).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantA) }, randomUUID()))
      .rejects.toMatchObject({ code: "Conflict", details: { reason: "enrichment_daily_cap" } });
    await worker.runOnce();
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses every attempt while the token is an owner token, and tells the operator, not the tenant", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA);
    const { fake, worker, reports } = harness({ role: "owner" });
    const made = await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID());
    await worker.runOnce();
    expect(fake.calls).toHaveLength(0);
    expect(reports.map((report) => report.code)).toContain("treg_token_is_owner");
    expect(await enrichmentFor(tenantA, ownerA).getRequest(made.result.id)).toMatchObject({ status: "blocked", reason: "enrichment_unavailable" });
    expect(await wallet(tenantA)).toMatchObject({ balance: 1000, reserved: 0 });
  });

  it("stops at the global daily cap across tenants", async () => {
    await fund(tenantA, 1000);
    await fund(tenantB, 1000);
    const capped: EnrichmentConfigInput = { ...baseConfig, globalDailyCap: 1 };
    const { fake, worker } = harness({}, capped);
    const a = await enrichmentFor(tenantA, ownerA, capped).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantA) }, randomUUID());
    const b = await enrichmentFor(tenantB, ownerB, capped).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantB) }, randomUUID());
    await worker.runOnce();
    expect(fake.calls).toHaveLength(1);
    const statuses = [
      (await enrichmentFor(tenantA, ownerA).getRequest(a.result.id)).status,
      (await enrichmentFor(tenantB, ownerB).getRequest(b.result.id)).status,
    ].sort();
    expect(statuses).toEqual(["daily_cap", "no_match"]);
    expect(await wallet(tenantA)).toMatchObject({ reserved: 0 });
    expect(await wallet(tenantB)).toMatchObject({ reserved: 0 });
  });
});

describe("outcomes (E-11, E-12, E-13, E-16)", () => {
  it("a miss releases the hold and charges nothing", async () => {
    await fund(tenantA, 1000);
    const { worker } = harness({ script: [{ status: "miss", callId: "call-m", provider: null, costMicro: 0 }] });
    const made = await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantA) }, randomUUID());
    await worker.runOnce();
    expect(await enrichmentFor(tenantA, ownerA).getRequest(made.result.id)).toMatchObject({ status: "no_match" });
    expect(await wallet(tenantA)).toMatchObject({ balance: 1000, reserved: 0 });
    expect(await rows("SELECT 1 FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenantA])).toHaveLength(0);
    expect(await rows("SELECT 1 FROM enrichment_results WHERE tenant_id=$1", [tenantA])).toHaveLength(0);
  });

  it("a timeout keeps the hold; the replay with the same key captures once", async () => {
    await fund(tenantA, 1000);
    const { fake, worker } = harness({ script: [{ status: "uncertain", code: "provider_timeout" }, HIT] });
    const made = await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantA) }, randomUUID());
    await worker.runOnce();
    expect(await enrichmentFor(tenantA, ownerA).getRequest(made.result.id)).toMatchObject({ status: "uncertain" });
    expect(await wallet(tenantA)).toMatchObject({ balance: 1000, reserved: 5 });
    now += 10 * 60_000;
    await worker.runOnce();
    expect(fake.calls.map((call) => call.idempotencyKey)).toEqual([`enrichment:${made.result.id}`, `enrichment:${made.result.id}`]);
    expect(fake.calls[1]!.seen).toMatchObject({ reserved: 5 });
    expect(await enrichmentFor(tenantA, ownerA).getRequest(made.result.id)).toMatchObject({ status: "succeeded" });
    expect(await wallet(tenantA)).toMatchObject({ balance: 995, reserved: 0 });
    expect(await rows("SELECT 1 FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [tenantA])).toHaveLength(1);
    expect(await rows("SELECT 1 FROM wallet_reservations WHERE tenant_id=$1", [tenantA])).toHaveLength(1);
  });

  it("an answer naming France is discarded unstored, the hold is released, and the contact learns its country", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA);
    const french = { ...HIT, fields: { name: "Acme SA", location: "Paris, France" } } as const;
    const { worker } = harness({ script: [french] });
    const made = await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID());
    await worker.runOnce();
    expect(await enrichmentFor(tenantA, ownerA).getRequest(made.result.id)).toMatchObject({ status: "region_blocked_after_call" });
    expect(await rows("SELECT 1 FROM enrichment_results WHERE tenant_id=$1", [tenantA])).toHaveLength(0);
    expect(await rows("SELECT 1 FROM approvals WHERE tenant_id=$1", [tenantA])).toHaveLength(0);
    expect(await wallet(tenantA)).toMatchObject({ balance: 1000, reserved: 0 });
    const detail = await enrichmentFor(tenantA, ownerA).getContactEnrichment(contactId);
    expect(detail.profile).toMatchObject({ country: "FR", companyName: null });
    // The next request is refused before any hold.
    await expect(enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID()))
      .rejects.toMatchObject({ details: { reason: "enrichment_region_blocked" } });
  });

  it("a 499-cent balance reports treg_balance_low to the operator and to no tenant", async () => {
    await fund(tenantA, 1000);
    const { worker, reports } = harness({ script: [HIT], balanceMicro: 4_990_000 });
    await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantA) }, randomUUID());
    await worker.runOnce();
    expect(reports).toContainEqual({ code: "treg_balance_low", balanceMicro: 4_990_000 });
    for (const report of reports.filter((entry) => entry.code === "treg_balance_low")) expect(report.tenantId).toBeUndefined();
    expect(await rows("SELECT 1 FROM outbox WHERE tenant_id=$1 AND event_type LIKE '%balance%'", [tenantA])).toHaveLength(0);
    // A healthy balance reports nothing.
    const healthy = harness({ script: [HIT], balanceMicro: 5_000_000 });
    await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantA) }, randomUUID());
    await healthy.worker.runOnce();
    expect(healthy.reports.map((report) => report.code)).not.toContain("treg_balance_low");
  });

  it("an answer lost to an expired key is looked up: charged releases the hold and ends answer_lost", async () => {
    await fund(tenantA, 1000);
    const { fake, worker } = harness({ script: [{ status: "key_expired", callId: null }], lookups: [{ status: "charged", callId: "call-lost" }] });
    const made = await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId: await contact(tenantA) }, randomUUID());
    await worker.runOnce();
    expect(fake.lookupCalls).toHaveLength(1);
    expect(await enrichmentFor(tenantA, ownerA).getRequest(made.result.id)).toMatchObject({ status: "answer_lost" });
    expect(await wallet(tenantA)).toMatchObject({ balance: 1000, reserved: 0 });
  });

  it("purges results past their expiry and keeps applied values", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA);
    const { worker } = harness({ script: [HIT] });
    await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID());
    await worker.runOnce();
    const detail = await enrichmentFor(tenantA, ownerA).getContactEnrichment(contactId);
    const name = detail.results.find((result) => result.field === "name")!;
    await createSession(deps(), { tenantId: tenantA, actorId: ownerA }).approveApproval(name.approvalId, {}, randomUUID());
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await worker.purgeExpired()).toBe(4);
    const after = await enrichmentFor(tenantA, ownerA).getContactEnrichment(contactId);
    expect(after.results).toHaveLength(0);
    expect(after.profile).toMatchObject({ companyName: "Acme Inc" });
  });
});

describe("review fixes (E-6, E-7, E-10, E-14, E-17)", () => {
  it("a queued request is stopped when the company domain has since moved into the refused region", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA);
    const { fake, worker } = harness({ script: [HIT] });
    const requested = await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID());
    await fixture.service((tx) => tx.query(
      "INSERT INTO crm_contact_profile (tenant_id, contact_id, company_domain, updated_at) VALUES ($1,$2,'firma.de',$3)", [tenantA, contactId, new Date(now)]));
    await worker.runOnce();
    expect(fake.calls).toHaveLength(0);
    expect(await enrichmentFor(tenantA, ownerA).getRequest(requested.result.id)).toMatchObject({ status: "blocked", reason: "enrichment_region_blocked" });
  });

  it("an approval cannot write a field after the contact's address is suppressed", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA, { email: "ann@later-suppressed.example" });
    const { worker } = harness({ script: [HIT] });
    await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID());
    await worker.runOnce();
    const detail = await enrichmentFor(tenantA, ownerA).getContactEnrichment(contactId);
    await fixture.service((tx) => tx.query(
      "INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'unsubscribe','test',$3)",
      [tenantA, "ann@later-suppressed.example", new Date(now)]));
    const owner = createSession(deps(), { tenantId: tenantA, actorId: ownerA });
    await owner.approveApproval(detail.results.find((result) => result.field === "name")!.approvalId, {}, randomUUID()).catch(() => undefined);
    expect((await enrichmentFor(tenantA, ownerA).getContactEnrichment(contactId)).profile?.companyName ?? null).toBeNull();
  });

  it("a tenant reads an internal reason as unavailable", async () => {
    await fund(tenantA, 1000);
    const contactId = await contact(tenantA);
    const requested = await enrichmentFor(tenantA, ownerA).requestEnrichment({ op: "company.enrich", contactId }, randomUUID());
    await fixture.service((tx) => tx.query(
      "UPDATE enrichment_requests SET status='dead', final_reason='outcome_unknown' WHERE tenant_id=$1 AND id=$2", [tenantA, requested.result.id]));
    expect(await enrichmentFor(tenantA, ownerA).getRequest(requested.result.id)).toMatchObject({ status: "dead", reason: "enrichment_unavailable" });
  });
});
