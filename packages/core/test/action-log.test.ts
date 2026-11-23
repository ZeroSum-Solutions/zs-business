// Backlog B05: the owner's redacted action log. Two-tenant denial under the runtime role, owner-only
// access, redaction of bodies, addresses and secrets, actor kinds, approvals and keyset paging.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENT_KINDS, NotFound, TenantDenied, actionLogPageSchema, type MemberRole } from "@zs/contracts";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import {
  agentActorId,
  automationActorId,
  createSession,
  emailFeedbackActorId,
  enrichmentActorId,
  imageActorId,
  inboundSmsActorId,
  intakeWorkerActorId,
  outreachOperatorActorId,
  publicIntakeActorId,
  smsStatusActorId,
  transcriptionActorId,
  unsubscribeActorId,
  voiceActorId,
  type EdgeDependencies,
  type Session,
} from "../src/index.js";
import { derivedId } from "../src/edge/ids.js";
import { OUTCOMES, serviceActors } from "../src/actions/log.js";

const START = Date.parse("2026-11-20T09:00:00.000Z");
const clock = { now: () => new Date(START) };
const at = (seconds: number) => new Date(START + seconds * 1000);

const EMAIL = "mira.rowe@haldenrowe.example";
const PHONE = "+15555550142";
const BODY = "Hi Mira, your sapphire ring is ready for pickup on Saturday.";
const SECRET = "zs-test-token-9f3c2a7e-not-a-secret";

const STORED_ASSET = "7a1c3e5f-2b4d-4c6e-8a0b-9d1f3e5a7c90";

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenantA: string;
let tenantB: string;
let ownerA: string;
let ownerAMember: string;
let staffA: string;
let ownerB: string;

const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const sessionFor = (actorId: string, tenant = tenantA): Session => createSession(deps(), { tenantId: tenant, actorId });

async function addMember(tenant: string, role: MemberRole): Promise<{ userId: string; memberId: string }> {
  const userId = randomUUID();
  const memberId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenant, memberId, `${role}-${memberId.slice(0, 8)}@example.com`, userId, role, new Date(START)],
  ));
  return { userId, memberId };
}

/** One committed action, written as the service role so the test controls every column. */
async function insertAction(tenant: string, row: {
  actorId: string; actionType: string; targetType?: string; targetId?: string; payload?: unknown; result?: unknown;
  approvalId?: string; createdAt: Date; id?: string;
}): Promise<string> {
  const id = row.id ?? randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO actions (tenant_id,id,actor_id,action_type,target,payload,approval_reference,idempotency_key,result,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenant, id, row.actorId, row.actionType, JSON.stringify({ tenantId: tenant, type: row.targetType ?? "contact", id: row.targetId ?? randomUUID() }),
      JSON.stringify(row.payload ?? {}), row.approvalId ? JSON.stringify({ tenantId: tenant, id: row.approvalId }) : null,
      randomUUID(), JSON.stringify(row.result ?? {}), row.createdAt],
  ));
  return id;
}

async function insertApproval(tenant: string, decidedBy: string, expiresAt = at(86_400)): Promise<string> {
  const id = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at,status,decided_by,decided_at)
     VALUES ($1,$2,'reply.send','reply',$3,$4,$5,$6,$7,$8,'approved',$6,$7)`,
    [tenant, id, randomUUID(), JSON.stringify({ to: EMAIL, body: BODY }), `Send to ${EMAIL}`, decidedBy, at(-60), expiresAt],
  ));
  return id;
}

let sendActionId: string;
let approvalId: string;
let tokenId: string;
let contactId: string;
let standingActionId: string;
let skippedQueueId: string;
let expiredActionId: string;
let expiredApprovalId: string;

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  tenantA = fixture.a.tenantId;
  tenantB = fixture.b.tenantId;
  const owner = await addMember(tenantA, "owner");
  ownerA = owner.userId;
  ownerAMember = owner.memberId;
  staffA = (await addMember(tenantA, "staff")).userId;
  ownerB = (await addMember(tenantB, "owner")).userId;

  // A real action through the one action path: a contact with a name, an address and a phone.
  const saved = await sessionFor(ownerA).upsertContact({ displayName: "Mira Rowe", email: EMAIL, phone: PHONE }, randomUUID());
  contactId = (saved.result as { contact: { id: string } }).contact.id;
  // The same address under a new key finds that contact; its requested ID is never written.
  clock.now = () => at(1);
  await sessionFor(ownerA).upsertContact({ displayName: "Mira Rowe", email: EMAIL }, randomUUID());
  clock.now = () => new Date(START);

  approvalId = await insertApproval(tenantA, ownerA);
  sendActionId = await insertAction(tenantA, {
    actorId: agentActorId(tenantA), actionType: "reply.send", targetType: "reply", approvalId,
    payload: { to: EMAIL, body: BODY, apiKey: SECRET }, result: { status: "queued", to: EMAIL, preview: BODY }, createdAt: at(10),
  });
  // A status that is not a short word is never shown: it could hold an address or text.
  await insertAction(tenantA, {
    actorId: publicIntakeActorId(tenantA), actionType: "intake.submit", payload: { email: EMAIL },
    result: { status: `sent to ${EMAIL}` }, createdAt: at(20),
  });
  await insertAction(tenantA, { actorId: randomUUID(), actionType: "contact.upsert", result: { token: SECRET }, createdAt: at(30) });
  tokenId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO automation_tokens (tenant_id,id,name,created_by,created_at) VALUES ($1,$2,'Zap',$3,$4)", [tenantA, tokenId, ownerA, at(0)],
  ));
  await insertAction(tenantA, { actorId: automationActorId(tenantA, tokenId), actionType: "approval.request", createdAt: at(40) });
  // A-15: a templated send records the standing approval it ran under on its decision; its own
  // approval_reference is derived and has no approvals row. A skipped send names the approval in its
  // payload but ran under none.
  standingActionId = await insertAction(tenantA, {
    actorId: agentActorId(tenantA, "appointment_reminder"), actionType: "agent.reminder.queue", approvalId: randomUUID(),
    payload: { standingApprovalId: approvalId, values: { name: "Mira" } }, result: { outcome: "queued", approvalId }, createdAt: at(50),
  });
  skippedQueueId = await insertAction(tenantA, {
    actorId: agentActorId(tenantA, "review_request"), actionType: "agent.review.queue", approvalId: randomUUID(),
    payload: { standingApprovalId: approvalId }, result: { outcome: "skipped", reason: "daily_cap", approvalId: null }, createdAt: at(51),
  });
  // An approval past its expiry reads "expired", not "approved" (A-3).
  expiredApprovalId = await insertApproval(tenantA, ownerA, at(-1));
  expiredActionId = await insertAction(tenantA, {
    actorId: ownerA, actionType: "site.release.publish", targetType: "site", approvalId: expiredApprovalId, createdAt: at(52),
  });
  // Handlers that name how they ended in `outcome`, and writes that changed nothing.
  await insertAction(tenantA, { actorId: ownerA, actionType: "booking.outcome.set", targetType: "booking", result: { outcome: "no_show", changed: true }, createdAt: at(53) });
  await insertAction(tenantA, { actorId: voiceActorId(tenantA), actionType: "voice.textback.optin", result: { outcome: "denied", messageId: null }, createdAt: at(54) });
  await insertAction(tenantA, { actorId: ownerA, actionType: "source.observe", result: { applied: false }, createdAt: at(55) });
  await insertAction(tenantA, { actorId: ownerA, actionType: "booking.cancel", targetType: "booking", result: { customerNotice: "already_cancelled" }, createdAt: at(56) });
  // An upload of bytes already stored returns the stored asset; the requested ID was never written.
  await insertAction(tenantA, {
    actorId: ownerA, actionType: "media.asset.upload", targetType: "media_asset", targetId: randomUUID(),
    result: { id: STORED_ASSET, sha256: "ab" }, createdAt: at(57),
  });
  // A status word off the allowlist is not shown, even one that looks like a code.
  await insertAction(tenantA, {
    actorId: smsStatusActorId(tenantA), actionType: "sms.status", result: { status: "mira_rowe_haldenrowe" }, createdAt: at(60),
  });
  // A notice other than "queued" means the action sent nothing.
  await insertAction(tenantA, {
    actorId: publicIntakeActorId(tenantA), actionType: "booking.confirmation_send", result: { notice: "no_email" }, createdAt: at(70),
  });
  await insertAction(tenantA, { actorId: outreachOperatorActorId(tenantA), actionType: "outreach.mailbox.connect", createdAt: at(80) });

  // Tenant B's own action, with A's address in it, must never reach A's log.
  await insertAction(tenantB, { actorId: ownerB, actionType: "contact.upsert", payload: { email: EMAIL }, createdAt: at(15) });
});
afterAll(async () => { await database?.close(); });

describe("access", () => {
  it("is for owners: staff and strangers get 403", async () => {
    await expect(sessionFor(staffA).listActions({})).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(staffA).listActions({ limit: "500" })).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(staffA).getAction(sendActionId)).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(randomUUID()).listActions({})).rejects.toBeInstanceOf(TenantDenied);
  });

  it("never shows one tenant's actions to another (two-tenant denial under the runtime role)", async () => {
    const a = await sessionFor(ownerA).listActions({ limit: 100 });
    const b = await sessionFor(ownerB, tenantB).listActions({ limit: 100 });
    const aIds = new Set(a.items.map((item) => item.id));
    expect(b.items).toHaveLength(1);
    expect(b.items.some((item) => aIds.has(item.id))).toBe(false);
    // A's owner cannot open A's actions through tenant B, nor B's owner A's action by ID.
    await expect(sessionFor(ownerA, tenantB).listActions({})).rejects.toBeInstanceOf(TenantDenied);
    await expect(sessionFor(ownerB, tenantB).getAction(sendActionId)).rejects.toBeInstanceOf(NotFound);
    // RLS itself, not only the WHERE clause: the runtime role under B's tenant reads none of A's rows.
    const leaked = await fixture.b.run((tx) => tx.query("SELECT count(*)::int AS n FROM actions WHERE tenant_id=$1", [tenantA]));
    expect(leaked.rows[0]).toEqual({ n: 0 });
  });

  it("answers 404 for an unknown or malformed ID", async () => {
    await expect(sessionFor(ownerA).getAction(randomUUID())).rejects.toBeInstanceOf(NotFound);
    await expect(sessionFor(ownerA).getAction("not-an-id")).rejects.toBeInstanceOf(NotFound);
  });
});

describe("redaction", () => {
  it("leaves out message bodies, addresses, phone numbers, names and secrets", async () => {
    const page = await sessionFor(ownerA).listActions({ limit: 100 });
    expect(actionLogPageSchema.parse(page)).toEqual(page);
    const text = JSON.stringify(page);
    for (const secret of [EMAIL, "haldenrowe", PHONE, "5550142", BODY, "sapphire", "Mira", SECRET, "zs-test-token"])
      expect(text).not.toContain(secret);
    const receipt = JSON.stringify(await sessionFor(ownerA).getAction(sendActionId));
    for (const secret of [EMAIL, BODY, SECRET]) expect(receipt).not.toContain(secret);
  });

  it("takes every fixed job and record status from the contracts, and only short words", () => {
    for (const word of ["dead_letter", "review", "blocked", "uncertain", "stopped", "bounced", "no_match"]) expect(OUTCOMES.has(word), word).toBe(true);
    for (const word of OUTCOMES) expect(word).toMatch(/^[a-z][a-z_]{0,39}$/);
  });

  it("keeps a short status word as the outcome and drops anything else", async () => {
    const page = await sessionFor(ownerA).listActions({ limit: 100 });
    const byType = Object.fromEntries(page.items.map((item) => [item.actionType, item]));
    expect(byType["reply.send"]!.outcome).toBe("queued");
    expect(byType["intake.submit"]!.outcome).toBe("done");
    expect(byType["sms.status"]!.outcome).toBe("done");
    expect(byType["booking.confirmation_send"]!.outcome).toBe("skipped");
    expect(byType["agent.review.queue"]!.outcome).toBe("skipped");
    expect(byType["agent.reminder.queue"]!.outcome).toBe("queued");
    expect(byType["booking.outcome.set"]!.outcome).toBe("no_show");
    expect(byType["voice.textback.optin"]!.outcome).toBe("denied");
    expect(byType["source.observe"]!.outcome).toBe("no_change");
    expect(byType["booking.cancel"]!.outcome).toBe("no_change");
  });

  it("shows an approval only where an approvals row stands behind the action", async () => {
    const page = await sessionFor(ownerA).listActions({ limit: 100 });
    // Direct writes carry a derived approval_reference with no approvals row: no approval card.
    const contacts = page.items.filter((item) => item.actionType === "crm.contact.create-or-find");
    expect(contacts).toHaveLength(2);
    for (const item of contacts) expect(item.approval).toBeNull();
    expect(page.items.filter((item) => item.approval !== null).map((item) => item.id).sort())
      .toEqual([sendActionId, standingActionId, expiredActionId].sort());
    // The skipped send named a standing approval in its payload, but ran under none.
    expect(page.items.find((item) => item.id === skippedQueueId)!.approval).toBeNull();
    expect((await sessionFor(ownerA).getAction(expiredActionId)).approval).toEqual({ id: expiredApprovalId, status: "expired" });
    expect(await sessionFor(ownerA).getAction(standingActionId)).toMatchObject({
      approval: { id: approvalId, status: "approved" }, outcome: "queued", actor: { kind: "agent", agent: "appointment_reminder" },
    });
  });

  it("points a contact receipt at the contact that was written, also when an existing one matched", async () => {
    const page = await sessionFor(ownerA).listActions({ limit: 100 });
    const contacts = page.items.filter((item) => item.actionType === "crm.contact.create-or-find");
    expect(contacts.map((item) => item.target)).toEqual([{ type: "contact", id: contactId }, { type: "contact", id: contactId }]);
    const upload = page.items.find((item) => item.actionType === "media.asset.upload")!;
    expect(upload.target).toEqual({ type: "media_asset", id: STORED_ASSET });
  });

  it("points each row to its source record and its approval", async () => {
    const receipt = await sessionFor(ownerA).getAction(sendActionId);
    expect(receipt).toEqual({
      id: sendActionId, actionType: "reply.send", actor: { kind: "agent", agent: "inquiry_followup" },
      target: { type: "reply", id: expect.any(String) }, approval: { id: approvalId, status: "approved" },
      outcome: "queued", createdAt: at(10).toISOString(),
    });
  });
});

describe("actors", () => {
  it("names a person, an agent or a system actor", async () => {
    const page = await sessionFor(ownerA).listActions({ limit: 100 });
    const byType = Object.fromEntries(page.items.map((item) => [item.actionType, item.actor]));
    // The contact the owner saved through the action path.
    expect(page.items.find((item) => item.actionType === "crm.contact.create-or-find")).toMatchObject({
      actionType: expect.stringContaining("contact"), actor: { kind: "person", memberId: ownerAMember, role: "owner" },
      target: { type: "contact" },
    });
    expect(byType["reply.send"]).toEqual({ kind: "agent", agent: "inquiry_followup" });
    expect(byType["intake.submit"]).toEqual({ kind: "system", name: "public_intake" });
    expect(byType["approval.request"]).toEqual({ kind: "system", name: "automation" });
    expect(byType["outreach.mailbox.connect"]).toEqual({ kind: "system", name: "outreach" });
    // A member who left is still a person, with no member ID.
    expect(page.items.some((item) => item.actor.kind === "person" && item.actor.memberId === null)).toBe(true);
  });

  it("knows every service actor the code derives", async () => {
    // Checked against the map the log uses: a renamed helper must not turn a worker into a "person".
    const map = await fixture.service((tx) => serviceActors(tx, tenantA));
    const systems: Array<[(tenant: string) => string, string]> = [
      [publicIntakeActorId, "public_intake"], [unsubscribeActorId, "unsubscribe"], [inboundSmsActorId, "inbound_sms"],
      [smsStatusActorId, "sms_status"], [emailFeedbackActorId, "email_feedback"], [voiceActorId, "voice"],
      [enrichmentActorId, "enrichment"], [transcriptionActorId, "transcription"], [intakeWorkerActorId, "document_intake"],
      [imageActorId, "images"], [outreachOperatorActorId, "outreach"], [(t) => derivedId(t, "outreach", "actor"), "outreach"],
      [(t) => automationActorId(t, tokenId), "automation"],
    ];
    for (const [helper, name] of systems) expect(map.get(helper(tenantA))).toEqual({ kind: "system", name });
    for (const agent of AGENT_KINDS) expect(map.get(agentActorId(tenantA, agent))).toEqual({ kind: "agent", agent });
  });
});

describe("paging", () => {
  it("pages newest first by cursor and stays put when new actions land", async () => {
    const tenant = tenantB;
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) ids.push(await insertAction(tenant, { actorId: ownerB, actionType: "deal.update", createdAt: at(100 + i) }));
    const session = sessionFor(ownerB, tenant);
    const first = await session.listActions({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[4], ids[3]]);
    expect(first.nextCursor).not.toBeNull();
    // A newer action lands between pages; the cursor still continues after ids[3].
    await insertAction(tenant, { actorId: ownerB, actionType: "deal.update", createdAt: at(200) });
    const second = await session.listActions({ limit: 2, cursor: first.nextCursor });
    expect(second.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    const third = await session.listActions({ limit: 2, cursor: second.nextCursor });
    // ids[0], then the B action from setup; nothing after it.
    expect(third.items.map((item) => item.id)).toEqual([ids[0], expect.any(String)]);
    expect(third.nextCursor).toBeNull();
  });

  it("keeps rows with the same timestamp apart across a page boundary", async () => {
    const tenant = tenantB;
    const same = at(300);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) ids.push(await insertAction(tenant, { actorId: ownerB, actionType: "deal.tie", createdAt: same }));
    const session = sessionFor(ownerB, tenant);
    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const next = await session.listActions({ limit: 1, ...(cursor ? { cursor } : {}) });
      seen.push(...next.items.filter((item) => item.actionType === "deal.tie").map((item) => item.id));
      cursor = next.items.some((item) => item.actionType === "deal.tie") ? next.nextCursor : null;
    } while (cursor);
    expect(seen).toEqual([...ids].sort().reverse());
  });

  it("refuses another list's cursor and a bad limit", async () => {
    const foreign = Buffer.from(JSON.stringify(["approvals.recent", "1", randomUUID()])).toString("base64url");
    await expect(sessionFor(ownerA).listActions({ cursor: foreign })).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(sessionFor(ownerA).listActions({ limit: "500" })).rejects.toMatchObject({ code: "ValidationFailed" });
    // Before Postgres's first timestamp: bad input, not a server error.
    const ancient = Buffer.from(JSON.stringify(["actions.recent", "-999999999999999999", randomUUID()])).toString("base64url");
    await expect(sessionFor(ownerA).listActions({ cursor: ancient })).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});
