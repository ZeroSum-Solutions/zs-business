// The demo adapter's first-run setup keeps the API's rules (industry-templates.md IT-4, IT-6, IT-10,
// IT-11): any member reads it, only an owner applies, the errors come in the API's order, an apply
// adds the template's records beside the seed's, the same template replays and another one is a 409.
import { INDUSTRY_TEMPLATE_IDS, INDUSTRY_TEMPLATES, setupReadSchema } from "@zs/contracts";
import { describe, expect, it } from "vitest";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_BOOKING_PAGE, DEMO_PIPELINE, DEMO_RESOURCES } from "../src/lib/api/demo/seed";

const NOW = new Date("2026-11-07T10:00:00.000Z");
const adapter = () => createDemoAdapter({ clock: { now: () => NOW } });
let keys = 0;
const key = () => ({ idempotencyKey: `setup-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);

describe("demo adapter: setup", () => {
  it("starts with no setup, no zone and the four previews", async () => {
    const read = setupReadSchema.parse(await adapter().getSetup());
    expect(read.applied).toBeNull();
    expect(read.timeZone).toBeNull();
    expect(read.templates.map((template) => template.id)).toEqual([...INDUSTRY_TEMPLATE_IDS]);
    expect(read.templates[0]!.resource.weekly.length).toBeGreaterThan(0);
  });

  it.each(INDUSTRY_TEMPLATE_IDS)("applies %s beside the seed's records, off line, in the confirmed zone", async (id) => {
    const api = adapter();
    const template = INDUSTRY_TEMPLATES[id];
    const answer = await api.applyTemplate({ templateId: id, timeZone: "Europe/London" });
    expect(answer.replayed).toBe(false);
    expect(answer.result).toMatchObject({ templateId: id, templateVersion: template.version, timeZone: "Europe/London" });

    const pipelines = await api.listPipelines();
    expect(pipelines.map((pipeline) => pipeline.id)).toEqual([DEMO_PIPELINE.id, answer.result.pipelineId]);
    expect(pipelines[1]!.stages.map((stage) => [stage.name, stage.outcome])).toEqual(template.pipeline.stages.map((stage) => [stage.name, stage.outcome]));

    const resources = await api.listResources();
    expect(resources).toHaveLength(DEMO_RESOURCES.length + 1);
    expect(resources.at(-1)).toMatchObject({ id: answer.result.resourceId, name: template.resource.name, timeZone: "Europe/London", slotLengthMinutes: template.resource.slotLengthMinutes });

    const pages = await api.listBookingPages();
    expect(pages.map((page) => page.id)).toEqual([DEMO_BOOKING_PAGE.id, answer.result.bookingPageId]);
    expect(pages[1]).toMatchObject({ title: template.bookingPage.title, published: false, resourceIds: [answer.result.resourceId] });

    expect((await api.getBusiness()).timeZone).toBe("Europe/London");
    const read = await api.getSetup();
    expect(read.timeZone).toBe("Europe/London");
    expect(read.applied).toMatchObject({ templateId: id, pipelineId: answer.result.pipelineId, bookingPageId: answer.result.bookingPageId, published: false });

    // Wording for each recommended agent, waiting for the owner's approval.
    for (const kind of template.recommendedAgents) {
      const state = await api.getTemplate(kind);
      expect(state.currentRevision).toBe(1);
      expect(state.revisions[0]!.approved).toBe(false);
    }
    expect(answer.result.messageTemplateIds).toHaveLength(template.recommendedAgents.length);
  });

  it("replays the same template with the stored result and refuses another one", async () => {
    const api = adapter();
    const first = await api.applyTemplate({ templateId: "agency", timeZone: "America/Chicago" });
    const again = await api.applyTemplate({ templateId: "agency", timeZone: "America/Chicago" });
    expect(again).toEqual({ ...first, replayed: true });
    expect(await api.listPipelines()).toHaveLength(2);
    const error = await failure(api.applyTemplate({ templateId: "fitness", timeZone: "America/Chicago" }));
    expect(error).toMatchObject({ kind: "conflict", status: 409, reason: "template_already_applied" });
  });

  it("keeps wording the business already wrote", async () => {
    const api = adapter();
    api.writeTemplateElsewhere("appointment_reminder");
    const answer = await api.applyTemplate({ templateId: "agency", timeZone: "America/Chicago" });
    expect(answer.result.messageTemplateIds).toEqual([]);
    expect((await api.getTemplate("appointment_reminder")).currentRevision).toBe(1);
  });

  it("answers in the API's order: 403 for staff, then 404 for an unknown id, then 422 for an unknown zone", async () => {
    const api = adapter();
    api.actAs("staff");
    expect(await failure(api.applyTemplate({ templateId: "nope", timeZone: "Mars/Olympus" }))).toMatchObject({ kind: "forbidden", status: 403 });
    api.actAs("owner");
    expect(await failure(api.applyTemplate({ templateId: "nope", timeZone: "Mars/Olympus" }))).toMatchObject({ kind: "not_found", status: 404 });
    const zone = await failure(api.applyTemplate({ templateId: "jewelry", timeZone: "Mars/Olympus" }));
    expect(zone).toMatchObject({ kind: "validation", status: 422, reason: "invalid_time_zone" });
    expect((await api.getSetup()).applied).toBeNull();
    expect(await api.listPipelines()).toHaveLength(1);
  });

  it("lets staff read the setup with the page's title and address, but not list booking pages (the API's `publish` permission)", async () => {
    const api = adapter();
    const { bookingPageId } = api.applyTemplateElsewhere("crafts", "Europe/Paris");
    const owned = (await api.listBookingPages()).find((page) => page.id === bookingPageId)!;
    api.actAs("staff");
    expect((await api.getSetup()).applied).toMatchObject({
      templateId: "crafts", published: false, bookingPageTitle: INDUSTRY_TEMPLATES.crafts.bookingPage.title, bookingUrl: owned.bookingUrl,
    });
    expect(await failure(api.listBookingPages())).toMatchObject({ kind: "forbidden", status: 403 });
  });

  it("numbers the template's stages from 0 and keeps its booking horizon, as the core handler does", async () => {
    const api = adapter();
    const applied = await api.applyTemplate({ templateId: "agency", timeZone: "America/Chicago" });
    const pipeline = (await api.listPipelines()).find((item) => item.id === applied.result.pipelineId)!;
    expect(pipeline.stages.map((stage) => stage.position)).toEqual(pipeline.stages.map((_stage, index) => index));
    // Nothing is bookable from the horizon on: 60 days ahead for every template.
    const horizon = INDUSTRY_TEMPLATES.agency.resource.bookingHorizonMinutes * 60_000;
    const day = 86_400_000;
    const near = await api.getSlots({ resourceId: applied.result.resourceId, from: NOW.toISOString(), to: new Date(NOW.getTime() + 7 * day).toISOString() });
    expect(near.slots.length).toBeGreaterThan(0);
    const beyond = await api.getSlots({
      resourceId: applied.result.resourceId, from: new Date(NOW.getTime() + horizon).toISOString(), to: new Date(NOW.getTime() + horizon + 7 * day).toISOString(),
    });
    expect(beyond.slots).toEqual([]);
    // The same weekday and hour 56 days out books (inside the horizon); 63 days out (beyond it) does not.
    const slot = near.slots[0]!.startsAt;
    const at = (days: number) => new Date(Date.parse(slot) + days * day).toISOString();
    await expect(api.createBooking({ resourceId: applied.result.resourceId, startsAt: at(56) }, key())).resolves.toBeTruthy();
    expect(await failure(api.createBooking({ resourceId: applied.result.resourceId, startsAt: at(63) }, key()))).toMatchObject({ kind: "conflict" });
  });

  it("accepts a valid zone alias PostgreSQL lists, and refuses a zone in the wrong case", async () => {
    for (const timeZone of ["Asia/Kolkata", "Etc/UTC", "UTC"]) {
      const api = adapter();
      expect((await api.applyTemplate({ templateId: "jewelry", timeZone })).result.timeZone, timeZone).toBe(timeZone);
    }
    expect(await failure(adapter().applyTemplate({ templateId: "jewelry", timeZone: "america/los_angeles" }))).toMatchObject({ status: 422, reason: "invalid_time_zone" });
  });

  it("takes the page live and off line again; the same value is no change, staff get 403, an unknown page 404", async () => {
    const api = adapter();
    const { bookingPageId } = api.applyTemplateElsewhere("jewelry");
    expect(await api.setBookingPagePublished(bookingPageId, true, key())).toEqual({ pageId: bookingPageId, published: true, changed: true });
    expect((await api.getSetup()).applied?.published).toBe(true);
    expect(await api.setBookingPagePublished(bookingPageId, true, key())).toMatchObject({ changed: false });
    expect(await api.setBookingPagePublished(bookingPageId, false, key())).toMatchObject({ published: false, changed: true });
    expect((await api.listBookingPages()).find((page) => page.id === bookingPageId)?.published).toBe(false);

    expect(await failure(api.setBookingPagePublished("7c9e1b3d-5f7a-4b9c-8d1e-000000000000", true, key()))).toMatchObject({ kind: "not_found" });
    api.actAs("staff");
    expect(await failure(api.setBookingPagePublished(bookingPageId, true, key()))).toMatchObject({ kind: "forbidden" });
  });

  it("creates a deal in the given stage, and refuses a stage outside the pipeline", async () => {
    const api = adapter();
    const applied = api.applyTemplateElsewhere("fitness");
    const pipeline = (await api.listPipelines()).find((item) => item.id === applied.pipelineId)!;
    const contact = (await api.listContacts()).items[0]!;
    const deal = await api.createDeal({ contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0]!.id, title: "Intro package" }, key());
    expect(deal).toMatchObject({ contactId: contact.id, pipelineId: pipeline.id, stageId: pipeline.stages[0]!.id, title: "Intro package", revision: 1 });
    expect((await api.listDeals({ contactId: contact.id })).items.some((item) => item.id === deal.id && item.value === null)).toBe(true);
    const error = await failure(api.createDeal({ contactId: contact.id, pipelineId: pipeline.id, stageId: DEMO_PIPELINE.stages[0]!.id, title: "x" }, key()));
    expect(error).toMatchObject({ kind: "forbidden" });
  });

  it("keeps its internals off the demo controls", () => {
    const api = adapter() as unknown as Record<string, unknown>;
    for (const name of ["seedWording", "confirmTimeZone", "profileTimeZone"]) expect(api[name]).toBeUndefined();
  });
});
