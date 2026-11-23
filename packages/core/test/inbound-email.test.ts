// Inbound email, slice 1 (docs/requirements/inbound-email.md IE-3, IE-4, IE-9, IE-17, IE-24, IE-32)
// through the core session under the runtime role, with an injected clock: routing on to, cc and
// bcc (test 10), unrouted mail (test 3), idempotency (test 5), state plus outbox (test 6), the
// admission cap, a read-only plan (test 15), and sender threads for members only (test 14).
import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, INBOUND_ADMISSION_LIMIT, INBOUND_EMAIL_RECEIVE_ACTION, NotFound } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createInboundEmailSession, inboundEmailActorId } from "../src/edge/inbound-email-session.js";
import { ACTION_PERMISSIONS, createSession, type EdgeDependencies } from "../src/edge/session.js";
import { createTokenReads } from "../src/automation/hub.js";
import { getThread, listThreads } from "../src/reads/inbox.js";
import {
  collapseByTenant,
  inboundEmailEventSchema,
  inboundSenderKey,
  inboundSubject,
  routeRecipients,
  senderAddress,
  type InboundEmailEvent,
} from "../src/index.js";

const DOMAIN = "reply.example.test";
const entryId = (entry: { type: string; id?: string; reply?: { id: string } }) => entry.reply?.id ?? entry.id;
let now = Date.parse("2026-11-22T08:00:00.000Z");
const clock = { now: () => new Date(now) };

let database: TestDatabase;
let fixture: TwoTenantFixture;
let handleA: string;
let addressA: string;
let handleB: string;
let ownerA: string;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const session = () => createInboundEmailSession(deps(), { domain: DOMAIN });

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const randomHandle = () => Array.from({ length: 16 }, () => BASE32[randomInt(0, 32)]).join("");

function event(data: Partial<InboundEmailEvent["data"]> = {}): InboundEmailEvent {
  return inboundEmailEventSchema.parse({
    type: "email.received",
    created_at: new Date(now).toISOString(),
    data: { email_id: `em_${randomUUID()}`, from: "Pat Doe <Pat@Example.COM>", to: [], subject: "Hello", ...data },
  });
}

async function rows(tenantId: string, providerEmailId?: string) {
  return (await fixture.service((tx) => tx.query<{
    id: string; address_id: string; reply_ref: string | null; from_address: string; subject: string | null;
    status: string; kind: string; body_state: string; received_at: Date; sender_key: string;
  }>(
    `SELECT id, address_id, reply_ref, from_address, subject, status, kind, body_state, received_at, sender_key
       FROM inbound_emails WHERE tenant_id=$1 ${providerEmailId ? "AND provider_email_id=$2" : ""}`,
    providerEmailId ? [tenantId, providerEmailId] : [tenantId],
  ))).rows;
}
async function events(tenantId: string, inboundEmailId: string) {
  return (await fixture.service((tx) => tx.query<{ payload: unknown }>(
    "SELECT payload FROM outbox WHERE tenant_id=$1 AND event_type='inbound.email.received' AND payload->>'inboundEmailId'=$2",
    [tenantId, inboundEmailId],
  ))).rows;
}
async function addAddress(tenantId: string, status: "retiring" | "disabled") {
  const handle = randomHandle();
  const id = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO inbound_email_addresses (tenant_id, id, handle, status, retire_after, disabled_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, id, handle, status, status === "retiring" ? new Date(now + 90 * 86_400_000) : null,
      status === "disabled" ? new Date(now) : null, new Date(now)]));
  return { handle, id };
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  const active = (tenantId: string) => fixture.service(async (tx) => (await tx.query<{ id: string; handle: string }>(
    "SELECT id, handle FROM inbound_email_addresses WHERE tenant_id=$1 AND status='active'", [tenantId])).rows[0]!);
  ({ id: addressA, handle: handleA } = await active(fixture.a.tenantId));
  ({ handle: handleB } = await active(fixture.b.tenantId));
  ownerA = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner',$5,$5)",
    [fixture.a.tenantId, randomUUID(), "owner-a@example.com", ownerA, new Date(now)]));
});
afterAll(async () => {
  await database?.close();
});

describe("routing (IE-3, pure)", () => {
  const handle = "abcdefghijklmnop";
  const ref = "qrstuvwxyz234567";
  it("keeps hub recipients in to, cc, bcc order, in lower case, with the reply reference", () => {
    const routed = routeRecipients(event({
      to: ["someone@elsewhere.test", `Desk <${handle.toUpperCase()}@REPLY.EXAMPLE.TEST>`],
      cc: [`${handle}+${ref}@${DOMAIN}`],
      bcc: [`zzzzzzzzzzzzzzzz@${DOMAIN}`],
    }), DOMAIN);
    expect(routed.recipients).toEqual([
      { handle, replyRef: null }, { handle, replyRef: ref }, { handle: "zzzzzzzzzzzzzzzz", replyRef: null },
    ]);
  });
  it("routes nothing on a malformed local part, another domain or a subdomain", () => {
    const routed = routeRecipients(event({
      to: [`${handle}x@${DOMAIN}`, `${handle}+short@${DOMAIN}`, `${handle}@other.test`, `${handle}@x.${DOMAIN}`, "not an address", `${handle}1@${DOMAIN}`],
    }), DOMAIN);
    expect(routed.recipients).toEqual([]);
  });
  it("reads at most 50 recipients across to, cc and bcc", () => {
    const filler = Array.from({ length: 50 }, (_, i) => `x${i}@elsewhere.test`);
    expect(routeRecipients(event({ to: filler, bcc: [`${handle}@${DOMAIN}`] }), DOMAIN).recipients).toEqual([]);
    expect(routeRecipients(event({ to: filler.slice(1), bcc: [`${handle}@${DOMAIN}`] }), DOMAIN).recipients).toHaveLength(1);
  });
  it("never routes on received_for, and counts its hub entries", () => {
    const routed = routeRecipients(event({ received_for: [`${handle}@${DOMAIN}`, `${handle}@${DOMAIN.toUpperCase()}`, "x@other.test"] }), DOMAIN);
    expect(routed).toEqual({ recipients: [], receivedForUnrouted: 2 });
  });
  it("collapses one tenant to the first recipient with a reference, else the first", () => {
    const plain = { tenantId: "t1", recipient: { handle: "a", replyRef: null } };
    const later = { tenantId: "t1", recipient: { handle: "b", replyRef: null } };
    const withRef = { tenantId: "t1", recipient: { handle: "a", replyRef: "r" } };
    const other = { tenantId: "t2", recipient: { handle: "c", replyRef: null } };
    expect(collapseByTenant([plain, later, other])).toEqual([plain, other]);
    expect(collapseByTenant([plain, withRef, other, { ...withRef, recipient: { handle: "b", replyRef: "s" } }])).toEqual([withRef, other]);
  });
  it("normalises the sender and cuts the subject to one line of 200", () => {
    expect(senderAddress("Pat <Pat@Example.COM>")).toBe("pat@example.com");
    expect(senderAddress("  weird\u0007 sender ")).toBe("weird sender");
    expect(senderAddress("<>")).toBeNull();
    expect(inboundSubject("a\r\nb\u0000c")).toBe("a bc");
    expect(inboundSubject(null)).toBeNull();
    const long = inboundSubject("😀".repeat(150))!;
    expect(long.length).toBe(200);
    expect(inboundSubject("x\uD800y")).toBe("x�y");
  });
});

describe("receive (IE-9)", () => {
  it("a handle in to, in cc and in bcc each routes, with a received row and one outbox event (test 10)", async () => {
    for (const field of ["to", "cc", "bcc"] as const) {
      const message = event({ [field]: [`${handleA}@${DOMAIN}`] });
      const outcome = await session().receive(message);
      expect(outcome).toMatchObject({ handled: true, tenants: [{ tenantId: fixture.a.tenantId, outcome: "received" }] });
      const [row] = await rows(fixture.a.tenantId, message.data.email_id);
      expect(row).toMatchObject({
        address_id: addressA, reply_ref: null, from_address: "pat@example.com", subject: "Hello",
        status: "received", kind: "unclassified", body_state: "none", received_at: new Date(now),
        sender_key: inboundSenderKey(fixture.a.tenantId, "pat@example.com"),
      });
      expect(await events(fixture.a.tenantId, row!.id)).toEqual([{ payload: { inboundEmailId: row!.id } }]);
    }
  });

  it("a forged To naming tenant B routes to both tenants, each in its own scope", async () => {
    const message = event({ to: [`${handleA}@${DOMAIN}`, `${handleB}@${DOMAIN}`] });
    const outcome = await session().receive(message);
    expect(outcome.handled && outcome.tenants.map((t) => t.tenantId).sort()).toEqual([fixture.a.tenantId, fixture.b.tenantId].sort());
    const [rowA] = await rows(fixture.a.tenantId, message.data.email_id);
    const [rowB] = await rows(fixture.b.tenantId, message.data.email_id);
    expect(rowA!.id).not.toBe(rowB!.id);
    expect(rowB!.sender_key).toBe(inboundSenderKey(fixture.b.tenantId, "pat@example.com"));
    // B's row is in a sender thread of B, and A's member cannot see it.
    const ownerB = randomUUID();
    await fixture.service((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner',$5,$5)",
      [fixture.b.tenantId, randomUUID(), "owner-b@example.com", ownerB, new Date(now)]));
    const threadB = `e_${rowB!.sender_key}`;
    const detail = await createSession(deps(), { tenantId: fixture.b.tenantId, actorId: ownerB }).getThread(threadB);
    expect(detail.entries.map(entryId)).toContain(rowB!.id);
    await expect(createSession(deps(), { tenantId: fixture.a.tenantId, actorId: ownerA }).getThread(threadB)).rejects.toBeInstanceOf(NotFound);
  });

  it("unknown, disabled, malformed and received_for-only mail is unrouted and leaves no row (test 3)", async () => {
    const disabled = await addAddress(fixture.a.tenantId, "disabled");
    const before = (await rows(fixture.a.tenantId)).length;
    for (const data of [
      { to: [`${randomHandle()}@${DOMAIN}`] },
      { to: [`${disabled.handle}@${DOMAIN}`] },
      { to: [`${handleA}-x@${DOMAIN}`] },
      { to: ["desk@business.test"], received_for: [`${handleA}@${DOMAIN}`] },
    ]) {
      const outcome = await session().receive(event(data));
      expect(outcome).toMatchObject({ handled: false, reason: "unrouted" });
    }
    expect(await session().receive(event({ received_for: [`${handleA}@${DOMAIN}`] })))
      .toEqual({ handled: false, reason: "unrouted", receivedForUnrouted: 1 });
    expect(await rows(fixture.a.tenantId)).toHaveLength(before);
  });

  it("a routed message whose sender cannot be read is malformed", async () => {
    const message = event({ to: [`${handleA}@${DOMAIN}`], from: "<>" });
    expect(await session().receive(message)).toEqual({ handled: false, reason: "malformed_event" });
    expect(await rows(fixture.a.tenantId, message.data.email_id)).toEqual([]);
  });

  it("the same message twice, and two concurrent deliveries, give one row and one event (test 5)", async () => {
    const message = event({ to: [`${handleA}@${DOMAIN}`] });
    const first = await session().receive(message);
    now += 60_000;
    const second = await session().receive(message);
    expect(second).toEqual(first);
    const [row] = await rows(fixture.a.tenantId, message.data.email_id);
    expect(await events(fixture.a.tenantId, row!.id)).toHaveLength(1);

    const racing = event({ to: [`${handleA}@${DOMAIN}`] });
    const both = await Promise.all([session().receive(racing), session().receive(racing)]);
    expect(both[0]).toEqual(both[1]);
    const raced = await rows(fixture.a.tenantId, racing.data.email_id);
    expect(raced).toHaveLength(1);
    expect(await events(fixture.a.tenantId, raced[0]!.id)).toHaveLength(1);
  });

  it("a second event for one email_id that builds another payload changes nothing", async () => {
    const message = event({ to: [`${handleA}@${DOMAIN}`] });
    await session().receive(message);
    const again = await session().receive({ ...message, data: { ...message.data, subject: "Changed" } });
    expect(again).toMatchObject({ handled: true, tenants: [{ tenantId: fixture.a.tenantId, outcome: "already_received" }] });
    expect((await rows(fixture.a.tenantId, message.data.email_id)).map((row) => row.subject)).toEqual(["Hello"]);
  });

  it("the active and the retiring handle of one tenant give one action, with the reference preferred", async () => {
    const retiring = await addAddress(fixture.a.tenantId, "retiring");
    const ref = randomHandle();
    const message = event({ to: [`${handleA}@${DOMAIN}`], cc: [`${retiring.handle}+${ref}@${DOMAIN}`] });
    const outcome = await session().receive(message);
    expect(outcome.handled && outcome.tenants).toHaveLength(1);
    expect(await rows(fixture.a.tenantId, message.data.email_id)).toMatchObject([{ address_id: retiring.id, reply_ref: ref }]);
    const plain = event({ to: [`${handleA}@${DOMAIN}`], cc: [`${retiring.handle}@${DOMAIN}`] });
    await session().receive(plain);
    expect(await rows(fixture.a.tenantId, plain.data.email_id)).toMatchObject([{ address_id: addressA, reply_ref: null }]);
  });

  it("a failure after the row insert leaves neither the row nor the event (test 6)", async () => {
    await database.pool.query(`
      CREATE OR REPLACE FUNCTION public.test_fail_inbound_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_type = 'inbound.email.received' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER test_fail_inbound_event BEFORE INSERT ON public.outbox FOR EACH ROW EXECUTE FUNCTION public.test_fail_inbound_event();`);
    const message = event({ to: [`${handleA}@${DOMAIN}`] });
    try {
      await expect(session().receive(message)).rejects.toThrow();
    } finally {
      await database.pool.query(`DROP TRIGGER test_fail_inbound_event ON public.outbox; DROP FUNCTION public.test_fail_inbound_event();`);
    }
    expect(await rows(fixture.a.tenantId, message.data.email_id)).toEqual([]);
    expect(await fixture.service(async (tx) => (await tx.query(
      "SELECT 1 FROM actions WHERE tenant_id=$1 AND idempotency_key=$2", [fixture.a.tenantId, `email-inbound:${message.data.email_id}`])).rowCount)).toBe(0);
    // The retry after the fault receives it.
    expect(await session().receive(message)).toMatchObject({ handled: true, tenants: [{ outcome: "received" }] });
  });

  it("only the inbound principal runs the receive: no member permission names it", () => {
    expect(ACTION_PERMISSIONS[INBOUND_EMAIL_RECEIVE_ACTION]).toBeUndefined();
    expect(inboundEmailActorId(fixture.a.tenantId)).not.toBe(inboundEmailActorId(fixture.b.tenantId));
  });
});

describe("admission and plans (IE-17, IE-32)", () => {
  it("past 2,000 rows in 24 hours nothing is stored for that tenant, until the window moves (IE-17)", async () => {
    const fresh = randomUUID();
    await fixture.service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Flooded')", [fresh]));
    const address = await fixture.service(async (tx) => (await tx.query<{ id: string; handle: string }>(
      "SELECT id, handle FROM inbound_email_addresses WHERE tenant_id=$1", [fresh])).rows[0]!);
    const used = (await rows(fresh)).length;
    await fixture.service((tx) => tx.query(
      `INSERT INTO inbound_emails (tenant_id, id, address_id, provider, provider_email_id, from_address, received_at, sender_key, created_at)
       SELECT $1, gen_random_uuid(), $2, 'resend', 'flood-' || n, 'flood@example.com', $3, gen_random_uuid(), $3
         FROM generate_series(1, $4::int) n`,
      [fresh, address.id, new Date(now - 60_000), INBOUND_ADMISSION_LIMIT - used]));
    const message = event({ to: [`${address.handle}@${DOMAIN}`] });
    expect(await session().receive(message)).toEqual({
      handled: true, tenants: [{ tenantId: fresh, outcome: "over_admission" }], receivedForUnrouted: 0,
    });
    expect(await rows(fresh, message.data.email_id)).toEqual([]);
    // Another tenant in the same message is not held back.
    const shared = event({ to: [`${address.handle}@${DOMAIN}`, `${handleA}@${DOMAIN}`] });
    const outcome = await session().receive(shared);
    expect(outcome.handled && outcome.tenants.map((t) => t.outcome).sort()).toEqual(["over_admission", "received"]);
    // A day later the window has moved: the same message is received.
    now += 24 * 3_600_000;
    expect(await session().receive(message)).toMatchObject({ handled: true, tenants: [{ outcome: "received" }] });
    await fixture.service((tx) => tx.query("DELETE FROM inbound_emails WHERE tenant_id=$1", [fresh]));
  });

  it("a read-only tenant still receives (test 15)", async () => {
    const lapsed = randomUUID();
    await fixture.service(async (tx) => {
      await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Lapsed')", [lapsed]);
      await tx.query(
        `INSERT INTO tenant_plans (tenant_id, plan, plan_interval, status, read_only_after, created_at, updated_at)
         VALUES ($1,'studio','month','canceled',$2,$2,$2)`, [lapsed, new Date(now - 60_000)]);
    });
    const handle = await fixture.service(async (tx) => (await tx.query<{ handle: string }>(
      "SELECT handle FROM inbound_email_addresses WHERE tenant_id=$1", [lapsed])).rows[0]!.handle);
    const message = event({ to: [`${handle}@${DOMAIN}`] });
    expect(await session().receive(message)).toMatchObject({ handled: true, tenants: [{ tenantId: lapsed, outcome: "received" }] });
    expect(await rows(lapsed, message.data.email_id)).toHaveLength(1);
  });
});

describe("sender threads (IE-24, test 14)", () => {
  const sender = `sender-${randomUUID().slice(0, 8)}@example.org`;
  let threadId: string;
  let firstId: string;
  let secondId: string;

  beforeAll(async () => {
    const first = event({ to: [`${handleA}@${DOMAIN}`], from: `Sam <${sender}>`, subject: "First" });
    now += 60_000;
    await session().receive(first);
    now += 60_000;
    const second = event({ to: [`${handleA}@${DOMAIN}`], from: sender, subject: "Second" });
    await session().receive(second);
    firstId = (await rows(fixture.a.tenantId, first.data.email_id))[0]!.id;
    secondId = (await rows(fixture.a.tenantId, second.data.email_id))[0]!.id;
    threadId = `e_${inboundSenderKey(fixture.a.tenantId, sender)}`;
  });

  it("a member sees one sender thread with needsReview and metadata-only entries, content pending", async () => {
    const member = createSession(deps(), { tenantId: fixture.a.tenantId, actorId: ownerA });
    const threads = (await member.listThreads({ limit: 100 })).items;
    const summary = threads.find((thread) => thread.id === threadId);
    expect(summary).toMatchObject({
      kind: "sender", contactId: null, intakeItemId: null, name: sender, email: sender, preview: "Second",
      needsReview: true, needsReply: false, drafts: 0, lastActivityAt: new Date(now).toISOString(),
    });
    const detail = await member.getThread(threadId);
    expect(detail.phone).toBeNull();
    expect(detail.olderEntries).toBe(false);
    expect(detail.entries).toEqual([
      { type: "email", id: firstId, at: new Date(now - 60_000).toISOString(), fromAddress: sender, fromName: null, subject: "First", contentPending: true },
      { type: "email", id: secondId, at: new Date(now).toISOString(), fromAddress: sender, fromName: null, subject: "Second", contentPending: true },
    ]);
  });

  it("a settled ready row stays; dropped and rejected rows leave the thread", async () => {
    const member = createSession(deps(), { tenantId: fixture.a.tenantId, actorId: ownerA });
    await fixture.service((tx) => tx.query(
      "UPDATE inbound_emails SET status='ready', settled_at=$3, kind='message', body_state='full', review='unmatched' WHERE tenant_id=$1 AND id=$2",
      [fixture.a.tenantId, firstId, new Date(now)]));
    expect((await member.getThread(threadId)).entries.map((entry) => entry.type === "email" && entry.contentPending)).toEqual([false, true]);
    await fixture.service((tx) => tx.query(
      "UPDATE inbound_emails SET status='dropped', drop_reason='loop', settled_at=$3 WHERE tenant_id=$1 AND id=$2",
      [fixture.a.tenantId, secondId, new Date(now)]));
    expect((await member.getThread(threadId)).entries.map(entryId)).toEqual([firstId]);
    await fixture.service((tx) => tx.query(
      "UPDATE inbound_emails SET review='rejected' WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, firstId]));
    await expect(member.getThread(threadId)).rejects.toBeInstanceOf(NotFound);
    expect((await member.listThreads({ limit: 100 })).items.some((thread) => thread.id === threadId)).toBe(false);
  });

  it("MCP and token reads see no sender thread and no email entry", async () => {
    const message = event({ to: [`${handleA}@${DOMAIN}`], from: "hidden@example.org" });
    await session().receive(message);
    const hidden = `e_${inboundSenderKey(fixture.a.tenantId, "hidden@example.org")}`;
    // The core reads without the member option (what the stdio MCP, hosted MCP and hub call).
    await database.db.tenant(fixture.a.tenantId, async (tx) => {
      expect((await listThreads(tx, fixture.a.tenantId, { limit: 100, offset: 0 })).items.every((thread) => thread.kind !== "sender")).toBe(true);
      await expect(getThread(tx, fixture.a.tenantId, hidden)).rejects.toBeInstanceOf(NotFound);
    });
    // An automation token with inbox:read.
    const tokenId = randomUUID();
    await fixture.service((tx) => tx.query(
      `INSERT INTO automation_tokens (tenant_id,id,name,scopes,created_by,created_at,expires_at)
       VALUES ($1,$2,'reader','{inbox:read}',$3,$4,$5)`,
      [fixture.a.tenantId, tokenId, ownerA, new Date(now - 60_000), new Date(now + 86_400_000)]));
    const reads = createTokenReads(deps());
    const principal = { tenantId: fixture.a.tenantId, tokenId, actorId: ownerA, name: "reader", scopes: ["inbox:read" as const], expiresAt: null };
    expect((await reads.listThreads(principal, { limit: 100 })).items.every((thread) => thread.kind !== "sender")).toBe(true);
    const refused = await reads.getThread(principal, hidden).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ActionError);
    expect((refused as ActionError).code).toBe("NotFound");
  });

  it("tenant B's member reads none of A's sender threads", async () => {
    const ownerB = randomUUID();
    await fixture.service((tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner',$5,$5)",
      [fixture.b.tenantId, randomUUID(), "b2@example.com", ownerB, new Date(now)]));
    const b = createSession(deps(), { tenantId: fixture.b.tenantId, actorId: ownerB });
    const message = event({ to: [`${handleA}@${DOMAIN}`], from: "only-a@example.org" });
    await session().receive(message);
    const senderKeyA = inboundSenderKey(fixture.a.tenantId, "only-a@example.org");
    await expect(b.getThread(`e_${senderKeyA}`)).rejects.toBeInstanceOf(NotFound);
    expect((await b.listThreads({ limit: 100 })).items.some((thread) => thread.id === `e_${senderKeyA}`)).toBe(false);
  });
});
