// industry-templates.md acceptance 2, 3 (HTTP status codes), 5 and IT-6 through the API, on fresh
// local tenants. Core covers the transaction, replay and query-count rules (packages/core/test/setup.test.ts).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  apiErrorBodySchema,
  applyTemplateResponseSchema,
  createDealOutputSchema,
  createOrFindContactOutputSchema,
  INDUSTRY_TEMPLATE_IDS,
  INDUSTRY_TEMPLATES,
  moveDealStageOutputSchema,
  publicBookingReplySchema,
  publicPageSchema,
  renderTemplate,
  setBookingPagePublishedResponseSchema,
  setupReadSchema,
  templateStateSchema,
  type IndustryTemplate,
  type IndustryTemplateId,
} from "@zs/contracts";
import { signBookingKey } from "@zs/core";
import { call, createApiHarness, KEY_SECRET, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({
    publicIntake: {
      clientIp: { header: "x-real-ip" },
      limits: {
        addressWrites: { limit: 1000, windowMs: 600_000 },
        addressReads: { limit: 1000, windowMs: 600_000 },
        tenantWrites: { limit: 1000, windowMs: 3_600_000 },
      },
    },
  });
});
afterAll(async () => h.close());

const ZONE = "America/Los_Angeles";
let address = 0;
const nextAddress = () => `198.51.100.${(++address % 250) + 1}`;

/** A tenant with no pipeline, resource or page, and a signed-in owner. */
async function freshTenant(name: string): Promise<{ tenantId: string; owner: MemberSetup }> {
  const tenantId = randomUUID();
  await h.fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [tenantId, name]));
  return { tenantId, owner: await signedInMember(h.database, h.fixture, tenantId, "owner") };
}
const apply = (member: MemberSetup, templateId: string, timeZone = ZONE) =>
  call(h.app, "POST", "/v1/setup/apply", { token: member.token, body: { templateId, timeZone } });
const setPublished = (member: MemberSetup, pageId: string, published: boolean, key: string = randomUUID()) =>
  call(h.app, "POST", `/v1/setup/booking-pages/${pageId}/published`, { token: member.token, key, body: { published } });
const pagePath = (tenantId: string, pageId: string) => `/public/v1/pages/${signBookingKey(KEY_SECRET, { tenantId, pageId })}`;
const errorOf = (body: unknown) => apiErrorBodySchema.parse(body).error;

/**
 * Sat 2026-10-24, Sun 25, Mon 26 in Los Angeles (PDT, UTC-7): after every notice period from
 * NOW (Mon 19 08:00Z) and inside the 60-day horizon.
 */
const LOCAL_OFFSET_HOURS = 7;
const localInstant = (day: number, minute: number) =>
  new Date(Date.UTC(2026, 9, day, LOCAL_OFFSET_HOURS) + minute * 60_000).toISOString();
const localMinuteOf = (instant: string) =>
  ((new Date(instant).getUTCHours() - LOCAL_OFFSET_HOURS + 24) % 24) * 60 + new Date(instant).getUTCMinutes();
const localWeekdayOf = (instant: string) => new Date(new Date(instant).getTime() - LOCAL_OFFSET_HOURS * 3_600_000).getUTCDay();

const visitor = (resourceId: string, startsAt: string) => ({
  resourceId,
  startsAt,
  name: "Mira Rowe",
  email: `mira.${randomUUID().slice(0, 8)}@haldenrowe.example`,
  phone: null,
  notes: null,
  consent: { email: false, sms: false },
  disclosureVersion: "v1",
  channel: "widget",
  website: "",
});

async function checkHours(template: IndustryTemplate, path: string, resourceId: string) {
  const query = `resourceId=${resourceId}&from=${localInstant(24, 0)}&to=${localInstant(27, 0)}`;
  const response = await call(h.app, "GET", `${path}/slots?${query}`);
  expect(response.status).toBe(200);
  const slots = response.body.slots as { startsAt: string; endsAt: string }[];
  const windowsOn = (weekday: number) => template.resource.weekly.find((day) => day.weekday === weekday)?.windows ?? [];
  // No slot outside the hours, and every slot is the template's length.
  for (const slot of slots) {
    const start = localMinuteOf(slot.startsAt);
    const windows = windowsOn(localWeekdayOf(slot.startsAt));
    expect(windows.some((window) => start >= window.startMinute && start + template.resource.slotLengthMinutes <= window.endMinute)).toBe(true);
    expect(new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime()).toBe(template.resource.slotLengthMinutes * 60_000);
  }
  const monday = windowsOn(1)[0]!;
  expect(slots.map((slot) => slot.startsAt)).toContain(localInstant(26, monday.startMinute));
  const saturday = windowsOn(6)[0];
  const saturdaySlots = slots.filter((slot) => localWeekdayOf(slot.startsAt) === 6);
  if (saturday) expect(saturdaySlots[0]?.startsAt).toBe(localInstant(24, saturday.startMinute));
  else expect(saturdaySlots).toEqual([]);
  expect(slots.filter((slot) => localWeekdayOf(slot.startsAt) === 0)).toEqual([]);
  return monday.startMinute;
}

describe("acceptance 2: each template on a fresh tenant", () => {
  // Saturday opening (local) where the template has Saturday hours.
  const SATURDAY: Record<IndustryTemplateId, string | null> = { jewelry: "10:00", crafts: "10:00", agency: null, fitness: "08:00" };

  it.each(INDUSTRY_TEMPLATE_IDS)("%s: apply, go live, book twice, win a deal, render the messages", async (templateId) => {
    const template = INDUSTRY_TEMPLATES[templateId];
    const { tenantId, owner } = await freshTenant(`Halden & Rowe ${templateId}`);

    const applied = await apply(owner, templateId);
    expect(applied.status).toBe(201);
    const result = applyTemplateResponseSchema.parse(applied.body).result;
    expect(result).toMatchObject({ templateId, timeZone: ZONE });

    // The page is off line until IT-11 takes it live.
    const path = pagePath(tenantId, result.bookingPageId);
    expect((await call(h.app, "GET", path)).status).toBe(404);
    const live = await setPublished(owner, result.bookingPageId, true);
    expect(live.status).toBe(200);
    const page = publicPageSchema.parse((await call(h.app, "GET", path)).body);
    expect(page).toMatchObject({
      businessName: `Halden & Rowe ${templateId}`,
      title: template.bookingPage.title,
      description: template.bookingPage.description,
      disclosure: { version: "v1", text: template.bookingPage.disclosureText },
    });
    expect(page.resources).toEqual([{
      id: result.resourceId, name: template.resource.name, timeZone: ZONE, slotLengthMinutes: template.resource.slotLengthMinutes,
    }]);

    // Opening slots on Monday and, where the template has them, Saturday; nothing outside the hours.
    const opening = await checkHours(template, path, result.resourceId);
    const saturday = template.resource.weekly.find((day) => day.weekday === 6)?.windows[0];
    expect(saturday ? `${String(saturday.startMinute / 60).padStart(2, "0")}:00` : null).toBe(SATURDAY[templateId]);

    // A booking at the opening, then one at slot end plus buffer.
    const first = localInstant(26, opening);
    const second = localInstant(26, opening + template.resource.slotLengthMinutes + template.resource.bufferAfterMinutes);
    for (const startsAt of [first, second]) {
      const booked = await call(h.app, "POST", `${path}/requests`, {
        body: visitor(result.resourceId, startsAt), key: randomUUID(), headers: { "X-Real-IP": nextAddress() },
      });
      expect(booked.status).toBe(201);
      expect(publicBookingReplySchema.parse(booked.body)).toMatchObject({ status: "confirmed", resourceId: result.resourceId, startsAt });
    }

    // IT-10: a deal in the first open stage moves through every open stage to won.
    const contact = createOrFindContactOutputSchema.parse((await call(h.app, "POST", "/v1/crm/contacts", {
      token: owner.token, key: randomUUID(), body: { displayName: "Ada Byron", email: `ada.${templateId}@example.com` },
    })).body).result.contact;
    const stages = template.pipeline.stages;
    const deal = await call(h.app, "POST", "/v1/crm/deals", {
      token: owner.token, key: randomUUID(),
      body: { contactId: contact.id, pipelineId: result.pipelineId, stageId: result.stageIds[0], title: "First order" },
    });
    expect(deal.status).toBe(201);
    const dealId = createDealOutputSchema.parse(deal.body).result.id;
    expect(stages[0]!.outcome).toBe("open");
    const wonIndex = stages.findIndex((stage) => stage.outcome === "won");
    let revision = 1;
    for (let index = 1; index <= wonIndex; index += 1) {
      const moved = await call(h.app, "POST", `/v1/crm/deals/${dealId}/stage`, {
        token: owner.token, key: randomUUID(),
        body: { pipelineId: result.pipelineId, stageId: result.stageIds[index], expectedRevision: revision },
      });
      expect(moved.status).toBe(200);
      revision = moveDealStageOutputSchema.parse(moved.body).result.revision;
    }
    const pipelines = await call(h.app, "GET", "/v1/crm/pipelines", { token: owner.token });
    const pipeline = (pipelines.body.items as { id: string; stages: { id: string; name: string; outcome: string }[] }[])
      .find((item) => item.id === result.pipelineId)!;
    expect(pipeline.stages.map((stage) => stage.name)).toEqual(stages.map((stage) => stage.name));
    const finalStage = (await h.fixture.service((tx) => tx.query<{ stage_id: string }>(
      "SELECT stage_id FROM crm_deals WHERE tenant_id=$1 AND id=$2", [tenantId, dealId]))).rows[0]!.stage_id;
    expect(pipeline.stages.find((stage) => stage.id === finalStage)?.outcome).toBe("won");

    // Each recommended message renders with the business's display name.
    const displayName = (await call(h.app, "GET", "/v1/business", { token: owner.token })).body.displayName as string;
    expect(template.messages.map((message) => message.agentKind)).toEqual(template.recommendedAgents);
    for (const message of template.messages) {
      const state = templateStateSchema.parse((await call(h.app, "GET", `/v1/agents/${message.agentKind}/template`, { token: owner.token })).body);
      const current = state.revisions.find((item) => item.current)!;
      expect(current).toMatchObject({ channel: "email", timingHours: message.timingHours, subject: message.subject, body: message.body });
      const values = {
        business_name: displayName, customer_first_name: "Mira", booking_start_local: "Mon 26 Oct, 9:00 AM",
        booking_link: "https://book.example/b", review_link: "https://review.example/r",
      };
      for (const text of [current.subject!, current.body]) {
        const rendered = renderTemplate(text, values);
        expect(rendered).not.toMatch(/\{[a-z_]+\}/);
      }
      expect(renderTemplate(`${current.subject} ${current.body}`, values)).toContain(displayName);
    }
  });
});

describe("POST /v1/setup/apply status codes (acceptance 3)", () => {
  it("201 then 200 replays for any owner; another template 409; staff 403; unknown id 404; bad zone 422", async () => {
    const { tenantId, owner } = await freshTenant("Rowe Studio");
    const staff = await signedInMember(h.database, h.fixture, tenantId, "staff");
    expect((await apply(staff, "agency")).status).toBe(403);
    const unknown = await apply(owner, "bakery");
    expect(unknown.status).toBe(404);
    const zone = await apply(owner, "agency", "Mars/Olympus_Mons");
    expect(zone.status).toBe(422);
    expect(errorOf(zone.body)).toMatchObject({ code: "ValidationFailed", details: { reason: "invalid_time_zone" } });
    const rows = await h.fixture.service(async (tx) => (await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM actions WHERE tenant_id=$1", [tenantId])).rows[0]!.n);
    expect(rows).toBe(0);

    const first = await apply(owner, "agency");
    expect(first.status).toBe(201);
    const again = await apply(owner, "agency");
    expect(again.status).toBe(200);
    expect(applyTemplateResponseSchema.parse(again.body)).toMatchObject({ replayed: true, result: first.body.result });
    const second = await signedInMember(h.database, h.fixture, tenantId, "owner");
    expect((await apply(second, "agency")).body).toMatchObject({ replayed: true, actionId: first.body.actionId });
    const other = await apply(owner, "fitness");
    expect(other.status).toBe(409);
    expect(errorOf(other.body)).toMatchObject({ code: "Conflict", details: { reason: "template_already_applied" } });
    expect((await apply(owner, "agency", "UTC")).status).toBe(200);
  });

  it("GET /v1/setup shows nothing applied, then the applied setup with the page's live state, to any member", async () => {
    const { tenantId, owner } = await freshTenant("Rowe & Daughters");
    const staff = await signedInMember(h.database, h.fixture, tenantId, "staff");
    const before = setupReadSchema.parse((await call(h.app, "GET", "/v1/setup", { token: staff.token })).body);
    expect(before.applied).toBeNull();
    expect(before.templates.map((template) => template.id)).toEqual([...INDUSTRY_TEMPLATE_IDS]);
    const applied = applyTemplateResponseSchema.parse((await apply(owner, "jewelry")).body).result;
    const after = setupReadSchema.parse((await call(h.app, "GET", "/v1/setup", { token: staff.token })).body);
    expect(after).toMatchObject({
      timeZone: ZONE,
      applied: {
        templateId: "jewelry", templateVersion: 1, pipelineId: applied.pipelineId, resourceId: applied.resourceId,
        bookingPageId: applied.bookingPageId, published: false,
      },
    });
    expect((await call(h.app, "GET", "/v1/setup")).status).toBe(401);
  });
});

describe("POST /v1/setup/booking-pages/:id/published (IT-11, acceptance 5)", () => {
  it("on answers the public page, off makes it 404, a repeat replays; another tenant's page 404; staff 403", async () => {
    const { tenantId, owner } = await freshTenant("Halden Fitness");
    const staff = await signedInMember(h.database, h.fixture, tenantId, "staff");
    const { bookingPageId } = applyTemplateResponseSchema.parse((await apply(owner, "fitness")).body).result;
    const path = pagePath(tenantId, bookingPageId);

    const on = await setPublished(owner, bookingPageId, true);
    expect(on.status).toBe(200);
    expect(setBookingPagePublishedResponseSchema.parse(on.body)).toMatchObject({
      replayed: false, result: { pageId: bookingPageId, published: true, changed: true },
    });
    expect((await call(h.app, "GET", path)).status).toBe(200);
    const repeat = await setPublished(owner, bookingPageId, true);
    expect(repeat.status).toBe(200);
    expect(repeat.body).toMatchObject({ replayed: true, result: { published: true, changed: false } });

    const off = await setPublished(owner, bookingPageId, false);
    expect(off.body).toMatchObject({ replayed: false, result: { published: false, changed: true } });
    expect((await call(h.app, "GET", path)).status).toBe(404);

    expect((await setPublished(staff, bookingPageId, true)).status).toBe(403);
    const elsewhere = await setPublished(h.b, bookingPageId, true);
    expect(elsewhere.status).toBe(404);
    expect((await setPublished(owner, randomUUID(), true)).status).toBe(404);
    expect((await setPublished(owner, "not-a-page", true)).status).toBe(404);
    expect((await call(h.app, "GET", path)).status).toBe(404);
  });
});
