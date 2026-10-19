import type { Pool } from "pg";
import { createSession, derivedId, type Principal } from "@zs/core";
import { asService, createScopedDatabase } from "@zs/db";
import { assertLocalPool } from "../config.js";
import { hostedPool, type HostedDatabaseTarget } from "../hosted.js";
import { provisionOwner, type AuthAdmin, type ProvisionOwnerSummary } from "../provision-owner.js";
import {
  DEMO_CONTACTS,
  DEMO_DEALS,
  DEMO_OWNER_EMAIL,
  DEMO_RESOURCES,
  DEMO_STAGES,
  DEMO_TENANT_NAME,
  DEMO_ZONE,
} from "./demo-data.js";

export interface SeedDependencies {
  /** Privileged pool for provisioning rows that have no write action yet (tenant, calendars, pipeline). */
  readonly service: Pool;
  /** Runtime-role pool; contacts, deals and bookings go through the one action path. */
  readonly runtime: Pool;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}
export interface SeedSummary {
  readonly principal: Principal;
  /** The owner's membership; its user id is the principal's actorId. */
  readonly owner: { readonly memberId: string; readonly email: string };
  readonly resources: readonly { id: string; name: string }[];
  readonly pipelineId: string;
  readonly contacts: number;
  readonly deals: number;
  readonly bookings: number;
}

const id = (...parts: string[]) => derivedId("zs-demo", ...parts);
const CONSENT_RECORDED_AT = "2026-01-15T15:00:00.000Z";

/**
 * Idempotent: fixed IDs and idempotency keys make a rerun replay instead of duplicating.
 * Refuses, before any query, pools whose destination is not a checked loopback URL.
 */
export async function seedDemo(deps: SeedDependencies): Promise<SeedSummary> {
  assertLocalPool(deps.service);
  assertLocalPool(deps.runtime);
  return seedTenant(deps);
}

export interface HostedSeedOwner {
  /** The person who owns the hosted demo tenant; provisioned like db:hosted-provision-owner. */
  readonly email: string;
  /** The Supabase Auth admin API of the same project. */
  readonly auth: AuthAdmin;
}

export interface HostedSeedDependencies {
  /** A login that may SET ROLE service_role (postgres on hosted Supabase). */
  readonly service: HostedDatabaseTarget;
  /** The zs_runtime login. */
  readonly runtime: HostedDatabaseTarget;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** Absent: the tenant is left without a member until db:hosted-provision-owner runs. */
  readonly owner?: HostedSeedOwner;
}

export interface HostedSeedSummary extends SeedSummary {
  /** The seed's own member was removed: its user id names no Supabase user. */
  readonly seedMemberRemoved: boolean;
  /** provisionOwner's report for the real owner, or null when none was named. */
  readonly provisionedOwner: ProvisionOwnerSummary | null;
}

/**
 * Owner-run seed of the same invented tenant into a hosted Supabase project. Takes checked
 * targets, not pools, and builds TLS-verified pools itself; both must name one project.
 */
export async function seedHostedDemo(deps: HostedSeedDependencies): Promise<HostedSeedSummary> {
  if (deps.service.projectRef !== deps.runtime.projectRef || deps.runtime.role !== "zs_runtime")
    throw new Error("Refusing to run: service and runtime targets must be one project, and runtime must be zs_runtime");
  const service = hostedPool(deps.service);
  const runtime = hostedPool(deps.runtime);
  try {
    return await seedHostedTenant({ service, runtime, clock: deps.clock, generateId: deps.generateId }, deps.owner);
  } finally {
    await Promise.all([service.end(), runtime.end()]);
  }
}

/**
 * The hosted seed on open pools (seedHostedDemo builds them; tests pass local ones). The seed
 * writes through the action path as its own owner member, whose user id is derived and names
 * no Supabase user. Hosted, nobody may hold that membership, so it is removed once the writes
 * are done; the action history keeps the record. The real owner then comes from the same
 * provisionOwner the db:hosted-provision-owner step runs: bound to their Supabase user and
 * given the tenant claim, or pending until that user exists. A rerun replays the seed and
 * reports the owner "unchanged".
 */
export async function seedHostedTenant(deps: SeedDependencies, owner?: HostedSeedOwner): Promise<HostedSeedSummary> {
  const summary = await seedTenant(deps);
  const removed = await asService(deps.service, async (tx) => (await tx.query(
    "DELETE FROM tenant_members WHERE tenant_id=$1 AND id=$2 AND user_id=$3",
    [summary.principal.tenantId, summary.owner.memberId, summary.principal.actorId],
  )).rowCount === 1);
  const provisionedOwner = owner
    ? await provisionOwner({ service: deps.service, clock: deps.clock, generateId: deps.generateId, auth: owner.auth },
      { tenantId: summary.principal.tenantId, email: owner.email, dryRun: false })
    : null;
  return { ...summary, seedMemberRemoved: removed, provisionedOwner };
}

async function seedTenant(deps: SeedDependencies): Promise<SeedSummary> {
  const principal: Principal = { tenantId: id("tenant"), actorId: id("owner") };
  const { tenantId } = principal;
  const pipelineId = id("pipeline");
  const owner = { memberId: id("member", "owner"), email: DEMO_OWNER_EMAIL };
  const stageIds = new Map(DEMO_STAGES.map((stage) => [stage, id("stage", stage)]));
  const resources = DEMO_RESOURCES.map((resource) => ({ ...resource, id: id("resource", resource.key) }));

  await asService(deps.service, async (tx) => {
    await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [tenantId, DEMO_TENANT_NAME]);
    for (const resource of resources)
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,name,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
           buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
         VALUES ($1,$2,$3,$4,$5::jsonb,'[]'::jsonb,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
        [tenantId, resource.id, resource.name, DEMO_ZONE, JSON.stringify(resource.weekly), resource.slotLengthMinutes,
          resource.slotStepMinutes, resource.bufferBeforeMinutes, resource.bufferAfterMinutes,
          resource.minimumNoticeMinutes, resource.bookingHorizonMinutes],
      );
    // The owner's membership has no action of its own: a tenant's first owner is provisioned.
    const joinedAt = deps.clock.now().toISOString();
    await tx.query(
      `INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'owner',$5,$5) ON CONFLICT DO NOTHING`,
      [tenantId, owner.memberId, owner.email, principal.actorId, joinedAt],
    );
    await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [tenantId, pipelineId, "Custom & bridal"]);
    for (const [position, stage] of DEMO_STAGES.entries())
      await tx.query(
        "INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [tenantId, stageIds.get(stage), pipelineId, stage, position],
      );
  });

  const session = createSession({ db: createScopedDatabase(deps.runtime), clock: deps.clock, generateId: deps.generateId }, principal);
  const contactIds: string[] = [];
  for (const [index, contact] of DEMO_CONTACTS.entries()) {
    const output = await session.upsertContact({
      displayName: contact.name,
      email: contact.email,
      phone: contact.phone,
      consent: {
        email: contact.email ? { status: "granted", source: "Showroom sign-up card", recordedAt: CONSENT_RECORDED_AT } : null,
        sms: null,
      },
    }, `seed:contact:${index}`);
    contactIds.push(output.result.contact.id);
  }

  for (const [index, deal] of DEMO_DEALS.entries()) {
    const created = await session.createDeal({
      contactId: contactIds[deal.contact],
      pipelineId,
      stageId: stageIds.get("Inquiry"),
      title: deal.title,
    }, `seed:deal:${index}`);
    if (deal.stage !== "Inquiry")
      await session.moveDealStage(created.result.id, {
        pipelineId, stageId: stageIds.get(deal.stage), expectedRevision: created.result.revision,
      }, `seed:deal-move:${index}`);
  }

  // Bookings depend on today's free slots, so only the first run creates them.
  const existing = await session.listBookings({ limit: "1" });
  if (existing.items.length === 0) {
    const now = deps.clock.now().getTime();
    for (const resource of resources) {
      const { slots } = await session.findSlots({
        resourceId: resource.id,
        from: new Date(now).toISOString(),
        to: new Date(now + 14 * 86400000).toISOString(),
      });
      for (const pick of [2, 9, 17]) {
        const slot = slots[pick];
        if (slot)
          await session.createBooking({ resourceId: resource.id, startsAt: slot.startsAt },
            `seed:booking:${resource.key}:${slot.startsAt}`);
      }
    }
  }
  const bookings = await session.listBookings({ limit: "100" });
  return {
    principal,
    owner,
    resources: resources.map((resource) => ({ id: resource.id, name: resource.name })),
    pipelineId,
    contacts: contactIds.length,
    deals: DEMO_DEALS.length,
    bookings: bookings.items.length,
  };
}
