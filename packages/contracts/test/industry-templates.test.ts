import { describe, expect, it } from "vitest";
import {
  applyTemplatePayloadSchema,
  firstOpenStageIndex,
  idempotencyKeySchema,
  INDUSTRY_TEMPLATE_IDS,
  INDUSTRY_TEMPLATES,
  industryTemplatePreview,
  industryTemplateSchema,
  parseTemplateDraft,
  renderTemplate,
  SERVER_IDEMPOTENCY_PREFIXES,
  setupReadSchema,
  templateApplyKey,
  type IndustryTemplate,
} from "../src/index.js";

// docs/requirements/industry-templates.md, acceptance 1.
const minutes = (hour: number) => hour * 60;
const weekdays = (start: number, end: number) =>
  [1, 2, 3, 4, 5].map((weekday) => ({ weekday, windows: [{ startMinute: minutes(start), endMinute: minutes(end) }] }));
const saturday = (start: number, end: number) => ({ weekday: 6, windows: [{ startMinute: minutes(start), endMinute: minutes(end) }] });

const expected = {
  jewelry: {
    pipeline: "Custom & bridal",
    stages: ["Inquiry", "Consultation", "Design approved", "Deposit paid", "In production", "Delivered", "Lost"],
    resource: "Consultation", slot: 45, weekly: [...weekdays(9, 17), saturday(10, 16)], buffers: [0, 15], notice: 12 * 60,
    page: "Book a consultation", description: "In person at our studio. We confirm the details by email.",
    agents: ["appointment_reminder", "review_request"], connections: ["shopify", "google_calendar"],
  },
  crafts: {
    pipeline: "Commissions",
    stages: ["Inquiry", "Quote sent", "Deposit paid", "In the studio", "Delivered", "Lost"],
    resource: "Studio visit", slot: 30, weekly: [...weekdays(9, 17), saturday(10, 16)], buffers: [0, 15], notice: 12 * 60,
    page: "Visit the studio", description: "In person at our studio. We confirm the details by email.",
    agents: ["appointment_reminder", "review_request"], connections: ["shopify", "google_calendar"],
  },
  agency: {
    pipeline: "Client pipeline",
    stages: ["Lead", "Discovery call", "Proposal sent", "Negotiation", "Won", "Lost"],
    resource: "Discovery call", slot: 30, weekly: weekdays(9, 17), buffers: [0, 0], notice: 12 * 60,
    page: "Book a discovery call", description: "A video call. We confirm the details by email.",
    agents: ["appointment_reminder"], connections: ["google_calendar"],
  },
  fitness: {
    pipeline: "New clients",
    stages: ["Lead", "Intro booked", "Intro done", "Offer made", "Signed up", "Lost"],
    resource: "Free intro session", slot: 30, weekly: [...weekdays(6, 20), saturday(8, 14)], buffers: [0, 15], notice: 2 * 60,
    page: "Book a free intro", description: "At the gym. Wear training clothes. We confirm the details by email.",
    agents: ["appointment_reminder", "review_request"], connections: ["google_calendar"],
  },
} as const;

describe("IT-1, IT-2 industry template catalog", () => {
  it("has the four ids, frozen", () => {
    expect(Object.keys(INDUSTRY_TEMPLATES)).toEqual(["jewelry", "crafts", "agency", "fitness"]);
    expect(INDUSTRY_TEMPLATE_IDS).toEqual(["jewelry", "crafts", "agency", "fitness"]);
    expect(Object.isFrozen(INDUSTRY_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(INDUSTRY_TEMPLATES.jewelry.pipeline.stages[0])).toBe(true);
  });

  it.each(INDUSTRY_TEMPLATE_IDS)("%s passes the schema and matches IT-2", (id) => {
    const template = INDUSTRY_TEMPLATES[id];
    expect(industryTemplateSchema.parse(template)).toEqual(template);
    const want = expected[id];
    expect(template.id).toBe(id);
    expect(template.version).toBe(1);
    expect(template.pipeline.name).toBe(want.pipeline);
    expect(template.pipeline.stages.map((stage) => stage.name)).toEqual(want.stages);
    expect(template.pipeline.stages.map((stage) => stage.outcome).slice(-2)).toEqual(["won", "lost"]);
    expect(template.resource).toEqual({
      name: want.resource, weekly: want.weekly, slotLengthMinutes: want.slot, slotStepMinutes: 15,
      bufferBeforeMinutes: want.buffers[0], bufferAfterMinutes: want.buffers[1],
      minimumNoticeMinutes: want.notice, bookingHorizonMinutes: 60 * 24 * 60,
    });
    expect(template.bookingPage.title).toBe(want.page);
    expect(template.bookingPage.description).toBe(want.description);
    expect(template.bookingPage.disclosureText.length).toBeGreaterThan(0);
    expect(template.recommendedAgents).toEqual(want.agents);
    expect(template.recommendedConnections).toEqual(want.connections);
    expect(template.messages.map((message) => message.agentKind)).toEqual(want.agents);
    for (const message of template.messages) {
      expect(message.channel).toBe("email");
      expect(message.timingHours).toBe(24);
      const checked = parseTemplateDraft(message.agentKind, {
        channel: message.channel, subject: message.subject, body: message.body, timingHours: message.timingHours,
      });
      expect(checked.variables).toContain("business_name");
      expect(renderTemplate(message.subject!, { business_name: "Acme" })).toContain("Acme");
    }
    expect(template.pipeline.stages[firstOpenStageIndex(template)]!.name).toBe(want.stages[0]);
  });

  it("refuses a template that breaks a schema rule", () => {
    const base = INDUSTRY_TEMPLATES.agency;
    const broken = (change: (copy: IndustryTemplate) => void) => {
      const copy = structuredClone(base) as IndustryTemplate;
      change(copy);
      return industryTemplateSchema.safeParse(copy).success;
    };
    expect(broken(() => undefined)).toBe(true);
    expect(broken((t) => { t.pipeline.stages = t.pipeline.stages.slice(-2); })).toBe(false);
    expect(broken((t) => { t.pipeline.stages = [...t.pipeline.stages].reverse(); })).toBe(false);
    expect(broken((t) => { t.pipeline.stages[0] = { name: "Extra win", outcome: "won" }; })).toBe(false);
    expect(broken((t) => { t.resource.slotLengthMinutes = 0; })).toBe(false);
    expect(broken((t) => { t.resource.weekly = [...t.resource.weekly, t.resource.weekly[0]!]; })).toBe(false);
    expect(broken((t) => { t.messages[0]!.subject = null; })).toBe(false);
    expect(broken((t) => { t.messages[0]!.body = "Hi {nobody}"; })).toBe(false);
    expect(broken((t) => { t.messages[0]!.timingHours = 500; })).toBe(false);
    expect(broken((t) => { t.recommendedAgents = ["appointment_reminder", "review_request"]; })).toBe(false);
    expect(broken((t) => { (t.recommendedConnections as string[]) = ["stripe"]; })).toBe(false);
  });

  it("previews every template for GET /v1/setup", () => {
    const read = setupReadSchema.parse({
      applied: null,
      timeZone: null,
      templates: INDUSTRY_TEMPLATE_IDS.map((id) => industryTemplatePreview(INDUSTRY_TEMPLATES[id])),
    });
    const fitness = read.templates[3]!;
    expect(fitness.resource.weekly.at(-1)).toEqual(saturday(8, 14));
    expect(fitness.messages.map((message) => [message.agentKind, message.timing, message.timingHours]))
      .toEqual([["appointment_reminder", "before", 24], ["review_request", "after", 24]]);
    expect(fitness.bookingPage.disclosureText).toBe(INDUSTRY_TEMPLATES.fitness.bookingPage.disclosureText);
  });

  it("reserves the template: key prefix and checks the apply payload", () => {
    expect(SERVER_IDEMPOTENCY_PREFIXES).toContain("template:");
    expect(templateApplyKey("agency")).toBe("template:agency");
    expect(idempotencyKeySchema.safeParse("template:agency").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("Template:jewelry").success).toBe(false);
    expect(applyTemplatePayloadSchema.safeParse({ templateId: "agency", timeZone: "America/Los_Angeles" }).success).toBe(true);
    expect(applyTemplatePayloadSchema.safeParse({ templateId: "bakery", timeZone: "UTC" }).success).toBe(false);
    expect(applyTemplatePayloadSchema.safeParse({ templateId: "agency", timeZone: "Mars/Olympus" }).success).toBe(false);
  });
});
