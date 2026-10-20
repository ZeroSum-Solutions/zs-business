import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MESSAGE_SEND_REQUESTED, SUPPRESSION_RECORD_ACTION } from "@zs/contracts";
import { signUnsubscribeToken } from "@zs/core";
import {
  createApiHarness,
  NOW,
  PREVIOUS_UNSUBSCRIBE_SECRET,
  UNSUBSCRIBE_SECRET,
  type ApiHarness,
  type TenantSetup,
} from "./helpers.js";

const NOT_FOUND = JSON.stringify({ error: { code: "NotFound", message: "Not found", details: {} } });
const ONE_CLICK = "List-Unsubscribe=One-Click";

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({
    unsubscribe: {
      tokenSecrets: { current: UNSUBSCRIBE_SECRET, previous: PREVIOUS_UNSUBSCRIBE_SECRET },
      clientIp: { header: "x-real-ip" },
      // Small limits so the abuse tests reach them.
      limits: { addressWrites: { limit: 3, windowMs: 600_000 }, addressReads: { limit: 3, windowMs: 600_000 } },
    },
  });
});
afterAll(async () => h.close());

let addressCount = 0;
const nextAddress = () => `198.51.100.${(++addressCount % 250) + 1}`;

interface Send {
  method: "GET" | "POST";
  body?: string;
  contentType?: string;
  from?: string;
}
async function send(token: string, options: Send, app = h.app) {
  const headers: Record<string, string> = { "X-Real-IP": options.from ?? nextAddress() };
  if (options.contentType) headers["Content-Type"] = options.contentType;
  const response = await app.request(`/public/v1/unsubscribe/${token}`, {
    method: options.method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
const view = (token: string, from?: string) => send(token, { method: "GET", ...(from ? { from } : {}) });
const oneClick = (token: string, from?: string) =>
  send(token, { method: "POST", body: ONE_CLICK, contentType: "application/x-www-form-urlencoded", ...(from ? { from } : {}) });

/**
 * A delivery as the core worker leaves it after a send: a contact, the producing action and
 * its outbox event, and a sent message_deliveries row pinned to the recipient address.
 */
async function sentDelivery(
  tenant: TenantSetup,
  options: { address?: string | null; channel?: "email" | "sms" } = {},
) {
  const address = options.address === undefined ? `guest-${randomUUID().slice(0, 8)}@haldenrowe.example` : options.address;
  const channel = options.channel ?? "email";
  const ids = { contact: randomUUID(), action: randomUUID(), outbox: randomUUID(), delivery: randomUUID(), message: randomUUID() };
  await h.fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       VALUES ($1,$2,'Halden Guest',$3,$4,$5,$5)`,
      [tenant.tenantId, ids.contact, channel === "email" ? address ?? `guest-${ids.contact.slice(0, 8)}@haldenrowe.example` : null,
        channel === "sms" ? address : null, NOW]);
    await tx.query(
      `INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at)
       VALUES ($1,$2,$3,'test.message.send','{}'::jsonb,'{}'::jsonb,$4,'{}'::jsonb,$5)`,
      [tenant.tenantId, ids.action, tenant.actorId, `send:${ids.message}`, NOW]);
    await tx.query(
      `INSERT INTO outbox (tenant_id,id,action_id,event_type,payload,created_at,processed_at)
       VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,$5)`, [tenant.tenantId, ids.outbox, ids.action, MESSAGE_SEND_REQUESTED, NOW]);
    await tx.query(
      `INSERT INTO message_deliveries (tenant_id,id,outbox_id,message_id,channel,contact_id,action_id,subject,body,status,
         next_attempt_at,first_attempt_at,attempts,idempotency_key,recipient_address,provider,provider_message_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5::crm_consent_channel,$6,$7,$8,'Thanks for booking.','sent',$9,$9,1,$10,$11,'fake',$12,$9,$9)`,
      [tenant.tenantId, ids.delivery, ids.outbox, ids.message, channel, ids.contact, ids.action,
        channel === "email" ? "Your booking" : null, NOW, `delivery:${ids.delivery}`, address, `pm-${ids.delivery}`]);
  });
  const token = signUnsubscribeToken(UNSUBSCRIBE_SECRET, { tenantId: tenant.tenantId, deliveryId: ids.delivery });
  return { deliveryId: ids.delivery, address, token };
}

const suppressions = (tenantId: string) => h.fixture.service(async (tx) => (await tx.query<{
  channel: string; address: string; reason: string; source: string;
}>("SELECT channel::text AS channel, address, reason, source FROM suppressions WHERE tenant_id=$1 ORDER BY address", [tenantId])).rows);
const actionCount = (tenantId: string, actionType = SUPPRESSION_RECORD_ACTION) => h.fixture.service(async (tx) =>
  Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND action_type=$2",
    [tenantId, actionType])).rows[0]!.n));

describe("GET shows a confirmation and changes nothing", () => {
  it("answers a self-contained page with a form that posts back", async () => {
    const { token } = await sentDelivery(h.a);
    const before = { suppressions: await suppressions(h.a.tenantId), actions: await actionCount(h.a.tenantId) };
    for (let i = 0; i < 2; i += 1) {
      const page = await view(token);
      expect(page.status).toBe(200);
      expect(page.headers.get("content-type")).toMatch(/^text\/html/);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
      expect(page.text).toMatch(/<form method="post">/);
      // No script, no outside asset, and neither the token nor the address in the page.
      expect(page.text).not.toMatch(/<script|<img|<link|https?:\/\//i);
      expect(page.text).not.toContain(token);
    }
    expect({ suppressions: await suppressions(h.a.tenantId), actions: await actionCount(h.a.tenantId) }).toEqual(before);
  });
});

describe("POST suppresses the address the delivery went to (RFC 8058)", () => {
  it("records one unsubscribe for the one-click body", async () => {
    const { token, address, deliveryId } = await sentDelivery(h.a);
    const done = await oneClick(token);
    expect(done.status).toBe(200);
    expect(done.headers.get("content-type")).toMatch(/^text\/html/);
    expect(done.headers.get("cache-control")).toBe("no-store");
    expect(done.text).toMatch(/unsubscribed/i);
    expect(await suppressions(h.a.tenantId)).toContainEqual({
      channel: "email", address, reason: "unsubscribe", source: `email:${deliveryId}`,
    });
  });

  it("replays a repeat, from an empty body or the page's form, without a second row or action", async () => {
    const { token, address } = await sentDelivery(h.b);
    const before = await actionCount(h.b.tenantId);
    expect((await oneClick(token)).status).toBe(200);
    expect((await send(token, { method: "POST" })).status).toBe(200);
    expect((await send(token, { method: "POST", body: "", contentType: "application/x-www-form-urlencoded" })).status).toBe(200);
    const rows = (await suppressions(h.b.tenantId)).filter((row) => row.address === address);
    expect(rows).toHaveLength(1);
    expect(await actionCount(h.b.tenantId)).toBe(before + 1);
  });

  it("accepts a link signed with the previous secret during a rotation", async () => {
    const { deliveryId, address } = await sentDelivery(h.a);
    const token = signUnsubscribeToken(PREVIOUS_UNSUBSCRIBE_SECRET, { tenantId: h.a.tenantId, deliveryId });
    expect((await view(token)).status).toBe(200);
    expect((await oneClick(token)).status).toBe(200);
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).toContain(address);
  });

  it("refuses a body over the public limit", async () => {
    const { token, address } = await sentDelivery(h.a);
    const big = await send(token, { method: "POST", body: `${ONE_CLICK}&x=${"y".repeat(9000)}`, contentType: "application/x-www-form-urlencoded" });
    expect(big.status).toBe(413);
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).not.toContain(address);
  });
});

describe("forged and cross-tenant tokens (D-9)", () => {
  it("answers the shared public 404 for every forged or unusable token", async () => {
    const real = await sentDelivery(h.a);
    const sms = await sentDelivery(h.a, { channel: "sms", address: "+15555550123" });
    const unpinned = await sentDelivery(h.a, { address: null });
    const tokens = [
      "not-a-token",
      `zsu1_${"A".repeat(64)}`,
      // Right tenant and delivery, wrong secret.
      signUnsubscribeToken(["other", "secret", "z".repeat(32)].join("-"), { tenantId: h.a.tenantId, deliveryId: real.deliveryId }),
      // One flipped character in the tag.
      real.token.slice(0, -1) + (real.token.endsWith("A") ? "B" : "A"),
      // Validly signed, but no such delivery.
      signUnsubscribeToken(UNSUBSCRIBE_SECRET, { tenantId: h.a.tenantId, deliveryId: randomUUID() }),
      // An SMS delivery, and an email delivery that never pinned an address.
      sms.token,
      unpinned.token,
    ];
    const before = { a: await suppressions(h.a.tenantId), b: await suppressions(h.b.tenantId) };
    for (const token of tokens) {
      for (const response of [await view(token), await oneClick(token)]) {
        expect(response.status, token).toBe(404);
        expect(response.text, token).toBe(NOT_FOUND);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    }
    expect({ a: await suppressions(h.a.tenantId), b: await suppressions(h.b.tenantId) }).toEqual(before);
  });

  it("never lets tenant A's token reach tenant B's delivery or list", async () => {
    // Both tenants mailed the same person.
    const address = `shared-${randomUUID().slice(0, 8)}@haldenrowe.example`;
    const deliveryA = await sentDelivery(h.a, { address });
    const deliveryB = await sentDelivery(h.b, { address });
    const forged = [
      // Signed for tenant A, naming B's delivery: A has no such delivery.
      signUnsubscribeToken(UNSUBSCRIBE_SECRET, { tenantId: h.a.tenantId, deliveryId: deliveryB.deliveryId }),
      // A's token with B's tenant ID spliced in: the tag no longer matches.
      `zsu1_${Buffer.concat([
        Buffer.from(h.b.tenantId.replaceAll("-", ""), "hex"),
        Buffer.from(deliveryA.token.slice(5), "base64url").subarray(16),
      ]).toString("base64url")}`,
    ];
    for (const token of forged) expect((await oneClick(token)).status).toBe(404);
    expect((await suppressions(h.b.tenantId)).map((row) => row.address)).not.toContain(address);

    // A's own token suppresses the address in A only.
    expect((await oneClick(deliveryA.token)).status).toBe(200);
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).toContain(address);
    expect((await suppressions(h.b.tenantId)).map((row) => row.address)).not.toContain(address);
  });
});

describe("abuse limits", () => {
  it("charges forged tokens to the caller's address before any database work", async () => {
    const { token, address } = await sentDelivery(h.a);
    const from = "192.0.2.77";
    for (let i = 0; i < 3; i += 1) expect((await send("zsu1_forged", { method: "POST", from })).status).toBe(404);
    const limited = await send("zsu1_forged", { method: "GET", from });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(JSON.parse(limited.text).error.code).toBe("RateLimited");
    // A real token from the same address is not charged there: one-click POSTs come from a few
    // mailbox-provider servers shared by every recipient.
    expect((await oneClick(token, from)).status).toBe(200);
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).toContain(address);
  });

  it("charges a real token to its own delivery, reads and writes apart", async () => {
    const mailboxProvider = "192.0.2.88";
    const first = await sentDelivery(h.a);
    for (let i = 0; i < 3; i += 1) expect((await oneClick(first.token, mailboxProvider)).status).toBe(200);
    expect((await oneClick(first.token, mailboxProvider)).status).toBe(429);
    expect((await oneClick(first.token)).status).toBe(429);
    expect((await view(first.token, mailboxProvider)).status).toBe(200);
    // Other recipients unsubscribing through the same server are unaffected.
    for (let i = 0; i < 5; i += 1) {
      const other = await sentDelivery(h.a);
      expect((await oneClick(other.token, mailboxProvider)).status).toBe(200);
    }
  });
});

describe("without a token secret", () => {
  let off: ApiHarness;
  beforeAll(async () => { off = await createApiHarness(); });
  afterAll(async () => off.close());

  it("serves no unsubscribe route", async () => {
    const token = signUnsubscribeToken(UNSUBSCRIBE_SECRET, { tenantId: off.a.tenantId, deliveryId: randomUUID() });
    for (const method of ["GET", "POST"] as const) {
      const response = await send(token, { method }, off.app);
      expect(response.status).toBe(404);
      expect(JSON.parse(response.text).error.code).toBe("NotFound");
    }
  });
});
