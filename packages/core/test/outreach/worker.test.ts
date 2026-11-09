// outreach-sequencer.md OS-1, OS-10, OS-12..OS-16, OS-18 (worker side), OS-19, OS-20 against a real local Postgres and
// FakeGmail. Nothing here can reach Google: the only Gmail is FakeGmail and the setup file's fetch guard fails any
// real request.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOutreachWorker,
  createUnsubscribeSession,
  FakeGmail,
  HARD_SUPPRESSED_COMPANIES,
  parseSealPrivateKey,
  type OutreachReport,
  type OutreachRunCounts,
  type OutreachWorkerConfig,
} from "../../src/index.js";
import { campaignBody, createWorld, DAY, MINUTE, MONDAY_0700_LA, prospect, type World } from "./harness.js";

const SECRET = "outreach-worker-test-secret-0123456789";
const ADDR = "devin@zerosum-solutions.com";
const OTHER = "devin.wiggins@zerosum-solutions.com";
/** Monday 08:30 PST: inside the usual 08:00..10:30 window. */
const OPEN = MONDAY_0700_LA + 90 * MINUTE;
/** Monday 08:00 PST: the window opens. */
const WINDOW_START = MONDAY_0700_LA + 60 * MINUTE;
/** Thursday 08:30 PST: step 2 (three business days after Monday) is due. */
const THURSDAY = Date.parse("2026-11-12T16:30:00.000Z");

let world: World;
let privateKey: ReturnType<typeof parseSealPrivateKey>;
const events: OutreachReport[] = [];

beforeAll(async () => {
  world = await createWorld();
  privateKey = parseSealPrivateKey(world.seal.privateKey);
});
afterAll(async () => { await world?.close(); });
beforeEach(() => { world.time.ms = OPEN; events.length = 0; });

interface Rig {
  readonly tenant: string;
  readonly ownerId: string;
  readonly mailboxes: string[];
  readonly campaignId: string;
  readonly fake: FakeGmail;
  readonly session: ReturnType<World["owner"]>;
  worker(overrides?: Partial<OutreachWorkerConfig>, extra?: { clock?: { now(): Date } }): ReturnType<typeof createOutreachWorker>;
  run(overrides?: Partial<OutreachWorkerConfig>): Promise<OutreachRunCounts>;
  prospects(): Promise<Array<{ id: string; email: string; status: string; next_step: number | null; due: string | null; thread_id: string | null }>>;
  status(email: string): Promise<string>;
  sends(): Promise<Array<{ id: string; prospect_id: string; step_number: number; status: string; error_code: string | null; rfc_message_id: string | null; gmail_message_id: string | null; local_send_date: string }>>;
  campaign(): Promise<{ status: string; paused_reason: string | null; activation_approval_id: string }>;
  /** A send row written straight into the table, for the states a test needs to start from. */
  seed(prospectId: string, step: number, status: string, change?: { date?: string; at?: Date; message?: string | null; history?: string | null; thread?: string }): Promise<string>;
}

async function rig(options: { count?: number; addresses?: string[]; dailyLimit?: number; campaign?: Record<string, unknown>; activate?: boolean } = {}): Promise<Rig> {
  const addresses = options.addresses ?? [ADDR];
  const tenant = await world.tenant("Outreach tenant");
  const ownerId = await world.member(tenant, "owner");
  const fake = new FakeGmail(world.clock);
  const mailboxes: string[] = [];
  for (const address of addresses) {
    mailboxes.push(await world.mailbox(tenant, address, { ...(options.dailyLimit === undefined ? {} : { dailyLimit: options.dailyLimit }) }));
    fake.addMailbox(address);
  }
  const session = world.owner(tenant, ownerId, [tenant]);
  const created = (await session.createCampaign(campaignBody(mailboxes, { dailyCapPerMailbox: 50, ...options.campaign }), randomUUID())).result;
  const count = options.count ?? 1;
  if (count > 0) await session.importProspects(created.id, { prospects: Array.from({ length: count }, (_, i) => prospect(i + 1)) }, randomUUID());
  if (options.activate !== false && count > 0) {
    const { approvalId } = await session.requestActivation(created.id, randomUUID());
    await world.member_session(tenant, ownerId, [tenant]).approveApproval(approvalId, {}, randomUUID());
  }
  const make: Rig["worker"] = (overrides = {}, extra = {}) => createOutreachWorker({
    service: world.fixture.service, db: world.database.db, gmail: fake, oauth: fake.oauth, clock: extra.clock ?? world.clock, generateId: randomUUID,
    report: (event) => { events.push(event); },
    config: {
      privateKey, tenants: [tenant], sendEnabled: true, minGapMs: 0, probeDelayMs: 0,
      unsubscribeBaseUrl: "https://hub.example/u", unsubscribeSecret: SECRET, ...overrides,
    },
  });
  return {
    tenant, ownerId, mailboxes, campaignId: created.id, fake, session,
    worker: make,
    run: (overrides) => make(overrides).runOnce(),
    prospects: () => world.rows(
      "SELECT id, email, status, next_step, to_char(next_due_on,'YYYY-MM-DD') AS due, thread_id FROM outreach_prospects WHERE tenant_id=$1 ORDER BY email", [tenant]),
    async status(email) {
      return (await world.rows<{ status: string }>("SELECT status FROM outreach_prospects WHERE tenant_id=$1 AND email=$2", [tenant, email]))[0]!.status;
    },
    sends: () => world.rows(
      `SELECT id, prospect_id, step_number, status, error_code, rfc_message_id, gmail_message_id, to_char(local_send_date,'YYYY-MM-DD') AS local_send_date
         FROM outreach_sends WHERE tenant_id=$1 ORDER BY attempt_started_at, step_number, id`, [tenant]),
    async campaign() {
      return (await world.rows<any>("SELECT status, paused_reason, activation_approval_id FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2", [tenant, created.id]))[0];
    },
    async seed(prospectId, step, status, change = {}) {
      const id = randomUUID();
      await world.rows(
        `INSERT INTO outreach_sends (tenant_id,id,campaign_id,prospect_id,mailbox_id,step_number,status,recipient_address,subject,body,local_send_date,
            attempt_started_at,history_id_before,gmail_message_id,gmail_thread_id,settled_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'seed@seed.example','Seed','Seed body',$8::date,$9,$10,$11,$12,$9,$9,$9)`,
        [tenant, id, created.id, prospectId, mailboxes[0], step, status, change.date ?? "2026-11-09", change.at ?? new Date(world.time.ms),
          change.history ?? null, status === "sent" ? (change.message === undefined ? `seed-${id}` : change.message) : null,
          status === "sent" ? change.thread ?? `seed-thread-${id}` : null]);
      return id;
    },
  };
}

const prospectEmail = (n: number) => prospect(n).email;
const sentCount = (r: Rig) => r.fake.sent.length;

describe("access and the send switch (OS-1, OS-10)", () => {
  it("makes no Gmail call for a tenant that is not on the worker's allowlist", async () => {
    const r = await rig();
    const counts = await r.run({ tenants: [randomUUID()] });
    expect(r.fake.calls).toEqual([]);
    expect(counts.mailboxes).toBe(0);
    expect(await r.sends()).toEqual([]);
  });

  it("polls but never sends while sendEnabled is false, and sends once when it is true", async () => {
    const r = await rig();
    await r.run({ sendEnabled: false });
    expect(r.fake.sendCalls()).toBe(0);
    expect(r.fake.calls.some((call) => call.op === "profile" || call.op === "history")).toBe(true);
    expect(await r.sends()).toEqual([]);
    await r.run({ sendEnabled: true });
    expect(r.fake.sendCalls()).toBe(1);
    expect(sentCount(r)).toBe(1);
  });

  it("sends the contract message: footer, unsubscribe link, headers and a send id the probe can find", async () => {
    const r = await rig();
    await r.run();
    const [message] = r.fake.sent;
    const [row] = await r.sends();
    expect(message).toMatchObject({ mailbox: ADDR, to: prospectEmail(1), subject: "Quick idea for Acme 1" });
    expect(message!.body).toContain("Hi Pat1, I help Plumbing teams.");
    expect(message!.body).toContain("Zero Sum Solutions LLC");
    expect(message!.body).toContain("1 Market St");
    expect(message!.body).toMatch(/To stop these emails: https:\/\/hub\.example\/u\/zsu1_[A-Za-z0-9_-]+/);
    expect(message!.headers["x-zs-ref"]).toBe(row!.id);
    expect(message!.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    expect(row).toMatchObject({ status: "sent", step_number: 1, local_send_date: "2026-11-09" });
    expect(row!.rfc_message_id).toBe(message!.headers["message-id"]);
    const [pat] = await r.prospects();
    expect(pat).toMatchObject({ status: "active", next_step: 2, due: "2026-11-12", thread_id: message!.threadId });
  });
});

describe("caps, warm-up and pacing (OS-12)", () => {
  async function ticks(r: Rig, count: number, overrides: Partial<OutreachWorkerConfig> = {}) {
    for (let i = 0; i < count; i += 1) {
      world.time.ms = WINDOW_START + i * 5 * MINUTE;
      await r.run({ minGapMs: 240_000, ...overrides });
    }
  }

  it("a mailbox 28 days into sending, with 25 due prospects, sends its cap of 20 with the gap between sends", async () => {
    const r = await rig({ count: 26 });
    const [first] = await r.prospects();
    await world.rows("UPDATE outreach_prospects SET status='stopped', next_step=NULL, next_due_on=NULL WHERE tenant_id=$1 AND id=$2", [r.tenant, first!.id]);
    await r.seed(first!.id, 1, "sent", { date: "2026-10-12", at: new Date(Date.parse("2026-10-12T17:00:00Z")) });
    await ticks(r, 30);
    expect(sentCount(r)).toBe(20);
    const times = r.fake.sent.map((message) => message.at.getTime());
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(240_000);
  });

  it("a mailbox on its first send day sends 5", async () => {
    const r = await rig({ count: 25 });
    await ticks(r, 30);
    expect(sentCount(r)).toBe(5);
  });

  it("two runs started together at the cap minus one make exactly one send", async () => {
    const r = await rig({ count: 6 });
    const all = await r.prospects();
    for (const stopped of all.slice(0, 4)) {
      await world.rows("UPDATE outreach_prospects SET status='stopped', next_step=NULL, next_due_on=NULL WHERE tenant_id=$1 AND id=$2", [r.tenant, stopped.id]);
      await r.seed(stopped.id, 1, "sent");
    }
    await Promise.all([r.run(), r.run()]);
    expect(sentCount(r)).toBe(1);
  });

  it("the campaign's own daily cap limits one campaign below the mailbox cap", async () => {
    const r = await rig({ count: 4, campaign: { dailyCapPerMailbox: 2 } });
    await r.run({ sendsPerTick: 5 });
    await r.run({ sendsPerTick: 5 });
    expect(sentCount(r)).toBe(2);
  });

  it("uses the smaller of the mailbox daily limit and the configured limit, and never sooner than the gap", async () => {
    const r = await rig({ count: 4, dailyLimit: 2 });
    await r.run({ sendsPerTick: 5, mailboxDailyLimit: 20, warmup: { start: 50, step: 0, periodDays: 7 } });
    expect(sentCount(r)).toBe(2);
    const gap = await rig({ count: 3 });
    await gap.run({ sendsPerTick: 5, minGapMs: 240_000 });
    expect(sentCount(gap)).toBe(1);
  });

  it("takes follow-ups before step 1, then the oldest due date", async () => {
    const r = await rig({ count: 2 });
    await r.run();
    const first = r.fake.sent[0]!.to;
    world.time.ms = THURSDAY;
    await r.run();
    expect(r.fake.sent[1]!.to).toBe(first);
    expect(r.fake.sent[1]!.subject).toMatch(/^Re: Quick idea for/);
  });
});

describe("the worker run (OS-13)", () => {
  it("leases disjoint mailboxes when two runs start together", async () => {
    const r = await rig({ addresses: [ADDR, OTHER] });
    const [a, b] = await Promise.all([r.run({ mailboxesPerRun: 1 }), r.run({ mailboxesPerRun: 1 })]);
    expect(a.mailboxes + b.mailboxes).toBe(2);
    expect(await world.rows("SELECT 1 FROM outreach_mailboxes WHERE tenant_id=$1 AND history_checked_at IS NOT NULL", [r.tenant])).toHaveLength(2);
    expect(await world.rows("SELECT 1 FROM outreach_mailboxes WHERE tenant_id=$1 AND lease_token IS NOT NULL", [r.tenant])).toHaveLength(0);
  });

  it("skips a mailbox another run holds and one that needs a new sign-in", async () => {
    const r = await rig({ addresses: [ADDR, OTHER] });
    await world.rows("UPDATE outreach_mailboxes SET lease_token=$3, lease_expires_at=$4 WHERE tenant_id=$1 AND id=$2", [r.tenant, r.mailboxes[0], randomUUID(), new Date(world.time.ms + DAY)]);
    expect((await r.run()).mailboxes).toBe(1);
    await world.rows("UPDATE outreach_mailboxes SET status='reauthorize' WHERE tenant_id=$1 AND id=$2", [r.tenant, r.mailboxes[1]]);
    expect((await r.run()).mailboxes).toBe(0);
  });

  it("writes nothing after its lease expires", async () => {
    const r = await rig();
    const jump = { ...r.fake.oauth, refreshAccessToken: async (token: string) => {
      const minted = await r.fake.oauth.refreshAccessToken(token);
      world.time.ms += 10_000; // longer than the 1 s lease
      return minted;
    } };
    const worker = createOutreachWorker({
      service: world.fixture.service, db: world.database.db, gmail: r.fake, oauth: jump, clock: world.clock, generateId: randomUUID,
      report: (event) => { events.push(event); },
      config: { privateKey, tenants: [r.tenant], sendEnabled: true, leaseMs: 1000, unsubscribeBaseUrl: "https://hub.example/u", unsubscribeSecret: SECRET },
    });
    const counts = await worker.runOnce();
    expect(counts.lostLeases).toBe(1);
    expect(r.fake.sendCalls()).toBe(0);
    expect(await r.sends()).toEqual([]);
    expect((await world.rows("SELECT history_id FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!.history_id).toBeNull();
    expect(events.map((event) => event.kind)).toContain("outreach_lost_lease");
  });

  it("makes no Gmail call when the budget has already passed", async () => {
    const r = await rig();
    let tick = world.time.ms;
    const stepping = { now: () => new Date((tick += 1)) };
    const counts = await r.worker({ runBudgetMs: 1 }, { clock: stepping }).runOnce();
    expect(r.fake.calls).toEqual([]);
    expect(counts.deadlineStops).toBe(1);
  });

  it("refuses a budget over 20 seconds", async () => {
    const r = await rig();
    expect(() => r.worker({ runBudgetMs: 20_001 })).toThrow();
  });

  it("marks a campaign completed once no prospect is pending or active", async () => {
    const r = await rig();
    await world.rows("UPDATE outreach_prospects SET status='stopped', next_step=NULL, next_due_on=NULL WHERE tenant_id=$1", [r.tenant]);
    const counts = await r.run();
    expect(counts.campaignsCompleted).toBe(1);
    expect((await r.campaign()).status).toBe("completed");
  });

  it("runs all three steps and completes the prospect and the campaign, with Re: subjects and a growing References chain", async () => {
    const r = await rig();
    await r.run();
    world.time.ms = THURSDAY;
    await r.run();
    world.time.ms = Date.parse("2026-11-19T16:30:00.000Z");
    const counts = await r.run();
    expect(r.fake.sent.map((message) => message.subject)).toEqual(["Quick idea for Acme 1", "Re: Quick idea for Acme 1", "Re: Quick idea for Acme 1"]);
    const [one, two, three] = r.fake.sent;
    expect(two!.threadId).toBe(one!.threadId);
    expect(three!.threadId).toBe(one!.threadId);
    expect(two!.headers["in-reply-to"]).toBe(one!.headers["message-id"]);
    expect(three!.headers["in-reply-to"]).toBe(two!.headers["message-id"]);
    expect(three!.headers.references).toContain(one!.headers["message-id"]);
    expect((await r.prospects())[0]!.status).toBe("completed");
    expect(counts.campaignsCompleted).toBe(1);
    expect((await r.campaign()).status).toBe("completed");
  });
});

describe("the pre-send check (OS-14)", () => {
  const stopped = (status: string) => ({ prospect: status });
  const cases: Array<{ name: string; change: (r: Rig) => Promise<void>; prospect: string; campaign?: { status: string; paused_reason: string | null } }> = [
    { name: "a paused mailbox", prospect: "active", change: async (r) => { await world.rows("UPDATE outreach_mailboxes SET paused_until=$3 WHERE tenant_id=$1 AND id=$2", [r.tenant, r.mailboxes[0], new Date(world.time.ms + DAY)]); } },
    { name: "a paused campaign", prospect: "active", change: async (r) => { await r.session.pauseCampaign(r.campaignId, randomUUID()); } },
    { name: "a revoked activation approval", prospect: "active", campaign: { status: "paused", paused_reason: "approval_revoked" }, change: async (r) => {
      await world.member_session(r.tenant, r.ownerId, [r.tenant]).revokeApproval((await r.campaign()).activation_approval_id, {}, randomUUID());
    } },
    { name: "a prospect not yet due", prospect: "active", change: async (r) => { await world.rows("UPDATE outreach_prospects SET next_due_on='2026-11-10' WHERE tenant_id=$1", [r.tenant]); } },
    { name: "a time before the window", prospect: "active", change: async () => { world.time.ms = MONDAY_0700_LA; } },
    { name: "a time at the window end", prospect: "active", change: async () => { world.time.ms = MONDAY_0700_LA + 210 * MINUTE; } },
    { name: "a Saturday", prospect: "active", change: async (r) => {
      await world.rows("UPDATE outreach_prospects SET next_due_on='2026-11-09' WHERE tenant_id=$1", [r.tenant]);
      world.time.ms = Date.parse("2026-11-14T18:00:00.000Z");
    } },
    { name: "a placeholder postal address", prospect: "active", campaign: { status: "paused", paused_reason: "postal_address_placeholder" }, change: async (r) => {
      await world.rows(`UPDATE business_profiles SET postal_address = postal_address || '{"line1":"Placeholder Street"}'::jsonb WHERE tenant_id=$1`, [r.tenant]);
    } },
    { name: "a missing postal address", prospect: "active", campaign: { status: "paused", paused_reason: "postal_address_missing" }, change: async (r) => { await world.rows("UPDATE business_profiles SET postal_address=NULL WHERE tenant_id=$1", [r.tenant]); } },
    { name: "an unsubscribe suppression", ...stopped("unsubscribed"), change: async (r) => { await world.rows("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'unsubscribe','test',now())", [r.tenant, prospectEmail(1)]); } },
    { name: "a bounce suppression", ...stopped("bounced"), change: async (r) => { await world.rows("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'bounce','test',now())", [r.tenant, prospectEmail(1)]); } },
    { name: "a manual suppression", ...stopped("suppressed"), change: async (r) => { await world.rows("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'manual','test',now())", [r.tenant, prospectEmail(1)]); } },
    { name: "a hard-suppressed company", ...stopped("hard_suppressed"), change: async (r) => { await world.rows("UPDATE outreach_prospects SET company=$2 WHERE tenant_id=$1", [r.tenant, HARD_SUPPRESSED_COMPANIES[0]]); } },
    { name: "denied email consent", ...stopped("consent_denied"), change: async (r) => {
      const contactId = randomUUID();
      await world.rows("INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,created_at,updated_at) VALUES ($1,$2,'No Mail',$3,now(),now())", [r.tenant, contactId, prospectEmail(1)]);
      await world.rows("INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at) VALUES ($1,$2,'email','denied','test',now())", [r.tenant, contactId]);
    } },
    { name: "a missing template value", ...stopped("stopped"), change: async (r) => { await world.rows("UPDATE outreach_prospects SET company='' WHERE tenant_id=$1", [r.tenant]); } },
    { name: "a read-only plan", prospect: "active", change: async (r) => {
      await world.rows("INSERT INTO tenant_plans (tenant_id,status,read_only_after,created_at,updated_at) VALUES ($1,'none',$2,now(),now())", [r.tenant, new Date(world.time.ms - DAY)]);
    } },
  ];
  it.each(cases)("sends nothing for $name", async ({ change, prospect: expected, campaign }) => {
    const r = await rig();
    await change(r);
    await r.run();
    expect(r.fake.sendCalls()).toBe(0);
    expect(await r.sends()).toEqual([]);
    expect((await r.prospects())[0]!.status).toBe(expected);
    if (campaign) expect(await r.campaign()).toMatchObject(campaign);
  });

  async function stepTwo(r: Rig) {
    await r.run();
    world.time.ms = THURSDAY;
    return r.fake.sent[0]!;
  }

  it("stops a follow-up when the prospect replied in the Gmail thread just before it", async () => {
    const r = await rig();
    const first = await stepTwo(r);
    r.fake.reply(ADDR, first.threadId, prospectEmail(1));
    await r.run();
    expect(sentCount(r)).toBe(1);
    expect(await r.status(prospectEmail(1))).toBe("replied");
  });

  it("stops a follow-up when the owner replied in the thread, and when Gmail no longer has it", async () => {
    const r = await rig({ count: 2 });
    await r.run({ sendsPerTick: 2 });
    world.time.ms = THURSDAY;
    const [one, two] = r.fake.sent;
    r.fake.receive(ADDR, { from: ADDR, threadId: one!.threadId, labels: ["SENT"] });
    r.fake.deleteThread(ADDR, two!.threadId);
    await r.run({ sendsPerTick: 2 });
    expect(sentCount(r)).toBe(2);
    expect(await r.status(one!.to)).toBe("owner_replied");
    expect(await r.status(two!.to)).toBe("thread_unavailable");
  });

  it("reads a missing Message-ID before a follow-up, skips while it cannot be read, and stops after the wait", async () => {
    const r = await rig();
    await r.run();
    world.time.ms = THURSDAY;
    await world.rows("UPDATE outreach_sends SET rfc_message_id=NULL WHERE tenant_id=$1", [r.tenant]);
    r.fake.script(ADDR, "getMessage", { status: 500 });
    await r.run({ messageIdWaitMs: 10 * DAY });
    expect(sentCount(r)).toBe(1);
    expect(await r.status(prospectEmail(1))).toBe("active");
    // The wait counts from the first failed lookup, which the first run stored: a day later the prospect stops (B8).
    const [stored] = await world.rows<{ message_id_first_failed_at: Date | null }>("SELECT message_id_first_failed_at FROM outreach_sends WHERE tenant_id=$1", [r.tenant]);
    expect(stored!.message_id_first_failed_at).not.toBeNull();
    world.time.ms += DAY;
    r.fake.script(ADDR, "getMessage", { status: 500 });
    await r.run({ messageIdWaitMs: DAY });
    expect(sentCount(r)).toBe(1);
    expect(await r.status(prospectEmail(1))).toBe("thread_unavailable");
    // And with the header readable the follow-up goes.
    world.time.ms = OPEN;
    const ok = await rig();
    await ok.run();
    world.time.ms = THURSDAY;
    await world.rows("UPDATE outreach_sends SET rfc_message_id=NULL WHERE tenant_id=$1", [ok.tenant]);
    await ok.run();
    expect(sentCount(ok)).toBe(2);
    expect(ok.fake.sent[1]!.headers["in-reply-to"]).toBe(ok.fake.sent[0]!.headers["message-id"]);
  });
});

describe("the send record and at-most-once (OS-15)", () => {
  it("makes one send per step when two runs start together", async () => {
    const r = await rig();
    await Promise.all([r.run(), r.run(), r.run()]);
    expect(sentCount(r)).toBe(1);
    expect(await r.sends()).toHaveLength(1);
  });

  it("never sends a step again after a run crashed with the row committed and the call not made", async () => {
    const r = await rig();
    const [pat] = await r.prospects();
    await r.seed(pat!.id, 1, "sending");
    await r.run();
    await r.run();
    expect(r.fake.sendCalls()).toBe(0);
    expect((await r.sends()).map((row) => row.status)).toEqual(["lost"]);
    expect(await r.status(prospectEmail(1))).toBe("send_outcome_unknown");
    expect(events.map((event) => event.kind)).toContain("outreach_send_outcome_unknown");
  });

  it("leaves a 429 retryable: not_sent, the mailbox paused 15 minutes, then one send", async () => {
    const r = await rig();
    r.fake.script(ADDR, "send", { status: 429 });
    await r.run();
    expect(await r.sends()).toMatchObject([{ status: "not_sent", error_code: "google_429" }]);
    expect(await r.status(prospectEmail(1))).toBe("active");
    const paused_until = (await world.rows<{ paused_until: Date }>("SELECT paused_until FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!.paused_until;
    expect(paused_until.getTime()).toBe(world.time.ms + 15 * MINUTE);
    await r.run();
    expect(sentCount(r)).toBe(0);
    world.time.ms += 16 * MINUTE;
    await r.run();
    expect(sentCount(r)).toBe(1);
    expect((await r.sends()).map((row) => row.status)).toEqual(["not_sent", "sent"]);
  });

  it("treats a 403 userRateLimitExceeded like a 429", async () => {
    const r = await rig();
    r.fake.script(ADDR, "send", { status: 403, reason: "userRateLimitExceeded" });
    await r.run();
    expect((await r.sends())[0]!.status).toBe("not_sent");
    expect((await world.rows("SELECT pause_reason FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!.pause_reason).toBe("gmail_rate_limit");
  });

  it("pauses to the next local midnight on dailyLimitExceeded and reports it", async () => {
    const r = await rig();
    r.fake.script(ADDR, "send", { status: 403, reason: "dailyLimitExceeded" });
    await r.run();
    const paused_until = (await world.rows<{ paused_until: Date }>("SELECT paused_until FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!.paused_until;
    expect(paused_until.toISOString()).toBe("2026-11-10T08:00:00.000Z");
    expect(events.map((event) => event.kind)).toContain("outreach_gmail_daily_limit");
  });

  it("stops the prospect on a 400 and marks the mailbox for sign-in on a 401", async () => {
    const r = await rig({ count: 2 });
    r.fake.script(ADDR, "send", { status: 400 });
    await r.run();
    const rows = await r.sends();
    expect(rows[0]).toMatchObject({ status: "rejected" });
    const stopped = (await r.prospects()).filter((p) => p.status === "invalid_address");
    expect(stopped).toHaveLength(1);
    r.fake.script(ADDR, "send", { status: 401 });
    await r.run();
    expect((await world.rows("SELECT status FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!.status).toBe("reauthorize");
    expect(events.map((event) => event.kind)).toContain("outreach_mailbox_reauthorize");
  });

  it("marks any other failure uncertain and sends no second time", async () => {
    const r = await rig();
    r.fake.script(ADDR, "send", { status: 503 });
    await r.run();
    expect((await r.sends()).map((row) => row.status)).toEqual(["uncertain"]);
    expect(sentCount(r)).toBe(0);
  });
});

describe("unknown outcome (OS-16)", () => {
  it("finds a message the fake accepted before it timed out: sent, schedule advanced, one send", async () => {
    const r = await rig();
    r.fake.script(ADDR, "send", "timeout_after");
    await r.run();
    expect((await r.sends()).map((row) => row.status)).toEqual(["uncertain"]);
    expect(sentCount(r)).toBe(1);
    await r.run();
    expect((await r.sends()).map((row) => row.status)).toEqual(["sent"]);
    expect(sentCount(r)).toBe(1);
    expect((await r.prospects())[0]).toMatchObject({ status: "active", next_step: 2, due: "2026-11-12" });
  });

  it("marks a send lost when the fake never accepted it, and never sends it again", async () => {
    const r = await rig();
    r.fake.script(ADDR, "send", "timeout_before");
    await r.run();
    await r.run();
    await r.run();
    expect(sentCount(r)).toBe(0);
    expect((await r.sends()).map((row) => row.status)).toEqual(["lost"]);
    expect(await r.status(prospectEmail(1))).toBe("send_outcome_unknown");
    expect(events.filter((event) => event.kind === "outreach_send_outcome_unknown")).toHaveLength(1);
  });

  it("marks a send lost when Gmail no longer keeps the history it starts from", async () => {
    const r = await rig();
    r.fake.script(ADDR, "send", "timeout_after");
    await r.run();
    r.fake.expireHistoryThrough(ADDR, 1_000_000);
    await r.run();
    expect((await r.sends()).map((row) => row.status)).toEqual(["lost"]);
    expect(await r.status(prospectEmail(1))).toBe("send_outcome_unknown");
  });

  it("waits for the probe delay before it looks", async () => {
    const r = await rig();
    r.fake.script(ADDR, "send", "timeout_after");
    await r.run({ probeDelayMs: 120_000 });
    await r.run({ probeDelayMs: 120_000 });
    expect((await r.sends()).map((row) => row.status)).toEqual(["uncertain"]);
    world.time.ms += 3 * MINUTE;
    await r.run({ probeDelayMs: 120_000 });
    expect((await r.sends()).map((row) => row.status)).toEqual(["sent"]);
  });
});

describe("replies and bounces (OS-19)", () => {
  async function sent(count = 1) {
    const r = await rig({ count });
    await r.run({ sendsPerTick: count });
    return r;
  }
  const kinds = (r: Rig) => world.rows<{ kind: string }>("SELECT kind FROM outreach_inbound_events WHERE tenant_id=$1 ORDER BY kind", [r.tenant]);

  it("stops a prospect that replied in the thread and writes nothing new on a repeat", async () => {
    const r = await sent();
    r.fake.reply(ADDR, r.fake.sent[0]!.threadId, prospectEmail(1));
    const first = await r.run();
    expect(first.replies).toBe(1);
    expect(await r.status(prospectEmail(1))).toBe("replied");
    const second = await r.run();
    expect(second.replies).toBe(0);
    expect(second.inboundRead).toBe(0);
    expect(await kinds(r)).toEqual([{ kind: "reply" }]);
  });

  it("stops a prospect that replied from a new thread", async () => {
    const r = await sent();
    r.fake.receive(ADDR, { from: `Pat <${prospectEmail(1)}>`, subject: "Different subject" });
    await r.run();
    expect(await r.status(prospectEmail(1))).toBe("replied");
  });

  it("stops a prospect on a bounce in its thread and records exactly one bounce suppression", async () => {
    const r = await sent();
    const bounce = r.fake.bounce(ADDR, r.fake.sent[0]!.threadId, prospectEmail(1));
    await r.run();
    await r.run();
    expect(await r.status(prospectEmail(1))).toBe("bounced");
    expect(await world.rows("SELECT reason, source FROM suppressions WHERE tenant_id=$1", [r.tenant]))
      .toEqual([{ reason: "bounce", source: `outreach-bounce:${bounce.id}` }]);
    expect(await world.rows("SELECT 1 FROM actions WHERE tenant_id=$1 AND action_type='suppression.record'", [r.tenant])).toHaveLength(1);
    expect(await kinds(r)).toEqual([{ kind: "bounce" }]);
  });

  it("matches a bounce outside the thread by X-Failed-Recipients", async () => {
    const r = await sent();
    r.fake.bounce(ADDR, undefined, prospectEmail(1));
    await r.run();
    expect(await r.status(prospectEmail(1))).toBe("bounced");
  });

  it("records an out-of-office and keeps the prospect active", async () => {
    const r = await sent();
    r.fake.outOfOffice(ADDR, r.fake.sent[0]!.threadId, prospectEmail(1));
    const counts = await r.run();
    expect(counts.autoReplies).toBe(1);
    expect(await r.status(prospectEmail(1))).toBe("active");
    expect(await kinds(r)).toEqual([{ kind: "auto_reply" }]);
  });

  it("stops a prospect when the owner answered by hand in its thread, and ignores mail the owner sent elsewhere", async () => {
    const r = await sent(2);
    const [one] = r.fake.sent;
    r.fake.receive(ADDR, { from: ADDR, threadId: one!.threadId, labels: ["SENT"] });
    r.fake.receive(ADDR, { from: ADDR, labels: ["SENT"], subject: "Unrelated" });
    await r.run();
    expect(await r.status(one!.to)).toBe("owner_replied");
    expect((await kinds(r))).toEqual([{ kind: "owner_reply" }]);
  });

  it("reads inbound mail while sending is off", async () => {
    const r = await sent();
    r.fake.reply(ADDR, r.fake.sent[0]!.threadId, prospectEmail(1));
    await r.run({ sendEnabled: false });
    expect(await r.status(prospectEmail(1))).toBe("replied");
  });

  it("starts a mailbox with no cursor from the profile history id and reports it; an expired cursor does the same", async () => {
    const r = await rig({ count: 0 });
    await r.run();
    expect(events).toContainEqual({ kind: "outreach_history_reset", tenantId: r.tenant, mailboxId: r.mailboxes[0], reason: "no_cursor" });
    r.fake.expireHistoryThrough(ADDR, 1_000_000);
    await r.run();
    expect(events.map((event) => event.kind).filter((kind) => kind === "outreach_history_reset")).toHaveLength(2);
  });

  const mailboxState = async (r: Rig) => (await world.rows<{ history_id: string; history_resume_token: string | null }>(
    "SELECT history_id, history_resume_token FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!;

  it("keeps the cursor where it was and resumes from a stored page token when a run cannot read all the new mail (B3)", async () => {
    const r = await sent();
    const before = (await mailboxState(r)).history_id;
    r.fake.setHistoryPageSize(ADDR, 1);
    for (let i = 0; i < 3; i += 1) r.fake.receive(ADDR, { from: "someone@else.example" });
    await r.run({ maxInboundMessages: 1 });
    expect(await mailboxState(r)).toMatchObject({ history_id: before, history_resume_token: expect.any(String) });
    await r.run({ maxInboundMessages: 1 });
    await r.run({ maxInboundMessages: 1 });
    const after = await mailboxState(r);
    expect(after.history_resume_token).toBeNull();
    expect(BigInt(after.history_id)).toBeGreaterThan(BigInt(before));
  });

  it("sends nothing from a mailbox that has not read all its new mail, so a reply on a later page stops its prospect first (B3)", async () => {
    const r = await sent();
    const first = r.fake.sent[0]!;
    r.fake.setHistoryPageSize(ADDR, 1);
    r.fake.receive(ADDR, { from: "someone@else.example" });
    r.fake.reply(ADDR, first.threadId, first.to);
    world.time.ms = THURSDAY;
    await r.run({ maxInboundMessages: 1 });
    expect(sentCount(r)).toBe(1);
    await r.run({ maxInboundMessages: 1 });
    expect(sentCount(r)).toBe(1);
    expect(await r.status(first.to)).toBe("replied");
  });
});

describe("unsubscribe, bounce rate and sign-in (OS-18, OS-20, OS-3)", () => {
  it("stops a prospect that used the unsubscribe link in its first email before step 2", async () => {
    const r = await rig();
    await r.run();
    const token = /https:\/\/hub\.example\/u\/(zsu1_[A-Za-z0-9_-]+)/.exec(r.fake.sent[0]!.body)![1]!;
    await createUnsubscribeSession(world.deps([r.tenant]), { current: SECRET }).unsubscribe(token);
    world.time.ms = THURSDAY;
    await r.run();
    expect(sentCount(r)).toBe(1);
    expect(await r.status(prospectEmail(1))).toBe("unsubscribed");
  });

  /** 39 or 40 earlier sends, written straight in: older than any cap day, so today's caps stay free. */
  async function bounceRig(earlier: number, bounced: number) {
    const r = await rig({ count: 45 });
    const all = await r.prospects();
    for (const [index, item] of all.slice(0, earlier).entries()) {
      await world.rows("UPDATE outreach_prospects SET next_due_on='2026-12-01', thread_id=$3 WHERE tenant_id=$1 AND id=$2", [r.tenant, item.id, `thr-seed-${index}`]);
      await r.seed(item.id, 1, "sent", { date: "2026-10-01", thread: `thr-seed-${index}` });
    }
    // The mailbox already has its history cursor (the fake's first history id); mail that arrives after it is what the next run reads.
    await world.rows("UPDATE outreach_mailboxes SET history_id='1000' WHERE tenant_id=$1", [r.tenant]);
    for (const item of all.slice(0, bounced)) r.fake.bounce(ADDR, undefined, item.email);
    return r;
  }

  it("keeps a campaign active at 39 sent and 2 bounces, then pauses it on the 40th send", async () => {
    const r = await bounceRig(39, 2);
    await r.run({ sendEnabled: false });
    expect((await r.prospects()).filter((p) => p.status === "bounced")).toHaveLength(2);
    expect((await r.campaign()).status).toBe("active");
    await r.run();
    expect(sentCount(r)).toBe(1);
    expect(await r.campaign()).toMatchObject({ status: "paused", paused_reason: "bounce_rate" });
    expect(events.map((event) => event.kind)).toContain("outreach_bounce_rate");
  });

  it("keeps a campaign active at 40 sent and 1 bounce", async () => {
    const r = await bounceRig(40, 1);
    await r.run();
    expect((await r.prospects()).filter((p) => p.status === "bounced")).toHaveLength(1);
    expect((await r.campaign()).status).toBe("active");
  });

  it("marks a mailbox for sign-in on invalid_grant and resumes after a reconnect", async () => {
    const r = await rig();
    r.fake.script(ADDR, "refresh", { status: "invalid_grant" });
    const counts = await r.run();
    expect(counts.reauthorized).toBe(1);
    expect((await world.rows("SELECT status FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!.status).toBe("reauthorize");
    expect(events).toContainEqual({ kind: "outreach_mailbox_reauthorize", tenantId: r.tenant, mailboxId: r.mailboxes[0], code: "invalid_grant" });
    await r.run();
    expect(sentCount(r)).toBe(0);
    await world.mailbox(r.tenant, ADDR);
    await r.run();
    expect(sentCount(r)).toBe(1);
  });

  it("puts no token in a log, a report, a stored error or a stored message", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    try {
      const r = await rig({ count: 2 });
      r.fake.script(ADDR, "send", { status: 503 });
      await r.run({ sendsPerTick: 2 });
      await r.run();
      const logged = JSON.stringify(spies.flatMap((spy) => spy.mock.calls)) + JSON.stringify(events);
      const stored = JSON.stringify(await world.rows("SELECT error_code, subject, body FROM outreach_sends WHERE tenant_id=$1", [r.tenant]))
        + JSON.stringify(await world.rows("SELECT pause_reason FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]));
      expect(r.fake.accessTokens.length).toBeGreaterThan(0);
      for (const text of [logged, stored]) {
        for (const token of r.fake.accessTokens) expect(text).not.toContain(token);
        expect(text).not.toContain("fake-refresh-");
        expect(text).not.toContain("zsg1.");
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// Review fixes (B1..B9 and the warnings): each block names the finding it closes.
describe("review fixes", () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Sends step 1 from a fresh rig, with its history cursor stored. */
  async function afterStep1(options: Parameters<typeof rig>[0] = {}) {
    const r = await rig(options);
    await r.run();
    return r;
  }

  /**
   * Holds `hold` open in one transaction, starts a worker run on other connections, shows that the run sends nothing while the
   * transaction is open (it is waiting on a lock the writer also takes), then lets the transaction commit.
   */
  async function raceWith(r: Rig, hold: (tx: Parameters<Parameters<typeof world.fixture.service>[0]>[0]) => Promise<void>, overrides: Partial<OutreachWorkerConfig> = {}) {
    let pending: Promise<OutreachRunCounts> | undefined;
    await world.fixture.service(async (tx) => {
      await hold(tx);
      pending = r.run(overrides);
      await pause(600);
      expect(r.fake.sendCalls(), "the run must wait for the writer's lock").toBe(0);
    });
    return pending!;
  }

  describe("B1: only mail with one of our own refs is ours", () => {
    it("treats a prospect's reply that copies our X-Zs-Ref header as a reply", async () => {
      const r = await afterStep1();
      const [row] = await r.sends();
      r.fake.reply(ADDR, r.fake.sent[0]!.threadId, prospectEmail(1), { "X-Zs-Ref": row!.id });
      world.time.ms = THURSDAY;
      await r.run();
      expect(await r.status(prospectEmail(1))).toBe("replied");
      expect(sentCount(r)).toBe(1);
    });

    it("treats a reply with an X-Zs-Ref of no send of ours as a reply too", async () => {
      const r = await afterStep1();
      r.fake.reply(ADDR, r.fake.sent[0]!.threadId, prospectEmail(1), { "X-Zs-Ref": randomUUID() });
      world.time.ms = THURSDAY;
      await r.run();
      expect(await r.status(prospectEmail(1))).toBe("replied");
      expect(sentCount(r)).toBe(1);
    });
  });

  describe("B2: a mailbox sends only after it settled and read everything", () => {
    it("sends nothing in a run whose inbound read failed, and sends in the next", async () => {
      const r = await afterStep1();
      world.time.ms = THURSDAY;
      r.fake.script(ADDR, "history", { status: 500 });
      const failed = await r.run();
      expect(failed.stepsFailed).toBe(1);
      expect(sentCount(r)).toBe(1);
      await r.run();
      expect(sentCount(r)).toBe(2);
    });

    it("sends nothing while an uncertain attempt could not be settled to its end, then sends once it is decided", async () => {
      const r = await rig({ count: 2 });
      await r.run();
      const unsent = (await r.prospects()).find((p) => p.email !== r.fake.sent[0]!.to)!;
      await r.seed(unsent.id, 1, "uncertain", { history: "1" });
      r.fake.setHistoryPageSize(ADDR, 1);
      for (let i = 0; i < 3; i += 1) r.fake.receive(ADDR, { from: "someone@else.example" });
      world.time.ms = THURSDAY;
      await r.run({ maxHistoryPages: 1 });
      expect(sentCount(r)).toBe(1);
      await r.run({ maxHistoryPages: 50 });
      expect(sentCount(r)).toBe(2);
    });
  });

  describe("B4: a history gap pauses a mailbox that has mailed prospects", () => {
    it("pauses the mailbox with a reason and an operator report, sends nothing, and a reconnect resumes it", async () => {
      const r = await afterStep1();
      const cursor = (await world.rows<{ history_id: string }>("SELECT history_id FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!.history_id;
      // Gmail drops the history up to the cursor; mail that arrived since moves the mailbox's head past it.
      r.fake.expireHistoryThrough(ADDR, Number(cursor) + 1);
      r.fake.receive(ADDR, { from: "someone@else.example" });
      world.time.ms = THURSDAY;
      await r.run();
      expect(events).toContainEqual({ kind: "outreach_history_reset", tenantId: r.tenant, mailboxId: r.mailboxes[0], reason: "expired", paused: true });
      const [box] = await world.rows<{ pause_reason: string | null; paused_until: Date | null }>("SELECT pause_reason, paused_until FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]);
      expect(box!.pause_reason).toBe("history_gap");
      expect(box!.paused_until!.getUTCFullYear()).toBe(9999);
      expect(sentCount(r)).toBe(1);
      await r.run();
      expect(sentCount(r)).toBe(1);
      await world.mailbox(r.tenant, ADDR);
      const [after] = await world.rows("SELECT paused_until, pause_reason FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]);
      expect(after).toMatchObject({ paused_until: null, pause_reason: null });
      await r.run();
      expect(sentCount(r)).toBe(2);
    });

    it("moves a mailbox with nothing mailed to the head without a pause", async () => {
      const r = await rig({ count: 1 });
      await r.run({ sendEnabled: false });
      const [box] = await world.rows<{ pause_reason: string | null }>("SELECT pause_reason FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]);
      expect(box!.pause_reason).toBeNull();
    });
  });

  describe("B5: the send decision waits for competing writers' locks and rechecks", () => {
    it("does not send past an approval revoked in an open transaction", async () => {
      const r = await rig();
      const { activation_approval_id } = await r.campaign();
      const done = await raceWith(r, async (tx) => {
        await tx.query("UPDATE approvals SET status='revoked', revoked_by=$3, revoked_at=$4 WHERE tenant_id=$1 AND id=$2", [r.tenant, activation_approval_id, r.ownerId, new Date(world.time.ms)]);
      });
      expect(done.sends).toBe(0);
      expect(sentCount(r)).toBe(0);
      expect(await r.campaign()).toMatchObject({ status: "paused", paused_reason: "approval_revoked" });
    });

    it("does not send past a campaign paused in an open transaction", async () => {
      const r = await rig();
      await raceWith(r, async (tx) => {
        await tx.query("UPDATE outreach_campaigns SET status='paused', paused_reason='owner' WHERE tenant_id=$1 AND id=$2", [r.tenant, r.campaignId]);
      });
      expect(sentCount(r)).toBe(0);
      expect(await r.campaign()).toMatchObject({ status: "paused", paused_reason: "owner" });
    });

    it("does not send to an address suppressed in an open transaction (the writer's advisory lock)", async () => {
      const r = await rig();
      await raceWith(r, async (tx) => {
        await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [`suppression:${r.tenant}:email:${prospectEmail(1)}`]);
        await tx.query("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'manual','test',$3)", [r.tenant, prospectEmail(1), new Date(world.time.ms)]);
      });
      expect(sentCount(r)).toBe(0);
      expect(await r.status(prospectEmail(1))).toBe("suppressed");
    });

    it("does not send past a CRM identity lock held by a consent writer", async () => {
      const r = await rig();
      await raceWith(r, async (tx) => {
        await tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [`crm:contact:email:${r.tenant}:${prospectEmail(1)}`]);
      });
      // Nothing changed when the lock was released: the send goes.
      expect(sentCount(r)).toBe(1);
    });

    it("does not send after the owner stopped the prospect in an open transaction", async () => {
      const r = await rig();
      await raceWith(r, async (tx) => {
        await tx.query("UPDATE outreach_prospects SET status='stopped', next_step=NULL, next_due_on=NULL, stopped_at=$3 WHERE tenant_id=$1 AND email=$2", [r.tenant, prospectEmail(1), new Date(world.time.ms)]);
      });
      expect(sentCount(r)).toBe(0);
      expect(await r.status(prospectEmail(1))).toBe("stopped");
    });

    it("rechecks the postal address a profile writer changed in an open transaction", async () => {
      const r = await rig();
      await raceWith(r, async (tx) => {
        await tx.query("UPDATE business_profiles SET postal_address=NULL WHERE tenant_id=$1", [r.tenant]);
      });
      expect(sentCount(r)).toBe(0);
      expect(await r.campaign()).toMatchObject({ status: "paused", paused_reason: "postal_address_missing" });
    });
  });

  describe("B6: the worker needs an approved activation of this very campaign", () => {
    it.each([
      ["another target", "UPDATE approvals SET target_id=gen_random_uuid() WHERE tenant_id=$1 AND id=$2"],
      ["another action", "UPDATE approvals SET action_type='outreach.campaign.pause' WHERE tenant_id=$1 AND id=$2"],
    ])("pauses the campaign and sends nothing when its approval is %s", async (_name, change) => {
      const r = await rig();
      const { activation_approval_id } = await r.campaign();
      await world.rows(change, [r.tenant, activation_approval_id]);
      await r.run();
      expect(sentCount(r)).toBe(0);
      expect(await r.campaign()).toMatchObject({ status: "paused", paused_reason: "approval_invalid" });
    });
  });

  describe("B7: an open attempt of a prospect is skipped, not fatal", () => {
    it("sends to the other prospects when the first one already has an uncertain attempt", async () => {
      const r = await rig({ count: 2 });
      const [first] = await r.prospects();
      await r.seed(first!.id, 1, "uncertain", { history: "1" });
      const counts = await r.run({ probeDelayMs: DAY });
      expect(counts.stepsFailed).toBe(0);
      expect(sentCount(r)).toBe(1);
      expect(r.fake.sent[0]!.to).toBe(prospectEmail(2));
    });
  });

  describe("B8: the Message-ID wait", () => {
    it("fails the mailbox into reauthorize when the lookup says the grant is gone", async () => {
      const r = await afterStep1();
      await world.rows("UPDATE outreach_sends SET rfc_message_id=NULL WHERE tenant_id=$1", [r.tenant]);
      world.time.ms = THURSDAY;
      r.fake.script(ADDR, "getMessage", { status: 401 });
      await r.run();
      expect((await world.rows("SELECT status FROM outreach_mailboxes WHERE tenant_id=$1", [r.tenant]))[0]!.status).toBe("reauthorize");
      expect(await r.status(prospectEmail(1))).toBe("active");
    });
  });

  describe("B9: a run that ran out of time before Gmail was asked releases the reservation", () => {
    it("marks the row not_sent, keeps the prospect on its step and sends it in the next run", async () => {
      const r = await rig();
      let ids = 0;
      let jumped = false;
      const clock = { now: () => new Date(world.time.ms + (jumped ? 25_000 : 0)) };
      const worker = createOutreachWorker({
        service: world.fixture.service, db: world.database.db, gmail: r.fake, oauth: r.fake.oauth, clock,
        generateId: () => { ids += 1; if (ids >= 2) jumped = true; return randomUUID(); },
        report: (event) => { events.push(event); },
        config: { privateKey, tenants: [r.tenant], sendEnabled: true, minGapMs: 0, probeDelayMs: 0, unsubscribeBaseUrl: "https://hub.example/u", unsubscribeSecret: SECRET },
      });
      const counts = await worker.runOnce();
      expect(r.fake.sendCalls()).toBe(0);
      expect(counts.notSent).toBe(1);
      expect(await r.sends()).toMatchObject([{ status: "not_sent", error_code: "out_of_time" }]);
      expect(await r.status(prospectEmail(1))).toBe("active");
      await r.run();
      expect(sentCount(r)).toBe(1);
    });
  });

  describe("warnings", () => {
    it("counts a bounce by its event and ignores a prospect stopped before any mail by a bounce suppression (A6, Argon)", async () => {
      const r = await rig({ count: 45 });
      const all = await r.prospects();
      for (const [index, item] of all.slice(0, 39).entries()) {
        await world.rows("UPDATE outreach_prospects SET next_due_on='2026-12-01', thread_id=$3 WHERE tenant_id=$1 AND id=$2", [r.tenant, item.id, `thr-seed-${index}`]);
        await r.seed(item.id, 1, "sent", { date: "2026-10-01", thread: `thr-seed-${index}` });
      }
      await world.rows("UPDATE outreach_mailboxes SET history_id='1000' WHERE tenant_id=$1", [r.tenant]);
      for (const item of all.slice(39, 44))
        await world.rows("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email',$2,'bounce','test',$3)", [r.tenant, item.email, new Date(world.time.ms)]);
      await r.run({ sendsPerTick: 5 });
      expect((await r.prospects()).filter((p) => p.status === "bounced")).toHaveLength(5);
      expect((await r.campaign()).status).toBe("active");
    });

    it("pauses the campaign with a reason when the business has no time zone, never on UTC (A11)", async () => {
      const r = await rig();
      await world.profile(r.tenant, { timeZone: null });
      await r.run();
      expect(sentCount(r)).toBe(0);
      expect(await r.campaign()).toMatchObject({ status: "paused", paused_reason: "time_zone_missing" });
    });

    it("rotates mailboxes by their last attempt so one cannot starve the other (OS-13)", async () => {
      const r = await rig({ count: 2, addresses: [ADDR, OTHER] });
      await r.run({ mailboxesPerRun: 1 });
      await r.run({ mailboxesPerRun: 1 });
      expect(new Set(r.fake.calls.map((call) => call.mailbox).filter((m) => m !== null)).size).toBe(2);
    });

    it("treats a first send date ahead of today (a time zone moved west) as warm-up day zero", async () => {
      const r = await rig({ count: 2 });
      const [, second] = await r.prospects();
      await r.seed(second!.id, 1, "sent", { date: "2026-11-10", thread: "thr-future" });
      const counts = await r.run();
      expect(counts.stepsFailed).toBe(0);
      expect(sentCount(r)).toBe(1);
    });

    it("lets a follow-up lookup stay out of the 24 hours until the first lookup failed (B8 clock)", async () => {
      const r = await afterStep1();
      await world.rows("UPDATE outreach_sends SET rfc_message_id=NULL WHERE tenant_id=$1", [r.tenant]);
      world.time.ms = THURSDAY;
      r.fake.script(ADDR, "getMessage", { status: 500 });
      await r.run({ messageIdWaitMs: DAY });
      world.time.ms = THURSDAY + 2 * 60 * MINUTE;
      r.fake.script(ADDR, "getMessage", { status: 500 });
      await r.run({ messageIdWaitMs: DAY });
      expect(await r.status(prospectEmail(1))).toBe("active");
    });

    it("refuses at import a prospect whose rendered subject is too long (A10)", async () => {
      const r = await rig({ count: 0, campaign: { steps: [{ subject: "{{company}}{{company}}{{company}}{{company}}{{company}}{{company}}", body: "Hi {{first_name}}", delayBusinessDays: 0 }] } });
      const imported = (await r.session.importProspects(r.campaignId, { prospects: [prospect(1, { company: "C".repeat(190) }), prospect(2)] }, randomUUID())).result;
      expect(imported.rejected).toEqual([{ index: 0, reason: "render_too_long" }]);
      expect(imported.imported).toBe(1);
    });

    it("stops a prospect that slipped past the import with a too-long subject, and still sends the others (A10)", async () => {
      const r = await rig({ count: 2, campaign: { steps: [{ subject: "{{company}}{{company}}{{company}}", body: "Hi {{first_name}}", delayBusinessDays: 0 }] } });
      await world.rows("UPDATE outreach_prospects SET company=$3 WHERE tenant_id=$1 AND email=$2", [r.tenant, prospectEmail(1), "C".repeat(190)]);
      const counts = await r.run({ sendsPerTick: 2 });
      expect(counts.stepsFailed).toBe(0);
      expect(await r.status(prospectEmail(1))).toBe("stopped");
      expect(sentCount(r)).toBe(1);
    });
  });
});
