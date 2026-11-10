import { describe, expect, it } from "vitest";
import {
  createOutreachCampaignRequestSchema, idempotencyKeySchema, importOutreachProspectsRequestSchema, OUTREACH_ERROR_CODES, OUTREACH_VARIABLES, outreachProspectRecordSchema,
  outreachWindowSchema, permissionSchema, ROLE_PERMISSIONS,
} from "../src/index.js";

const id = "0b5f6f7e-1d6b-4a52-9b8a-0a7d5a1c9e11";
const campaign = {
  name: "First",
  steps: [
    { subject: "Hello {{first_name}}", body: "Body", delayBusinessDays: 0 },
    { body: "Follow up", delayBusinessDays: 3 },
  ],
  window: { start: "08:00", end: "10:30" },
  mailboxIds: [id],
};

describe("outreach contracts (OS-4)", () => {
  it("accepts a valid campaign and leaves the cap to the handler's default", () => {
    const parsed = createOutreachCampaignRequestSchema.parse(campaign);
    expect(parsed.dailyCapPerMailbox).toBeUndefined();
  });

  it.each([
    ["no subject on step 1", { steps: [{ body: "B", delayBusinessDays: 0 }] }, "steps.0.subject"],
    ["a delay on step 1", { steps: [{ subject: "S", body: "B", delayBusinessDays: 1 }] }, "steps.0.delayBusinessDays"],
    ["a subject on step 2", { steps: [campaign.steps[0], { subject: "S", body: "B", delayBusinessDays: 2 }] }, "steps.1.subject"],
    ["no delay on step 2", { steps: [campaign.steps[0], { body: "B", delayBusinessDays: 0 }] }, "steps.1.delayBusinessDays"],
    ["a delay over 30", { steps: [campaign.steps[0], { body: "B", delayBusinessDays: 31 }] }, "steps.1.delayBusinessDays"],
    ["a line break in the subject", { steps: [{ subject: "A\nB", body: "B", delayBusinessDays: 0 }] }, "steps.0.subject"],
    ["a subject over 150", { steps: [{ subject: "a".repeat(151), body: "B", delayBusinessDays: 0 }] }, "steps.0.subject"],
    ["an empty body", { steps: [{ subject: "S", body: "", delayBusinessDays: 0 }] }, "steps.0.body"],
    ["six steps", { steps: [campaign.steps[0], ...Array.from({ length: 5 }, () => ({ body: "B", delayBusinessDays: 1 }))] }, "steps"],
    ["a window under 30 minutes", { window: { start: "08:00", end: "08:20" } }, "window.end"],
    ["a window that ends first", { window: { start: "10:00", end: "09:00" } }, "window.end"],
    ["a cap of 0", { dailyCapPerMailbox: 0 }, "dailyCapPerMailbox"],
    ["a cap of 51", { dailyCapPerMailbox: 51 }, "dailyCapPerMailbox"],
    ["no mailbox", { mailboxIds: [] }, "mailboxIds"],
    ["a repeated mailbox", { mailboxIds: [id, id] }, "mailboxIds"],
    ["six mailboxes", { mailboxIds: Array.from({ length: 6 }, (_, n) => `0b5f6f7e-1d6b-4a52-9b8a-0a7d5a1c9e0${n}`) }, "mailboxIds"],
    ["a name over 120", { name: "n".repeat(121) }, "name"],
  ])("refuses %s with the field's path", (_label, change, path) => {
    const parsed = createOutreachCampaignRequestSchema.safeParse({ ...campaign, ...change });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.path.join("."))).toContain(path);
  });

  it("takes HH:MM windows only", () => {
    expect(outreachWindowSchema.safeParse({ start: "8:00", end: "10:30" }).success).toBe(false);
    expect(outreachWindowSchema.safeParse({ start: "08:00", end: "24:00" }).success).toBe(false);
    expect(outreachWindowSchema.safeParse({ start: "08:00", end: "08:30" }).success).toBe(true);
  });
});

describe("outreach import and permission (OS-1, OS-7)", () => {
  it("bounds an import to 500 rows and keeps a bad address for a per-row reason", () => {
    const row = { email: "not an email", firstName: "A", company: "B" };
    expect(importOutreachProspectsRequestSchema.safeParse({ prospects: [row] }).success).toBe(true);
    expect(importOutreachProspectsRequestSchema.safeParse({ prospects: [] }).success).toBe(false);
    expect(importOutreachProspectsRequestSchema.safeParse({ prospects: Array.from({ length: 501 }, () => row) }).success).toBe(false);
  });

  it("bounds an optional opener to 300 characters with no CR or LF, and allows {{opener}} in templates (OS-5, OS-7)", () => {
    const row = { email: "a@b.example", firstName: "A", company: "B" };
    const parse = (opener: unknown) => importOutreachProspectsRequestSchema.safeParse({ prospects: [{ ...row, opener }] });
    expect(importOutreachProspectsRequestSchema.safeParse({ prospects: [row] }).success).toBe(true);
    for (const ok of ["Read your post on boilers.", "x", "x".repeat(300), ` ${"x".repeat(300)} `, "", "   ", "Loved {{company}}", "tab\there"]) expect(parse(ok).success, ok).toBe(true);
    for (const bad of ["x".repeat(301), "x".repeat(1201), "two\nlines", "two\rlines", "crlf\r\n", 5, null]) expect(parse(bad).success, String(bad)).toBe(false);
    // An excluded row only reserves the address: its opener is not checked, so it cannot block the rest of the call.
    expect(importOutreachProspectsRequestSchema.safeParse({ prospects: [{ ...row, excluded: true, opener: "two\nlines" }, { ...row, opener: "x".repeat(300) }] }).success).toBe(true);
    const broken = parse("two\nlines");
    expect(broken.success ? [] : broken.error.issues[0]!.path).toEqual(["prospects", 0, "opener"]);
    expect(OUTREACH_VARIABLES).toEqual(["first_name", "company", "industry", "opener"]);
  });

  it("reads a stored prospect record from before the opener existed as opener null (replay of a stop)", () => {
    const stored = {
      id, campaignId: id, mailboxId: id, email: "a@b.example", firstName: "A", lastName: null, company: "B", industry: null, website: null,
      status: "stopped", nextStep: null, nextDueOn: null, stoppedAt: null, createdAt: "2026-11-09T10:00:00.000Z", updatedAt: "2026-11-09T10:00:00.000Z",
    };
    expect(outreachProspectRecordSchema.parse(stored).opener).toBeNull();
    expect(outreachProspectRecordSchema.parse({ ...stored, opener: "Hi" }).opener).toBe("Hi");
  });

  it("gives owners the outreach permission and staff none, and reserves the outreach: key prefix", () => {
    expect(permissionSchema.options).toContain("outreach");
    expect(ROLE_PERMISSIONS.owner).toContain("outreach");
    expect(ROLE_PERMISSIONS.staff).not.toContain("outreach");
    expect(idempotencyKeySchema.safeParse("outreach:bounce:1").success).toBe(false);
    expect(idempotencyKeySchema.safeParse("OUTREACH:x").success).toBe(false);
  });

  it("lists the codes a tenant may see, row reasons included", () => {
    for (const code of ["invalid_email", "role_address", "missing_field", "hard_suppressed", "suppressed", "consent_denied", "duplicate",
      "mailbox_not_in_campaign", "render_too_long", "campaign_not_activatable", "campaign_changed", "no_prospects", "mailbox_unavailable", "time_zone_missing",
      "postal_address_missing", "postal_address_placeholder", "template_placeholder", "campaign_active", "unknown_variable"])
      expect(OUTREACH_ERROR_CODES).toContain(code);
  });
});
