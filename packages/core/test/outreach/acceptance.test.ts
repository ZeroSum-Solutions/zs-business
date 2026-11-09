// outreach-sequencer.md, "First slice" acceptance scenario, end to end against a real local Postgres and FakeGmail with an
// injected clock in America/Los_Angeles. Nothing here can reach Google: the only Gmail is FakeGmail, the setup file's fetch
// guard fails any real request, and the test also asserts that nothing called fetch.
import { randomUUID } from "node:crypto";
import { NotFound, TenantDenied, OUTREACH_CAMPAIGN_ACTIVATE_ACTION, OUTREACH_CAMPAIGN_TARGET } from "@zs/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createOutreachWorker,
  createUnsubscribeSession,
  directDispatch,
  FakeGmail,
  HARD_SUPPRESSED_COMPANIES,
  memberAuthorize,
  parseSealPrivateKey,
  type FakeSentMessage,
  type OutreachWorkerConfig,
} from "../../src/index.js";
import { campaignBody, createWorld, MINUTE, MONDAY_0700_LA, prospect, type World } from "./harness.js";

const SECRET = "outreach-acceptance-secret-0123456789";
const ADDR = "devin@zerosum-solutions.com";
const OTHER = "devin.wiggins@zerosum-solutions.com";
/** 07:00 in Los Angeles on the three send days (PST, UTC-8, no daylight change in between). */
const MONDAY = MONDAY_0700_LA;
const THURSDAY = Date.parse("2026-11-12T15:00:00.000Z");
const NEXT_THURSDAY = Date.parse("2026-11-19T15:00:00.000Z");

let world: World;
beforeAll(async () => { world = await createWorld(); });
afterAll(async () => { await world?.close(); });

describe("the outreach sequencer, first slice", () => {
  it("runs the whole scenario: approval, windows, caps, threads, reply, bounce, unsubscribe, completion and isolation", async () => {
    const fetched = vi.spyOn(globalThis, "fetch");
    const privateKey = parseSealPrivateKey(world.seal.privateKey);
    const tenantA = await world.tenant("Tenant A");
    const tenantB = await world.tenant("Tenant B");
    const ownerA = await world.member(tenantA, "owner");
    const staffA = await world.member(tenantA, "staff");
    const ownerB = await world.member(tenantB, "owner");
    const boxes = [await world.mailbox(tenantA, ADDR), await world.mailbox(tenantA, OTHER)];
    const fake = new FakeGmail(world.clock);
    fake.addMailbox(ADDR);
    fake.addMailbox(OTHER);
    const owner = world.owner(tenantA, ownerA, [tenantA]);

    // The owner creates a three-step campaign (delays 0, 3, 5; window 08:00 to 10:30; cap 2) and imports six prospects.
    world.time.ms = MONDAY;
    const campaign = (await owner.createCampaign(campaignBody(boxes), randomUUID())).result;
    await world.rows("INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'email','gone@acme8.example','unsubscribe','test',now())", [tenantA]);
    const imported = await owner.importProspects(campaign.id, {
      prospects: [
        prospect(1), prospect(2), prospect(3), prospect(4),
        prospect(5, { company: HARD_SUPPRESSED_COMPANIES[0] }),
        prospect(6, { email: "gone@acme8.example" }),
      ],
    }, randomUUID());
    expect(imported.result).toEqual({
      imported: 4, excluded: 0,
      rejected: [{ index: 4, reason: "hard_suppressed" }, { index: 5, reason: "suppressed" }],
    });
    const perMailbox = await world.rows<{ mailbox_id: string; n: number }>(
      "SELECT mailbox_id, count(*)::int AS n FROM outreach_prospects WHERE tenant_id=$1 GROUP BY mailbox_id ORDER BY mailbox_id", [tenantA]);
    expect(perMailbox.map((row) => row.n)).toEqual([2, 2]);
    expect(perMailbox.map((row) => row.mailbox_id).sort()).toEqual([...boxes].sort());

    // Activation by direct dispatch is TenantDenied; a request plus the owner's approval makes it active.
    const direct = directDispatch(world.deps([tenantA]), tenantA, ownerA, memberAuthorize(tenantA, ownerA), { outreach: { tenants: [tenantA] } });
    await expect(direct({
      actionType: OUTREACH_CAMPAIGN_ACTIVATE_ACTION, target: { tenantId: tenantA, type: OUTREACH_CAMPAIGN_TARGET, id: campaign.id },
      approvalReference: { tenantId: tenantA, id: randomUUID() }, idempotencyKey: randomUUID(),
      payload: { campaignId: campaign.id, contentDigest: campaign.contentDigest, prospectsDigest: "0".repeat(64), prospectCount: 4 },
    })).rejects.toBeInstanceOf(TenantDenied);
    await expect(world.owner(tenantA, staffA, [tenantA]).requestActivation(campaign.id, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    const { approvalId } = await owner.requestActivation(campaign.id, randomUUID());
    expect(await campaignStatus()).toBe("draft");
    await world.member_session(tenantA, ownerA, [tenantA]).approveApproval(approvalId, {}, randomUUID());
    expect(await campaignStatus()).toBe("active");

    const events: unknown[] = [];
    const worker = (sendEnabled: boolean) => createOutreachWorker({
      service: world.fixture.service, db: world.database.db, gmail: fake, oauth: fake.oauth, clock: world.clock, generateId: randomUUID,
      report: (event) => { events.push(event); },
      config: {
        privateKey, tenants: [tenantA], sendEnabled, minGapMs: 240_000, probeDelayMs: 120_000,
        unsubscribeBaseUrl: "https://hub.example/u", unsubscribeSecret: SECRET,
      } satisfies OutreachWorkerConfig,
    });
    async function campaignStatus() {
      return (await world.rows<{ status: string }>("SELECT status FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2", [tenantA, campaign.id]))[0]!.status;
    }
    const status = async (email: string) =>
      (await world.rows<{ status: string }>("SELECT status FROM outreach_prospects WHERE tenant_id=$1 AND email=$2", [tenantA, email]))[0]!.status;
    /** One tick: two runs started together (never a double send), and how many each mailbox sent. */
    async function tick(at: number, sendEnabled: boolean) {
      world.time.ms = at;
      const before = new Map([ADDR, OTHER].map((address) => [address, fake.sent.filter((message) => message.mailbox === address).length]));
      await Promise.all([worker(sendEnabled).runOnce(), worker(sendEnabled).runOnce()]);
      for (const address of [ADDR, OTHER]) expect(fake.sent.filter((message) => message.mailbox === address).length - before.get(address)!, `${address} at ${new Date(at).toISOString()}`).toBeLessThanOrEqual(1);
    }
    /** Runs at 5-minute steps from 07:55 to 10:35 local. */
    async function day(base: number, sendEnabled: boolean) {
      for (let at = base + 55 * MINUTE; at <= base + 215 * MINUTE; at += 5 * MINUTE) await tick(at, sendEnabled);
    }
    const insideWindow = (message: FakeSentMessage, base: number) => {
      const offset = message.at.getTime() - base;
      return offset >= 60 * MINUTE && offset < 210 * MINUTE;
    };

    // OUTREACH_SEND_ENABLED unset: runs through the window send nothing.
    await day(MONDAY, false);
    expect(fake.sent).toEqual([]);
    expect(fake.sendCalls()).toBe(0);

    // With it true: step 1 goes to all four, two per mailbox, only inside the window. One send times out after Gmail
    // accepted it; the probe settles it as sent with a single fake send.
    fake.script(ADDR, "send", "timeout_after");
    await day(MONDAY, true);
    expect(fake.sent).toHaveLength(4);
    expect(fake.sent.filter((message) => message.mailbox === ADDR)).toHaveLength(2);
    expect(fake.sent.filter((message) => message.mailbox === OTHER)).toHaveLength(2);
    for (const message of fake.sent) expect(insideWindow(message, MONDAY), message.at.toISOString()).toBe(true);
    expect(fake.sent.map((message) => message.to).sort()).toEqual([1, 2, 3, 4].map((n) => prospect(n).email));
    const step1 = await world.rows<{ status: string; step_number: number; error_code: string | null }>(
      "SELECT status, step_number, error_code FROM outreach_sends WHERE tenant_id=$1 ORDER BY attempt_started_at", [tenantA]);
    expect(step1).toHaveLength(4);
    expect(step1.every((row) => row.status === "sent" && row.step_number === 1)).toBe(true);

    // Each message has the footer with the address, a working unsubscribe link and the two List-Unsubscribe headers.
    for (const message of fake.sent) {
      expect(message.body).toContain("Zero Sum Solutions LLC");
      expect(message.body).toContain("1 Market St");
      expect(message.body).toMatch(/To stop these emails: https:\/\/hub\.example\/u\/zsu1_[A-Za-z0-9_-]+/);
      expect(message.headers["list-unsubscribe"]).toMatch(/^<https:\/\/hub\.example\/u\/zsu1_[A-Za-z0-9_-]+>$/);
      expect(message.headers["list-unsubscribe-post"]).toBe("List-Unsubscribe=One-Click");
    }
    const first = (n: number) => fake.sent.find((message) => message.to === prospect(n).email)!;

    // Prospect 2 replies in the thread; prospect 3's first email bounces.
    fake.reply(first(2).mailbox, first(2).threadId, prospect(2).email);
    fake.bounce(first(3).mailbox, first(3).threadId, prospect(3).email);
    await tick(MONDAY + 225 * MINUTE, true);
    expect(await status(prospect(2).email)).toBe("replied");
    expect(await status(prospect(3).email)).toBe("bounced");
    expect(await world.rows("SELECT reason FROM suppressions WHERE tenant_id=$1 AND reason='bounce'", [tenantA])).toHaveLength(1);
    expect(fake.sent).toHaveLength(4);

    // Three business days later step 2 goes in the same thread, as "Re: ", to prospects 1 and 4 only.
    await day(THURSDAY, true);
    expect(fake.sent).toHaveLength(6);
    for (const n of [1, 4]) {
      const second = fake.sent.filter((message) => message.to === prospect(n).email)[1]!;
      const original = first(n);
      expect(second.threadId).toBe(original.threadId);
      expect(second.mailbox).toBe(original.mailbox);
      expect(second.subject).toBe(`Re: ${original.subject}`);
      expect(second.headers["in-reply-to"]).toBe(original.headers["message-id"]);
      expect(second.headers["references"]).toContain(original.headers["message-id"]);
      expect(second.body).toContain("Following up");
      expect(insideWindow(second, THURSDAY)).toBe(true);
    }
    for (const n of [2, 3]) expect(fake.sent.filter((message) => message.to === prospect(n).email)).toHaveLength(1);

    // Prospect 4 clicks unsubscribe after step 2.
    const second4 = fake.sent.filter((message) => message.to === prospect(4).email)[1]!;
    const token = /https:\/\/hub\.example\/u\/(zsu1_[A-Za-z0-9_-]+)/.exec(second4.body)![1]!;
    await createUnsubscribeSession(world.deps([tenantA]), { current: SECRET }).unsubscribe(token);

    // Five business days after step 2: prospect 1 gets step 3 and is completed; prospect 4 gets nothing.
    await day(NEXT_THURSDAY, true);
    expect(fake.sent).toHaveLength(7);
    const third = fake.sent.filter((message) => message.to === prospect(1).email)[2]!;
    expect(third.threadId).toBe(first(1).threadId);
    expect(third.body).toContain("Last note for Acme 1");
    expect(fake.sent.filter((message) => message.to === prospect(4).email)).toHaveLength(2);
    expect(await status(prospect(1).email)).toBe("completed");
    expect(await status(prospect(2).email)).toBe("replied");
    expect(await status(prospect(3).email)).toBe("bounced");
    expect(await status(prospect(4).email)).toBe("unsubscribed");
    expect(await world.rows("SELECT 1 FROM suppressions WHERE tenant_id=$1 AND address=$2 AND reason='unsubscribe'", [tenantA, prospect(4).email])).toHaveLength(1);
    expect(await campaignStatus()).toBe("completed");

    // The fake recorded exactly the expected sends: no step twice, none for a stopped prospect, no failed attempt left open.
    expect(fake.sendCalls()).toBe(7);
    const sends = await world.rows<{ status: string }>("SELECT status FROM outreach_sends WHERE tenant_id=$1", [tenantA]);
    expect(sends).toHaveLength(7);
    expect(sends.every((row) => row.status === "sent")).toBe(true);
    expect(await world.rows(
      "SELECT prospect_id, step_number FROM outreach_sends WHERE tenant_id=$1 GROUP BY prospect_id, step_number HAVING count(*) > 1", [tenantA])).toEqual([]);

    // Tenant B reads none of tenant A's rows, and its owner gets NotFound on every route.
    for (const table of ["outreach_campaigns", "outreach_prospects", "outreach_mailboxes", "outreach_sends"]) {
      const rows = await world.database.db.tenant(tenantB, async (tx) => (await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [tenantA])).rows);
      expect(rows, table).toEqual([]);
    }
    const insideList = world.owner(tenantB, ownerB, [tenantA, tenantB]);
    expect((await insideList.listCampaigns()).items).toEqual([]);
    expect((await insideList.listMailboxes()).items).toEqual([]);
    await expect(insideList.getCampaign(campaign.id)).rejects.toBeInstanceOf(NotFound);
    await expect(insideList.listProspects(campaign.id, {})).rejects.toBeInstanceOf(NotFound);
    await expect(insideList.pauseCampaign(campaign.id, randomUUID())).rejects.toBeInstanceOf(NotFound);
    const outsideList = world.owner(tenantB, ownerB, [tenantA]);
    await expect(outsideList.listCampaigns()).rejects.toBeInstanceOf(NotFound);
    await expect(outsideList.getCampaign(campaign.id)).rejects.toBeInstanceOf(NotFound);
    await expect(outsideList.listMailboxes()).rejects.toBeInstanceOf(NotFound);

    // Nothing reached Google.
    expect(fetched).not.toHaveBeenCalled();
    fetched.mockRestore();
  }, 180_000);
});
