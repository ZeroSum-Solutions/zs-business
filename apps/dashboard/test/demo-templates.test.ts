// The demo adapter's templated kinds keep the API's rules (agents.md G-14, G-19, G-20,
// approvals.md A-15): owners write and approve wording, placeholders are checked against the
// kind, a new revision ends the previous approval, and review requests need a review link.
import { describe, expect, it } from "vitest";
import {
  agentKindStatusSchema,
  approveApprovalResponseSchema,
  templateStateSchema,
  templateSuggestionSchema,
  type CreateTemplateRevisionRequest,
} from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { isSettingsChanged } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_OWNER } from "../src/lib/api/demo/seed";

// Wednesday 2026-10-21, 15:00 in New York: outside the default quiet hours.
const NOW = new Date("2026-10-21T19:00:00.000Z");

function adapter(now = NOW) {
  let ids = 0;
  return createDemoAdapter({ clock: { now: () => now }, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` });
}

let keys = 0;
const key = () => ({ idempotencyKey: `tpl-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
const wording = (patch: Partial<CreateTemplateRevisionRequest> = {}): CreateTemplateRevisionRequest => ({
  expectedRevision: 0, channel: "email", subject: "See you soon at {business_name}",
  body: "Hi {customer_first_name}, your appointment is {booking_start_local}. Change it at {booking_link}.", timingHours: 24, ...patch,
});
const settingsOf = async (api: ReturnType<typeof adapter>, kind: "appointment_reminder" | "review_request") => {
  const status = await api.getAgentKindStatus(kind);
  return { ...status.settings, expectedRevision: status.revision };
};

describe("demo adapter: message templates", () => {
  it("starts with no wording, the kind's variables and purpose", async () => {
    const api = adapter();
    const reminder = templateStateSchema.parse(await api.getTemplate("appointment_reminder"));
    expect(reminder).toMatchObject({ agentKind: "appointment_reminder", purpose: "transactional", currentRevision: 0, revisions: [] });
    expect(reminder.variables).toEqual(["booking_link", "booking_start_local", "business_name", "customer_first_name"]);
    const review = await api.getTemplate("review_request");
    expect(review).toMatchObject({ purpose: "marketing", variables: ["booking_start_local", "business_name", "customer_first_name", "review_link"] });
    expect(review.templateId).not.toBe(reminder.templateId);
  });

  it("writes a revision that is current and unapproved, with its variables and a digest", async () => {
    const api = adapter();
    const state = templateStateSchema.parse(await api.createTemplateRevision("appointment_reminder", wording(), key()));
    expect(state.currentRevision).toBe(1);
    expect(state.revisions[0]).toMatchObject({
      revision: 1, current: true, approved: false, standing: null, purpose: "transactional", createdBy: DEMO_OWNER.userId,
      variables: ["booking_link", "booking_start_local", "business_name", "customer_first_name"],
    });
    expect(state.revisions[0]!.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await api.getTemplate("appointment_reminder")).toEqual(state);
  });

  it("refuses a placeholder outside the kind's variables, an email without a subject and a stale revision", async () => {
    const api = adapter();
    expect(await failure(api.createTemplateRevision("appointment_reminder", wording({ body: "Review us at {review_link}" }), key())))
      .toMatchObject({ kind: "validation", status: 400 });
    expect(await failure(api.createTemplateRevision("appointment_reminder", wording({ subject: null }), key()))).toMatchObject({ kind: "validation" });
    expect(await failure(api.createTemplateRevision("appointment_reminder", wording({ timingHours: 169 }), key()))).toMatchObject({ kind: "validation" });
    await api.createTemplateRevision("appointment_reminder", wording(), key());
    const stale = await failure(api.createTemplateRevision("appointment_reminder", wording({ body: "Hi {customer_first_name}" }), key()));
    expect(stale).toMatchObject({ kind: "conflict", reason: "stale_revision", details: { currentRevision: 1 } });
    expect((await api.getTemplate("appointment_reminder")).currentRevision).toBe(1);
  });

  it("approves the current revision by its digest, and a new revision ends that approval (A-15)", async () => {
    const api = adapter();
    const first = (await api.createTemplateRevision("appointment_reminder", wording(), key())).revisions[0]!;
    const answer = approveApprovalResponseSchema.parse(
      await api.approveTemplate("appointment_reminder", { revision: 1, contentDigest: first.contentDigest }, key()));
    expect(answer.approval.result).toMatchObject({ status: "approved", actionType: "template.standing.grant", decidedBy: DEMO_OWNER.userId });
    const approved = (await api.getTemplate("appointment_reminder")).revisions[0]!;
    expect(approved).toMatchObject({ approved: true, standing: { standing: "approved", sends: 0, expiresAt: "2026-11-20T19:00:00.000Z" } });

    const next = await api.createTemplateRevision("appointment_reminder", wording({ expectedRevision: 1, timingHours: 6 }), key());
    expect(next.revisions.map((item) => [item.revision, item.current, item.approved, item.standing?.standing ?? null])).toEqual([
      [2, true, false, null], [1, false, false, "revoked"],
    ]);
    expect(next.revisions[0]!.contentDigest).not.toBe(first.contentDigest);
    // The old revision's digest no longer approves anything.
    expect(await failure(api.approveTemplate("appointment_reminder", { revision: 1, contentDigest: first.contentDigest }, key())))
      .toMatchObject({ kind: "conflict", reason: "template_superseded" });
    expect(await failure(api.approveTemplate("appointment_reminder", { revision: 2, contentDigest: first.contentDigest }, key())))
      .toMatchObject({ kind: "conflict", reason: "template_changed" });
    expect(await failure(api.approveTemplate("appointment_reminder", { revision: 9, contentDigest: first.contentDigest }, key())))
      .toMatchObject({ kind: "not_found" });
  });

  it("is deterministic: the same wording has the same digest in another session", async () => {
    const one = (await adapter().createTemplateRevision("review_request", wording({ body: "Thanks {customer_first_name}: {review_link}" }), key())).revisions[0]!;
    const two = (await adapter().createTemplateRevision("review_request", wording({ body: "Thanks {customer_first_name}: {review_link}" }), key())).revisions[0]!;
    expect(two.contentDigest).toBe(one.contentDigest);
    expect(two.id).toBe(one.id);
  });

  it("replays a write for the same key and refuses the key for another body", async () => {
    const api = adapter();
    const once = key();
    const first = await api.createTemplateRevision("appointment_reminder", wording(), once);
    expect(await api.createTemplateRevision("appointment_reminder", wording(), once)).toEqual(first);
    expect(await failure(api.createTemplateRevision("appointment_reminder", wording({ timingHours: 2 }), once))).toMatchObject({ reason: "idempotency_key_reused" });
    expect(api.writeLog().filter((write) => write.operation === "template.revision.create").map((write) => write.outcome)).toEqual(["applied", "replayed", "rejected"]);
  });

  it("is owners only: staff cannot read, write or approve the wording (403)", async () => {
    const api = adapter();
    const first = (await api.createTemplateRevision("appointment_reminder", wording(), key())).revisions[0]!;
    api.actAs("staff");
    expect(await failure(api.getTemplate("appointment_reminder"))).toMatchObject({ kind: "forbidden", status: 403 });
    expect(await failure(api.createTemplateRevision("appointment_reminder", wording({ expectedRevision: 1 }), key()))).toMatchObject({ kind: "forbidden" });
    expect(await failure(api.approveTemplate("appointment_reminder", { revision: 1, contentDigest: first.contentDigest }, key()))).toMatchObject({ kind: "forbidden" });
    // Staff still read the kind's switches.
    expect(agentKindStatusSchema.parse(await api.getAgentKindStatus("appointment_reminder")).settings.enabled).toBe(false);
  });

  it("suggests wording that uses only the kind's variables, and is a 404 without a suggestion model", async () => {
    const api = adapter();
    const email = templateSuggestionSchema.parse(await api.suggestTemplate("review_request", { channel: "email" }, key()));
    expect(email.subject).toMatch(/\w/);
    expect(email.variables.every((name) => ["booking_start_local", "business_name", "customer_first_name", "review_link"].includes(name))).toBe(true);
    expect((await api.suggestTemplate("appointment_reminder", { channel: "sms" }, key())).subject).toBeNull();
    api.setTemplateSuggestions(false);
    expect(await failure(api.suggestTemplate("review_request", { channel: "email" }, key()))).toMatchObject({ kind: "not_found", status: 404 });
  });
});

describe("demo adapter: templated kinds' settings", () => {
  it("reads each kind off by default, in the business's zone", async () => {
    const status = agentKindStatusSchema.parse(await adapter().getAgentKindStatus("review_request"));
    expect(status).toMatchObject({ agentKind: "review_request", revision: 0, canRun: false, blockedBy: "disabled" });
    expect(status.settings).toMatchObject({ enabled: false, timeZone: "America/New_York", config: { timingHours: 24, maxSendsPerDay: 20 } });
  });

  it("turns a reminder on with the revision it read, and refuses a stale one", async () => {
    const api = adapter();
    const input = await settingsOf(api, "appointment_reminder");
    const on = await api.updateAgentKindSettings("appointment_reminder", { ...input, enabled: true }, key());
    expect(on).toMatchObject({ revision: 1, canRun: true, blockedBy: null, settings: { enabled: true } });
    const stale = await failure(api.updateAgentKindSettings("appointment_reminder", { ...input, enabled: false }, key()));
    expect(isSettingsChanged(stale)).toBe(true);
  });

  it("refuses to turn review requests on without a review link, like the API (ValidationFailed)", async () => {
    const api = adapter();
    const input = await settingsOf(api, "review_request");
    expect(await failure(api.updateAgentKindSettings("review_request", { ...input, enabled: true }, key()))).toMatchObject({ kind: "validation", status: 400 });
    expect(await failure(api.updateAgentKindSettings("review_request", { ...input, config: { ...input.config, reviewUrl: "http://x.example" } }, key())))
      .toMatchObject({ kind: "validation" });
    const linked = await api.updateAgentKindSettings("review_request", { ...input, config: { ...input.config, reviewUrl: "https://g.page/r/halden/review" } }, key());
    const on = await api.updateAgentKindSettings("review_request", { ...linked.settings, expectedRevision: linked.revision, enabled: true }, key());
    expect(on).toMatchObject({ revision: 2, settings: { enabled: true, config: { reviewUrl: "https://g.page/r/halden/review" } } });
  });

  it("staff cannot change a kind's settings or run it", async () => {
    const api = adapter();
    const input = await settingsOf(api, "appointment_reminder");
    api.actAs("staff");
    expect(await failure(api.updateAgentKindSettings("appointment_reminder", { ...input, enabled: true }, key()))).toMatchObject({ kind: "forbidden" });
    expect(await failure(api.startKindRun("appointment_reminder", key()))).toMatchObject({ kind: "forbidden" });
  });

  it("a run reports why it stopped while the kind is off, and finishes once it is on", async () => {
    const api = adapter();
    expect(await api.startKindRun("appointment_reminder", key())).toMatchObject({ agent: "appointment_reminder", status: "stopped", stopReason: "disabled", decisions: [] });
    await api.updateAgentKindSettings("appointment_reminder", { ...(await settingsOf(api, "appointment_reminder")), enabled: true }, key());
    expect(await api.startKindRun("appointment_reminder", key())).toMatchObject({ status: "completed", stopReason: null, requestedBy: DEMO_OWNER.userId });
    api.setGlobalAgentKill(true);
    expect(await api.getAgentKindStatus("appointment_reminder")).toMatchObject({ globalKilled: true, canRun: false, blockedBy: "global_killed" });
  });
});
