// docs/requirements/inbound-email.md tests 3, 4, 5 and 10 at the HTTP edge: the signed inbound
// webhook (IE-8), routing on to, cc and bcc (IE-3) and the report that never names an address (IE-4).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Conflict, INBOUND_EMAIL_RECEIVED_EVENT } from "@zs/contracts";
import { DatabaseUnavailable, signResendWebhook } from "@zs/core";
import type { ScopedDatabase } from "@zs/db";
import {
  appOnDatabase,
  clock,
  createApiHarness,
  INBOUND_EMAIL_DOMAIN,
  PREVIOUS_RESEND_INBOUND_WEBHOOK_SECRET,
  RESEND_INBOUND_WEBHOOK_SECRET,
  RESEND_WEBHOOK_SECRET,
  type ApiHarness,
  type TenantSetup,
} from "./helpers.js";
import type { ResendInboundWebhookConfig } from "../src/app.js";

const PATH = "/webhooks/resend/inbound";
const NOW_SECONDS = Math.floor(clock.now().getTime() / 1000);
const UNAUTHORIZED = { error: { code: "Unauthorized", message: "Invalid webhook signature", details: {} } };
const SENDER = "Pat Guest <pat.guest@example.org>";
const SUBJECT = "Question about my booking";

type Report = Parameters<NonNullable<ResendInboundWebhookConfig["report"]>>[0];
let h: ApiHarness;
const reports: Report[] = [];
const report = (event: Report) => { reports.push(event); };
beforeAll(async () => {
  h = await createApiHarness({
    resendInboundWebhook: {
      secrets: { current: RESEND_INBOUND_WEBHOOK_SECRET, previous: PREVIOUS_RESEND_INBOUND_WEBHOOK_SECRET },
      report,
    },
  });
});
afterAll(async () => h.close());

const newId = () => `msg_${randomUUID().replaceAll("-", "")}`;
const newEmailId = () => randomUUID();

async function handleOf(tenant: TenantSetup): Promise<string> {
  return h.fixture.service(async (tx) => (await tx.query<{ handle: string }>(
    "SELECT handle FROM inbound_email_addresses WHERE tenant_id=$1 AND status='active' AND kind='reply'",
    [tenant.tenantId])).rows[0]!.handle);
}

function received(data: Record<string, unknown>) {
  return {
    type: "email.received",
    created_at: clock.now().toISOString(),
    data: { email_id: newEmailId(), from: SENDER, to: [], subject: SUBJECT, created_at: clock.now().toISOString(), ...data },
  };
}

interface Post {
  id?: string;
  timestamp?: number;
  secret?: string;
  signedBody?: string;
  headers?: Record<string, string>;
  unsigned?: boolean;
  webhookHeaders?: boolean;
}
async function post(body: string, options: Post = {}, app = h.app) {
  const id = options.id ?? newId();
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const signature = signResendWebhook(options.secret ?? RESEND_INBOUND_WEBHOOK_SECRET, id, timestamp, options.signedBody ?? body);
  const prefix = options.webhookHeaders ? "webhook" : "svix";
  const headers: Record<string, string> = options.unsigned ? {} : {
    [`${prefix}-id`]: id, [`${prefix}-timestamp`]: String(timestamp), [`${prefix}-signature`]: signature,
  };
  const response = await app.request(PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers, ...options.headers },
    body,
  });
  const text = await response.text();
  let parsed: unknown = text;
  try { parsed = text ? JSON.parse(text) as unknown : null; } catch { /* a plain-text 404 */ }
  return { status: response.status, body: parsed };
}
const deliver = (event: unknown, options: Post = {}, app = h.app) => post(JSON.stringify(event), options, app);

const rows = (tenantId: string) => h.fixture.service(async (tx) => (await tx.query<{
  provider_email_id: string; from_address: string; subject: string | null; reply_ref: string | null; status: string;
}>("SELECT provider_email_id, from_address, subject, reply_ref, status FROM inbound_emails WHERE tenant_id=$1 ORDER BY provider_email_id",
  [tenantId])).rows);
const events = (tenantId: string) => h.fixture.service(async (tx) => Number((await tx.query<{ n: string }>(
  "SELECT count(*) AS n FROM outbox WHERE tenant_id=$1 AND event_type=$2", [tenantId, INBOUND_EMAIL_RECEIVED_EVENT])).rows[0]!.n));
const snapshot = async () => ({
  a: await rows(h.a.tenantId), b: await rows(h.b.tenantId), eventsA: await events(h.a.tenantId), eventsB: await events(h.b.tenantId),
});

describe("signature and body checks (test 4, IE-8)", () => {
  it("answers 401 for missing, stale, forged or tampered signatures and the bounce secret, and writes nothing", async () => {
    const event = received({ to: [`${await handleOf(h.a)}@${INBOUND_EMAIL_DOMAIN}`] });
    const body = JSON.stringify(event);
    const forged = "whsec_" + Buffer.from(["forged", "inbound", "z".repeat(32)].join("-")).toString("base64");
    const before = await snapshot();
    const attempts: Array<[string, Post]> = [
      ["missing", { unsigned: true }],
      ["forged", { secret: forged }],
      ["the outbound bounce secret", { secret: RESEND_WEBHOOK_SECRET }],
      ["tampered", { signedBody: body.replace(SUBJECT, "Something else") }],
      ["stale", { timestamp: NOW_SECONDS - 6 * 60 }],
      ["from the future", { timestamp: NOW_SECONDS + 6 * 60 }],
    ];
    for (const [name, options] of attempts)
      expect(await post(body, options), name).toEqual({ status: 401, body: UNAUTHORIZED });
    expect(await snapshot()).toEqual(before);
  });

  it("accepts the previous secret during a rotation, and the webhook-* header names", async () => {
    const handle = await handleOf(h.a);
    const before = (await rows(h.a.tenantId)).length;
    expect(await deliver(received({ to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`] }), { secret: PREVIOUS_RESEND_INBOUND_WEBHOOK_SECRET }))
      .toEqual({ status: 200, body: { handled: true } });
    expect(await deliver(received({ to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`] }), { webhookHeaders: true }))
      .toEqual({ status: 200, body: { handled: true } });
    expect(await rows(h.a.tenantId)).toHaveLength(before + 2);
  });

  it("refuses a body over 256 KiB with 413 before anything else", async () => {
    const event = { ...received({ to: [`${await handleOf(h.a)}@${INBOUND_EMAIL_DOMAIN}`] }), padding: "x".repeat(256 * 1024) };
    const before = await snapshot();
    const response = await deliver(event);
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ error: { code: "ValidationFailed" } });
    // A declared length smaller than the body does not get it past: the bytes read are counted.
    expect((await deliver(event, { headers: { "Content-Length": "100" } })).status).toBe(413);
    expect(await snapshot()).toEqual(before);
  });

  it("answers 400 for a signed body that is not JSON", async () => {
    const before = await snapshot();
    const response = await post("not json {");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "ValidationFailed", message: "Invalid webhook payload" } });
    expect(await snapshot()).toEqual(before);
  });

  it("answers 400 and reports an email.received it cannot read, so Resend retries it", async () => {
    const handle = await handleOf(h.a);
    const before = await snapshot();
    const unreadable = [
      { type: "email.received", data: { from: SENDER, to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`] } },
      { type: "email.received", data: { email_id: "has space", from: SENDER, to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`] } },
      { type: "email.received", data: { email_id: newEmailId(), to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`] } },
      { type: "email.received", data: { email_id: newEmailId(), from: SENDER, to: "not a list" } },
      { type: "email.received" },
      // No `to` at all: unreadable, never acknowledged as unrouted.
      { type: "email.received", data: { email_id: newEmailId(), from: SENDER } },
      // An email_id so long that `email-inbound:<id>` would pass the 200-character key limit.
      received({ email_id: "x".repeat(187), to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`] }),
      // A from that holds no characters once cleaned: the session reads it as malformed.
      received({ from: "\u0000\u0007 ", to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`] }),
    ];
    for (const [index, event] of unreadable.entries()) {
      const id = newId();
      const response = await deliver(event, { id });
      expect(response.status, String(index)).toBe(400);
      expect(response.body).toMatchObject({ error: { code: "ValidationFailed", message: "Unreadable email.received event" } });
      expect(reports.at(-1)).toMatchObject({ id, outcome: { handled: false, reason: "malformed_event" } });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("acknowledges unrouted mail with 200 even when its sender cannot be read (IE-4)", async () => {
    const before = await snapshot();
    const id = newId();
    const response = await deliver(received({ from: "\u0000", to: ["someone@elsewhere.test"] }), { id });
    expect(response.status).toBe(200);
    expect(reports.at(-1)).toMatchObject({ id, outcome: { handled: false, reason: "unrouted" } });
    expect(await snapshot()).toEqual(before);
  });

  it("acknowledges other signed event types without reading them", async () => {
    const before = await snapshot();
    for (const type of ["email.bounced", "email.delivered", "contact.created"])
      expect(await deliver({ type, data: {} }), type).toEqual({ status: 200, body: { handled: false, reason: "unread_event" } });
    expect(await snapshot()).toEqual(before);
  });
});

describe("routing (tests 3 and 10, IE-3, IE-4)", () => {
  it("routes a handle in to, in cc and in bcc", async () => {
    const handle = await handleOf(h.a);
    for (const field of ["to", "cc", "bcc"]) {
      const event = received({ [field]: ["someone@example.org", `Halden <${handle}@${INBOUND_EMAIL_DOMAIN}>`] });
      expect(await deliver(event), field).toEqual({ status: 200, body: { handled: true } });
      expect((await rows(h.a.tenantId)).map((row) => row.provider_email_id), field).toContain(event.data.email_id);
    }
  });

  it("stores the sender and a one-line subject, never a body", async () => {
    const handle = await handleOf(h.b);
    const event = received({ to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`], subject: "Line one\r\nline two", text: "Body text", html: "<p>Body</p>" });
    expect(await deliver(event)).toEqual({ status: 200, body: { handled: true } });
    const row = (await rows(h.b.tenantId)).find((candidate) => candidate.provider_email_id === event.data.email_id);
    expect(row).toEqual({
      provider_email_id: event.data.email_id, from_address: "pat.guest@example.org", subject: "Line one line two", reply_ref: null, status: "received",
    });
    const stored = await h.fixture.service(async (tx) => (await tx.query<{ body_text: string | null }>(
      "SELECT body_text FROM inbound_emails WHERE tenant_id=$1 AND provider_email_id=$2", [h.b.tenantId, event.data.email_id])).rows[0]!);
    expect(stored.body_text).toBeNull();
  });

  it("stores a sender and subject with C1 controls and bidi overrides cleaned, and the longest email_id the key allows", async () => {
    const handle = await handleOf(h.b);
    const event = received({
      email_id: "y".repeat(186), to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`],
      from: "odd\u0085\u009bname\u202e", subject: "Pay \u202etxt.exe\u2069",
    });
    expect(await deliver(event)).toEqual({ status: 200, body: { handled: true } });
    expect((await rows(h.b.tenantId)).find((row) => row.provider_email_id === event.data.email_id))
      .toMatchObject({ from_address: "oddname", subject: "Pay txt.exe" });
  });

  it("reads an event with a subject past 100,000 characters and an odd entry past the 50 read", async () => {
    const handle = await handleOf(h.b);
    const event = received({
      to: [`${handle}@${INBOUND_EMAIL_DOMAIN}`, ...Array.from({ length: 50 }, (_, i) => `x${i}@elsewhere.test`), "y".repeat(5000)],
      received_for: ["z".repeat(5000)], subject: "s".repeat(120_000),
    });
    expect(await deliver(event)).toEqual({ status: 200, body: { handled: true } });
    expect((await rows(h.b.tenantId)).find((row) => row.provider_email_id === event.data.email_id)?.subject).toBe("s".repeat(200));
  });

  it("answers 200 for unrouted mail, writes nothing and reports no address or subject (test 3)", async () => {
    const disabled = await h.fixture.service(async (tx) => {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO inbound_email_addresses (tenant_id,id,handle,kind,status,disabled_at,created_at)
         VALUES ($1,$2,'disabledhandle22','reply','disabled',$3,$3)`, [h.a.tenantId, id, clock.now()]);
      return "disabledhandle22";
    });
    const handle = await handleOf(h.a);
    const before = await snapshot();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["unknown handle", { to: [`aaaaaaaaaaaaaaaa@${INBOUND_EMAIL_DOMAIN}`] }],
      ["disabled handle", { to: [`${disabled}@${INBOUND_EMAIL_DOMAIN}`] }],
      ["malformed local part", { to: [`${handle}-x@${INBOUND_EMAIL_DOMAIN}`] }],
      ["another domain", { to: [`${handle}@other.example`] }],
      ["received_for only", { to: ["someone@example.org"], received_for: [`${handle}@${INBOUND_EMAIL_DOMAIN}`] }],
    ];
    for (const [name, data] of cases) {
      const reportedBefore = reports.length;
      expect(await deliver(received(data)), name).toEqual({ status: 200, body: { handled: false, reason: "unrouted" } });
      const reported = reports.slice(reportedBefore);
      expect(reported, name).toHaveLength(1);
      const text = JSON.stringify(reported);
      for (const secret of [handle, disabled, "pat.guest", "example.org", SUBJECT, INBOUND_EMAIL_DOMAIN])
        expect(text, `${name}: ${secret}`).not.toContain(secret);
    }
    expect(reports.at(-1)!.outcome).toEqual({ handled: false, reason: "unrouted", receivedForUnrouted: 1 });
    expect(await snapshot()).toEqual(before);
  });

  it("a forged To naming two tenants' handles gives each tenant its own row (two-tenant)", async () => {
    const [a, b] = [await handleOf(h.a), await handleOf(h.b)];
    const event = received({ to: [`${a}@${INBOUND_EMAIL_DOMAIN}`, `${b}@${INBOUND_EMAIL_DOMAIN}`] });
    expect(await deliver(event)).toEqual({ status: 200, body: { handled: true } });
    expect((await rows(h.a.tenantId)).filter((row) => row.provider_email_id === event.data.email_id)).toHaveLength(1);
    expect((await rows(h.b.tenantId)).filter((row) => row.provider_email_id === event.data.email_id)).toHaveLength(1);
    const outcome = reports.at(-1)!.outcome;
    expect(outcome.handled && outcome.tenants.map((tenant) => tenant.tenantId).sort()).toEqual([h.a.tenantId, h.b.tenantId].sort());
  });
});

describe("retries (test 5, IE-8)", () => {
  it("a redelivery, and the same email_id under another svix-id, give one row and one event", async () => {
    const event = received({ to: [`${await handleOf(h.a)}@${INBOUND_EMAIL_DOMAIN}`] });
    const id = newId();
    const before = await events(h.a.tenantId);
    expect(await deliver(event, { id })).toEqual({ status: 200, body: { handled: true } });
    expect(await deliver(event, { id, timestamp: NOW_SECONDS + 60 })).toEqual({ status: 200, body: { handled: true } });
    expect(await deliver(event)).toEqual({ status: 200, body: { handled: true } });
    expect((await rows(h.a.tenantId)).filter((row) => row.provider_email_id === event.data.email_id)).toHaveLength(1);
    expect(await events(h.a.tenantId)).toBe(before + 1);
  });

  it("answers 503 when the database is down, so Resend retries, and reports it", async () => {
    const down = appOnDatabase({
      tenant: () => Promise.reject(new DatabaseUnavailable("connect")),
      withoutTenant: () => Promise.reject(new DatabaseUnavailable("connect")),
    } satisfies ScopedDatabase, {
      resendInboundWebhook: { secrets: { current: RESEND_INBOUND_WEBHOOK_SECRET }, domain: INBOUND_EMAIL_DOMAIN, report },
    });
    const id = newId();
    const response = await deliver(received({ to: [`${await handleOf(h.a)}@${INBOUND_EMAIL_DOMAIN}`] }), { id }, down);
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: "Unavailable" } });
    expect(reports.at(-1)).toMatchObject({ id, outcome: { handled: false, reason: "unavailable" } });
  });
});

describe("a fault that is not the database", () => {
  it("reaches the app's error handler (500), not a 503 retry loop, and is reported as failed", async () => {
    const broken = appOnDatabase({
      tenant: () => Promise.reject(new Error("bug")),
      withoutTenant: () => Promise.reject(new Error("bug")),
    } satisfies ScopedDatabase, {
      resendInboundWebhook: { secrets: { current: RESEND_INBOUND_WEBHOOK_SECRET }, domain: INBOUND_EMAIL_DOMAIN, report },
    });
    const id = newId();
    const response = await deliver(received({ to: [`${await handleOf(h.a)}@${INBOUND_EMAIL_DOMAIN}`] }), { id }, broken);
    expect(response.status).toBe(500);
    expect(reports.at(-1)).toMatchObject({ id, outcome: { handled: false, reason: "failed" } });
  });

  it("answers a raw lock wait 503 and any refusal the action path raises one fixed 500", async () => {
    const to = [`${await handleOf(h.a)}@${INBOUND_EMAIL_DOMAIN}`];
    const webhook = { resendInboundWebhook: { secrets: { current: RESEND_INBOUND_WEBHOOK_SECRET }, domain: INBOUND_EMAIL_DOMAIN, report } };
    const locked = appOnDatabase({
      ...h.database.db,
      withoutTenant: () => Promise.reject(Object.assign(new Error("lock timeout"), { code: "55P03" })),
    } satisfies ScopedDatabase, webhook);
    const id = newId();
    expect((await deliver(received({ to }), { id }, locked)).status).toBe(503);
    expect(reports.at(-1)).toMatchObject({ id, outcome: { handled: false, reason: "unavailable" } });
    const refused = appOnDatabase({
      ...h.database.db,
      tenant: () => Promise.reject(new Conflict("refused")),
    } satisfies ScopedDatabase, webhook);
    const other = newId();
    const response = await deliver(received({ to }), { id: other }, refused);
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ error: { code: "Internal" } });
    expect(reports.at(-1)).toMatchObject({ id: other, outcome: { handled: false, reason: "failed" } });
  });
});

describe("the route ships dark", () => {
  it("is absent (404) when no inbound secret is configured", async () => {
    const dark = appOnDatabase(h.database.db);
    const response = await deliver(received({ to: [`${await handleOf(h.a)}@${INBOUND_EMAIL_DOMAIN}`] }), {}, dark);
    expect(response.status).toBe(404);
  });
});
