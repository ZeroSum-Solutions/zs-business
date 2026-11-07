import { z } from "zod";
import { actionResultSchema, uuidSchema, ValidationFailed } from "../index.js";
import { bookingResourceSchema, bookingTimeZoneSchema, weeklyAvailabilityRuleSchema, type WeeklyAvailabilityRule } from "../booking.js";
import { parseTemplateDraft, templatedKindSchema, type TemplatedKind } from "../templates.js";
import { deliveryChannelSchema } from "../delivery.js";

// Industry templates (docs/requirements/industry-templates.md IT-1, IT-2, IT-6, IT-11). Templates are
// code: the API and the dashboard read this one copy, and a change ships as a reviewed diff with a
// version bump. Root re-exports this module, so shared root schemas are reached lazily.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

export const INDUSTRY_TEMPLATE_IDS = ["jewelry", "crafts", "agency", "fitness"] as const;
export const industryTemplateIdSchema = z.enum(INDUSTRY_TEMPLATE_IDS);
export type IndustryTemplateId = z.infer<typeof industryTemplateIdSchema>;
export const isIndustryTemplateId = (value: unknown): value is IndustryTemplateId =>
  typeof value === "string" && (INDUSTRY_TEMPLATE_IDS as readonly string[]).includes(value);

/**
 * IT-1: the connection ids a template may recommend: the connections catalog's toolkits
 * (connections.md C-6; the pilot catalog is Shopify) and `google_calendar`.
 */
export const RECOMMENDABLE_CONNECTIONS = ["shopify", "google_calendar"] as const;
export const recommendableConnectionSchema = z.enum(RECOMMENDABLE_CONNECTIONS);

/** IT-4: the action that applies a template, and the server-reserved key it uses. */
export const TEMPLATE_APPLY_ACTION = "tenant.template.apply";
export const TEMPLATE_APPLIED_EVENT = "tenant.template.applied";
export const templateApplyKey = (templateId: IndustryTemplateId): string => `template:${templateId}`;
/** IT-11: the owner action that takes a booking page live or off line. */
export const BOOKING_PAGE_SET_PUBLISHED_ACTION = "booking.page.set_published";

const text = (max: number) => z.string().trim().min(1).max(max);
const stageSchema = z.strictObject({ name: text(200), outcome: z.enum(["open", "won", "lost"]) });
const templateResourceSchema = z.strictObject({
  name: text(200),
  weekly: z.array(weeklyAvailabilityRuleSchema).min(1),
  slotLengthMinutes: z.number().int(),
  slotStepMinutes: z.number().int(),
  bufferBeforeMinutes: z.number().int(),
  bufferAfterMinutes: z.number().int(),
  minimumNoticeMinutes: z.number().int(),
  bookingHorizonMinutes: z.number().int(),
});
const templateMessageSchema = z.strictObject({
  agentKind: templatedKindSchema,
  channel: deliveryChannelSchema,
  subject: z.string().nullable(),
  body: z.string(),
  timingHours: z.number().int(),
});
const PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/** IT-1: every template passes this schema; a test runs it over the catalog. */
export const industryTemplateSchema = z.strictObject({
  id: industryTemplateIdSchema,
  version: z.number().int().min(1),
  label: text(80),
  summary: text(300),
  pipeline: z.strictObject({ name: text(200), stages: z.array(stageSchema).min(3).max(8) }),
  resource: templateResourceSchema,
  bookingPage: z.strictObject({ title: text(200), description: text(2000), disclosureText: text(2000) }),
  messages: z.array(templateMessageSchema),
  recommendedConnections: z.array(recommendableConnectionSchema),
  recommendedAgents: z.array(templatedKindSchema).min(1),
}).superRefine((template, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const outcomes = template.pipeline.stages.map((stage) => stage.outcome);
  if (outcomes.filter((o) => o === "won").length !== 1 || outcomes.filter((o) => o === "lost").length !== 1)
    issue("A pipeline has exactly one won and one lost stage");
  if (outcomes.at(-2) !== "won" || outcomes.at(-1) !== "lost") issue("The last two stages are won, then lost");
  if (new Set(template.pipeline.stages.map((stage) => stage.name)).size !== template.pipeline.stages.length)
    issue("Stage names are unique");
  const { name: _name, ...rules } = template.resource;
  const resource = bookingResourceSchema.safeParse({
    ...rules, tenantId: PLACEHOLDER_ID, id: PLACEHOLDER_ID, timeZone: "UTC", overrides: [],
  });
  if (!resource.success) issue(`Invalid resource: ${resource.error.issues[0]?.message ?? "invalid"}`);
  const kinds = template.messages.map((message) => message.agentKind);
  if (new Set(kinds).size !== kinds.length) issue("One message per agent kind");
  if (kinds.join() !== template.recommendedAgents.join()) issue("One message per recommended agent, in the same order");
  if (new Set(template.recommendedConnections).size !== template.recommendedConnections.length)
    issue("Recommended connections are unique");
  for (const { agentKind, ...draft } of template.messages) {
    try {
      parseTemplateDraft(agentKind, draft);
    } catch (error) {
      issue(`Invalid ${agentKind} message: ${error instanceof ValidationFailed ? error.message : "invalid"}`);
    }
  }
});
export type IndustryTemplate = z.infer<typeof industryTemplateSchema>;

const HOUR = 60;
const DAY = 24 * HOUR;
const window = (startHour: number, endHour: number) => [{ startMinute: startHour * HOUR, endMinute: endHour * HOUR }];
const hours = (weekdays: { start: number; end: number }, saturday?: { start: number; end: number }): WeeklyAvailabilityRule[] => [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, windows: window(weekdays.start, weekdays.end) })),
  ...(saturday ? [{ weekday: 6, windows: window(saturday.start, saturday.end) }] : []),
];
const stages = (open: readonly string[], won: string, lost: string) => [
  ...open.map((name) => ({ name, outcome: "open" as const })),
  { name: won, outcome: "won" as const },
  { name: lost, outcome: "lost" as const },
];
const STUDIO_DESCRIPTION = "In person at our studio. We confirm the details by email.";
const DISCLOSURE =
  "We use your details to manage this appointment and email you about it. If you agree, we may also email you afterwards to ask how it went. You can opt out at any time.";
/** For a template that sends no review request, so the page does not promise one. */
const APPOINTMENT_DISCLOSURE =
  "We use your details to manage this appointment and email you about it. You can opt out at any time.";
const reminder = (what: string) => ({
  agentKind: "appointment_reminder" as const,
  channel: "email" as const,
  subject: `Reminder: your ${what} with {business_name}`,
  body: `Hi {customer_first_name},\n\nThis is a reminder of your ${what} with {business_name} on {booking_start_local}.\n\nYour booking: {booking_link}\n\nSee you soon,\n{business_name}`,
  timingHours: 24,
});
const reviewRequest = (what: string) => ({
  agentKind: "review_request" as const,
  channel: "email" as const,
  subject: `How was your ${what} with {business_name}?`,
  body: `Hi {customer_first_name},\n\nThank you for your ${what} with {business_name} on {booking_start_local}. If you have a minute, we would value a short review of your visit: {review_link}\n\nThank you,\n{business_name}`,
  timingHours: 24,
});

const catalog = {
  jewelry: {
    id: "jewelry",
    version: 1,
    label: "Jewelry: custom and bridal",
    summary: "For jewelers who make custom and bridal pieces: from the first inquiry through the design and the deposit to delivery.",
    pipeline: {
      name: "Custom & bridal",
      stages: stages(["Inquiry", "Consultation", "Design approved", "Deposit paid", "In production"], "Delivered", "Lost"),
    },
    resource: {
      name: "Consultation",
      weekly: hours({ start: 9, end: 17 }, { start: 10, end: 16 }),
      slotLengthMinutes: 45, slotStepMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 15,
      minimumNoticeMinutes: 12 * HOUR, bookingHorizonMinutes: 60 * DAY,
    },
    bookingPage: { title: "Book a consultation", description: STUDIO_DESCRIPTION, disclosureText: DISCLOSURE },
    messages: [reminder("consultation"), reviewRequest("consultation")],
    recommendedConnections: ["shopify", "google_calendar"],
    recommendedAgents: ["appointment_reminder", "review_request"],
  },
  crafts: {
    id: "crafts",
    version: 1,
    label: "Ceramics and crafts: commissions",
    summary: "For ceramicists and other makers who take commissions: from the first inquiry through the quote and the deposit to delivery.",
    pipeline: {
      name: "Commissions",
      stages: stages(["Inquiry", "Quote sent", "Deposit paid", "In the studio"], "Delivered", "Lost"),
    },
    resource: {
      name: "Studio visit",
      weekly: hours({ start: 9, end: 17 }, { start: 10, end: 16 }),
      slotLengthMinutes: 30, slotStepMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 15,
      minimumNoticeMinutes: 12 * HOUR, bookingHorizonMinutes: 60 * DAY,
    },
    bookingPage: { title: "Visit the studio", description: STUDIO_DESCRIPTION, disclosureText: DISCLOSURE },
    messages: [reminder("studio visit"), reviewRequest("studio visit")],
    recommendedConnections: ["shopify", "google_calendar"],
    recommendedAgents: ["appointment_reminder", "review_request"],
  },
  agency: {
    id: "agency",
    version: 1,
    label: "AI and business agency",
    summary: "For agencies that sell AI and business services: from the first lead through the discovery call and the proposal to a signed client.",
    pipeline: {
      name: "Client pipeline",
      stages: stages(["Lead", "Discovery call", "Proposal sent", "Negotiation"], "Won", "Lost"),
    },
    resource: {
      name: "Discovery call",
      weekly: hours({ start: 9, end: 17 }),
      slotLengthMinutes: 30, slotStepMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 0,
      minimumNoticeMinutes: 12 * HOUR, bookingHorizonMinutes: 60 * DAY,
    },
    bookingPage: { title: "Book a discovery call", description: "A video call. We confirm the details by email.", disclosureText: APPOINTMENT_DISCLOSURE },
    messages: [reminder("discovery call")],
    recommendedConnections: ["google_calendar"],
    recommendedAgents: ["appointment_reminder"],
  },
  fitness: {
    id: "fitness",
    version: 1,
    label: "Gym or personal trainer",
    summary: "For gyms and personal trainers winning new clients: from the first lead through a free intro session to a signed-up client.",
    pipeline: {
      name: "New clients",
      stages: stages(["Lead", "Intro booked", "Intro done", "Offer made"], "Signed up", "Lost"),
    },
    resource: {
      name: "Free intro session",
      weekly: hours({ start: 6, end: 20 }, { start: 8, end: 14 }),
      slotLengthMinutes: 30, slotStepMinutes: 15, bufferBeforeMinutes: 0, bufferAfterMinutes: 15,
      minimumNoticeMinutes: 2 * HOUR, bookingHorizonMinutes: 60 * DAY,
    },
    bookingPage: {
      title: "Book a free intro",
      description: "At the gym. Wear training clothes. We confirm the details by email.",
      disclosureText: DISCLOSURE,
    },
    messages: [reminder("intro session"), reviewRequest("intro session")],
    recommendedConnections: ["google_calendar"],
    recommendedAgents: ["appointment_reminder", "review_request"],
  },
} satisfies Record<IndustryTemplateId, IndustryTemplate>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** IT-1, IT-2: the four templates, frozen. */
export const INDUSTRY_TEMPLATES: Readonly<Record<IndustryTemplateId, IndustryTemplate>> = deepFreeze(catalog);

/** IT-6: the stage a new deal goes into: the first that is neither won nor lost (IT-10). */
export const firstOpenStageIndex = (template: IndustryTemplate): number =>
  template.pipeline.stages.findIndex((stage) => stage.outcome === "open");

// IT-6 API shapes.
const previewMessageSchema = z.strictObject({
  agentKind: templatedKindSchema,
  channel: deliveryChannelSchema,
  subject: z.string().nullable(),
  timingHours: z.number().int(),
  /** "before" for reminders, "after" for review requests. */
  timing: z.enum(["before", "after"]),
});
export const industryTemplatePreviewSchema = z.strictObject({
  id: industryTemplateIdSchema,
  version: z.number().int().min(1),
  label: z.string(),
  summary: z.string(),
  pipeline: z.strictObject({ name: z.string(), stages: z.array(stageSchema) }),
  resource: templateResourceSchema,
  bookingPage: z.strictObject({ title: z.string(), description: z.string(), disclosureText: z.string() }),
  messages: z.array(previewMessageSchema),
  recommendedConnections: z.array(recommendableConnectionSchema),
  recommendedAgents: z.array(templatedKindSchema),
});
export type IndustryTemplatePreview = z.infer<typeof industryTemplatePreviewSchema>;

const MESSAGE_TIMING: Readonly<Record<TemplatedKind, "before" | "after">> = Object.freeze({
  appointment_reminder: "before",
  review_request: "after",
});
/** IT-6: the resolved preview a member reads before applying. */
export function industryTemplatePreview(template: IndustryTemplate): IndustryTemplatePreview {
  return industryTemplatePreviewSchema.parse({
    id: template.id,
    version: template.version,
    label: template.label,
    summary: template.summary,
    pipeline: { name: template.pipeline.name, stages: template.pipeline.stages.map((stage) => ({ ...stage })) },
    resource: { ...template.resource, weekly: template.resource.weekly.map((rule) => ({ weekday: rule.weekday, windows: rule.windows.map((w) => ({ ...w })) })) },
    bookingPage: { ...template.bookingPage },
    messages: template.messages.map((message) => ({
      agentKind: message.agentKind,
      channel: message.channel,
      subject: message.subject,
      timingHours: message.timingHours,
      timing: MESSAGE_TIMING[message.agentKind],
    })),
    recommendedConnections: [...template.recommendedConnections],
    recommendedAgents: [...template.recommendedAgents],
  });
}

export const appliedSetupSchema = z.strictObject({
  templateId: industryTemplateIdSchema,
  templateVersion: z.number().int().min(1),
  appliedAt: instantSchema,
  pipelineId: idSchema,
  resourceId: idSchema,
  bookingPageId: idSchema,
  /** The page's title and public address, so every member sees the link; the address is null when the server has no public base URL. */
  bookingPageTitle: z.string(),
  bookingUrl: z.string().nullable(),
  published: z.boolean(),
});
export type AppliedSetup = z.infer<typeof appliedSetupSchema>;

/** IT-6: GET /v1/setup. */
export const setupReadSchema = z.strictObject({
  applied: appliedSetupSchema.nullable(),
  timeZone: z.string().nullable(),
  templates: z.array(industryTemplatePreviewSchema),
});
export type SetupRead = z.infer<typeof setupReadSchema>;

/** IT-4, IT-6: POST /v1/setup/apply. */
export const applyTemplateRequestSchema = z.strictObject({
  templateId: z.string().min(1).max(64),
  timeZone: z.string().min(1).max(100),
});
export type ApplyTemplateRequest = z.infer<typeof applyTemplateRequestSchema>;
/** IT-4: the payload the dispatcher binds, once the id and zone are known to be valid. */
export const applyTemplatePayloadSchema = z.strictObject({
  templateId: industryTemplateIdSchema,
  timeZone: bookingTimeZoneSchema,
});
export type ApplyTemplatePayload = z.infer<typeof applyTemplatePayloadSchema>;

/** IT-4: what an apply created, stored as the action result and returned on replay. */
export const templateAppliedSchema = z.strictObject({
  templateId: industryTemplateIdSchema,
  templateVersion: z.number().int().min(1),
  timeZone: z.string(),
  appliedAt: instantSchema,
  pipelineId: idSchema,
  stageIds: z.array(idSchema),
  resourceId: idSchema,
  bookingPageId: idSchema,
  /** The message templates this apply created; a kind the tenant already had is left out. */
  messageTemplateIds: z.array(idSchema),
});
export type TemplateApplied = z.infer<typeof templateAppliedSchema>;
/** The action's id and stored result; `replayed` is true when the template was already applied. */
export const applyTemplateResponseSchema = z.lazy(() =>
  actionResultSchema.extend({ result: templateAppliedSchema, replayed: z.boolean() }));
export type ApplyTemplateResponse = z.infer<typeof applyTemplateResponseSchema>;

/** IT-11: POST /v1/setup/booking-pages/:id/published. */
export const setBookingPagePublishedRequestSchema = z.strictObject({ published: z.boolean() });
export type SetBookingPagePublishedRequest = z.infer<typeof setBookingPagePublishedRequestSchema>;
/** `changed` is false when the page already had the requested value. */
export const bookingPagePublishedSchema = z.strictObject({ pageId: idSchema, published: z.boolean(), changed: z.boolean() });
export type BookingPagePublished = z.infer<typeof bookingPagePublishedSchema>;
/** `replayed` is true only when a stored action answered: the same Idempotency-Key and request. A page that already has the value answers changed:false. */
export const setBookingPagePublishedResponseSchema = z.lazy(() =>
  actionResultSchema.extend({ result: bookingPagePublishedSchema, replayed: z.boolean() }));
export type SetBookingPagePublishedResponse = z.infer<typeof setBookingPagePublishedResponseSchema>;
