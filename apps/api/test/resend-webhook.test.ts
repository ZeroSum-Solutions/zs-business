import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { idempotencyKeySchema, MESSAGE_SEND_REQUESTED, SUPPRESSION_RECORD_ACTION } from "@zs/contracts";
import { signResendWebhook } from "@zs/core";
import {
  call,
  clock,
  createApiHarness,
  NOW,
  PREVIOUS_RESEND_WEBHOOK_SECRET,
  RESEND_WEBHOOK_SECRET,
  type ApiHarness,
  type TenantSetup,
} from "./helpers.js";

const NOW_SECONDS = Math.floor(clock.now().getTime() / 1000);
const UNAUTHORIZED = { error: { code: "Unauthorized", message: "Invalid webhook signature", details: {} } };

let h: ApiHarness;
/** What the webhook reported, for the logs, in order. */
const reports: { id: string; type: string; reason: string | null }[] = [];
beforeAll(async () => {
  h = await createApiHarness({
    resendWebhook: {
      secrets: { current: RESEND_WEBHOOK_SECRET, previous: PREVIOUS_RESEND_WEBHOOK_SECRET },
      report: ({ id, type, outcome }) => { reports.push({ id, type, reason: outcome.handled ? null : outcome.reason }); },
    },
  });
});
afterAll(async () => h.close());

/**
 * A delivery as the core worker leaves it after a Resend send: a contact, the producing action
 * and its outbox event, and a sent message_deliveries row pinned to the recipient address. With
 * `providerMessageId: null` it is the `uncertain` row a lost provider reply leaves.
 */
async function sentDelivery(
  tenant: TenantSetup,
  options: { address?: string; provider?: string; providerMessageId?: string | null } = {},
) {
  const address = options.address ?? `guest-${randomUUID().slice(0, 8)}@haldenrowe.example`;
  const ids = { contact: randomUUID(), action: randomUUID(), outbox: randomUUID(), delivery: randomUUID(), message: randomUUID() };
  const emailId = options.providerMessageId === undefined ? randomUUID() : options.providerMessageId;
  await h.fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,created_at,updated_at)
       VALUES ($1,$2,'Halden Guest',$3,$4,$4)`,
      [tenant.tenantId, ids.contact, address, NOW]);
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
       VALUES ($1,$2,$3,$4,'email',$5,$6,'Your booking','Thanks for booking.',$7,$8,$8,1,$9,$10,$11,$12,$13,$8,$8)`,
      [tenant.tenantId, ids.delivery, ids.outbox, ids.message, ids.contact, ids.action, emailId === null ? "uncertain" : "sent",
        NOW, `delivery:${ids.delivery}`, address, options.provider ?? "resend", emailId, emailId === null]);
  });
  return { tenantId: tenant.tenantId, deliveryId: ids.delivery, address, emailId };
}
type Delivery = Awaited<ReturnType<typeof sentDelivery>>;

/** The event Resend posts about a delivery; `data` overrides merge over the tagged defaults. */
function emailEvent(type: string, delivery: Delivery, data: Record<string, unknown> = {}) {
  return {
    type,
    created_at: NOW,
    data: {
      email_id: delivery.emailId ?? randomUUID(),
      from: "Halden & Rowe <bookings@haldenrowe.example>",
      to: [delivery.address],
      subject: "Your booking",
      created_at: NOW,
      tags: { zs_tenant: delivery.tenantId, zs_delivery: delivery.deliveryId },
      ...data,
    },
  };
}
const bounce = (delivery: Delivery, bounceType = "Permanent") =>
  emailEvent("email.bounced", delivery, { bounce: { type: bounceType, subType: "General", message: "Mailbox does not exist" } });

const newId = () => `msg_${randomUUID().replaceAll("-", "")}`;

interface Post {
  id?: string;
  timestamp?: number;
  secret?: string;
  /** Signs this instead of the body sent, for tampering. */
  signedBody?: string;
  headers?: Record<string, string>;
  unsigned?: boolean;
}
/** POST a raw body to the webhook, signed with the current secret at the harness clock's time. */
async function post(body: string, options: Post = {}, app = h.app) {
  const id = options.id ?? newId();
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const headers: Record<string, string> = options.unsigned ? {} : {
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": signResendWebhook(options.secret ?? RESEND_WEBHOOK_SECRET, id, timestamp, options.signedBody ?? body),
  };
  const response = await app.request("/webhooks/resend", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers, ...options.headers },
    body,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as unknown : null };
}
const deliver = (event: unknown, options: Post = {}) => post(JSON.stringify(event), options);

const suppressions = (tenantId: string) => h.fixture.service(async (tx) => (await tx.query<{
  channel: string; address: string; reason: string; source: string;
}>("SELECT channel::text AS channel, address, reason, source FROM suppressions WHERE tenant_id=$1 ORDER BY address", [tenantId])).rows);
const actionCount = (tenantId: string) => h.fixture.service(async (tx) =>
  Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND action_type=$2",
    [tenantId, SUPPRESSION_RECORD_ACTION])).rows[0]!.n));
/** Every suppression and suppression action in both tenants, to show a request changed nothing. */
const snapshot = async () => ({
  a: await suppressions(h.a.tenantId), b: await suppressions(h.b.tenantId),
  actionsA: await actionCount(h.a.tenantId), actionsB: await actionCount(h.b.tenantId),
});

describe("signed bounces and complaints suppress the delivery's address (R-8)", () => {
  it("records one bounce for a permanent bounce", async () => {
    const delivery = await sentDelivery(h.a);
    const before = await actionCount(h.a.tenantId);
    const response = await deliver(bounce(delivery));
    expect(response).toEqual({ status: 200, body: { handled: true } });
    expect((await suppressions(h.a.tenantId)).filter((row) => row.address === delivery.address)).toEqual([{
      channel: "email", address: delivery.address, reason: "bounce", source: `resend:email.bounced:${delivery.deliveryId}`,
    }]);
    expect(await actionCount(h.a.tenantId)).toBe(before + 1);
  });

  it("replays a redelivery with the same svix-id: one suppression, one action", async () => {
    const delivery = await sentDelivery(h.b);
    const event = bounce(delivery);
    const id = newId();
    const before = await actionCount(h.b.tenantId);
    expect(await deliver(event, { id })).toEqual({ status: 200, body: { handled: true } });
    // A retry carries the same ID, re-signed at a later time.
    expect(await deliver(event, { id })).toEqual({ status: 200, body: { handled: true } });
    expect(await deliver(event, { id, timestamp: NOW_SECONDS + 60 })).toEqual({ status: 200, body: { handled: true } });
    expect((await suppressions(h.b.tenantId)).filter((row) => row.address === delivery.address)).toHaveLength(1);
    expect(await actionCount(h.b.tenantId)).toBe(before + 1);
  });

  it("records a complaint", async () => {
    const delivery = await sentDelivery(h.a);
    expect(await deliver(emailEvent("email.complained", delivery))).toEqual({ status: 200, body: { handled: true } });
    expect(await suppressions(h.a.tenantId)).toContainEqual({
      channel: "email", address: delivery.address, reason: "complaint", source: `resend:email.complained:${delivery.deliveryId}`,
    });
  });

  it("records email.suppressed as a bounce", async () => {
    const delivery = await sentDelivery(h.a);
    expect(await deliver(emailEvent("email.suppressed", delivery))).toEqual({ status: 200, body: { handled: true } });
    expect(await suppressions(h.a.tenantId)).toContainEqual({
      channel: "email", address: delivery.address, reason: "bounce", source: `resend:email.suppressed:${delivery.deliveryId}`,
    });
  });

  it("accepts a delivery whose Resend reply was lost (no ID recorded), and tags sent as name/value pairs", async () => {
    const delivery = await sentDelivery(h.a, { providerMessageId: null });
    const event = bounce(delivery);
    event.data.tags = [{ name: "zs_tenant", value: delivery.tenantId }, { name: "zs_delivery", value: delivery.deliveryId }] as never;
    expect(await deliver(event)).toEqual({ status: 200, body: { handled: true } });
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).toContain(delivery.address);
  });

  it("acknowledges other email events without writing anything", async () => {
    const delivery = await sentDelivery(h.a);
    const before = await snapshot();
    const cases = [
      [bounce(delivery, "Transient"), "bounce_not_permanent"],
      [bounce(delivery, "Undetermined"), "bounce_not_permanent"],
      [emailEvent("email.delivered", delivery), "no_suppression"],
      [emailEvent("email.opened", delivery), "no_suppression"],
    ] as const;
    for (const [event, reason] of cases)
      expect(await deliver(event), event.type).toEqual({ status: 200, body: { handled: false, reason } });
    expect(await snapshot()).toEqual(before);
  });
});

describe("signature and body checks (R-7)", () => {
  it("answers 401 for unsigned, wrongly signed, tampered or stale requests and writes nothing", async () => {
    const delivery = await sentDelivery(h.a);
    const body = JSON.stringify(bounce(delivery));
    const other = "whsec_" + Buffer.from(["other", "resend", "z".repeat(32)].join("-")).toString("base64");
    const before = await snapshot();
    const attempts: Array<[string, Post]> = [
      ["unsigned", { unsigned: true }],
      ["wrong secret", { secret: other }],
      ["tampered body", { signedBody: body.replace(delivery.address, "someone-else@haldenrowe.example") }],
      ["six minutes early", { timestamp: NOW_SECONDS - 6 * 60 }],
      ["six minutes late", { timestamp: NOW_SECONDS + 6 * 60 }],
      ["no v1 entry", { headers: { "svix-signature": "v2,AAAA" } }],
      ["bad timestamp", { headers: { "svix-timestamp": "soon" } }],
    ];
    for (const [name, options] of attempts) {
      const response = await post(body, options);
      expect(response.status, name).toBe(401);
      expect(response.body, name).toEqual(UNAUTHORIZED);
    }
    expect(await snapshot()).toEqual(before);
  });

  it("accepts the previous secret during a rotation, and the webhook-* header names", async () => {
    const delivery = await sentDelivery(h.a);
    expect(await deliver(bounce(delivery), { secret: PREVIOUS_RESEND_WEBHOOK_SECRET })).toEqual({ status: 200, body: { handled: true } });
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).toContain(delivery.address);

    const next = await sentDelivery(h.a);
    const body = JSON.stringify(bounce(next));
    const id = newId();
    const response = await post(body, {
      unsigned: true,
      headers: {
        "webhook-id": id,
        "webhook-timestamp": String(NOW_SECONDS),
        "webhook-signature": signResendWebhook(RESEND_WEBHOOK_SECRET, id, NOW_SECONDS, body),
      },
    });
    expect(response).toEqual({ status: 200, body: { handled: true } });
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).toContain(next.address);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const before = await snapshot();
    const response = await post("{not json");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "ValidationFailed" } });
    expect(await snapshot()).toEqual(before);
  });

  it("acknowledges a signed event of a shape it does not read", async () => {
    const before = await snapshot();
    for (const event of [{ type: "contact.created", data: { id: randomUUID() } }, [], "text", { type: "email.delivered" }])
      expect(await deliver(event)).toEqual({ status: 200, body: { handled: false, reason: "unread_event" } });
    expect(await snapshot()).toEqual(before);
  });

  it("reads null optional fields: a bounce with bounce, its type or tags null still suppresses or is told apart", async () => {
    const delivery = await sentDelivery(h.a);
    expect(await deliver(emailEvent("email.bounced", delivery, { bounce: null }))).toEqual({ status: 200, body: { handled: true } });
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).toContain(delivery.address);
    const other = await sentDelivery(h.a);
    expect(await deliver(emailEvent("email.bounced", other, { bounce: { type: null } }))).toEqual({ status: 200, body: { handled: true } });
    const untagged = await sentDelivery(h.a);
    expect(await deliver(emailEvent("email.complained", untagged, { tags: null })))
      .toEqual({ status: 200, body: { handled: false, reason: "untagged" } });
  });

  it("answers 400 and reports a signed bounce, complaint or suppression it cannot read, so Resend retries it", async () => {
    const delivery = await sentDelivery(h.a);
    const before = await snapshot();
    for (const type of ["email.bounced", "email.complained", "email.suppressed"]) {
      const id = newId();
      for (const event of [{ type }, emailEvent(type, delivery, { to: 42 }), emailEvent(type, delivery, { bounce: "Permanent" })]) {
        const response = await deliver(event, { id });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ error: { code: "ValidationFailed", message: "Unreadable suppression event" } });
        expect(reports.at(-1)).toEqual({ id, type, reason: "malformed_event" });
      }
    }
    expect(await snapshot()).toEqual(before);
  });

  it("refuses a body over 256 KiB with 413 before anything else", async () => {
    const delivery = await sentDelivery(h.a);
    const event = { ...bounce(delivery), padding: "x".repeat(256 * 1024) };
    const before = await snapshot();
    const response = await deliver(event);
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: "ValidationFailed" } });
    expect(await snapshot()).toEqual(before);
  });
});

describe("the tenant comes from the email's tags, checked against the delivery row", () => {
  it("ignores events that do not match a sent Resend delivery", async () => {
    const delivery = await sentDelivery(h.a);
    const fake = await sentDelivery(h.a, { provider: "fake" });
    const before = await snapshot();
    const cases: Array<[string, unknown, string]> = [
      ["untagged", emailEvent("email.bounced", delivery, { tags: undefined }), "untagged"],
      ["tags not ids", emailEvent("email.bounced", delivery, { tags: { zs_tenant: "acme", zs_delivery: "1" } }), "untagged"],
      ["unknown delivery", bounce({ ...delivery, deliveryId: randomUUID() }), "unknown_delivery"],
      ["unknown tenant", bounce({ ...delivery, tenantId: randomUUID() }), "unknown_delivery"],
      ["fake provider", bounce(fake), "unknown_delivery"],
      ["email_id mismatch", emailEvent("email.bounced", delivery, { email_id: randomUUID() }), "email_mismatch"],
      ["recipient mismatch", emailEvent("email.bounced", delivery, { to: ["someone-else@haldenrowe.example"] }), "recipient_mismatch"],
    ];
    for (const [name, event, reason] of cases)
      expect(await deliver(event), name).toEqual({ status: 200, body: { handled: false, reason } });
    expect(await snapshot()).toEqual(before);
  });

  it("never lets tenant A's tags reach tenant B's delivery or list (two-tenant denial)", async () => {
    // Both tenants mailed the same person.
    const address = `shared-${randomUUID().slice(0, 8)}@haldenrowe.example`;
    const deliveryA = await sentDelivery(h.a, { address });
    const deliveryB = await sentDelivery(h.b, { address });
    const before = await snapshot();
    // Tagged with A's tenant and B's delivery, and the reverse: neither tenant has such a delivery.
    for (const event of [
      bounce({ ...deliveryB, tenantId: h.a.tenantId }),
      bounce({ ...deliveryA, tenantId: h.b.tenantId }),
    ]) expect(await deliver(event)).toEqual({ status: 200, body: { handled: false, reason: "unknown_delivery" } });
    expect(await snapshot()).toEqual(before);

    // B's own bounce suppresses the address in B only.
    expect(await deliver(bounce(deliveryB))).toEqual({ status: 200, body: { handled: true } });
    expect((await suppressions(h.b.tenantId)).filter((row) => row.address === address)).toEqual([{
      channel: "email", address, reason: "bounce", source: `resend:email.bounced:${deliveryB.deliveryId}`,
    }]);
    expect((await suppressions(h.a.tenantId)).map((row) => row.address)).not.toContain(address);
    expect(await actionCount(h.a.tenantId)).toBe(before.actionsA);
  });

  it("keeps the email-feedback: key prefix away from members and MCP", async () => {
    expect(idempotencyKeySchema.safeParse("email-feedback:msg_1").success).toBe(false);
    const response = await call(h.app, "POST", "/v1/crm/contacts", {
      token: h.a.token, key: `email-feedback:${newId()}`, body: { displayName: "Ada", email: "ada@haldenrowe.example" },
    });
    expect(response.status).toBe(400);
  });
});

describe("database errors answer 503 so Resend retries (R-8)", () => {
  /** Makes suppression writes for one address fail with a SQLSTATE, as a lock wait past lock_timeout would. */
  async function failSuppressions(address: string, sqlstate: string) {
    const name = `fail_${randomBytes(4).toString("hex")}`;
    await h.database.pool.query(`CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF NEW.address = '${address}' THEN RAISE EXCEPTION 'injected' USING ERRCODE = '${sqlstate}'; END IF;
        RETURN NEW;
      END $f$`);
    await h.database.pool.query(`CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON public.suppressions FOR EACH ROW EXECUTE FUNCTION public.${name}()`);
    return async () => {
      await h.database.pool.query(`DROP TRIGGER ${name} ON public.suppressions`);
      await h.database.pool.query(`DROP FUNCTION public.${name}()`);
    };
  }

  it.each(["55P03", "40001", "40P01", "57014"])("a bounce that hits %s answers 503 and suppresses once on Resend's retry", async (sqlstate) => {
    const delivery = await sentDelivery(h.a);
    const id = newId();
    const restore = await failSuppressions(delivery.address, sqlstate);
    const first = await deliver(bounce(delivery), { id });
    await restore();
    expect(first).toMatchObject({ status: 503, body: { error: { code: "Unavailable" } } });
    const mine = async () => (await suppressions(delivery.tenantId)).filter((row) => row.address === delivery.address);
    expect(await mine()).toEqual([]);
    expect(await deliver(bounce(delivery), { id })).toEqual({ status: 200, body: { handled: true } });
    expect(await mine()).toEqual([
      { channel: "email", address: delivery.address, reason: "bounce", source: `resend:email.bounced:${delivery.deliveryId}` },
    ]);
  });
});

describe("without a webhook secret", () => {
  let off: ApiHarness;
  beforeAll(async () => { off = await createApiHarness(); });
  afterAll(async () => off.close());

  it("serves no webhook route", async () => {
    const response = await post(JSON.stringify({ type: "email.bounced", data: {} }), {}, off.app);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "NotFound" } });
  });
});
