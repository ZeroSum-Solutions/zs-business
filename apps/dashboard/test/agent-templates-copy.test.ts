// The Agents page's words and form checks for the templated kinds (agents.md G-19, G-20,
// approvals.md A-15): which variables a kind takes, unknown placeholders refused before a save,
// and what each revision's approval reads as.
import { describe, expect, it } from "vitest";
import { TEMPLATE_VARIABLES, defaultAgentKindSettings, type AgentKindStatus, type TemplateRevision } from "@zs/contracts";
import {
  CHANNEL_LABELS,
  currentRevisionOf,
  ENABLE_NEEDS_REVIEW_LINK,
  KIND_COPY,
  kindRunToast,
  kindState,
  NEEDS_APPROVAL_NOTE,
  readReviewLink,
  readTemplateForm,
  revisionState,
  timingSentence,
  toTemplateForm,
  unknownPlaceholders,
  UNAPPROVES_WARNING,
  VARIABLE_HELP,
} from "../src/lib/agents";

const USER = "9a1b3c5d-7e9f-4a1b-8c2d-000000000001";
const revision = (patch: Partial<TemplateRevision> = {}): TemplateRevision => ({
  id: "00000000-0000-4000-8000-000000000101", revision: 1, channel: "email", purpose: "transactional",
  subject: "See you soon", body: "Hi {customer_first_name}", variables: ["customer_first_name"], timingHours: 24,
  contentDigest: "a".repeat(64), createdBy: USER, createdAt: "2026-10-20T12:00:00.000Z", current: true,
  standing: null, pendingApprovalId: null, approved: false, ...patch,
});
const kindStatus = (patch: Partial<AgentKindStatus> = {}): AgentKindStatus => ({
  agentKind: "appointment_reminder", settings: { ...defaultAgentKindSettings("appointment_reminder"), enabled: true },
  revision: 1, updatedAt: null, killed: null, globalKilled: false, canRun: true, blockedBy: null,
  costSpentMicros: 0, costCapMicros: 1_000_000, costWarning: false, ...patch,
});
const form = (patch: Partial<ReturnType<typeof toTemplateForm>> = {}) => ({
  ...toTemplateForm("appointment_reminder", null), subject: "Your visit", body: "Hi {customer_first_name}, see you {booking_start_local}.", ...patch,
});

describe("templated kinds: copy", () => {
  it("has a title, a timing label and help for every variable each kind takes", () => {
    for (const kind of ["appointment_reminder", "review_request"] as const) {
      expect(KIND_COPY[kind].title).toMatch(/\w/);
      for (const name of TEMPLATE_VARIABLES[kind]) expect(VARIABLE_HELP[name]).toMatch(/\w/);
    }
    expect(CHANNEL_LABELS).toEqual({ email: "Email", sms: "Text message" });
    expect(timingSentence("appointment_reminder", 24)).toBe("24 hours before the appointment");
    expect(timingSentence("review_request", 1)).toBe("1 hour after the appointment");
  });

  it("says a new revision un-approves sends until an owner approves it again", () => {
    expect(UNAPPROVES_WARNING).toMatch(/un-approves/);
    expect(UNAPPROVES_WARNING).toMatch(/until an owner approves/);
    expect(NEEDS_APPROVAL_NOTE).toMatch(/approv/);
    expect(ENABLE_NEEDS_REVIEW_LINK).toMatch(/review link/);
  });

  it("names a revision's approval: approved, waiting, ended or needed", () => {
    expect(revisionState(revision())).toEqual({ label: "Needs approval", tone: "warn" });
    const standing = { approvalId: USER, standing: "approved" as const, expiresAt: "2026-11-19T12:00:00.000Z", sends: 0 };
    expect(revisionState(revision({ standing, approved: true }))).toEqual({ label: "Approved", tone: "success" });
    expect(revisionState(revision({ standing: { ...standing, standing: "expired" } }))).toEqual({ label: "Approval ended", tone: "warn" });
    expect(revisionState(revision({ pendingApprovalId: USER }))).toEqual({ label: "Waiting for approval", tone: "warn" });
    expect(currentRevisionOf({ revisions: [revision({ revision: 2 }), revision({ current: false })] })?.revision).toBe(2);
    expect(currentRevisionOf({ revisions: [] })).toBeNull();
  });

  it("states the kind: off, on, or on but waiting for approved wording", () => {
    expect(kindState(kindStatus({ settings: { ...kindStatus().settings, enabled: false } }), revision())).toEqual({ label: "Off", tone: "neutral" });
    expect(kindState(kindStatus(), revision({ approved: true }))).toEqual({ label: "On", tone: "success" });
    expect(kindState(kindStatus(), revision())).toEqual({ label: "On, needs approval", tone: "warn" });
    expect(kindState(kindStatus(), null)).toEqual({ label: "On, needs approval", tone: "warn" });
    // Unknown wording (staff cannot read it): only the switches.
    expect(kindState(kindStatus(), undefined)).toEqual({ label: "On", tone: "success" });
    expect(kindState(kindStatus({ globalKilled: true, canRun: false, blockedBy: "global_killed" }), revision()).label).toBe("Paused by support");
  });

  it("words a run of a templated kind", () => {
    const run = { status: "completed" as const, stopReason: null, considered: 0, drafted: 0, skipped: 0 };
    expect(kindRunToast(run)).toBe("Run finished. Nothing to send right now.");
    expect(kindRunToast({ ...run, considered: 3, drafted: 2, skipped: 1 })).toBe("Run finished. Queued 2 messages, skipped 1.");
    expect(kindRunToast({ ...run, status: "stopped", stopReason: "disabled" })).toBe("It sent nothing: the agent was turned off.");
  });
});

describe("templated kinds: the wording form", () => {
  it("starts from the current revision, or from the kind's defaults", () => {
    expect(toTemplateForm("review_request", null)).toEqual({ channel: "email", subject: "", body: "", timingHours: "24" });
    expect(toTemplateForm("appointment_reminder", revision({ channel: "sms", subject: null, timingHours: 6 }))).toEqual({
      channel: "sms", subject: "", body: "Hi {customer_first_name}", timingHours: "6",
    });
  });

  it("builds the request with the revision it started from, and no subject for a text message", () => {
    expect(readTemplateForm("appointment_reminder", form(), 3)).toEqual({
      ok: true,
      request: { expectedRevision: 3, channel: "email", subject: "Your visit", body: "Hi {customer_first_name}, see you {booking_start_local}.", timingHours: 24 },
    });
    const sms = readTemplateForm("appointment_reminder", form({ channel: "sms", subject: "ignored" }), 0);
    expect(sms.ok && sms.request.subject).toBeNull();
  });

  it("finds placeholders that are not the kind's variables", () => {
    expect(unknownPlaceholders("appointment_reminder", "Hi {customer_first_name} {review_link}", "{nope}")).toEqual(["review_link", "nope"]);
    expect(unknownPlaceholders("review_request", "Hi {customer_first_name}, {review_link}")).toEqual([]);
  });

  it("refuses an unknown placeholder with a clear message before anything is sent", () => {
    const read = readTemplateForm("appointment_reminder", form({ body: "Hi {first_name}, leave a review at {review_link}" }), 1);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.errors.body).toBe(
      "{first_name} and {review_link} are not variables for appointment reminders. Use only {booking_link}, {booking_start_local}, {business_name} and {customer_first_name}.");
    const subject = readTemplateForm("review_request", form({ subject: "Thanks {name}", body: "{review_link}" }), 1);
    expect(!subject.ok && subject.errors.subject).toMatch(/^\{name\} is not a variable for review requests\./);
  });

  it("names an empty subject or message, a timing out of range and a message too long once filled in", () => {
    const read = readTemplateForm("appointment_reminder", form({ subject: " ", body: "", timingHours: "169" }), 1);
    expect(!read.ok && read.errors).toEqual({
      subject: "Add a subject for the email.",
      body: "Write the message.",
      timingHours: "A whole number of hours from 1 to 168.",
    });
    expect(readTemplateForm("review_request", form({ timingHours: "720", body: "{review_link}" }), 1).ok).toBe(true);
    expect(readTemplateForm("review_request", form({ timingHours: "1.5", body: "{review_link}" }), 1).ok).toBe(false);
    // 1,530 characters fit a text message; with a 500-character link filled in, this does not.
    const long = readTemplateForm("appointment_reminder", form({ channel: "sms", body: `${"x".repeat(1100)} {booking_link}` }), 1);
    expect(!long.ok && long.errors.body).toBe("The message is too long once its variables are filled in. Shorten it.");
  });

  it("takes an https review link, or none", () => {
    expect(readReviewLink("https://g.page/r/halden/review")).toEqual({ ok: true, reviewUrl: "https://g.page/r/halden/review" });
    expect(readReviewLink("  ")).toEqual({ ok: true, reviewUrl: undefined });
    expect(readReviewLink("http://example.com")).toEqual({ ok: false, message: "Enter a full link that starts with https://." });
    expect(readReviewLink("not a link").ok).toBe(false);
  });
});
