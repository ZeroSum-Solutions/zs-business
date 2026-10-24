// BT-3 and BT-8: saving targets, their canonical origins and their credential references, under the
// runtime role. No site, runner or model: these are the owner's writes and the request policy.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, Conflict, TenantDenied } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import {
  browserConfig, createBrowserSession, createMemoryArtifactStore, createRequestPolicy, FAKE_MODEL_PRICES, type EdgeDependencies,
} from "../src/index.js";

const clock = { now: () => new Date("2026-10-20T12:00:00.000Z") };
const config = browserConfig({ stepPrice: 10, modelPrices: FAKE_MODEL_PRICES, stepModelReserveMicros: 100, allowLoopback: false });
const artifacts = createMemoryArtifactStore();
const ATTEST = { termsAllowAutomatedAccess: true, notInsurerOrPayerPortal: true } as const;

let database: TestDatabase;
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

async function member(tenantId: string, role: "owner" | "staff") {
  const userId = randomUUID();
  await service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, clock.now()]));
  return userId;
}

async function tenant() {
  const tenantId = randomUUID();
  await service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [tenantId, "Clinic"]));
  const owner = await member(tenantId, "owner");
  const staff = await member(tenantId, "staff");
  const sessionFor = (actorId: string) => createBrowserSession(deps(), { tenantId, actorId }, { config, artifacts });
  const secretRef = `browser/${tenantId}/supplier`;
  const saved = await sessionFor(owner).saveTarget({
    expectedRevision: 0, name: "Supplier portal", taskKind: "supplier_invoice_download", allowedOrigins: ["https://portal.example"],
    allowedPaths: ["/invoices"], signInPath: "/login", enabled: true, secretRef, attestation: ATTEST,
  }, randomUUID());
  const edit = (extra: Record<string, unknown>) => ({
    targetId: saved.result.id, expectedRevision: saved.result.revision, name: "Supplier portal", taskKind: "supplier_invoice_download",
    allowedOrigins: ["https://portal.example"], allowedPaths: ["/invoices"], signInPath: "/login", enabled: true, attestation: ATTEST, ...extra,
  });
  return { tenantId, owner, staff, sessionFor, secretRef, targetId: saved.result.id, edit };
}
const credentials = (tenantId: string) =>
  service(async (tx) => (await tx.query<{ target_id: string; secret_ref: string }>(
    "SELECT target_id, secret_ref FROM browser_credentials WHERE tenant_id=$1", [tenantId])).rows);

async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

describe("credential references on target save (BT-8)", () => {
  it("lets the owner clear its own credential reference under the runtime role", async () => {
    const a = await tenant();
    expect(await credentials(a.tenantId)).toHaveLength(1);
    const cleared = await a.sessionFor(a.owner).saveTarget(a.edit({ secretRef: null }), randomUUID());
    expect(cleared.result).toMatchObject({ hasCredentials: false, revision: 2 });
    expect(await credentials(a.tenantId)).toEqual([]);
  });

  it("keeps the credential when the revision is stale or the member lacks `agents`", async () => {
    const a = await tenant();
    const stale = await rejection(a.sessionFor(a.owner).saveTarget(a.edit({ expectedRevision: 0, secretRef: null }), randomUUID()));
    expect(stale).toBeInstanceOf(Conflict);
    const overwrite = await rejection(a.sessionFor(a.owner).saveTarget(
      a.edit({ expectedRevision: 7, secretRef: `browser/${a.tenantId}/other` }), randomUUID()));
    expect(overwrite).toBeInstanceOf(Conflict);
    expect(await rejection(a.sessionFor(a.staff).saveTarget(a.edit({ secretRef: null }), randomUUID()))).toBeInstanceOf(TenantDenied);
    expect(await credentials(a.tenantId)).toEqual([{ target_id: a.targetId, secret_ref: a.secretRef }]);
  });

  it("never lets tenant B clear or overwrite tenant A's credential", async () => {
    const a = await tenant();
    const b = await tenant();
    // B names A's target ID: it is a new, unrelated target in B's own tenant, so revision 1 is stale.
    expect(await rejection(b.sessionFor(b.owner).saveTarget({ ...a.edit({ secretRef: null }) }, randomUUID()))).toBeInstanceOf(Conflict);
    // A cross-tenant secret reference is refused outright.
    expect(await rejection(b.sessionFor(b.owner).saveTarget(b.edit({ secretRef: a.secretRef }), randomUUID()))).toBeInstanceOf(ActionError);
    // B's actor cannot act in A's tenant.
    expect(await rejection(createBrowserSession(deps(), { tenantId: a.tenantId, actorId: b.owner }, { config, artifacts })
      .saveTarget(a.edit({ secretRef: null }), randomUUID()))).toBeInstanceOf(ActionError);
    expect(await credentials(a.tenantId)).toEqual([{ target_id: a.targetId, secret_ref: a.secretRef }]);
  });

  it("lets the runtime role delete only its own tenant's credential rows", async () => {
    const a = await tenant();
    const b = await tenant();
    const removed = (tenantId: string, victim: string) =>
      database.db.tenant(tenantId, async (tx) => (await tx.query("DELETE FROM browser_credentials WHERE tenant_id=$1", [victim])).rowCount);
    expect(await removed(b.tenantId, a.tenantId)).toBe(0);
    expect(await credentials(a.tenantId)).toHaveLength(1);
    expect(await removed(a.tenantId, a.tenantId)).toBe(1);
    expect(await credentials(a.tenantId)).toEqual([]);
  });
});

describe("canonical origins (BT-3)", () => {
  it("stores canonical origins and refuses duplicates that differ only in form", async () => {
    const a = await tenant();
    const saved = await a.sessionFor(a.owner).saveTarget(a.edit({ allowedOrigins: ["HTTPS://Portal.Example:443", "https://cdn.example:8443"] }), randomUUID());
    expect(saved.result.allowedOrigins).toEqual(["https://portal.example", "https://cdn.example:8443"]);
    expect(await rejection(a.sessionFor(a.owner).saveTarget(
      a.edit({ expectedRevision: 2, allowedOrigins: ["https://portal.example", "https://portal.example:443"] }), randomUUID()))).toBeInstanceOf(ActionError);
  });

  it("matches requests against canonical origins in the policy", () => {
    const policy = createRequestPolicy({ allowedOrigins: ["https://x.example:443", "HTTPS://Y.EXAMPLE"], allowedPaths: ["/invoices"], assetPaths: [], signInPath: "/login" });
    expect(policy.check({ method: "GET", url: "https://x.example/invoices", resourceType: "document" })).toMatchObject({ allow: true });
    expect(policy.check({ method: "GET", url: "https://x.example:443/invoices", resourceType: "document" })).toMatchObject({ allow: true });
    expect(policy.check({ method: "GET", url: "https://y.example/invoices", resourceType: "document" })).toMatchObject({ allow: true });
    expect(policy.check({ method: "GET", url: "https://x.example:8443/invoices", resourceType: "document" })).toMatchObject({ allow: false, reason: "origin_denied" });
    expect(policy.check({ method: "GET", url: "http://x.example/invoices", resourceType: "document" })).toMatchObject({ allow: false, reason: "origin_denied" });
  });

  it("drops origins it cannot parse instead of matching them loosely", () => {
    const policy = createRequestPolicy({ allowedOrigins: ["not a url", "https://x.example/path"], allowedPaths: ["/"], assetPaths: [], signInPath: "/login" });
    expect(policy.check({ method: "GET", url: "https://x.example/", resourceType: "document" })).toMatchObject({ allow: false, reason: "origin_denied" });
  });
});
