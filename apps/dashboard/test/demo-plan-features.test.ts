// The demo plan page reads its feature switches from the demo agents with the rules the API uses (plans.md PL-26):
// the gate's first stop reason and the template approval, ordered by `planFeatureSwitch`. The demo has no runners, so
// none is ever "not running"; text back is off because the demo has no voice number.
import { describe, expect, it } from "vitest";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";

// Wednesday 2026-10-21, 15:00 in New York: outside the default quiet hours.
const NOW = new Date("2026-10-21T19:00:00.000Z");
let ids = 0;
let keys = 0;
const key = () => ({ idempotencyKey: `plan-key-${++keys}` });
const adapter = (now = NOW) => createDemoAdapter({ clock: { now: () => now }, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}` });
const states = async (api: ReturnType<typeof adapter>) =>
  Object.fromEntries((await api.getBillingPlan()).features!.map((feature) => [feature.kind, feature.offReason ?? feature.state]));
const settings = async (api: ReturnType<typeof adapter>, kind: "appointment_reminder" | "review_request") => {
  const status = await api.getAgentKindStatus(kind);
  return { ...status.settings, expectedRevision: status.revision };
};

describe("demo plan features", () => {
  it("shows a message kind as off until its agent is on, and as waiting for approval until its wording is approved", async () => {
    const api = adapter();
    // The demo's follow-up agent starts on; the two message kinds start off.
    expect(await states(api)).toEqual({ appointment_reminder: "disabled", review_request: "disabled", inquiry_followup: "included" });

    await api.updateAgentKindSettings("appointment_reminder", { ...(await settings(api, "appointment_reminder")), enabled: true }, key());
    // On, but with no wording nobody approved: a run would stop at `template_not_approved`.
    expect(await states(api)).toMatchObject({ appointment_reminder: "not_approved" });

    const state = await api.createTemplateRevision("appointment_reminder", {
      expectedRevision: 0, channel: "email", subject: "See you soon at {business_name}",
      body: "Hi {customer_first_name}, your appointment is {booking_start_local}. Change it at {booking_link}.", timingHours: 24,
    }, key());
    expect(await states(api)).toMatchObject({ appointment_reminder: "not_approved" });
    await api.approveTemplate("appointment_reminder", { revision: 1, contentDigest: state.revisions[0]!.contentDigest }, key());
    expect(await states(api)).toMatchObject({ appointment_reminder: "included", review_request: "disabled" });

    // A new revision ends the approval, so the line goes back to waiting.
    await api.createTemplateRevision("appointment_reminder", {
      expectedRevision: 1, channel: "email", subject: "See you soon at {business_name}", body: "Hi {customer_first_name}, see you {booking_start_local}: {booking_link}", timingHours: 6,
    }, key());
    expect(await states(api)).toMatchObject({ appointment_reminder: "not_approved" });
  });

  it("follows support's pause and the quiet hours, as the runners' gate does", async () => {
    const api = adapter();
    const followUp = await api.getFollowUpStatus();
    await api.updateFollowUpSettings({ ...followUp.settings, enabled: true, expectedRevision: followUp.revision }, key());
    expect(await states(api)).toMatchObject({ inquiry_followup: "included" });
    api.setGlobalAgentKill(true);
    expect(Object.values(await states(api)).every((state) => state === "paused")).toBe(true);
    api.setGlobalAgentKill(false);
    // Quiet hours are open at 03:00 New York time.
    const night = adapter(new Date("2026-10-21T07:00:00.000Z"));
    const status = await night.getFollowUpStatus();
    await night.updateFollowUpSettings({ ...status.settings, enabled: true, expectedRevision: status.revision }, key());
    expect(await states(night)).toMatchObject({ inquiry_followup: "quiet_hours" });
  });

  it("lets a zero AI budget leave a message kind on: it makes no model call (agents.md G-15)", async () => {
    const api = adapter();
    const followUp = await api.getFollowUpStatus();
    await api.updateFollowUpSettings({ ...followUp.settings, enabled: true, expectedRevision: followUp.revision }, key());
    const reminder = await settings(api, "appointment_reminder");
    await api.updateAgentKindSettings("appointment_reminder", { ...reminder, enabled: true }, key());
    const state = await api.createTemplateRevision("appointment_reminder", {
      expectedRevision: 0, channel: "email", subject: "See you soon at {business_name}",
      body: "Hi {customer_first_name}, your appointment is {booking_start_local}. Change it at {booking_link}.", timingHours: 24,
    }, key());
    await api.approveTemplate("appointment_reminder", { revision: 1, contentDigest: state.revisions[0]!.contentDigest }, key());
    expect(await states(api)).toMatchObject({ inquiry_followup: "included", appointment_reminder: "included" });

    // The demo's follow-up has a fixed cap; a message kind's budget is its own setting.
    const current = await settings(api, "appointment_reminder");
    await api.updateAgentKindSettings("appointment_reminder", { ...current, maxCostMicrosPerDay: 0 }, key());
    expect(await states(api)).toMatchObject({ inquiry_followup: "included", appointment_reminder: "included" });
  });

  it("keeps missed-call text back off: the demo has no voice number", async () => {
    const plan = await adapter().getBillingPlan();
    expect(plan.features!.some((feature) => feature.kind === "missed_call_textback")).toBe(false);
  });
});
