// Shared set-up for the Activepieces tests: a tenant with an owner, a staff member, a published
// booking page, a pipeline with a won stage, an injected clock, and the admin, inbound and worker
// pieces wired as production wires them (fake data only: Halden & Rowe).
import { randomUUID } from "node:crypto";
import type { MemberRole } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  createAutomationAdmin,
  createAutomationInbound,
  createNodeWebhookTransport,
  createPublicSession,
  createSession,
  createWebhookWorker,
  type EdgeDependencies,
  type WebhookTransport,
  type WebhookWorkerConfig,
} from "../../src/index.js";
import { manualClock, type ManualClock } from "../delivery/helpers.js";

/** Synthetic server key, built at runtime so secret scanners do not flag a literal. */
export const KEY = ["test", "activepieces", "k".repeat(32)].join("-");
export const OTHER_KEY = ["other", "activepieces", "q".repeat(32)].join("-");
/** Monday 2026-10-19 08:00 UTC; nothing depends on today's date. */
export const START = Date.parse("2026-10-19T08:00:00.000Z");

export interface Tenant {
  tenantId: string;
  ownerId: string;
  staffId: string;
  resourceId: string;
  pageId: string;
  pipelineId: string;
  openStage: string;
  wonStage: string;
}

export interface AutomationHarness {
  database: TestDatabase;
  fixture: TwoTenantFixture;
  clock: ManualClock;
  a: Tenant;
  b: Tenant;
  deps(): EdgeDependencies;
  admin(tenant: Tenant, actorId?: string, keys?: { current: string; previous?: string }): ReturnType<typeof createAutomationAdmin>;
  inbound(keys?: { current: string; previous?: string }): ReturnType<typeof createAutomationInbound>;
  session(tenant: Tenant, actorId?: string): ReturnType<typeof createSession>;
  worker(overrides?: Partial<WebhookWorkerConfig>, options?: { transport?: WebhookTransport; keys?: { current: string; previous?: string } }): ReturnType<typeof createWebhookWorker>;
  /** A website booking request on the tenant's public page, a day out, never on an earlier request's hour. */
  websiteRequest(tenant: Tenant, input?: { email?: string; notes?: string }): Promise<{ bookingId: string }>;
  addMember(tenantId: string, role: MemberRole): Promise<string>;
  rows<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  service<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createAutomationHarness(): Promise<AutomationHarness> {
  const database = await createTestDatabase();
  const fixture = await createTwoTenantFixture(database);
  const clock = manualClock(START);
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
  const addMember = async (tenantId: string, role: MemberRole) => {
    const userId = randomUUID();
    await service((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
      [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@haldenrowe.example`, userId, role, new Date(START)]));
    return userId;
  };
  const setUp = async (tenantId: string): Promise<Tenant> => {
    const resourceId = randomUUID();
    const pageId = randomUUID();
    const pipelineId = randomUUID();
    const openStage = randomUUID();
    const wonStage = randomUUID();
    await service(async (tx) => {
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,43200)`,
        [tenantId, resourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 0, endMinute: 1440 }] })))]);
      await tx.query("INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
        [tenantId, pageId, new Date(START)]);
      await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [tenantId, pageId, resourceId]);
      await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Sales')", [tenantId, pipelineId]);
      await tx.query(
        "INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome) VALUES ($1,$2,$3,'New',0,'open'),($1,$4,$3,'Won',1,'won')",
        [tenantId, openStage, pipelineId, wonStage]);
    });
    return {
      tenantId, ownerId: await addMember(tenantId, "owner"), staffId: await addMember(tenantId, "staff"),
      resourceId, pageId, pipelineId, openStage, wonStage,
    };
  };
  const a = await setUp(fixture.a.tenantId);
  const b = await setUp(fixture.b.tenantId);
  const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
  let slot = 0;

  return {
    database, fixture, clock, a, b, deps,
    admin: (tenant, actorId = tenant.ownerId, keys = { current: KEY }) =>
      createAutomationAdmin(deps(), { keySecrets: keys, urlPolicy: { allowLoopback: true } }, { tenantId: tenant.tenantId, actorId }),
    inbound: (keys = { current: KEY }) => createAutomationInbound(deps(), { keySecrets: keys }),
    session: (tenant, actorId = tenant.ownerId) => createSession(deps(), { tenantId: tenant.tenantId, actorId }),
    worker: (overrides = {}, options = {}) => createWebhookWorker({
      service,
      transport: options.transport ?? createNodeWebhookTransport({ allowLoopback: true }),
      keys: options.keys ?? { current: KEY },
      clock,
      generateId: randomUUID,
      config: {
        workerId: `worker-${randomUUID().slice(0, 8)}`, leaseMs: 30_000, requestTimeoutMs: 2_000, maxAttempts: 3,
        backoffBaseMs: 1_000, backoffMaxMs: 60_000, allowLoopback: true, ...overrides,
      },
    }),
    async websiteRequest(tenant, input = {}) {
      const n = slot++;
      const hour = Math.ceil(clock.now().getTime() / 3_600_000) * 3_600_000;
      const startsAt = new Date(hour + (24 + n) * 3_600_000).toISOString();
      const reply = await createPublicSession(deps(), { tenantId: tenant.tenantId, pageId: tenant.pageId }).request({
        resourceId: tenant.resourceId, startsAt, name: "Rowan Halden", email: input.email ?? `guest-${randomUUID().slice(0, 8)}@haldenrowe.example`,
        consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      }, randomUUID());
      const booking = await service(async (tx) => (await tx.query<{ id: string }>(
        "SELECT b.id FROM bookings b JOIN intake_items i ON i.tenant_id=b.tenant_id AND i.id=b.intake_item_id WHERE i.tenant_id=$1 AND i.id=$2",
        [tenant.tenantId, reply.requestId])).rows[0]);
      return { bookingId: booking?.id ?? "" };
    },
    addMember,
    async rows(sql, params = []) { return service(async (tx) => (await tx.query(sql, params)).rows); },
    service,
    close: () => database.close(),
  };
}
