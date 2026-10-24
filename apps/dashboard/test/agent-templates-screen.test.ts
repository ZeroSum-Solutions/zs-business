// The Agents page's templated kinds (agents.md G-19, G-20, approvals.md A-15), server-rendered
// with the query cache filled, as the page first paints: the current wording and its approval,
// Approve for an owner, the wording form with the kind's variables, and the on/off switch.
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_FOLLOW_UP_SETTINGS, defaultAgentKindSettings, TEMPLATE_VARIABLES, type AgentKindStatus, type TemplateRevision, type TemplateState, type TemplatedKind } from "@zs/contracts";
import { AgentsView } from "../src/components/agents/agents-view";
import { NEEDS_APPROVAL_NOTE, UNAPPROVES_WARNING } from "../src/lib/agents";
import { keys, renderScreen } from "./helpers/render";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
  usePathname: () => "/agents",
  useSearchParams: () => new URLSearchParams(),
}));

const USER = "9a1b3c5d-7e9f-4a1b-8c2d-000000000001";
const status = (kind: TemplatedKind, patch: Partial<AgentKindStatus> = {}): AgentKindStatus => ({
  agentKind: kind, settings: { ...defaultAgentKindSettings(kind), timeZone: "America/New_York" },
  revision: 0, updatedAt: null, killed: null, globalKilled: false, canRun: false, blockedBy: "disabled",
  costSpentMicros: 0, costCapMicros: 1_000_000, costWarning: false, ...patch,
});
const revision = (patch: Partial<TemplateRevision> = {}): TemplateRevision => ({
  id: "00000000-0000-4000-8000-000000000101", revision: 2, channel: "email", purpose: "transactional",
  subject: "See you soon at {business_name}", body: "Hi {customer_first_name}, see you {booking_start_local}.",
  variables: ["booking_start_local", "business_name", "customer_first_name"], timingHours: 24,
  contentDigest: "a".repeat(64), createdBy: USER, createdAt: "2026-10-20T12:00:00.000Z", current: true,
  standing: null, pendingApprovalId: null, approved: false, ...patch,
});
const template = (kind: TemplatedKind, revisions: TemplateRevision[]): TemplateState => ({
  agentKind: kind, templateId: "00000000-0000-4000-8000-0000000000a1", purpose: kind === "review_request" ? "marketing" : "transactional",
  variables: [...TEMPLATE_VARIABLES[kind]], currentRevision: revisions.find((item) => item.current)?.revision ?? 0, revisions,
});
const followUp = {
  settings: { ...DEFAULT_FOLLOW_UP_SETTINGS, enabled: true, timeZone: "America/New_York" }, revision: 1, updatedAt: null, killed: null,
  globalKilled: false, canDraft: true, blockedBy: null, costSpentMicros: 0, costCapMicros: 1_000_000, costWarning: false,
};

function renderAgents(reminder: TemplateRevision[], options: { staff?: boolean; reminderStatus?: AgentKindStatus } = {}) {
  const html = renderScreen(h(AgentsView), {
    staff: options.staff ?? false,
    fill: (client) => {
      client.setQueryData(keys.followUp, followUp);
      client.setQueryData(keys.agentKind("appointment_reminder"), options.reminderStatus ?? status("appointment_reminder"));
      client.setQueryData(keys.agentKind("review_request"), status("review_request"));
      client.setQueryData(keys.template("appointment_reminder"), template("appointment_reminder", reminder));
      client.setQueryData(keys.template("review_request"), template("review_request", []));
    },
  }).replaceAll("<!-- -->", "");
  return { reminder: cardOf(html, "appointment_reminder"), review: cardOf(html, "review_request") };
}
/** One kind's card: from its section to the section's end. */
function cardOf(html: string, kind: TemplatedKind): string {
  const start = html.indexOf(`data-testid="kind-${kind}"`);
  expect(start, `${kind} card`).toBeGreaterThan(-1);
  return html.slice(start, html.indexOf("</section>", start));
}
const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replaceAll("&amp;", "&").replace(/\s+/g, " ");
const button = (html: string, label: string) => html.match(new RegExp(`<button([^>]*)>(?:(?!</button>).)*?${label}`))?.[1] ?? null;

describe("agents screen: templated kinds", () => {
  it("with no wording yet, opens the form with only the kind's variables", () => {
    const { reminder, review } = renderAgents([]);
    expect(textOf(reminder)).toContain("Appointment reminders");
    expect(textOf(reminder)).toContain("No wording yet.");
    expect(reminder).toContain("Save new wording");
    for (const name of TEMPLATE_VARIABLES.appointment_reminder) expect(reminder).toContain(`{${name}}`);
    expect(reminder).not.toContain("{review_link}");
    expect(review).toContain("{review_link}");
    expect(review).not.toContain("{booking_link}");
    expect(textOf(reminder)).toContain(NEEDS_APPROVAL_NOTE);
    expect(reminder).toMatch(/<label[^>]*for="reminder-body"[^>]*>Message<\/label>/);
    expect(reminder).toMatch(/<label[^>]*for="reminder-timing"[^>]*>Hours before the appointment<\/label>/);
  });

  it("shows an unapproved current revision with Approve for the owner", () => {
    const { reminder } = renderAgents([revision()]);
    const text = textOf(reminder);
    expect(reminder).toMatch(/data-testid="reminder-approval"[^>]*>Needs approval</);
    expect(text).toContain("See you soon at {business_name}");
    expect(text).toContain("Hi {customer_first_name}, see you {booking_start_local}.");
    expect(text).toContain("24 hours before the appointment");
    expect(text).toContain("Revision 2");
    expect(button(reminder, "Approve this wording")).not.toMatch(/disabled=""/);
    // The form waits behind its button, which says a new revision needs approval.
    expect(button(reminder, "Write new wording")).toMatch(/aria-expanded="false"/);
    expect(reminder).not.toContain("Save new wording");
  });

  it("an approved revision has no Approve, and writing new wording says it un-approves sends", () => {
    const standing = { approvalId: USER, standing: "approved" as const, expiresAt: "2026-11-19T12:00:00.000Z", sends: 3 };
    const { reminder } = renderAgents([revision({ approved: true, standing })], {
      reminderStatus: status("appointment_reminder", { settings: { ...status("appointment_reminder").settings, enabled: true }, revision: 1, canRun: true, blockedBy: null }),
    });
    expect(reminder).toMatch(/data-testid="reminder-approval"[^>]*>Approved</);
    expect(reminder).toMatch(/data-testid="reminder-state"[^>]*>On</);
    expect(button(reminder, "Approve this wording")).toBeNull();
    expect(textOf(reminder)).toContain(UNAPPROVES_WARNING);
    expect(textOf(reminder)).toMatch(/Approved until .*Used for 3 messages so far\./);
  });

  it("on with unapproved wording, the state says it waits for approval", () => {
    const { reminder } = renderAgents([revision()], {
      reminderStatus: status("appointment_reminder", { settings: { ...status("appointment_reminder").settings, enabled: true }, revision: 1, canRun: true, blockedBy: null }),
    });
    expect(reminder).toMatch(/data-testid="reminder-state"[^>]*>On, needs approval</);
    expect(textOf(reminder)).toContain("Nothing is sent until an owner approves the wording.");
  });

  it("offers the on/off switch, and a review link for review requests", () => {
    const { reminder, review } = renderAgents([]);
    expect(reminder).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*id="reminder-enabled"/);
    expect(review).toMatch(/<label[^>]*for="review-link"[^>]*>Review link<\/label>/);
    expect(review).toContain('type="url"');
    expect(reminder).not.toContain('id="review-link"');
  });

  it("staff see the switch off-limits and no wording, since only owners read it", () => {
    const { reminder } = renderAgents([revision()], { staff: true });
    const text = textOf(reminder);
    expect(text).toContain("Only an owner can see and change this wording.");
    expect(text).toContain("Only an owner can turn this on or off.");
    expect(reminder).toMatch(/<button[^>]*role="switch"[^>]*disabled=""/);
    expect(reminder).not.toContain("Approve this wording");
    expect(reminder).not.toContain("Hi {customer_first_name}, see you");
  });
});
