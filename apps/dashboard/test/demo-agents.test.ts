// The demo adapter's follow-up agent keeps the API's rules (agents.md G-2..G-11): owners change
// settings, resume and run it; staff may read and stop it; saves are compare-and-set on the
// revision; a run drafts only what an owner then approves in the Inbox.
import { describe, expect, it } from "vitest";
import { followUpRunDetailSchema, followUpRunPageSchema, followUpStatusSchema } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { isSettingsChanged } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { DEMO_AGENT_ACTOR_ID, DEMO_FOLLOW_UP_SUBJECT, DEMO_OWNER, DEMO_STAFF } from "../src/lib/api/demo/seed";

// Sunday 2026-10-18, 09:00 in New York: outside the default quiet hours (21:00 to 08:00).
const NOW = new Date("2026-10-18T13:00:00.000Z");

function adapter(now = NOW) {
  let ids = 0;
  let clock = now;
  const api = createDemoAdapter({
    clock: { now: () => clock },
    newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`,
  });
  return Object.assign(api, { setNow: (next: Date) => { clock = next; } });
}

let keys = 0;
const key = () => ({ idempotencyKey: `agent-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);
const settingsOf = async (api: ReturnType<typeof adapter>) => {
  const status = await api.getFollowUpStatus();
  return { ...status.settings, expectedRevision: status.revision };
};

describe("demo adapter: follow-up agent", () => {
  it("reads the seeded status in contract shape: on, able to draft, in the business's zone", async () => {
    const status = followUpStatusSchema.parse(await adapter().getFollowUpStatus());
    expect(status).toMatchObject({ revision: 2, killed: null, globalKilled: false, canDraft: true, blockedBy: null });
    expect(status.settings).toMatchObject({ enabled: true, timeZone: "America/New_York", quietStartMinute: 1260, quietEndMinute: 480 });
  });

  it("names the first reason it cannot draft, in the API's order", async () => {
    const api = adapter(new Date("2026-10-19T06:00:00.000Z")); // 02:00 in New York
    expect((await api.getFollowUpStatus()).blockedBy).toBe("quiet_hours");
    await api.killFollowUp({}, key());
    expect((await api.getFollowUpStatus()).blockedBy).toBe("tenant_killed");
    await api.updateFollowUpSettings({ ...(await settingsOf(api)), enabled: false }, key());
    expect((await api.getFollowUpStatus()).blockedBy).toBe("disabled");
    api.setGlobalAgentKill(true);
    expect(await api.getFollowUpStatus()).toMatchObject({ globalKilled: true, canDraft: false, blockedBy: "global_killed" });
  });

  it("lists seeded runs newest first by cursor, each with its decisions", async () => {
    const api = adapter();
    const first = await api.listFollowUpRuns({ limit: 2 });
    followUpRunPageSchema.parse({ ...first, limit: 2, offset: 0, nextOffset: null });
    expect(first.items.map((run) => run.status)).toEqual(["completed", "stopped"]);
    expect(first.items[1]).toMatchObject({ stopReason: "tenant_killed", considered: 0 });
    const rest = await api.listFollowUpRuns({ cursor: first.nextCursor! });
    expect(rest.nextCursor).toBeNull();
    expect(rest.items).toHaveLength(1);
    const last = followUpRunDetailSchema.parse(await api.getFollowUpRun(rest.items[0]!.id));
    expect(last.decisions.map((decision) => decision.outcome)).toEqual(["drafted"]);
    const newest = await api.getFollowUpRun(first.items[0]!.id);
    expect(newest.decisions.map((decision) => decision.reason)).toEqual(["answered", "answered"]);
    expect(await failure(api.getFollowUpRun("00000000-0000-4000-8000-999999999999"))).toMatchObject({ kind: "not_found" });
    expect(await failure(api.getFollowUpRun("../x"))).toMatchObject({ kind: "not_found" });
  });

  it("runs now as an owner: drafts the unanswered request into the Inbox as the agent, and never approves it", async () => {
    const api = adapter();
    const run = followUpRunDetailSchema.parse(await api.startFollowUpRun(key()));
    expect(run).toMatchObject({ status: "completed", requestedBy: DEMO_OWNER.userId, considered: 1, drafted: 1, skipped: 0 });
    const [decision] = run.decisions;
    const threads = await api.listThreads({ limit: 100 });
    const linnea = threads.items.find((thread) => thread.contactId === decision!.contactId)!;
    expect(linnea).toMatchObject({ name: "Linnea Castellanos", drafts: 1 });
    const reply = (await api.getThread(linnea.id)).entries.find((entry) => entry.type === "reply");
    expect(reply?.type === "reply" && reply.reply).toMatchObject({
      id: decision!.replyId, status: "draft", subject: DEMO_FOLLOW_UP_SUBJECT, draftedBy: { userId: DEMO_AGENT_ACTOR_ID, email: null }, approvedAt: null,
    });
    // One draft per request: the next run has nothing left to follow up.
    expect(await api.startFollowUpRun(key())).toMatchObject({ status: "completed", considered: 0 });
    expect((await api.listFollowUpRuns()).items[0]!.id).not.toBe(run.id);
  });

  it("stops a run before any draft when the agent may not draft, and at the daily cap", async () => {
    const api = adapter();
    await api.killFollowUp({ note: "Checking the wording" }, key());
    expect(await api.startFollowUpRun(key())).toMatchObject({ status: "stopped", stopReason: "tenant_killed", considered: 0, decisions: [] });
    await api.resumeFollowUp(key());
    await api.startFollowUpRun(key());
    await api.updateFollowUpSettings({ ...(await settingsOf(api)), maxDraftsPerDay: 1 }, key());
    expect((await api.getFollowUpStatus()).blockedBy).toBe("daily_cap");
    expect(await api.startFollowUpRun(key())).toMatchObject({ status: "stopped", stopReason: "daily_cap" });
  });

  it("lets staff read and stop the agent, but not resume, run or change it (403)", async () => {
    const api = adapter();
    api.actAs("staff");
    expect(api.currentActor()).toEqual({ role: "staff", userId: DEMO_STAFF.userId });
    const input = await settingsOf(api);
    expect(await failure(api.updateFollowUpSettings({ ...input, maxDraftsPerDay: 3 }, key()))).toMatchObject({ kind: "forbidden", status: 403 });
    expect(await failure(api.startFollowUpRun(key()))).toMatchObject({ kind: "forbidden" });
    const stopped = await api.killFollowUp({ note: "Wrong tone" }, key());
    expect(stopped).toMatchObject({ canDraft: false, blockedBy: "tenant_killed", killed: { by: DEMO_STAFF.userId, note: "Wrong tone" } });
    expect(await failure(api.resumeFollowUp(key()))).toMatchObject({ kind: "forbidden" });
    // A second stop keeps the first time and note.
    expect((await api.killFollowUp({ note: "Again" }, key())).killed).toEqual(stopped.killed);
    api.actAs("owner");
    expect(await api.resumeFollowUp(key())).toMatchObject({ killed: null, canDraft: true });
  });

  it("tells listeners when the demo acts as someone else", () => {
    const api = adapter();
    const seen: string[] = [];
    const off = api.onActorChange(() => seen.push(api.currentActor().role));
    api.actAs("staff");
    api.actAs("owner");
    off();
    api.actAs("staff");
    expect(seen).toEqual(["staff", "owner"]);
  });

  it("refuses a save from an older revision with stale_revision, and checks the body first", async () => {
    const api = adapter();
    const input = await settingsOf(api);
    api.editAgentSettingsElsewhere();
    const stale = await failure(api.updateFollowUpSettings({ ...input, waitHours: 48 }, key()));
    expect(isSettingsChanged(stale)).toBe(true);
    expect(stale).toMatchObject({ reason: "stale_revision", details: { currentRevision: 3 } });
    expect(await failure(api.updateFollowUpSettings({ ...input, maxDraftsPerDay: 0, expectedRevision: 3 }, key()))).toMatchObject({ kind: "validation", field: "maxDraftsPerDay" });
    // Saved again from the reloaded settings, the other owner's change stays.
    const saved = await api.updateFollowUpSettings({ ...(await settingsOf(api)), waitHours: 48 }, key());
    expect(saved).toMatchObject({ revision: 4, settings: { waitHours: 48, maxDraftsPerDay: 15 } });
  });

  it("replays a save for the same key and refuses the key for another body", async () => {
    const api = adapter();
    const input = await settingsOf(api);
    const once = key();
    const first = await api.updateFollowUpSettings({ ...input, lookbackDays: 30 }, once);
    expect(await api.updateFollowUpSettings({ ...input, lookbackDays: 30 }, once)).toEqual(first);
    expect(await failure(api.updateFollowUpSettings({ ...input, lookbackDays: 31 }, once))).toMatchObject({ reason: "idempotency_key_reused" });
    expect(api.writeLog().filter((write) => write.operation === "agent.settings.update").map((write) => write.outcome)).toEqual(["applied", "replayed", "rejected"]);
  });

  it("has no Run now without a model: a 404", async () => {
    const api = adapter();
    api.setFollowUpModel(false);
    expect(await failure(api.startFollowUpRun(key()))).toMatchObject({ kind: "not_found", status: 404 });
  });

  it("refuses an approval from staff, as the API does", async () => {
    const api = adapter();
    await api.startFollowUpRun(key());
    const draft = (await api.getFollowUpRun((await api.listFollowUpRuns()).items[0]!.id)).decisions[0]!;
    api.actAs("staff");
    expect(await failure(api.approveReply(draft.replyId!, key()))).toMatchObject({ kind: "forbidden" });
    api.actAs("owner");
    expect(await api.approveReply(draft.replyId!, key())).toMatchObject({ status: "approved", approvedBy: DEMO_OWNER });
  });
});
