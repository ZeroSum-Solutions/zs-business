import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotencyKeySchema, MESSAGE_SEND_REQUESTED } from "@zs/contracts";
import { signTwilioRequest, smsStatusEvidence } from "@zs/core";
import type { App } from "../src/app.js";
import {
  call,
  createApiHarness,
  NOW,
  PREVIOUS_TWILIO_AUTH_TOKEN,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_WEBHOOK_BASE_URL,
  type ApiHarness,
  type TenantSetup,
} from "./helpers.js";

const UNAUTHORIZED = { error: { code: "Unauthorized", message: "Invalid webhook signature", details: {} } };
const XML_HEAD = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>";
const EMPTY = `${XML_HEAD}<Response/>`;
const message = (text: string) => `${XML_HEAD}<Response><Message>${text}</Message></Response>`;
/** A third test-only token, neither current nor previous. */
const OTHER_TWILIO_AUTH_TOKEN = ["c0ffee00", "c0ffee00", "c0ffee00", "c0ffee00"].join("");
const OTHER_ACCOUNT_SID = `AC${"b2".repeat(16)}`;

/** Each tenant's own sending number (T-7); every sender below is another +1555555 01xx number. */
const NUMBER_A = "+15555550100";
const NUMBER_B = "+15555550101";
let nextPhone = 2;
function phone(): string {
  if (nextPhone > 99) throw new Error("out of +1555555 01xx test numbers");
  return `+155555501${String(nextPhone++).padStart(2, "0")}`;
}
const newSid = () => `SM${randomBytes(16).toString("hex")}`;

let h: ApiHarness;
async function assignNumbers(harness: ApiHarness, helpA: string | null) {
  await harness.fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO sms_numbers (tenant_id,phone_number,help_reply,created_at,updated_at)
       VALUES ($1,$2,$3,$5,$5),($4,$6,NULL,$5,$5)`,
      [harness.a.tenantId, NUMBER_A, helpA, harness.b.tenantId, NOW, NUMBER_B]);
  });
}
beforeAll(async () => {
  h = await createApiHarness({
    twilioWebhook: { tokens: { current: TWILIO_AUTH_TOKEN, previous: PREVIOUS_TWILIO_AUTH_TOKEN } },
  });
  await assignNumbers(h, null);
});
afterAll(async () => h.close());

/**
 * A delivery as the core worker leaves it after a Twilio send: a contact, the producing action and
 * its outbox event, and a message_deliveries row pinned to the recipient. With `recorded: false`
 * it is the `uncertain` row a lost provider reply leaves; `messageSid` is then the SID Twilio made.
 */
interface Delivery {
  tenantId: string;
  deliveryId: string;
  /** The pinned recipient. */
  to: string;
  messageSid: string;
}
async function sentDelivery(
  tenant: TenantSetup,
  options: { to?: string; channel?: "sms" | "email"; provider?: string; recorded?: boolean } = {},
  harness = h,
): Promise<Delivery> {
  const channel = options.channel ?? "sms";
  const to = options.to ?? (channel === "sms" ? phone() : `guest-${randomUUID().slice(0, 8)}@haldenrowe.example`);
  const messageSid = newSid();
  const recorded = options.recorded ?? true;
  const ids = { contact: randomUUID(), action: randomUUID(), outbox: randomUUID(), delivery: randomUUID(), message: randomUUID() };
  await harness.fixture.service(async (tx) => {
    // One contact per number in a tenant; a second delivery to the same number reuses it.
    await tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       VALUES ($1,$2,'Halden Guest',$3,$4,$5,$5) ON CONFLICT DO NOTHING`,
      [tenant.tenantId, ids.contact, channel === "email" ? to : null, channel === "sms" ? to : null, NOW]);
    const contactId = (await tx.query<{ id: string }>(
      "SELECT id FROM crm_contacts WHERE tenant_id=$1 AND (e164_phone=$2 OR normalized_email=$2)",
      [tenant.tenantId, to])).rows[0]!.id;
    await tx.query(
      `INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,idempotency_key,result,created_at)
       VALUES ($1,$2,$3,'test.message.send','{}'::jsonb,'{}'::jsonb,$4,'{}'::jsonb,$5)`,
      [tenant.tenantId, ids.action, tenant.actorId, `send:${ids.message}`, NOW]);
    await tx.query(
      `INSERT INTO outbox (tenant_id,id,action_id,event_type,payload,created_at,processed_at)
       VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,$5)`, [tenant.tenantId, ids.outbox, ids.action, MESSAGE_SEND_REQUESTED, NOW]);
    await tx.query(
      `INSERT INTO message_deliveries (tenant_id,id,outbox_id,message_id,channel,contact_id,action_id,subject,body,status,
         next_attempt_at,first_attempt_at,attempts,idempotency_key,recipient_address,provider,provider_message_id,
         outcome_unknown,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,1,$12,$13,$14,$15,$16,$11,$11)`,
      [tenant.tenantId, ids.delivery, ids.outbox, ids.message, channel, contactId, ids.action,
        channel === "email" ? "Your booking" : null,
        "Halden & Rowe: see you Monday at 9. Reply STOP to opt out.",
        recorded ? "sent" : "uncertain", NOW, `zsd-${ids.delivery}`, to, options.provider ?? "twilio",
        recorded ? messageSid : null, !recorded]);
  });
  return { tenantId: tenant.tenantId, deliveryId: ids.delivery, to, messageSid };
}

const statusPath = (tenantId: string, deliveryId: string) => `/webhooks/twilio/status/${tenantId}/${deliveryId}`;
const inboundPath = (tenantId: string) => `/webhooks/twilio/inbound/${tenantId}`;

/** The form Twilio posts as a status callback; `undefined` overrides drop a field. */
function statusForm(delivery: Delivery, overrides: Record<string, string | undefined> = {}) {
  const fields: Record<string, string | undefined> = {
    AccountSid: TWILIO_ACCOUNT_SID,
    ApiVersion: "2010-04-01",
    From: NUMBER_A,
    MessageSid: delivery.messageSid,
    MessageStatus: "sent",
    SmsSid: delivery.messageSid,
    SmsStatus: "sent",
    To: delivery.to,
    ...overrides,
  };
  return new URLSearchParams(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
/** The form Twilio posts for an inbound text. */
function inboundForm(to: string, from: string, body: string, sid = newSid(), overrides: Record<string, string | undefined> = {}) {
  const fields: Record<string, string | undefined> = {
    AccountSid: TWILIO_ACCOUNT_SID, ApiVersion: "2010-04-01", Body: body, From: from, MessageSid: sid,
    NumMedia: "0", NumSegments: "1", SmsMessageSid: sid, SmsSid: sid, To: to, ...overrides,
  };
  return new URLSearchParams(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

interface Post {
  token?: string;
  /** Signs this URL instead of the configured base and the path sent. */
  signedUrl?: string;
  /** Signs these fields instead of the ones sent, for tampering. */
  signedParams?: URLSearchParams;
  unsigned?: boolean;
  headers?: Record<string, string>;
  /** Requests this URL (a full URL picks the host the app sees) instead of the path. */
  requestUrl?: string;
  /** A raw body in place of the form. */
  body?: string;
  app?: App;
}
/** POST a form to the webhook, signed like Twilio with the current token over base + path. */
async function post(path: string, params: URLSearchParams, options: Post = {}) {
  const signature = signTwilioRequest(
    options.token ?? TWILIO_AUTH_TOKEN, options.signedUrl ?? TWILIO_WEBHOOK_BASE_URL + path, options.signedParams ?? params);
  const response = await (options.app ?? h.app).request(options.requestUrl ?? path, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(options.unsigned ? {} : { "X-Twilio-Signature": signature }),
      ...options.headers,
    },
    body: options.body ?? params.toString(),
  });
  return { status: response.status, contentType: response.headers.get("content-type"), text: await response.text() };
}
async function postStatus(delivery: Delivery, params = statusForm(delivery), options: Post = {}) {
  const response = await post(statusPath(delivery.tenantId, delivery.deliveryId), params, options);
  return { status: response.status, body: response.text ? JSON.parse(response.text) as unknown : null };
}
async function postInbound(tenantId: string, params: URLSearchParams, options: Post = {}) {
  const response = await post(inboundPath(tenantId), params, options);
  return { status: response.status, contentType: response.contentType, body: response.text };
}

const statusEvents = (tenantId: string, deliveryId: string, harness = h) => harness.fixture.service(async (tx) => (await tx.query<{
  provider_message_id: string; status: string; error_code: string | null;
}>(`SELECT provider_message_id, status, error_code FROM sms_status_events
     WHERE tenant_id=$1 AND delivery_id=$2 ORDER BY received_at, status`, [tenantId, deliveryId])).rows);
const actionsWithKey = (tenantId: string, key: string, harness = h) => harness.fixture.service(async (tx) =>
  Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND idempotency_key=$2",
    [tenantId, key])).rows[0]!.n));
const suppressions = (tenantId: string, harness = h) => harness.fixture.service(async (tx) => (await tx.query<{
  channel: string; address: string; reason: string; source: string;
}>("SELECT channel::text AS channel, address, reason, source FROM suppressions WHERE tenant_id=$1 ORDER BY address",
  [tenantId])).rows);
const suppressionOf = async (tenantId: string, address: string, harness = h) =>
  (await suppressions(tenantId, harness)).filter((row) => row.address === address);
const suppress = (tenantId: string, address: string, reason: string, harness = h) => harness.fixture.service((tx) => tx.query(
  "INSERT INTO suppressions (tenant_id,channel,address,reason,source,created_at) VALUES ($1,'sms',$2,$3,'test:seed',$4)",
  [tenantId, address, reason, NOW]));
/** Every status event, suppression and action in both tenants, to show a request changed nothing. */
const snapshot = (harness = h) => harness.fixture.service(async (tx) => {
  const count = async (sql: string, tenantId: string) =>
    Number((await tx.query<{ n: string }>(sql, [tenantId])).rows[0]!.n);
  const of = async (tenantId: string) => ({
    events: await count("SELECT count(*) AS n FROM sms_status_events WHERE tenant_id=$1", tenantId),
    suppressions: (await tx.query("SELECT channel::text, address, reason, source FROM suppressions WHERE tenant_id=$1 ORDER BY address",
      [tenantId])).rows,
    actions: await count("SELECT count(*) AS n FROM actions WHERE tenant_id=$1", tenantId),
    numbers: (await tx.query("SELECT phone_number, help_reply FROM sms_numbers WHERE tenant_id=$1", [tenantId])).rows,
  });
  return { a: await of(harness.a.tenantId), b: await of(harness.b.tenantId) };
});

describe("signed status callbacks record evidence (T-5, T-6)", () => {
  it("records one row per status, replays a redelivery and adds a later status", async () => {
    const delivery = await sentDelivery(h.a);
    expect(await postStatus(delivery)).toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(h.a.tenantId, delivery.deliveryId)).toEqual([
      { provider_message_id: delivery.messageSid, status: "sent", error_code: null },
    ]);
    expect(await actionsWithKey(h.a.tenantId, `sms-status:${delivery.messageSid}:sent`)).toBe(1);

    // Twilio redelivers the same callback; the status word is read case-insensitively.
    expect(await postStatus(delivery)).toEqual({ status: 200, body: { handled: true } });
    expect(await postStatus(delivery, statusForm(delivery, { MessageStatus: "SENT" }))).toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(h.a.tenantId, delivery.deliveryId)).toHaveLength(1);
    expect(await actionsWithKey(h.a.tenantId, `sms-status:${delivery.messageSid}:sent`)).toBe(1);

    const delivered = statusForm(delivery, { MessageStatus: "delivered", SmsStatus: "delivered" });
    expect(await postStatus(delivery, delivered)).toEqual({ status: 200, body: { handled: true } });
    expect((await statusEvents(h.a.tenantId, delivery.deliveryId)).map((row) => row.status).sort()).toEqual(["delivered", "sent"]);
    expect(await actionsWithKey(h.a.tenantId, `sms-status:${delivery.messageSid}:delivered`)).toBe(1);
  });

  it("records evidence for an uncertain delivery whose Twilio reply was lost, which the worker can read back", async () => {
    const delivery = await sentDelivery(h.b, { recorded: false });
    expect(await h.fixture.service((tx) => smsStatusEvidence(tx, delivery))).toBeNull();
    expect(await postStatus(delivery, statusForm(delivery, { MessageStatus: "queued" }))).toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(h.b.tenantId, delivery.deliveryId)).toEqual([
      { provider_message_id: delivery.messageSid, status: "queued", error_code: null },
    ]);
    expect(await h.fixture.service((tx) => smsStatusEvidence(tx, delivery))).toEqual({ messageSid: delivery.messageSid });
    // The webhook records evidence only; the worker settles the delivery (T-5).
    const row = await h.fixture.service(async (tx) => (await tx.query<{ status: string; provider_message_id: string | null }>(
      "SELECT status, provider_message_id FROM message_deliveries WHERE tenant_id=$1 AND id=$2",
      [delivery.tenantId, delivery.deliveryId])).rows[0]);
    expect(row).toEqual({ status: "uncertain", provider_message_id: null });

    // Evidence for a second message on the same delivery is refused: one delivery is one message.
    const before = await snapshot();
    expect(await postStatus({ ...delivery, messageSid: newSid() })).toEqual({ status: 200, body: { handled: false, reason: "message_mismatch" } });
    expect(await snapshot()).toEqual(before);
  });

  it("records the error code, and error 21610 also suppresses the recipient with reason stop", async () => {
    const delivery = await sentDelivery(h.a);
    const optedOut = statusForm(delivery, { MessageStatus: "failed", SmsStatus: "failed", ErrorCode: "21610" });
    expect(await postStatus(delivery, optedOut)).toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(h.a.tenantId, delivery.deliveryId)).toEqual([
      { provider_message_id: delivery.messageSid, status: "failed", error_code: "21610" },
    ]);
    expect(await suppressionOf(h.a.tenantId, delivery.to)).toEqual([
      { channel: "sms", address: delivery.to, reason: "stop", source: `twilio:${delivery.messageSid}` },
    ]);
    expect(await actionsWithKey(h.a.tenantId, `sms-status:${delivery.messageSid}:stop`)).toBe(1);
    // A redelivery replays both actions.
    expect(await postStatus(delivery, optedOut)).toEqual({ status: 200, body: { handled: true } });
    expect(await actionsWithKey(h.a.tenantId, `sms-status:${delivery.messageSid}:stop`)).toBe(1);
    expect(await actionsWithKey(h.a.tenantId, `sms-status:${delivery.messageSid}:failed`)).toBe(1);
    expect(await suppressionOf(h.a.tenantId, delivery.to)).toHaveLength(1);
    // Tenant B never heard of the number.
    expect(await suppressionOf(h.b.tenantId, delivery.to)).toEqual([]);

    // Another error code records the status and suppresses nothing.
    const other = await sentDelivery(h.a);
    const undelivered = statusForm(other, { MessageStatus: "undelivered", ErrorCode: "30003" });
    expect(await postStatus(other, undelivered)).toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(h.a.tenantId, other.deliveryId)).toEqual([
      { provider_message_id: other.messageSid, status: "undelivered", error_code: "30003" },
    ]);
    expect(await suppressionOf(h.a.tenantId, other.to)).toEqual([]);
  });

  it("acknowledges callbacks that do not match a sent Twilio SMS delivery and writes nothing", async () => {
    const delivery = await sentDelivery(h.a);
    const email = await sentDelivery(h.a, { channel: "email" });
    const resend = await sentDelivery(h.a, { provider: "resend" });
    const before = await snapshot();
    const cases: Array<[string, Delivery, URLSearchParams, string]> = [
      ["email delivery", email, statusForm(email, { To: email.to }), "unknown_delivery"],
      ["provider resend", resend, statusForm(resend), "unknown_delivery"],
      ["unknown delivery", { ...delivery, deliveryId: randomUUID() }, statusForm(delivery), "unknown_delivery"],
      ["unknown tenant", { ...delivery, tenantId: randomUUID() }, statusForm(delivery), "unknown_delivery"],
      ["tenant not a uuid", { ...delivery, tenantId: "halden-rowe" }, statusForm(delivery), "unknown_delivery"],
      ["delivery not a uuid", { ...delivery, deliveryId: "1" }, statusForm(delivery), "unknown_delivery"],
      ["To is not the pinned recipient", delivery, statusForm(delivery, { To: phone() }), "recipient_mismatch"],
      ["another MessageSid", delivery, statusForm(delivery, { MessageSid: newSid() }), "message_mismatch"],
    ];
    for (const [name, target, params, reason] of cases)
      expect(await postStatus(target, params), name).toEqual({ status: 200, body: { handled: false, reason } });
    expect(await snapshot()).toEqual(before);
  });

  it("acknowledges a signed callback of a shape it does not read", async () => {
    const delivery = await sentDelivery(h.a);
    const before = await snapshot();
    const cases: Array<[string, URLSearchParams]> = [
      ["no MessageSid", statusForm(delivery, { MessageSid: undefined })],
      ["MessageSid not a message SID", statusForm(delivery, { MessageSid: "SM1" })],
      ["no MessageStatus", statusForm(delivery, { MessageStatus: undefined })],
      ["no To", statusForm(delivery, { To: undefined })],
      ["ErrorCode not a number", statusForm(delivery, { ErrorCode: "oops" })],
    ];
    for (const [name, params] of cases)
      expect(await postStatus(delivery, params), name).toEqual({ status: 200, body: { handled: false, reason: "unread_callback" } });
    expect(await snapshot()).toEqual(before);
  });
});

describe("signature, account and body checks (T-6)", () => {
  it("answers 401 with one fixed body for unsigned, wrongly signed or tampered callbacks and writes nothing", async () => {
    const delivery = await sentDelivery(h.a);
    const params = statusForm(delivery);
    const path = statusPath(delivery.tenantId, delivery.deliveryId);
    const before = await snapshot();
    const attempts: Array<[string, Post]> = [
      ["no signature", { unsigned: true }],
      ["empty signature", { unsigned: true, headers: { "X-Twilio-Signature": "" } }],
      ["not base64", { unsigned: true, headers: { "X-Twilio-Signature": "not a signature!" } }],
      ["wrong token", { token: OTHER_TWILIO_AUTH_TOKEN }],
      ["signed for another tenant's path", { signedUrl: TWILIO_WEBHOOK_BASE_URL + statusPath(h.b.tenantId, delivery.deliveryId) }],
      ["signed for another delivery", { signedUrl: TWILIO_WEBHOOK_BASE_URL + statusPath(delivery.tenantId, randomUUID()) }],
      ["signed with a query the request lacks", { signedUrl: `${TWILIO_WEBHOOK_BASE_URL}${path}?retry=1` }],
      ["signed over http, not the configured https base", { signedUrl: `http://api.example.test${path}` }],
      ["To changed after signing", { signedParams: statusForm(delivery, { To: phone() }) }],
      ["status changed after signing", { signedParams: statusForm(delivery, { MessageStatus: "failed" }) }],
      ["a field added after signing", { signedParams: statusForm(delivery, { ErrorCode: undefined }), body: `${params}&ErrorCode=21610` }],
    ];
    for (const [name, options] of attempts) {
      const response = await postStatus(delivery, params, options);
      expect(response.status, name).toBe(401);
      expect(response.body, name).toEqual(UNAUTHORIZED);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("rebuilds the signed URL from the configured base, never from the Host header", async () => {
    const delivery = await sentDelivery(h.a);
    const params = statusForm(delivery);
    const path = statusPath(delivery.tenantId, delivery.deliveryId);
    const before = await snapshot();
    // Signed over the host an attacker controls and sent with that host: refused either way.
    const evil = `https://evil.example${path}`;
    for (const options of [
      { signedUrl: evil, headers: { Host: "evil.example" } },
      { signedUrl: evil, requestUrl: evil },
      { signedUrl: evil, requestUrl: evil, headers: { Host: "evil.example" } },
    ] satisfies Post[]) {
      const response = await postStatus(delivery, params, options);
      expect(response).toEqual({ status: 401, body: UNAUTHORIZED });
    }
    expect(await snapshot()).toEqual(before);
    // Signed over the configured base: accepted whatever host the request arrived on.
    expect(await postStatus(delivery, params, { headers: { Host: "evil.example" } })).toEqual({ status: 200, body: { handled: true } });
    expect(await postStatus(delivery, params, { requestUrl: evil })).toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(h.a.tenantId, delivery.deliveryId)).toHaveLength(1);
  });

  it("signs the query string as received", async () => {
    const delivery = await sentDelivery(h.a);
    const path = `${statusPath(delivery.tenantId, delivery.deliveryId)}?attempt=2`;
    const response = await post(path, statusForm(delivery));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text)).toEqual({ handled: true });
  });

  it("accepts the previous token during a rotation, never a third", async () => {
    const delivery = await sentDelivery(h.a);
    expect(await postStatus(delivery, statusForm(delivery), { token: PREVIOUS_TWILIO_AUTH_TOKEN }))
      .toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(h.a.tenantId, delivery.deliveryId)).toHaveLength(1);
    const delivered = statusForm(delivery, { MessageStatus: "delivered" });
    expect(await postStatus(delivery, delivered, { token: OTHER_TWILIO_AUTH_TOKEN })).toEqual({ status: 401, body: UNAUTHORIZED });
    expect(await statusEvents(h.a.tenantId, delivery.deliveryId)).toHaveLength(1);
  });

  it("refuses a correctly signed callback for another Twilio account", async () => {
    const delivery = await sentDelivery(h.a);
    const before = await snapshot();
    expect(await postStatus(delivery, statusForm(delivery, { AccountSid: OTHER_ACCOUNT_SID })))
      .toEqual({ status: 401, body: UNAUTHORIZED });
    expect(await postStatus(delivery, statusForm(delivery, { AccountSid: undefined })))
      .toEqual({ status: 401, body: UNAUTHORIZED });
    const inbound = await postInbound(h.a.tenantId, inboundForm(NUMBER_A, phone(), "STOP", newSid(), { AccountSid: OTHER_ACCOUNT_SID }));
    expect(inbound.status).toBe(401);
    expect(JSON.parse(inbound.body)).toEqual(UNAUTHORIZED);
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a body over 64 KiB with 413", async () => {
    const delivery = await sentDelivery(h.a);
    const before = await snapshot();
    const big = statusForm(delivery, { Padding: "x".repeat(64 * 1024) });
    const response = await postStatus(delivery, big);
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: "ValidationFailed" } });
    const inbound = await postInbound(h.a.tenantId, inboundForm(NUMBER_A, phone(), "STOP", newSid(), { Padding: "x".repeat(64 * 1024) }));
    expect(inbound.status).toBe(413);
    expect(await snapshot()).toEqual(before);
  });

  it("answers 401 to an inbound text that is not signed", async () => {
    const before = await snapshot();
    const response = await postInbound(h.a.tenantId, inboundForm(NUMBER_A, phone(), "STOP"), { unsigned: true });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual(UNAUTHORIZED);
    const tampered = await postInbound(h.a.tenantId, inboundForm(NUMBER_A, phone(), "STOP"), {
      signedParams: inboundForm(NUMBER_A, phone(), "HELLO"),
    });
    expect(tampered.status).toBe(401);
    expect(await snapshot()).toEqual(before);
  });
});

describe("tenancy (T-6, T-7)", () => {
  it("never lets tenant B's callback URL reach tenant A's delivery", async () => {
    const shared = phone();
    const deliveryA = await sentDelivery(h.a, { to: shared });
    const deliveryB = await sentDelivery(h.b, { to: shared });
    const before = await snapshot();
    // Signed by Twilio over B's URL naming A's delivery, and the reverse: neither tenant has it.
    for (const target of [
      { ...deliveryA, tenantId: h.b.tenantId },
      { ...deliveryB, tenantId: h.a.tenantId },
    ]) {
      expect(await postStatus(target, statusForm(target, { MessageStatus: "failed", ErrorCode: "21610" })))
        .toEqual({ status: 200, body: { handled: false, reason: "unknown_delivery" } });
    }
    expect(await snapshot()).toEqual(before);

    // A's own callback records evidence in A only.
    expect(await postStatus(deliveryA)).toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(h.a.tenantId, deliveryA.deliveryId)).toHaveLength(1);
    expect(await statusEvents(h.b.tenantId, deliveryB.deliveryId)).toEqual([]);
    expect((await snapshot()).b).toEqual(before.b);
  });

  it("lets the runtime role read only its own tenant's status events and number", async () => {
    const delivery = await sentDelivery(h.a);
    expect(await postStatus(delivery)).toEqual({ status: 200, body: { handled: true } });
    const db = h.database.db;
    const eventsOf = (scope: string, owner: string) => db.tenant(scope, async (tx) => (await tx.query<{ delivery_id: string }>(
      "SELECT delivery_id FROM sms_status_events WHERE tenant_id=$1", [owner])).rows.map((row) => row.delivery_id));
    const numbersSeenBy = (scope: string) => db.tenant(scope, async (tx) => (await tx.query<{ tenant_id: string; phone_number: string }>(
      "SELECT tenant_id, phone_number FROM sms_numbers")).rows);

    expect(await eventsOf(h.a.tenantId, h.a.tenantId)).toContain(delivery.deliveryId);
    expect(await eventsOf(h.b.tenantId, h.a.tenantId)).toEqual([]);
    const seenByB = await db.tenant(h.b.tenantId, async (tx) => (await tx.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM sms_status_events")).rows);
    expect(seenByB.every((row) => row.tenant_id === h.b.tenantId)).toBe(true);

    expect(await numbersSeenBy(h.a.tenantId)).toEqual([{ tenant_id: h.a.tenantId, phone_number: NUMBER_A }]);
    expect(await numbersSeenBy(h.b.tenantId)).toEqual([{ tenant_id: h.b.tenantId, phone_number: NUMBER_B }]);
    // Only an operator (the service role) assigns numbers.
    await expect(db.tenant(h.a.tenantId, (tx) => tx.query(
      "UPDATE sms_numbers SET help_reply='Halden & Rowe' WHERE tenant_id=$1", [h.a.tenantId]))).rejects.toThrow();
  });

  it("keeps the sms-status: and sms-inbound: key prefixes away from members and MCP", async () => {
    expect(idempotencyKeySchema.safeParse("sms-status:SM1").success).toBe(false);
    expect(idempotencyKeySchema.safeParse(`SMS-STATUS:${newSid()}:sent`).success).toBe(false);
    expect(idempotencyKeySchema.safeParse("sms-inbound:SM1").success).toBe(false);
    for (const key of [`sms-status:${newSid()}:sent`, `sms-inbound:${newSid()}`]) {
      const response = await call(h.app, "POST", "/v1/crm/contacts", {
        token: h.a.token, key, body: { displayName: "Ada", email: "ada@haldenrowe.example" },
      });
      expect(response.status, key).toBe(400);
    }
  });
});

describe("inbound keywords with Twilio's own replies (T-6, T-8 provider, D-9)", () => {
  it("suppresses the sender for STOP, any case, with surrounding space and punctuation", async () => {
    for (const body of ["STOP", " stop! ", "Unsubscribe"]) {
      const from = phone();
      const sid = newSid();
      const response = await postInbound(h.a.tenantId, inboundForm(NUMBER_A, from, body, sid));
      expect(response, body).toEqual({ status: 200, contentType: expect.stringMatching(/^text\/xml/), body: EMPTY });
      expect(await suppressionOf(h.a.tenantId, from), body).toEqual([
        { channel: "sms", address: from, reason: "stop", source: `sms:${sid}` },
      ]);
      expect(await suppressionOf(h.b.tenantId, from), body).toEqual([]);
    }
  });

  it("replays a repeat of the same message: one action, one suppression", async () => {
    const from = phone();
    const sid = newSid();
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect((await postInbound(h.a.tenantId, inboundForm(NUMBER_A, from, "STOP", sid))).body).toBe(EMPTY);
    expect(await actionsWithKey(h.a.tenantId, `sms-inbound:${sid}`)).toBe(1);
    expect(await suppressionOf(h.a.tenantId, from)).toHaveLength(1);
  });

  it("lifts a stop with START, and keeps a lasting reason", async () => {
    const from = phone();
    await postInbound(h.a.tenantId, inboundForm(NUMBER_A, from, "STOP"));
    expect(await suppressionOf(h.a.tenantId, from)).toHaveLength(1);
    expect(await postInbound(h.a.tenantId, inboundForm(NUMBER_A, from, "start")))
      .toEqual({ status: 200, contentType: expect.stringMatching(/^text\/xml/), body: EMPTY });
    expect(await suppressionOf(h.a.tenantId, from)).toEqual([]);

    for (const reason of ["bounce", "manual"]) {
      const listed = phone();
      await suppress(h.a.tenantId, listed, reason);
      expect((await postInbound(h.a.tenantId, inboundForm(NUMBER_A, listed, "START"))).body).toBe(EMPTY);
      expect(await suppressionOf(h.a.tenantId, listed), reason).toEqual([
        { channel: "sms", address: listed, reason, source: "test:seed" },
      ]);
    }
  });

  it("answers HELP with nothing (Twilio replies) and changes nothing", async () => {
    const before = await snapshot();
    expect(await postInbound(h.a.tenantId, inboundForm(NUMBER_A, phone(), "HELP")))
      .toEqual({ status: 200, contentType: expect.stringMatching(/^text\/xml/), body: EMPTY });
    expect(await snapshot()).toEqual(before);
  });

  it("changes nothing for texts it does not act on", async () => {
    const tenantC = randomUUID();
    await h.fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Tenant C')", [tenantC]));
    const sid = newSid();
    const before = await snapshot();
    const cases: Array<[string, string, URLSearchParams]> = [
      ["not a keyword", h.a.tenantId, inboundForm(NUMBER_A, phone(), "Can I move my fitting to Tuesday?", sid)],
      ["keyword inside a sentence", h.a.tenantId, inboundForm(NUMBER_A, phone(), "please stop texting me")],
      ["empty body", h.a.tenantId, inboundForm(NUMBER_A, phone(), "")],
      ["no body field", h.a.tenantId, inboundForm(NUMBER_A, phone(), "STOP", newSid(), { Body: undefined })],
      ["To is not the tenant's number", h.a.tenantId, inboundForm(phone(), phone(), "STOP")],
      ["tenant without a number", tenantC, inboundForm(NUMBER_A, phone(), "STOP")],
      ["tenant B's URL, tenant A's number", h.b.tenantId, inboundForm(NUMBER_A, phone(), "STOP")],
      ["tenant A's URL, tenant B's number", h.a.tenantId, inboundForm(NUMBER_B, phone(), "STOP")],
      ["tenant not a uuid", "halden-rowe", inboundForm(NUMBER_A, phone(), "STOP")],
      ["sender is a short code", h.a.tenantId, inboundForm(NUMBER_A, "12345", "STOP")],
      ["sender not E.164", h.a.tenantId, inboundForm(NUMBER_A, "5555550142", "STOP")],
      ["no From", h.a.tenantId, inboundForm(NUMBER_A, phone(), "STOP", newSid(), { From: undefined })],
      ["MessageSid not a message SID", h.a.tenantId, inboundForm(NUMBER_A, phone(), "STOP", "SM1")],
    ];
    for (const [name, tenantId, params] of cases)
      expect(await postInbound(tenantId, params), name)
        .toEqual({ status: 200, contentType: expect.stringMatching(/^text\/xml/), body: EMPTY });
    expect(await snapshot()).toEqual(before);
    expect(await actionsWithKey(h.a.tenantId, `sms-inbound:${sid}`)).toBe(0);
    expect(await h.fixture.service(async (tx) => (await tx.query(
      "SELECT 1 FROM suppressions WHERE tenant_id=$1", [tenantC])).rowCount)).toBe(0);
  });
});

describe("inbound keywords answered by the app (T-8 app)", () => {
  let app: ApiHarness;
  const reports: unknown[] = [];
  const HELP_A = "Halden & Rowe <fittings>: call +15555550199 or reply STOP to opt out.";
  beforeAll(async () => {
    app = await createApiHarness({ twilioWebhook: { keywordReplies: "app", report: (event) => reports.push(event) } });
    await assignNumbers(app, HELP_A);
    // A business name that needs escaping in TwiML.
    await app.fixture.service((tx) => tx.query("UPDATE tenants SET name='Halden & Rowe' WHERE tenant_id=$1", [app.a.tenantId]));
  });
  afterAll(async () => app.close());
  const inbound = (tenantId: string, params: URLSearchParams) => postInbound(tenantId, params, { app: app.app });

  it("confirms STOP with the business name, XML-escaped, and replays the same reply", async () => {
    const from = phone();
    const sid = newSid();
    const expected = message("Halden &amp; Rowe: You are unsubscribed and will get no more messages. Reply START to resubscribe.");
    for (let attempt = 0; attempt < 2; attempt += 1)
      expect(await inbound(app.a.tenantId, inboundForm(NUMBER_A, from, "Stop", sid)))
        .toEqual({ status: 200, contentType: expect.stringMatching(/^text\/xml/), body: expected });
    expect(await suppressionOf(app.a.tenantId, from, app)).toEqual([
      { channel: "sms", address: from, reason: "stop", source: `sms:${sid}` },
    ]);
    expect(await actionsWithKey(app.a.tenantId, `sms-inbound:${sid}`, app)).toBe(1);
    expect(reports).toContainEqual({ kind: "inbound", messageSid: sid, outcome: { handled: true, keyword: "stop", reply: expect.any(String) } });
  });

  it("confirms START only when it lifted the stop", async () => {
    const from = phone();
    await inbound(app.a.tenantId, inboundForm(NUMBER_A, from, "STOP"));
    expect((await inbound(app.a.tenantId, inboundForm(NUMBER_A, from, "UNSTOP"))).body)
      .toBe(message("Halden &amp; Rowe: You are resubscribed. Reply STOP to opt out."));
    expect(await suppressionOf(app.a.tenantId, from, app)).toEqual([]);

    for (const reason of ["bounce", "manual"]) {
      const listed = phone();
      await suppress(app.b.tenantId, listed, reason, app);
      expect(await inbound(app.b.tenantId, inboundForm(NUMBER_B, listed, "START")), reason)
        .toEqual({ status: 200, contentType: expect.stringMatching(/^text\/xml/), body: EMPTY });
      expect(await suppressionOf(app.b.tenantId, listed, app), reason).toEqual([
        { channel: "sms", address: listed, reason, source: "test:seed" },
      ]);
    }
  });

  it("answers HELP with the number's own reply, else the default, and changes nothing", async () => {
    const before = await snapshot(app);
    expect((await inbound(app.a.tenantId, inboundForm(NUMBER_A, phone(), "help"))).body)
      .toBe(message("Halden &amp; Rowe &lt;fittings&gt;: call +15555550199 or reply STOP to opt out."));
    expect((await inbound(app.b.tenantId, inboundForm(NUMBER_B, phone(), " INFO? "))).body)
      .toBe(message("Tenant B: Reply STOP to opt out, START to resubscribe. Msg &amp; data rates may apply."));
    expect(await snapshot(app)).toEqual(before);
  });

  it("gives no reply to a text it does not act on", async () => {
    const before = await snapshot(app);
    expect((await inbound(app.a.tenantId, inboundForm(NUMBER_A, phone(), "Thanks!"))).body).toBe(EMPTY);
    expect((await inbound(app.b.tenantId, inboundForm(NUMBER_A, phone(), "STOP"))).body).toBe(EMPTY);
    expect((await inbound(app.a.tenantId, inboundForm(NUMBER_A, "12345", "HELP"))).body).toBe(EMPTY);
    expect(await snapshot(app)).toEqual(before);
  });
});

describe("database errors answer 503 so Twilio retries (T-6)", () => {
  /** Makes one table's writes fail with a SQLSTATE for one value of one column, as a lock wait past lock_timeout would. */
  async function failWrites(table: string, column: string, value: string, sqlstate: string) {
    const name = `fail_${randomBytes(4).toString("hex")}`;
    await h.database.pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.${column} = '${value}' THEN RAISE EXCEPTION 'injected' USING ERRCODE = '${sqlstate}'; END IF;
        RETURN NEW;
      END $f$`);
    await h.database.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    return async () => {
      await h.database.pool.query(`DROP TRIGGER ${name} ON public.${table}`);
      await h.database.pool.query(`DROP FUNCTION public.${name}()`);
    };
  }

  it.each(["55P03", "40001", "40P01"])("a status callback that hits %s answers 503 and records once on Twilio's retry", async (sqlstate) => {
    const delivery = await sentDelivery(h.a);
    const restore = await failWrites("sms_status_events", "provider_message_id", delivery.messageSid, sqlstate);
    const response = await post(statusPath(delivery.tenantId, delivery.deliveryId), statusForm(delivery));
    await restore();
    expect(response.status).toBe(503);
    expect(JSON.parse(response.text)).toMatchObject({ error: { code: "Unavailable" } });
    expect(await statusEvents(delivery.tenantId, delivery.deliveryId)).toEqual([]);
    expect(await postStatus(delivery)).toEqual({ status: 200, body: { handled: true } });
    expect(await statusEvents(delivery.tenantId, delivery.deliveryId)).toHaveLength(1);
  });

  it("answers 503 with Retry-After to a STOP that hits a lock wait, and suppresses once on Twilio's retry", async () => {
    const from = phone();
    const sid = newSid();
    const restore = await failWrites("suppressions", "address", from, "55P03");
    const first = await h.app.request(inboundPath(h.a.tenantId), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signTwilioRequest(TWILIO_AUTH_TOKEN, TWILIO_WEBHOOK_BASE_URL + inboundPath(h.a.tenantId),
          inboundForm(NUMBER_A, from, "STOP", sid)),
      },
      body: inboundForm(NUMBER_A, from, "STOP", sid).toString(),
    });
    await restore();
    expect(first.status).toBe(503);
    expect(first.headers.get("retry-after")).toBe("1");
    expect(await suppressionOf(h.a.tenantId, from)).toEqual([]);
    expect(await postInbound(h.a.tenantId, inboundForm(NUMBER_A, from, "STOP", sid))).toMatchObject({ status: 200, body: EMPTY });
    expect(await suppressionOf(h.a.tenantId, from)).toEqual([
      { channel: "sms", address: from, reason: "stop", source: `sms:${sid}` },
    ]);
  });
});

describe("without Twilio configured", () => {
  let off: ApiHarness;
  beforeAll(async () => { off = await createApiHarness(); });
  afterAll(async () => off.close());

  it("serves no Twilio route", async () => {
    const delivery = { tenantId: off.a.tenantId, deliveryId: randomUUID(), to: phone(), messageSid: newSid() };
    const status = await postStatus(delivery, statusForm(delivery), { app: off.app });
    expect(status.status).toBe(404);
    expect(status.body).toMatchObject({ error: { code: "NotFound" } });
    const inbound = await postInbound(off.a.tenantId, inboundForm(NUMBER_A, phone(), "STOP"), { app: off.app });
    expect(inbound.status).toBe(404);
  });
});
