/**
 * The demo adapter's first-run setup (industry-templates.md IT-4, IT-6, IT-11). It keeps the rules
 * the API enforces, in the API's order: a malformed body is 400, only an owner applies (403), then an unknown template is
 * 404 and an unknown zone 422 `invalid_time_zone`, then the same template again replays and another
 * one is 409 `template_already_applied`. An apply confirms the zone on the business profile and adds
 * the template's pipeline, calendar, booking page (off line) and wording beside what the business
 * already has; it changes or removes nothing. The booking page switch is the owner's, and the value
 * a page already has answers changed:false (a replay only for the same Idempotency-Key). In memory: it starts again on every page load.
 */
import type { z } from "zod";
import {
  applyTemplateRequestSchema,
  bookingTimeZoneSchema,
  INDUSTRY_TEMPLATE_IDS,
  INDUSTRY_TEMPLATES,
  industryTemplatePreview,
  isIndustryTemplateId,
  setBookingPagePublishedRequestSchema,
  uuidSchema,
  type AppliedSetup,
  type ApplyTemplateResponse,
  type BookingPageSummary,
  type DeliveryChannel,
  type IndustryTemplate,
  type IndustryTemplateId,
  type PipelineSummary,
  type TemplateApplied,
  type TemplatedKind,
} from "@zs/contracts";
import { demoError, demoErrorBody, errorFromBody } from "../errors";
import type { SetupApi, WriteOptions } from "../types";
import type { DemoActor } from "./agents";
import { DEMO_BOOKING_HOST, type DemoResource } from "./seed";

export interface DemoSetupControls {
  /** The business was set up before this visit (or by another owner): applies a template as the owner. */
  applyTemplateElsewhere(templateId: IndustryTemplateId, timeZone?: string): AppliedSetup;
}

export interface DemoSetupContext {
  now(): Date;
  newId(): string;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>;
  actor(): DemoActor;
  /** The business profile's zone, or null before anyone set one. */
  profileTimeZone(): string | null;
  /** Writes the zone the owner confirmed to the business profile. */
  confirmTimeZone(zone: string): void;
  addPipeline(pipeline: PipelineSummary): void;
  /** The adapter's calendars and booking pages; an apply adds one of each. */
  resources: DemoResource[];
  bookingPages: BookingPageSummary[];
  /** Writes a kind's first wording when it has none; answers the template id, or null when it had wording. */
  seedWording(kind: TemplatedKind, draft: { channel: DeliveryChannel; subject: string | null; body: string; timingHours: number }): string | null;
}

interface StoredSetup {
  actionId: string;
  result: TemplateApplied;
}

const clone = <T>(value: T): T => structuredClone(value);
const PREVIEWS = INDUSTRY_TEMPLATE_IDS.map((id) => industryTemplatePreview(INDUSTRY_TEMPLATES[id]));

/**
 * Like the API's check: an IANA name (or UTC) this runtime knows. An alias such as Asia/Kolkata or
 * Etc/UTC is a name PostgreSQL lists, so it passes; a name in the wrong case does not (PostgreSQL
 * compares names exactly).
 */
function zoneKnown(zone: string): boolean {
  if (!bookingTimeZoneSchema.safeParse(zone).success) return false;
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
    return resolved === zone || resolved.toLowerCase() !== zone.toLowerCase();
  } catch {
    return false;
  }
}

/** The API's 422 for a zone it does not know (`Refused(422, "invalid_time_zone")`). */
const invalidZone = () => errorFromBody(422, demoErrorBody("ValidationFailed", { reason: "invalid_time_zone" }));

const pageKey = (id: string) => `zsb1_${id.replace(/-/g, "").padEnd(64, "0")}`;

export function createDemoSetup(ctx: DemoSetupContext): SetupApi & DemoSetupControls {
  let stored: StoredSetup | null = null;

  const requireOwner = () => {
    if (ctx.actor().role !== "owner") throw demoError("Forbidden");
  };

  function create(template: IndustryTemplate, timeZone: string): StoredSetup {
    ctx.confirmTimeZone(timeZone);
    const pipelineId = ctx.newId();
    const stages = template.pipeline.stages.map((stage, index) => ({ id: ctx.newId(), name: stage.name, position: index, outcome: stage.outcome }));
    ctx.addPipeline({ id: pipelineId, name: template.pipeline.name, stages, archivedStages: [] });

    const { resource } = template;
    const hours: DemoResource["hours"] = {};
    for (const rule of resource.weekly) {
      const first = rule.windows[0];
      // The demo calendar keeps one window a day; every catalog template has one.
      if (first) hours[rule.weekday] = [first.startMinute, first.endMinute];
    }
    const resourceId = ctx.newId();
    ctx.resources.push({
      id: resourceId, name: resource.name, kind: "template", timeZone, hours,
      slotLengthMinutes: resource.slotLengthMinutes, slotStepMinutes: resource.slotStepMinutes,
      bufferBeforeMinutes: resource.bufferBeforeMinutes, bufferAfterMinutes: resource.bufferAfterMinutes,
      minimumNoticeMinutes: resource.minimumNoticeMinutes, bookingHorizonMinutes: resource.bookingHorizonMinutes,
    });

    const bookingPageId = ctx.newId();
    const key = pageKey(bookingPageId);
    ctx.bookingPages.push({
      id: bookingPageId,
      title: template.bookingPage.title,
      // IT-4: the page starts off line; the owner takes it live with IT-11.
      published: false,
      disclosureVersion: ctx.now().toISOString().slice(0, 7),
      resourceIds: [resourceId],
      publicKey: key,
      bookingUrl: `${DEMO_BOOKING_HOST}/book/${key}`,
      embedScript: `<div data-zs-booking="${key}"></div>\n<script src="${DEMO_BOOKING_HOST}/embed.js" async></script>`,
      embedIframe: `<iframe src="${DEMO_BOOKING_HOST}/book/${key}?embed=1" title="Book an appointment" style="width:100%;min-height:640px;border:0" loading="lazy"></iframe>`,
    });

    const messageTemplateIds: string[] = [];
    for (const message of template.messages) {
      if (!template.recommendedAgents.includes(message.agentKind)) continue;
      const id = ctx.seedWording(message.agentKind, { channel: message.channel, subject: message.subject, body: message.body, timingHours: message.timingHours });
      if (id) messageTemplateIds.push(id);
    }

    return {
      actionId: ctx.newId(),
      result: {
        templateId: template.id, templateVersion: template.version, timeZone, appliedAt: ctx.now().toISOString(),
        pipelineId, stageIds: stages.map((stage) => stage.id), resourceId, bookingPageId, messageTemplateIds,
      },
    };
  }

  function appliedView(): AppliedSetup | null {
    if (!stored) return null;
    const { result } = stored;
    const page = ctx.bookingPages.find((item) => item.id === result.bookingPageId);
    return {
      templateId: result.templateId, templateVersion: result.templateVersion, appliedAt: result.appliedAt,
      pipelineId: result.pipelineId, resourceId: result.resourceId, bookingPageId: result.bookingPageId,
      // Any member reads these with the setup, as on the API; the page list stays the owner's.
      bookingPageTitle: page?.title ?? INDUSTRY_TEMPLATES[result.templateId].bookingPage.title,
      bookingUrl: page?.bookingUrl ?? null,
      published: page?.published ?? false,
    };
  }

  return {
    async getSetup() {
      await ctx.wait();
      return { applied: appliedView(), timeZone: ctx.profileTimeZone(), templates: clone(PREVIEWS) };
    },

    async applyTemplate(input) {
      await ctx.wait();
      const request = ctx.parse(applyTemplateRequestSchema, input);
      requireOwner();
      if (!isIndustryTemplateId(request.templateId)) throw demoError("NotFound");
      if (!zoneKnown(request.timeZone)) throw invalidZone();
      if (stored) {
        if (stored.result.templateId !== request.templateId) throw demoError("Conflict", { reason: "template_already_applied" });
        return { ...clone(stored), replayed: true } satisfies ApplyTemplateResponse;
      }
      stored = create(INDUSTRY_TEMPLATES[request.templateId], request.timeZone);
      return { ...clone(stored), replayed: false };
    },

    async setBookingPagePublished(pageId, published, options) {
      // The `business` permission is checked before any replay, as on the API.
      if (ctx.actor().role !== "owner") {
        await ctx.wait();
        throw demoError("Forbidden");
      }
      return ctx.idempotent("booking.page.set_published", { pageId, published }, options, () => {
        if (!uuidSchema.safeParse(pageId).success) throw demoError("NotFound");
        const request = ctx.parse(setBookingPagePublishedRequestSchema, { published });
        const page = ctx.bookingPages.find((item) => item.id === pageId);
        if (!page) throw demoError("NotFound");
        const changed = page.published !== request.published;
        page.published = request.published;
        return { pageId, published: page.published, changed };
      });
    },

    applyTemplateElsewhere(templateId, timeZone = ctx.profileTimeZone() ?? "America/New_York") {
      if (!stored) stored = create(INDUSTRY_TEMPLATES[templateId], timeZone);
      return appliedView()!;
    },
  };
}
