// hub-access.md H-1, H-3, H-8, H-11, H-12: a token with a read scope. The expiry it must carry,
// the read adapter's lock and checks (including a revoke that waits for an in-flight read), the
// hourly usage record and its 30-day prune, and tenant isolation of the usage table under the
// runtime role. Fake data only: Halden & Rowe.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, AUTOMATION_SCOPES, READ_SCOPES, type AutomationScope } from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import {
  createTokenReads,
  recordTokenUsage,
  Unauthenticated,
  USAGE_RETENTION_DAYS,
  type AutomationPrincipal,
} from "../../src/index.js";
import { createAutomationHarness, START, type AutomationHarness } from "./helpers.js";

let h: AutomationHarness;
beforeAll(async () => { h = await createAutomationHarness(); });
afterAll(async () => { await h?.close(); });

const DAY = 86_400_000;
const HOUR = 3_600_000;
const code = (error: unknown) => (error instanceof ActionError ? error.code : error instanceof Unauthenticated ? "Unauthenticated" : String(error));

/** A site row of the tenant, for a token that names one (H-14). */
async function seedSite(tenantId: string): Promise<string> {
  const siteId = randomUUID();
  await h.database.pool.query("INSERT INTO sites (tenant_id,id,name,created_at,updated_at) VALUES ($1,$2,'Site',now(),now())", [tenantId, siteId]);
  return siteId;
}

async function mint(scopes: AutomationScope[], tenant = h.a, extra: { expiresInDays?: number | null; siteIds?: string[] } = {}) {
  const created = await h.admin(tenant).createToken({ name: `Hub ${scopes.length}`, scopes, ...extra }, randomUUID());
  const principal = await h.inbound().authenticate(`Bearer ${created.secret}`);
  return { ...created, principal };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The same database, with every statement a transaction sends given to `watch` first. */
function watched(db: ScopedDatabase, watch: (sql: string) => Promise<void> | void): ScopedDatabase {
  const wrap = (tx: Transaction): Transaction => ({
    query: (async (sql: string, params?: unknown[]) => {
      await watch(sql);
      return tx.query(sql as never, params as never);
    }) as Transaction["query"],
  });
  return {
    ...db,
    tenant: (tenantId, work, options) => db.tenant(tenantId, (tx) => work(wrap(tx)), options),
  };
}

describe("expiry of a read token (H-1, H-12)", () => {
  it("defaults to 90 days with a read scope, and leaves a propose-only token without one", async () => {
    const read = await mint(["contacts:read"]);
    expect(read.token.expiresAt).toBe(new Date(START + 90 * DAY).toISOString());
    const propose = await mint(["contacts:propose"]);
    expect(propose.token.expiresAt).toBeNull();
    const mixed = await mint(["contacts:propose", "deals:read"], h.a, { expiresInDays: 365 });
    expect(mixed.token.expiresAt).toBe(new Date(START + 365 * DAY).toISOString());
  });

  it("refuses a read token without an expiry, or with one outside 1 to 365 days", async () => {
    const admin = h.admin(h.a);
    for (const expiresInDays of [null, 0, 366, 1.5])
      expect(await admin.createToken({ name: "No", scopes: ["inbox:read"], expiresInDays }, randomUUID()).catch(code), String(expiresInDays))
        .toBe("ValidationFailed");
    // A propose-only token may still say null.
    expect((await admin.createToken({ name: "Old", scopes: ["bookings:propose"], expiresInDays: null }, randomUUID())).token.expiresAt).toBeNull();
  });

  it("holds all eleven scopes", async () => {
    const siteId = await seedSite(h.a.tenantId);
    const all = await mint([...AUTOMATION_SCOPES], h.a, { siteIds: [siteId] });
    expect([...all.principal.scopes].sort()).toEqual([...AUTOMATION_SCOPES].sort());
    expect(all.token.siteIds).toEqual([siteId]);
  });

  it("gives sites:publish an expiry and a site list, names only the tenant's own sites, and shows both in whoami (H-13, H-14)", async () => {
    const own = await seedSite(h.a.tenantId);
    const foreign = await seedSite(h.b.tenantId);
    const admin = h.admin(h.a);
    // The scope needs 1 to 10 distinct sites, and the list needs the scope.
    for (const request of [
      { scopes: ["sites:publish"] }, { scopes: ["sites:publish"], siteIds: [] }, { scopes: ["sites:publish"], siteIds: [own, own] },
      { scopes: ["sites:publish"], siteIds: Array.from({ length: 11 }, () => randomUUID()) },
      { scopes: ["contacts:read"], siteIds: [own] }, { scopes: ["sites:publish"], siteIds: [own], expiresInDays: null },
    ] as const)
      expect(await admin.createToken({ name: "No", ...request } as never, randomUUID()).catch(code), JSON.stringify(request)).toBe("ValidationFailed");
    // A foreign or unknown site is refused the same way, and no token is left behind.
    const before = (await h.database.pool.query("SELECT count(*)::int AS n FROM automation_tokens WHERE tenant_id=$1", [h.a.tenantId])).rows[0].n;
    for (const siteId of [foreign, randomUUID()])
      expect(await admin.createToken({ name: "No", scopes: ["sites:publish"], siteIds: [siteId] }, randomUUID()).catch(code)).toBe("ValidationFailed");
    expect((await h.database.pool.query("SELECT count(*)::int AS n FROM automation_tokens WHERE tenant_id=$1", [h.a.tenantId])).rows[0].n).toBe(before);

    const { token, principal } = await mint(["sites:publish"], h.a, { siteIds: [own] });
    expect(token).toMatchObject({ scopes: ["sites:publish"], siteIds: [own] });
    expect(token.expiresAt).not.toBeNull();
    expect(await h.inbound().whoAmI(principal)).toMatchObject({ tenantId: h.a.tenantId, siteIds: [own], scopes: ["sites:publish"] });
    const plain = await mint(["contacts:propose"]);
    expect(await h.inbound().whoAmI(plain.principal)).toMatchObject({ tenantId: h.a.tenantId, siteIds: [] });
  });

  it("is enforced by the database too: a read token cannot lose its expiry, or outlive 365 days", async () => {
    const { token } = await mint(["results:read"]);
    const bad = (expires: string) => h.database.pool.query(
      `UPDATE automation_tokens SET expires_at = ${expires} WHERE tenant_id=$1 AND id=$2`, [h.a.tenantId, token.id]);
    await expect(bad("NULL")).rejects.toMatchObject({ code: "23514" });
    await expect(bad("created_at + interval '9000 hours'")).rejects.toMatchObject({ code: "23514" });
    await expect(bad("created_at + interval '1 hour'")).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the read adapter (H-3)", () => {
  it("reads only what the scope allows, and refuses a missing scope before any business row is read", async () => {
    const seen: string[] = [];
    const reads = createTokenReads({ ...h.deps(), db: watched(h.deps().db, (sql) => { seen.push(sql); }) });
    const { principal } = await mint(["contacts:read"]);
    await reads.listContacts(principal, {});
    expect(await reads.listDeals(principal, {}).catch(code)).toBe("TenantDenied");
    expect(await reads.getBusiness(principal).catch(code)).toBe("TenantDenied");
    expect(await reads.listThreads(principal, {}).catch(code)).toBe("TenantDenied");
    seen.length = 0;
    expect(await reads.homeResults(principal, {}).catch(code)).toBe("TenantDenied");
    // The refused read sent the token lock and nothing that touches customers, deals or bookings.
    expect(seen.filter((sql) => /crm_|bookings|intake_items|business_profiles/.test(sql) && !/automation_tokens/.test(sql))).toEqual([]);
  });

  it("checks the clock after the lock: a revoked or expired token is refused, whatever the principal says", async () => {
    const reads = createTokenReads(h.deps());
    const revoked = await mint(["contacts:read"]);
    await reads.listContacts(revoked.principal, {});
    await h.admin(h.a).revokeToken(revoked.token.id, {}, randomUUID());
    expect(await reads.listContacts(revoked.principal, {}).catch(code)).toBe("Unauthenticated");
    const expiring = await mint(["contacts:read"], h.a, { expiresInDays: 1 });
    await reads.listContacts(expiring.principal, {});
    h.clock.advance(DAY + HOUR);
    try {
      expect(await reads.listContacts(expiring.principal, {}).catch(code)).toBe("Unauthenticated");
    } finally {
      h.clock.set(START);
    }
  });

  it("returns the tenant's own rows and nothing of the other tenant, also for the other tenant's IDs", async () => {
    const reads = createTokenReads(h.deps());
    const mine = await h.session(h.a).upsertContact({ displayName: "Rowan Halden", email: `rowan-${randomUUID().slice(0, 6)}@haldenrowe.example` }, randomUUID());
    const theirs = await h.session(h.b).upsertContact({ displayName: "Bea Other", email: `bea-${randomUUID().slice(0, 6)}@haldenrowe.example` }, randomUUID());
    const a = (await mint([...READ_SCOPES], h.a)).principal;
    const b = (await mint([...READ_SCOPES], h.b)).principal;
    const listed = await reads.listContacts(a, {});
    expect(listed.items.map((item) => item.id)).toContain(mine.result.contact.id);
    expect(listed.items.map((item) => item.id)).not.toContain(theirs.result.contact.id);
    expect(await reads.getContact(a, theirs.result.contact.id).catch(code)).toBe("NotFound");
    expect((await reads.getContact(b, theirs.result.contact.id)).id).toBe(theirs.result.contact.id);
    expect(await reads.getContact(b, mine.result.contact.id).catch(code)).toBe("NotFound");
    expect((await reads.listContacts(a, { ids: theirs.result.contact.id })).items).toEqual([]);
    expect(await reads.getThread(a, `c_${theirs.result.contact.id}`).catch(code)).toBe("NotFound");
    // Every other read answers for the token's tenant.
    expect((await reads.listPipelines(a)).items.map((pipeline) => pipeline.id)).toEqual([h.a.pipelineId]);
    expect((await reads.listResources(a)).items.map((resource) => resource.id)).toEqual([h.a.resourceId]);
    expect((await reads.listPipelines(b)).items.map((pipeline) => pipeline.id)).toEqual([h.b.pipelineId]);
    expect(await reads.listDeals(a, { contactId: theirs.result.contact.id })).toMatchObject({ items: [] });
    await reads.listBookings(a, {});
    await reads.listThreads(a, {});
    await reads.homeResults(a, { zone: "UTC" });
  });

  it("makes a revoke wait for a read that holds the lock, then refuses the next read", async () => {
    const { token, principal } = await mint(["contacts:read"]);
    let reached!: () => void;
    const atBusinessRows = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = createTokenReads({
      ...h.deps(),
      db: watched(h.deps().db, async (sql) => {
        if (/FROM crm_contacts/i.test(sql)) {
          reached();
          await gate;
        }
      }),
    });
    const inFlight = slow.listContacts(principal, {});
    await atBusinessRows;

    let revoked = false;
    const revoking = h.admin(h.a).revokeToken(token.id, {}, randomUUID()).then(() => { revoked = true; });
    await sleep(400);
    // The read holds the shared lock, so the revoke has not committed.
    expect(revoked).toBe(false);
    const waiting = await h.database.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type='Lock' AND query ILIKE '%automation_tokens%' AND query ILIKE '%FOR UPDATE%'");
    expect(Number(waiting.rows[0]!.n)).toBeGreaterThan(0);

    release();
    expect((await inFlight).items).toBeInstanceOf(Array);
    await revoking;
    expect(revoked).toBe(true);
    expect(await createTokenReads(h.deps()).listContacts(principal, {}).catch(code)).toBe("Unauthenticated");
  });
});

describe("usage record (H-8, H-11)", () => {
  it("adds to one row per token per hour, and an owner reads the last 7 days", async () => {
    const { token, principal } = await mint(["contacts:read"]);
    const deps = h.deps();
    await recordTokenUsage(deps, principal, { requests: 1, reads: 1, proposals: 0, refusals: 0 });
    await Promise.all([
      recordTokenUsage(deps, principal, { requests: 1, reads: 0, proposals: 1, refusals: 0 }),
      recordTokenUsage(deps, principal, { requests: 1, reads: 0, proposals: 0, refusals: 1 }),
    ]);
    h.clock.advance(HOUR);
    try {
      await recordTokenUsage(deps, principal, { requests: 2, reads: 2, proposals: 0, refusals: 0 });
      const usage = await h.admin(h.a).tokenUsage(token.id);
      expect(usage.hours).toEqual([
        { hour: new Date(START).toISOString(), requests: 3, reads: 1, proposals: 1, refusals: 1 },
        { hour: new Date(START + HOUR).toISOString(), requests: 2, reads: 2, proposals: 0, refusals: 0 },
      ]);
      expect(usage.totals).toEqual({ requests: 5, reads: 3, proposals: 1, refusals: 1 });
      // Eight days on, the first hours are outside the 7-day window.
      h.clock.advance(8 * DAY);
      expect((await h.admin(h.a).tokenUsage(token.id)).hours).toEqual([]);
    } finally {
      h.clock.set(START);
    }
  });

  it("is the owner's: another tenant's owner cannot see a token's usage, and staff cannot read it", async () => {
    const { token, principal } = await mint(["contacts:read"]);
    await recordTokenUsage(h.deps(), principal, { requests: 1, reads: 1, proposals: 0, refusals: 0 });
    expect(await h.admin(h.b).tokenUsage(token.id).catch(code)).toBe("NotFound");
    expect(await h.admin(h.a, h.a.staffId).tokenUsage(token.id).catch(code)).toBe("TenantDenied");
  });

  it("is hidden from the other tenant under the runtime role, for reads, updates, deletes and inserts", async () => {
    const { token, principal } = await mint(["contacts:read"]);
    await recordTokenUsage(h.deps(), principal, { requests: 1, reads: 1, proposals: 0, refusals: 0 });
    const db = h.deps().db;
    const rows = (tenantId: string) => db.tenant(tenantId, async (tx) =>
      (await tx.query("SELECT * FROM automation_token_usage WHERE token_id=$1", [token.id])).rows);
    expect(await rows(h.a.tenantId)).toHaveLength(1);
    expect(await rows(h.b.tenantId)).toEqual([]);
    const touched = await db.tenant(h.b.tenantId, async (tx) =>
      (await tx.query("UPDATE automation_token_usage SET requests = requests + 1 WHERE token_id=$1", [token.id])).rowCount);
    expect(touched).toBe(0);
    // The runtime role has no DELETE at all; and a row naming the other tenant fails the policy.
    await expect(db.tenant(h.b.tenantId, (tx) => tx.query("DELETE FROM automation_token_usage WHERE token_id=$1", [token.id])))
      .rejects.toMatchObject({ code: "42501" });
    await expect(db.tenant(h.b.tenantId, (tx) => tx.query(
      "INSERT INTO automation_token_usage (tenant_id, token_id, hour) VALUES ($1,$2,$3)", [h.a.tenantId, token.id, new Date(START + 5 * HOUR)])))
      .rejects.toMatchObject({ code: "42501" });
    // The counters are the only columns the runtime role may update.
    await expect(db.tenant(h.a.tenantId, (tx) => tx.query(
      "UPDATE automation_token_usage SET hour = hour + interval '1 hour' WHERE token_id=$1", [token.id])))
      .rejects.toMatchObject({ code: "42501" });
    expect(await rows(h.a.tenantId)).toHaveLength(1);
  });

  it("only grows: a decrease is refused, and tenant B cannot count against tenant A's token", async () => {
    const { token, principal } = await mint(["contacts:read"]);
    const db = h.deps().db;
    await recordTokenUsage(h.deps(), principal, { requests: 3, reads: 2, proposals: 1, refusals: 1 });
    for (const column of ["requests", "reads", "proposals", "refusals"])
      await expect(db.tenant(h.a.tenantId, (tx) => tx.query(
        `UPDATE automation_token_usage SET ${column} = ${column} - 1 WHERE token_id=$1`, [token.id])))
        .rejects.toMatchObject({ code: "23514" });
    await db.tenant(h.a.tenantId, (tx) => tx.query(
      "UPDATE automation_token_usage SET requests = requests + 4, reads = reads WHERE token_id=$1", [token.id]));
    const [row] = await h.rows<{ requests: number; reads: number; proposals: number; refusals: number }>(
      "SELECT requests, reads, proposals, refusals FROM automation_token_usage WHERE token_id=$1", [token.id]);
    expect(row).toEqual({ requests: 7, reads: 2, proposals: 1, refusals: 1 });
    // A row of tenant B that names tenant A's token breaks the composite foreign key; nothing is inserted.
    await expect(db.tenant(h.b.tenantId, (tx) => tx.query(
      "INSERT INTO automation_token_usage (tenant_id, token_id, hour, requests) VALUES ($1,$2,$3,1)",
      [h.b.tenantId, token.id, new Date(Math.floor(START / HOUR) * HOUR)]))).rejects.toMatchObject({ code: "23503" });
    expect(await h.rows("SELECT 1 FROM automation_token_usage WHERE tenant_id=$1", [h.b.tenantId])).toEqual([]);
  });

  it("is pruned after 30 days by the worker pass, a bounded batch at a time", async () => {
    const { token, principal } = await mint(["contacts:read"]);
    const deps = h.deps();
    const old = new Date(START - (USAGE_RETENTION_DAYS + 2) * DAY);
    const recent = new Date(START - (USAGE_RETENTION_DAYS - 2) * DAY);
    for (const hour of [old, new Date(old.getTime() + HOUR), recent])
      await h.service((tx) => tx.query(
        "INSERT INTO automation_token_usage (tenant_id, token_id, hour, requests) VALUES ($1,$2,$3,1)", [principal.tenantId, token.id, hour]));
    await recordTokenUsage(deps, principal, { requests: 1, reads: 0, proposals: 0, refusals: 0 });
    const pass = await h.worker().runOnce();
    expect(pass.usagePruned).toBeGreaterThanOrEqual(2);
    const left = await h.rows<{ hour: Date }>("SELECT hour FROM automation_token_usage WHERE token_id=$1 ORDER BY hour", [token.id]);
    expect(left.map((row) => row.hour.toISOString())).toEqual([recent.toISOString(), new Date(Math.floor(START / HOUR) * HOUR).toISOString()]);
  });

  it("reads exactly 168 hours: the hour 167 hours back is in, the one 168 back is out, and a later hour is never in", async () => {
    const { token, principal } = await mint(["contacts:read"]);
    const deps = h.deps();
    await recordTokenUsage(deps, principal, { requests: 1, reads: 0, proposals: 0, refusals: 0 });
    // A row in the next hour already exists (written by a clock that ran ahead): a read now never shows it.
    await h.service((tx) => tx.query(
      "INSERT INTO automation_token_usage (tenant_id, token_id, hour, requests) VALUES ($1,$2,$3,7)", [principal.tenantId, token.id, new Date(START + HOUR)]));
    try {
      expect((await h.admin(h.a).tokenUsage(token.id)).totals.requests).toBe(1);
      h.clock.set(START + 167 * HOUR);
      expect((await h.admin(h.a).tokenUsage(token.id)).hours.map((row) => row.hour)).toContain(new Date(START).toISOString());
      h.clock.set(START + 168 * HOUR);
      const edge = await h.admin(h.a).tokenUsage(token.id);
      expect(edge.hours.map((row) => row.hour)).not.toContain(new Date(START).toISOString());
      expect(edge.hours.map((row) => row.hour)).toContain(new Date(START + HOUR).toISOString());
      expect(edge.totals.requests).toBe(7);
    } finally {
      h.clock.set(START);
    }
  });

  it("prunes a backlog bigger than a batch over several bounded calls, and leaves rows inside the retention", async () => {
    const { token, principal } = await mint(["contacts:read"]);
    const old = new Date(START - (USAGE_RETENTION_DAYS + 2) * DAY);
    const recent = new Date(START - (USAGE_RETENTION_DAYS - 2) * DAY);
    await h.service(async (tx) => {
      await tx.query(
        `INSERT INTO automation_token_usage (tenant_id, token_id, hour, requests)
         SELECT $1, $2, $3::timestamptz - n * interval '1 hour', 1 FROM generate_series(0, 2499) n`, [principal.tenantId, token.id, old]);
      await tx.query("INSERT INTO automation_token_usage (tenant_id, token_id, hour, requests) VALUES ($1,$2,$3,1)", [principal.tenantId, token.id, recent]);
    });
    const left = async () => (await h.rows<{ n: string }>("SELECT count(*) AS n FROM automation_token_usage WHERE token_id=$1", [token.id]))[0]!.n;
    const worker = h.worker();
    // Batches of 100, at most five a call: 500 rows go, the rest wait for the next call.
    expect(await worker.pruneUsage(100)).toBe(500);
    expect(await left()).toBe("2001");
    // Batches of 1,000, five at most: the 2,000 left go in three batches (1,000, 1,000, 0).
    expect(await worker.pruneUsage(1000)).toBe(2000);
    expect(await left()).toBe("1");
    expect(await worker.pruneUsage()).toBe(0);
    expect(await left()).toBe("1");
  });
});

describe("principals", () => {
  it("is not what a request body names: a principal for tenant B with tenant A's token ID reads nothing", async () => {
    const a = await mint(["contacts:read"]);
    const forged: AutomationPrincipal = { ...a.principal, tenantId: h.b.tenantId };
    expect(await createTokenReads(h.deps()).listContacts(forged, {}).catch(code)).toBe("Unauthenticated");
  });
});
