import { randomUUID } from "node:crypto";
import { asService } from "@zs/db";
import type { TestDatabase, TwoTenantFixture } from "@zs/db/testing";
import { composioUserId, createComposioClient, createConnectionsWorker, type ConnectionsWorkerConfig, type ConnectionsWorkerReport } from "../../src/index.js";
import type { FakeComposio } from "./fake-composio.js";

export const T0 = Date.parse("2026-11-06T12:00:00.000Z");
export const AUTH_CONFIG = "ac_shopify";
export const CALLBACK_URL = "https://dashboard.example.test/api/connections/callback";
export const ENV = "preview" as const;

export interface TestClock { ms: number; now(): Date }
export const makeClock = (ms = T0): TestClock => ({ ms, now() { return new Date(this.ms); } });

export async function addMember(fixture: TwoTenantFixture, tenantId: string, role: "owner" | "staff", at = new Date(T0)) {
  const userId = randomUUID();
  const memberId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, memberId, `${role}-${memberId.slice(0, 8)}@example.com`, userId, role, at]));
  return { userId, memberId };
}

/** A tenant with an owner, for tests that need many live rows (one live row per tenant and toolkit). */
export async function newTenant(fixture: TwoTenantFixture, role: "owner" | "staff" = "owner") {
  const tenantId = randomUUID();
  await fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [tenantId, `Tenant ${tenantId.slice(0, 8)}`]));
  return { tenantId, ...(await addMember(fixture, tenantId, role)) };
}

export interface SeedConnection {
  tenantId: string;
  memberId: string;
  id?: string;
  toolkit?: string;
  accountId: string;
  status?: "active" | "reauthorize" | "disconnecting" | "disconnected";
  reason?: "provider_status" | "auth_error" | null;
  lastChecked?: Date;
  domain?: string;
  errorCode?: string | null;
}
export async function seedConnection(fixture: TwoTenantFixture, input: SeedConnection): Promise<string> {
  const id = input.id ?? randomUUID();
  const status = input.status ?? "active";
  const reason = input.reason ?? (status === "reauthorize" ? "provider_status" : null);
  await fixture.service((tx) => tx.query(
    `INSERT INTO connections (tenant_id,id,tier,toolkit,composio_account_id,external_account_id,account_domain,account_label,status,reauthorize_reason,
       connected_by,last_checked_at,last_error_code,created_at,updated_at)
     VALUES ($1,$2,'composio',$3,$4,'8812345',$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
    [input.tenantId, id, input.toolkit ?? "shopify", input.accountId, input.domain ?? "testshop.myshopify.com",
      status === "disconnected" ? null : "Test Shop", status, reason, input.memberId, input.lastChecked ?? new Date(T0), input.errorCode ?? null, new Date(T0)]));
  return id;
}
export const statusOf = (fixture: TwoTenantFixture, tenantId: string, id: string) =>
  fixture.service(async (tx) => (await tx.query<{ status: string; reauthorize_reason: string | null; account_label: string | null; last_error_code: string | null; last_checked_at: Date }>(
    "SELECT status, reauthorize_reason, account_label, last_error_code, last_checked_at FROM connections WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0]!);
export const attemptOf = (fixture: TwoTenantFixture, tenantId: string, id: string) =>
  fixture.service(async (tx) => (await tx.query<{ status: string }>("SELECT status FROM connection_attempts WHERE tenant_id=$1 AND id=$2", [tenantId, id])).rows[0]);

export function makeWorker(database: TestDatabase, fake: FakeComposio, clock: TestClock, extra: Partial<ConnectionsWorkerConfig> = {}, reports: ConnectionsWorkerReport[] = []) {
  return createConnectionsWorker({
    service: (work) => asService(database.servicePool, work),
    composio: createComposioClient({ apiKey: "test-key", baseUrl: "https://composio.test/api/v3.1", fetch: fake.fetch, timeoutMs: 1500 }),
    clock,
    config: { env: ENV, callbackUrl: CALLBACK_URL, authConfigIds: { shopify: AUTH_CONFIG }, ...extra },
    report: (event) => reports.push(event),
  });
}

/** Links an attempt through the worker and returns what the API would hold. */
export async function startAttempt(worker: ReturnType<typeof makeWorker>, input: { tenantId: string; createdBy: string; shop?: string; browserHash?: string }) {
  const attemptId = randomUUID();
  const connectionId = randomUUID();
  const linked = await worker.link({
    tenantId: input.tenantId, toolkit: "shopify", attemptId, connectionId, shopDomain: input.shop ?? "testshop.myshopify.com",
    createdBy: input.createdBy, browserHash: input.browserHash ?? "b".repeat(43),
  });
  if (linked.outcome !== "linked") throw new Error(`link refused: ${linked.code}`);
  return { attemptId, connectionId, accountId: linked.composioAccountId, linked };
}
export { composioUserId };
