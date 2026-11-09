// outreach-sequencer.md OS-18: the unsubscribe link in an outreach email goes through the existing token and
// suppression path. Delivery's own tokens are covered by test/delivery/consent.test.ts, which this change leaves green.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUnsubscribeSession, signUnsubscribeToken } from "../../src/index.js";
import { campaignBody, createWorld, prospect, type World } from "./harness.js";

const SECRET = "outreach-unsubscribe-secret-0123456789";
let world: World;
let tenantA: string;
let tenantB: string;
let sendId: string;

beforeAll(async () => {
  world = await createWorld();
  tenantA = await world.tenant("A");
  tenantB = await world.tenant("B");
  const owner = await world.member(tenantA, "owner");
  const mailbox = await world.mailbox(tenantA, "devin@zerosum-solutions.com");
  const session = world.owner(tenantA, owner, [tenantA]);
  const campaign = (await session.createCampaign(campaignBody([mailbox]), randomUUID())).result;
  await session.importProspects(campaign.id, { prospects: [prospect(1, { email: "Pat@Acme.example" })] }, randomUUID());
  const prospectId = (await world.rows<{ id: string }>("SELECT id FROM outreach_prospects WHERE tenant_id=$1", [tenantA]))[0]!.id;
  sendId = randomUUID();
  await world.rows(
    `INSERT INTO outreach_sends (tenant_id,id,campaign_id,prospect_id,mailbox_id,step_number,status,recipient_address,subject,body,local_send_date,attempt_started_at,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,1,'uncertain','pat@acme.example','Hi','Body','2026-11-09',now(),now(),now())`,
    [tenantA, sendId, campaign.id, prospectId, mailbox]);
});
afterAll(async () => { await world?.close(); });

const session = () => createUnsubscribeSession(world.deps([tenantA]), { current: SECRET });
const token = (tenantId: string, deliveryId: string) => signUnsubscribeToken(SECRET, { tenantId, deliveryId });

describe("unsubscribe through an outreach send (OS-18)", () => {
  it("checks the token, suppresses the address the send went to with the outreach source, and replays a repeat", async () => {
    const link = token(tenantA, sendId);
    expect(await session().check(link)).toEqual({ valid: true });
    expect(await world.rows("SELECT 1 FROM suppressions WHERE tenant_id=$1", [tenantA])).toHaveLength(0);
    expect(await session().unsubscribe(link)).toEqual({ channel: "email", suppressed: true, changed: true });
    expect(await session().unsubscribe(link)).toEqual({ channel: "email", suppressed: true, changed: true });
    expect(await world.rows("SELECT channel, address, reason, source FROM suppressions WHERE tenant_id=$1", [tenantA]))
      .toEqual([{ channel: "email", address: "pat@acme.example", reason: "unsubscribe", source: `outreach:${sendId}` }]);
    expect(await world.rows("SELECT 1 FROM actions WHERE tenant_id=$1 AND action_type='suppression.record'", [tenantA])).toHaveLength(1);
  });

  it("works for a tenant no longer on the allowlist: an address that asked to stop stays stopped", async () => {
    const other = createUnsubscribeSession(world.deps([]), { current: SECRET });
    expect(await other.check(token(tenantA, sendId))).toEqual({ valid: true });
  });

  it("is NotFound for a forged token, another secret, a send that does not exist and another tenant's tenant id", async () => {
    await expect(session().unsubscribe("zsu1_garbage")).rejects.toMatchObject({ code: "NotFound" });
    await expect(session().unsubscribe(signUnsubscribeToken("another-secret-another-secret-12345", { tenantId: tenantA, deliveryId: sendId })))
      .rejects.toMatchObject({ code: "NotFound" });
    await expect(session().unsubscribe(token(tenantA, randomUUID()))).rejects.toMatchObject({ code: "NotFound" });
    // Tenant A's send ID under tenant B's ID finds nothing, and writes nothing.
    await expect(session().unsubscribe(token(tenantB, sendId))).rejects.toMatchObject({ code: "NotFound" });
    expect(await world.rows("SELECT 1 FROM suppressions WHERE tenant_id=$1", [tenantB])).toHaveLength(0);
  });
});
