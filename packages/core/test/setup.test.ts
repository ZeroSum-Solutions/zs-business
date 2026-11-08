// industry-templates.md IT-4, IT-5, IT-11 and acceptance 3 to 5 in core, under the runtime role.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BindingMismatch,
  Conflict,
  INDUSTRY_TEMPLATE_IDS,
  INDUSTRY_TEMPLATES,
  NotFound,
  Refused,
  TEMPLATE_APPLY_ACTION,
  TenantDenied,
  type ActionCommand,
  type IndustryTemplateId,
  type MemberRole,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createSession, type EdgeDependencies } from "../src/edge/session.js";
import { memberAuthorize } from "../src/edge/session.js";
import { NEVER_APPROVED_ACTIONS, cannotBeApproved } from "../src/approvals/policy.js";
import { applyTemplateHandler, createDispatcher, createTemplateSession, derivedId, type ActionHandler } from "../src/index.js";

const NOW = "2026-10-19T08:00:00.000Z";
const clock = { now: () => new Date(NOW) };
let database: TestDatabase;
let fixture: TwoTenantFixture;
const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (tenantId: string, actorId: string) => createSession(deps(), { tenantId, actorId });

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
});
afterAll(async () => { await database?.close(); });

async function addMember(tenantId: string, role: MemberRole): Promise<string> {
  const userId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, NOW]));
  return userId;
}
async function freshTenant(name = "Halden & Rowe"): Promise<{ tenantId: string; ownerId: string }> {
  const tenantId = randomUUID();
  await fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [tenantId, name]));
  return { tenantId, ownerId: await addMember(tenantId, "owner") };
}
/** Rows the apply writes, per table, for one tenant. */
async function counts(tenantId: string): Promise<Record<string, number>> {
  const tables = ["tenant_setups", "actions", "outbox", "crm_pipelines", "crm_stages", "booking_resources", "booking_pages",
    "booking_page_resources", "booking_page_disclosures", "message_templates", "message_template_revisions"];
  const out: Record<string, number> = {};
  await fixture.service(async (tx) => {
    for (const table of tables)
      out[table] = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE tenant_id=$1`, [tenantId])).rows[0]!.n;
  });
  return out;
}
const profileOf = (tenantId: string) => fixture.service(async (tx) =>
  (await tx.query<{ time_zone: string | null; revision: number }>("SELECT time_zone, revision FROM business_profiles WHERE tenant_id=$1", [tenantId])).rows[0]!);

describe("tenant.template.apply (IT-4)", () => {
  it.each(INDUSTRY_TEMPLATE_IDS)("applies %s in one transaction, the page off line, the zone confirmed", async (templateId) => {
    const { tenantId, ownerId } = await freshTenant();
    const session = sessionFor(tenantId, ownerId);
    expect((await session.getSetup()).applied).toBeNull();
    const applied = await session.applyTemplate({ templateId, timeZone: "America/Los_Angeles" });
    const template = INDUSTRY_TEMPLATES[templateId];
    expect(applied.replayed).toBe(false);
    expect(applied.result).toMatchObject({ templateId, templateVersion: 1, timeZone: "America/Los_Angeles", appliedAt: NOW });
    expect(applied.result.stageIds).toHaveLength(template.pipeline.stages.length);
    expect(applied.result.messageTemplateIds).toHaveLength(template.messages.length);
    expect(await profileOf(tenantId)).toEqual({ time_zone: "America/Los_Angeles", revision: 2 });
    expect(await counts(tenantId)).toEqual({
      tenant_setups: 1, actions: 1, outbox: 1, crm_pipelines: 1, crm_stages: template.pipeline.stages.length,
      booking_resources: 1, booking_pages: 1, booking_page_resources: 1, booking_page_disclosures: 1,
      message_templates: template.messages.length, message_template_revisions: template.messages.length,
    });
    const rows = await fixture.service(async (tx) => ({
      setup: (await tx.query("SELECT action_id, pipeline_id, resource_id, booking_page_id FROM tenant_setups WHERE tenant_id=$1", [tenantId])).rows[0],
      action: (await tx.query("SELECT id, idempotency_key, action_type FROM actions WHERE tenant_id=$1", [tenantId])).rows[0],
      event: (await tx.query("SELECT event_type, payload FROM outbox WHERE tenant_id=$1", [tenantId])).rows[0],
      page: (await tx.query("SELECT title, description, published, disclosure_text FROM booking_pages WHERE tenant_id=$1", [tenantId])).rows[0],
      resource: (await tx.query("SELECT time_zone, weekly, buffer_after_minutes FROM booking_resources WHERE tenant_id=$1", [tenantId])).rows[0],
      stages: (await tx.query("SELECT name, outcome FROM crm_stages WHERE tenant_id=$1 ORDER BY position", [tenantId])).rows,
      approvals: (await tx.query("SELECT standing_approval_id FROM message_template_revisions WHERE tenant_id=$1", [tenantId])).rows,
    }));
    expect(rows.setup).toEqual({
      action_id: applied.actionId, pipeline_id: applied.result.pipelineId, resource_id: applied.result.resourceId,
      booking_page_id: applied.result.bookingPageId,
    });
    expect(rows.action).toEqual({ id: applied.actionId, idempotency_key: `template:${templateId}`, action_type: TEMPLATE_APPLY_ACTION });
    expect(rows.event.event_type).toBe("tenant.template.applied");
    expect(rows.event.payload).toMatchObject({ actionId: applied.actionId, templateId });
    expect(rows.page).toEqual({
      title: template.bookingPage.title, description: template.bookingPage.description, published: false,
      disclosure_text: template.bookingPage.disclosureText,
    });
    expect(rows.resource).toEqual({ time_zone: "America/Los_Angeles", weekly: template.resource.weekly, buffer_after_minutes: template.resource.bufferAfterMinutes });
    expect(rows.stages).toEqual(template.pipeline.stages);
    expect(rows.approvals.every((row) => row.standing_approval_id === null)).toBe(true);
    expect((await session.getSetup()).applied).toEqual({
      templateId, templateVersion: 1, appliedAt: NOW, pipelineId: applied.result.pipelineId,
      resourceId: applied.result.resourceId, bookingPageId: applied.result.bookingPageId,
      bookingPageTitle: template.bookingPage.title, bookingUrl: null, published: false,
    });
  });

  it("gives staff the page title and public address in the setup read, and no one an address without a base URL", async () => {
    const { tenantId, ownerId } = await freshTenant();
    const staff = await addMember(tenantId, "staff");
    const withKeys = (actorId: string) => createSession(
      { ...deps(), bookingKeys: { secret: ["test", "booking", "k".repeat(32)].join("-"), publicBaseUrl: "http://book.test/" } },
      { tenantId, actorId });
    const applied = await withKeys(ownerId).applyTemplate({ templateId: "jewelry", timeZone: "UTC" });
    const seen = (await withKeys(staff).getSetup()).applied;
    expect(seen).toMatchObject({ bookingPageId: applied.result.bookingPageId, bookingPageTitle: INDUSTRY_TEMPLATES.jewelry.bookingPage.title });
    expect(seen?.bookingUrl).toMatch(/^http:\/\/book\.test\/book\/[^/\s]+$/);
    // The staff read matches the owner's list entry, and staff still cannot list pages.
    const [listed] = await withKeys(ownerId).listBookingPages();
    expect(seen?.bookingUrl).toBe(listed!.bookingUrl);
    await expect(withKeys(staff).listBookingPages()).rejects.toBeInstanceOf(TenantDenied);
    expect((await sessionFor(tenantId, staff).getSetup()).applied?.bookingUrl).toBeNull();
  });

  it("checks the key, the zone and the setup row in the handler, so a direct dispatch cannot skip them", async () => {
    const { tenantId, ownerId } = await freshTenant();
    const dispatch = createDispatcher({ [TEMPLATE_APPLY_ACTION]: applyTemplateHandler });
    const run = (key: string, templateId: IndustryTemplateId, timeZone: string) => {
      const command = {
        actionType: TEMPLATE_APPLY_ACTION,
        target: { tenantId, type: "tenant_setup", id: tenantId },
        approvalReference: { tenantId, id: derivedId(tenantId, key, "approval") },
        idempotencyKey: key,
        payload: { templateId, timeZone },
      } satisfies ActionCommand;
      const { idempotencyKey: _key, ...fields } = command;
      return dispatch({
        tenantId, actor: { id: ownerId, tenantId }, db: database.db, clock, config: {}, generateId: randomUUID,
        resolveApproval: async () => ({ ...fields, tenantId, actorId: ownerId }),
        authorize: memberAuthorize(tenantId, ownerId),
      }, command);
    };
    // A key other than the server's template key, and a zone Intl accepts but PostgreSQL does not know.
    await expect(run("my-own-key", "agency", "UTC")).rejects.toThrow(/template key/);
    await expect(run("template:agency", "agency", "SystemV/AST4")).rejects.toThrow(/Unknown time zone/);
    expect(Object.values(await counts(tenantId)).every((n) => n === 0)).toBe(true);
    await run("template:agency", "agency", "UTC");
    // A second template under its own correct key meets the setup row before any write.
    const before = await counts(tenantId);
    await expect(run("template:fitness", "fitness", "UTC")).rejects.toBeInstanceOf(Conflict);
    expect(await counts(tenantId)).toEqual(before);
  });

  it("replays for the same owner and for a second owner, with no new rows", async () => {
    const { tenantId, ownerId } = await freshTenant();
    const first = await sessionFor(tenantId, ownerId).applyTemplate({ templateId: "crafts", timeZone: "Europe/London" });
    const before = await counts(tenantId);
    const again = await sessionFor(tenantId, ownerId).applyTemplate({ templateId: "crafts", timeZone: "Europe/London" });
    const secondOwner = await addMember(tenantId, "owner");
    // A replay keeps the stored answer, whatever valid zone the second call names.
    const other = await sessionFor(tenantId, secondOwner).applyTemplate({ templateId: "crafts", timeZone: "Asia/Tokyo" });
    expect(again).toEqual({ ...first, replayed: true });
    expect(other).toEqual({ ...first, replayed: true });
    expect(await counts(tenantId)).toEqual(before);
    expect((await profileOf(tenantId)).time_zone).toBe("Europe/London");
  });

  it("answers another template with 409 template_already_applied", async () => {
    const { tenantId, ownerId } = await freshTenant();
    await sessionFor(tenantId, ownerId).applyTemplate({ templateId: "agency", timeZone: "UTC" });
    const error = await sessionFor(tenantId, ownerId).applyTemplate({ templateId: "fitness", timeZone: "UTC" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Conflict);
    expect((error as Conflict).details).toEqual({ reason: "template_already_applied" });
  });

  it("leaves one setup, one action and one outbox row after concurrent applies, by one owner or two", async () => {
    for (const second of ["same", "other", "different-template"] as const) {
      const { tenantId, ownerId } = await freshTenant();
      const otherOwner = second === "same" ? ownerId : await addMember(tenantId, "owner");
      const results = await Promise.allSettled([
        sessionFor(tenantId, ownerId).applyTemplate({ templateId: "jewelry", timeZone: "UTC" }),
        sessionFor(tenantId, otherOwner).applyTemplate({ templateId: second === "different-template" ? "agency" : "jewelry", timeZone: "UTC" }),
      ]);
      const c = await counts(tenantId);
      expect([c.tenant_setups, c.actions, c.outbox, c.crm_pipelines, c.booking_pages], second).toEqual([1, 1, 1, 1, 1]);
      const fulfilled = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
      if (second === "different-template") {
        expect(fulfilled, second).toHaveLength(1);
        const rejected = results.find((r) => r.status === "rejected")!.reason;
        expect(rejected, second).toBeInstanceOf(Conflict);
        expect((rejected as Conflict).details, second).toEqual({ reason: "template_already_applied" });
      } else {
        expect(fulfilled, second).toHaveLength(2);
        expect(fulfilled.map((r) => r.replayed).sort(), second).toEqual([false, true]);
        expect(fulfilled[0]!.actionId, second).toBe(fulfilled[1]!.actionId);
      }
    }
  });

  it("refuses staff (403), an unknown id (404) and an unknown zone (422) before storing the key", async () => {
    const { tenantId, ownerId } = await freshTenant();
    const staff = await addMember(tenantId, "staff");
    await expect(sessionFor(tenantId, staff).applyTemplate({ templateId: "agency", timeZone: "UTC" })).rejects.toBeInstanceOf(TenantDenied);
    // Staff get 403 whatever they send: never 404 for an unknown id, 422 for a bad zone or a malformed body.
    for (const body of [{ templateId: "bakery", timeZone: "UTC" }, { templateId: "agency", timeZone: "Mars/Olympus" }, { nonsense: true }, null])
      await expect(sessionFor(tenantId, staff).applyTemplate(body), JSON.stringify(body)).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(tenantId, ownerId).applyTemplate({ templateId: "bakery", timeZone: "UTC" })).rejects.toBeInstanceOf(NotFound);
    for (const timeZone of ["Mars/Olympus", "EST5EDT-not", "america/los_angeles"]) {
      const error = await sessionFor(tenantId, ownerId).applyTemplate({ templateId: "agency", timeZone }).catch((e: unknown) => e);
      expect(error, timeZone).toBeInstanceOf(Refused);
      expect(error, timeZone).toMatchObject({ status: 422, reason: "invalid_time_zone" });
    }
    const empty = await counts(tenantId);
    expect(Object.values(empty).every((n) => n === 0), JSON.stringify(empty)).toBe(true);
    expect(await profileOf(tenantId)).toEqual({ time_zone: null, revision: 1 });
    // The owner then applies normally: nothing above took the key.
    await expect(sessionFor(tenantId, ownerId).applyTemplate({ templateId: "agency", timeZone: "UTC" }))
      .resolves.toMatchObject({ replayed: false });
  });

  it("lists tenant.template.apply in NEVER_APPROVED_ACTIONS, so no approval policy can gate it (IT-4)", () => {
    expect(NEVER_APPROVED_ACTIONS.has(TEMPLATE_APPLY_ACTION)).toBe(true);
    expect(cannotBeApproved(TEMPLATE_APPLY_ACTION)).toBe(true);
  });

  it("keeps the template: prefix from every member action, and keys per tenant", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const session = sessionFor(a.tenantId, a.ownerId);
    const { revision } = await session.getBusiness();
    await expect(session.updateBusiness({ expectedRevision: revision, changes: { currency: "EUR" } }, "template:agency"))
      .rejects.toMatchObject({ code: "ValidationFailed", message: "Invalid Idempotency-Key" });
    await expect(session.upsertContact({ displayName: "Ada", email: "ada@example.com" }, "Template:jewelry"))
      .rejects.toMatchObject({ code: "ValidationFailed", message: "Invalid Idempotency-Key" });
    const first = await session.applyTemplate({ templateId: "agency", timeZone: "UTC" });
    const other = await sessionFor(b.tenantId, b.ownerId).applyTemplate({ templateId: "agency", timeZone: "UTC" });
    expect(other.replayed).toBe(false);
    expect(other.actionId).not.toBe(first.actionId);
    expect(other.result.pipelineId).not.toBe(first.result.pipelineId);
  });

  it("adds its records beside an existing pipeline, resource, page and message template", async () => {
    const { tenantId, ownerId } = await freshTenant();
    const existing = { pipeline: randomUUID(), resource: randomUUID(), page: randomUUID() };
    await fixture.service(async (tx) => {
      await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Old')", [tenantId, existing.pipeline]);
      await tx.query(
        `INSERT INTO booking_resources (tenant_id,id,name,slot_length_minutes,slot_step_minutes,buffer_before_minutes,
           buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes) VALUES ($1,$2,'Old',60,60,0,0,0,1440)`,
        [tenantId, existing.resource]);
      await tx.query("INSERT INTO booking_pages (tenant_id,id,title,published,created_at) VALUES ($1,$2,'Old',true,$3)", [tenantId, existing.page, NOW]);
    });
    // The owner already wrote reminder wording: the template must not replace it.
    const session = sessionFor(tenantId, ownerId);
    await createTemplateSession(deps(), { tenantId, actorId: ownerId }).createRevision("appointment_reminder",
      { expectedRevision: 0, channel: "email", subject: "Mine", body: "See you, {customer_first_name}", timingHours: 48 }, randomUUID());
    const applied = await session.applyTemplate({ templateId: "jewelry", timeZone: "UTC" });
    expect(applied.result.messageTemplateIds).toHaveLength(1);
    const rows = await fixture.service(async (tx) => ({
      pipelines: (await tx.query("SELECT name FROM crm_pipelines WHERE tenant_id=$1 ORDER BY name", [tenantId])).rows,
      resources: (await tx.query("SELECT name FROM booking_resources WHERE tenant_id=$1 ORDER BY name", [tenantId])).rows,
      pages: (await tx.query("SELECT title, published FROM booking_pages WHERE tenant_id=$1 ORDER BY title", [tenantId])).rows,
      reminder: (await tx.query(
        `SELECT r.subject, r.timing_hours FROM message_templates t JOIN message_template_revisions r
           ON r.tenant_id=t.tenant_id AND r.template_id=t.id AND r.revision=t.current_revision
          WHERE t.tenant_id=$1 AND t.agent_kind='appointment_reminder'`, [tenantId])).rows,
      review: (await tx.query("SELECT count(*)::int AS n FROM message_templates WHERE tenant_id=$1 AND agent_kind='review_request'", [tenantId])).rows[0],
    }));
    expect(rows.pipelines).toEqual([{ name: "Custom & bridal" }, { name: "Old" }]);
    expect(rows.resources).toEqual([{ name: "Consultation" }, { name: "Old" }]);
    expect(rows.pages).toEqual([{ title: "Book a consultation", published: false }, { title: "Old", published: true }]);
    expect(rows.reminder).toEqual([{ subject: "Mine", timing_hours: 48 }]);
    expect(rows.review).toEqual({ n: 1 });
  });
});

/** A transaction that counts the queries made through it. */
function counting(tx: Transaction, tally: { n: number }): Transaction {
  return new Proxy(tx, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "query" && typeof value === "function")
        return (...args: unknown[]) => { tally.n += 1; return (value as (...a: unknown[]) => unknown).apply(target, args); };
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("IT-5 efficiency", () => {
  async function dispatchCounted(templateId: IndustryTemplateId, tally: { n: number }) {
    const { tenantId, ownerId } = await freshTenant();
    const counted: ActionHandler = {
      ...applyTemplateHandler,
      handle: (input) => applyTemplateHandler.handle({ ...input, tx: counting(input.tx, tally) }),
    };
    const dispatch = createDispatcher({ [TEMPLATE_APPLY_ACTION]: counted });
    const key = `template:${templateId}`;
    const command = {
      actionType: TEMPLATE_APPLY_ACTION,
      target: { tenantId, type: "tenant_setup", id: tenantId },
      approvalReference: { tenantId, id: derivedId(tenantId, key, "approval") },
      idempotencyKey: key,
      payload: { templateId, timeZone: "UTC" },
    } satisfies ActionCommand;
    const { idempotencyKey: _key, ...fields } = command;
    return dispatch({
      tenantId, actor: { id: ownerId, tenantId }, db: database.db, clock, config: {}, generateId: randomUUID,
      resolveApproval: async () => ({ ...fields, tenantId, actorId: ownerId }),
      authorize: memberAuthorize(tenantId, ownerId),
    }, command);
  }

  it("issues at most 10 queries of its own for every template", async () => {
    for (const templateId of INDUSTRY_TEMPLATE_IDS) {
      const tally = { n: 0 };
      await dispatchCounted(templateId, tally);
      expect(tally.n, templateId).toBeLessThanOrEqual(10);
      expect(tally.n, templateId).toBeGreaterThan(0);
    }
  });

  it("applies all four templates to four fresh tenants after one warm-up, reported, failing only above 10 s", async () => {
    const { tenantId, ownerId } = await freshTenant();
    await sessionFor(tenantId, ownerId).applyTemplate({ templateId: "agency", timeZone: "UTC" });
    const tenants = await Promise.all(INDUSTRY_TEMPLATE_IDS.map(() => freshTenant()));
    const started = performance.now();
    for (const [i, templateId] of INDUSTRY_TEMPLATE_IDS.entries())
      await sessionFor(tenants[i]!.tenantId, tenants[i]!.ownerId).applyTemplate({ templateId, timeZone: "UTC" });
    const elapsed = performance.now() - started;
    console.info(`IT-5: four template applies took ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(10_000);
  });
});

describe("booking.page.set_published (IT-11)", () => {
  it("takes a page live and off line, replays a repeat, and changes nothing else", async () => {
    const { tenantId, ownerId } = await freshTenant();
    const session = sessionFor(tenantId, ownerId);
    const { result } = await session.applyTemplate({ templateId: "fitness", timeZone: "UTC" });
    const onKey = randomUUID();
    const on = await session.setBookingPagePublished(result.bookingPageId, { published: true }, onKey);
    expect(on).toMatchObject({ result: { pageId: result.bookingPageId, published: true, changed: true }, replayed: false });
    expect((await session.getSetup()).applied?.published).toBe(true);
    const repeat = await session.setBookingPagePublished(result.bookingPageId, { published: true }, randomUUID());
    // A fresh key on a page that already has the value is a new action with changed:false, not a replay.
    expect(repeat).toMatchObject({ result: { published: true, changed: false }, replayed: false });
    expect(await session.setBookingPagePublished(result.bookingPageId, { published: true }, onKey)).toEqual({ ...on, replayed: true });
    const key = randomUUID();
    const off = await session.setBookingPagePublished(result.bookingPageId, { published: false }, key);
    expect(off).toMatchObject({ result: { published: false, changed: true }, replayed: false });
    expect(await session.setBookingPagePublished(result.bookingPageId, { published: false }, key)).toEqual({ ...off, replayed: true });
    expect((await session.getSetup()).applied?.published).toBe(false);
  });

  it("answers 404 for no page or another tenant's page, and 403 for staff", async () => {
    const a = await freshTenant();
    const b = await freshTenant();
    const pageA = (await sessionFor(a.tenantId, a.ownerId).applyTemplate({ templateId: "agency", timeZone: "UTC" })).result.bookingPageId;
    await expect(sessionFor(b.tenantId, b.ownerId).setBookingPagePublished(pageA, { published: true }, randomUUID())).rejects.toBeInstanceOf(NotFound);
    await expect(sessionFor(a.tenantId, a.ownerId).setBookingPagePublished(randomUUID(), { published: true }, randomUUID())).rejects.toBeInstanceOf(NotFound);
    await expect(sessionFor(a.tenantId, a.ownerId).setBookingPagePublished("not-a-page", { published: true }, randomUUID())).rejects.toBeInstanceOf(NotFound);
    const staff = await addMember(a.tenantId, "staff");
    await expect(sessionFor(a.tenantId, staff).setBookingPagePublished(pageA, { published: true }, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    // Staff get 403 before any 404 or 422 for the page ID or the body.
    for (const [page, body] of [[randomUUID(), { published: true }], ["not-a-page", { published: true }], [pageA, { published: "yes" }]] as const)
      await expect(sessionFor(a.tenantId, staff).setBookingPagePublished(page, body, randomUUID()), String(page)).rejects.toBeInstanceOf(TenantDenied);
    expect((await sessionFor(a.tenantId, staff).getSetup()).applied?.published).toBe(false);
  });
});

describe("dispatcher action ID reservation", () => {
  it("records the action under the ID the handler reserved", async () => {
    const { tenantId, ownerId } = await freshTenant();
    const applied = await sessionFor(tenantId, ownerId).applyTemplate({ templateId: "agency", timeZone: "UTC" });
    const ids = await fixture.service(async (tx) => ({
      setup: (await tx.query("SELECT action_id FROM tenant_setups WHERE tenant_id=$1", [tenantId])).rows[0]!.action_id,
      outbox: (await tx.query("SELECT action_id FROM outbox WHERE tenant_id=$1", [tenantId])).rows[0]!.action_id,
    }));
    expect(ids).toEqual({ setup: applied.actionId, outbox: applied.actionId });
    expect(BindingMismatch).toBeDefined();
  });
});
