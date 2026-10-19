import type { Pool } from "pg";
import { createSession, derivedId, type Principal } from "@zs/core";
import { asService, createScopedDatabase } from "@zs/db";
import { assertLocalPool } from "../config.js";
import { hostedPool, type HostedDatabaseTarget } from "../hosted.js";
import {
  DEMO_BOOKING_PAGE,
  DEMO_CONTACTS,
  DEMO_DEALS,
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
  readonly resources: readonly { id: string; name: string }[];
  readonly pipelineId: string;
  /** Published booking page linking every demo resource (public-intake.md P-4). */
  readonly bookingPageId: string;
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

export interface HostedSeedDependencies {
  /** A login that may SET ROLE service_role (postgres on hosted Supabase). */
  readonly service: HostedDatabaseTarget;
  /** The zs_runtime login. */
  readonly runtime: HostedDatabaseTarget;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}

/**
 * Owner-run seed of the same invented tenant into a hosted Supabase project. Takes checked
 * targets, not pools, and builds TLS-verified pools itself; both must name one project.
 */
export async function seedHostedDemo(deps: HostedSeedDependencies): Promise<SeedSummary> {
  if (deps.service.projectRef !== deps.runtime.projectRef || deps.runtime.role !== "zs_runtime")
    throw new Error("Refusing to run: service and runtime targets must be one project, and runtime must be zs_runtime");
  const service = hostedPool(deps.service);
  const runtime = hostedPool(deps.runtime);
  try {
    return await seedTenant({ service, runtime, clock: deps.clock, generateId: deps.generateId });
  } finally {
    await Promise.all([service.end(), runtime.end()]);
  }
}

async function seedTenant(deps: SeedDependencies): Promise<SeedSummary> {
  const principal: Principal = { tenantId: id("tenant"), actorId: id("owner") };
  const { tenantId } = principal;
  const pipelineId = id("pipeline");
  const stageIds = new Map(DEMO_STAGES.map((stage) => [stage, id("stage", stage)]));
  const resources = DEMO_RESOURCES.map((resource) => ({ ...resource, id: id("resource", resource.key) }));
  const bookingPageId = id("booking-page");

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
    await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
      [tenantId, pipelineId, "Custom & bridal"]);
    for (const [position, stage] of DEMO_STAGES.entries())
      await tx.query(
        "INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
        [tenantId, stageIds.get(stage), pipelineId, stage, position],
      );
    // Pages have no write action yet (M3a), so the service role provisions the demo page.
    await tx.query(
      `INSERT INTO booking_pages (tenant_id,id,title,description,published,disclosure_version,disclosure_text,created_at)
       VALUES ($1,$2,$3,$4,true,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [tenantId, bookingPageId, DEMO_BOOKING_PAGE.title, DEMO_BOOKING_PAGE.description,
        DEMO_BOOKING_PAGE.disclosureVersion, DEMO_BOOKING_PAGE.disclosureText, deps.clock.now()],
    );
    for (const [position, resource] of resources.entries())
      await tx.query(
        `INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,$4)
         ON CONFLICT DO NOTHING`,
        [tenantId, bookingPageId, resource.id, position],
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
    resources: resources.map((resource) => ({ id: resource.id, name: resource.name })),
    pipelineId,
    bookingPageId,
    contacts: contactIds.length,
    deals: DEMO_DEALS.length,
    bookings: bookings.items.length,
  };
}
