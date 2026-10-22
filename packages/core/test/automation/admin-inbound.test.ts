// activepieces.md W-1, W-2, W-5, W-9..W-13: owners manage endpoints and tokens; a token may
// only propose, through M3b approval records, and an owner's approval is what runs the action.
// Runs under the runtime role against local Postgres with an injected clock.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ActionError, TenantDenied } from "@zs/contracts";
import { AUTOMATION_LIMITS, automationActorId, createAutomationInbound, Unauthenticated, webhookSigningSecret } from "../../src/index.js";
import { createAutomationHarness, KEY, OTHER_KEY, START, type AutomationHarness } from "./helpers.js";

let h: AutomationHarness;
beforeAll(async () => { h = await createAutomationHarness(); });
afterAll(async () => { await h?.close(); });

const hook = (path = randomUUID()) => `https://hooks.haldenrowe.example/api/v1/webhooks/${path}`;
const code = (error: unknown) => (error instanceof ActionError ? error.code : error instanceof Unauthenticated ? "Unauthenticated" : String(error));
const reason = (error: unknown) => (error instanceof ActionError ? error.details.reason : undefined);

describe("webhook endpoints (W-2, W-5)", () => {
  it("creates an endpoint and shows its derived signing secret once; a replay shows the same", async () => {
    const key = randomUUID();
    const created = await h.admin(h.a).createEndpoint({ url: hook(), events: ["lead.created", "deal.won"] }, key);
    expect(created.endpoint).toMatchObject({ enabled: true, revision: 1, secretVersion: 1, events: ["lead.created", "deal.won"] });
    expect(created.signingSecret).toBe(webhookSigningSecret(KEY, h.a.tenantId, created.endpoint.id, 1));
    expect(await h.admin(h.a).createEndpoint({ url: hook(), events: ["lead.created", "deal.won"] }, key).catch(code)).toBe("IdempotencyConflict");
    const replay = await h.admin(h.a).createEndpoint({ url: created.endpoint.url, events: ["lead.created", "deal.won"] }, key);
    expect(replay).toEqual(created);
    const listed = await h.admin(h.a).listEndpoints();
    expect(listed.items.find((item) => item.id === created.endpoint.id)).toEqual(created.endpoint);
    expect(JSON.stringify(listed)).not.toContain(created.signingSecret);
    // Nothing secret is stored: no column or action row holds it.
    const stored = JSON.stringify(await h.rows("SELECT * FROM webhook_endpoints WHERE tenant_id=$1", [h.a.tenantId]))
      + JSON.stringify(await h.rows("SELECT result FROM actions WHERE tenant_id=$1", [h.a.tenantId]));
    expect(stored).not.toContain(created.signingSecret.slice(6));
  });

  it("refuses private and plain-http receiver URLs", async () => {
    const strict = (await import("../../src/index.js")).createAutomationAdmin(h.deps(), { keySecrets: { current: KEY } },
      { tenantId: h.a.tenantId, actorId: h.a.ownerId });
    for (const url of ["http://hooks.haldenrowe.example/x", "https://169.254.169.254/x", "https://localhost/x", "http://127.0.0.1:9/x"])
      expect(await strict.createEndpoint({ url, events: ["lead.created"] }, randomUUID()).catch(code), url).toBe("ValidationFailed");
  });

  it("updates under compare-and-set, and rotates with or without a grace", async () => {
    const admin = h.admin(h.a);
    const { endpoint } = await admin.createEndpoint({ url: hook(), events: ["booking.created"] }, randomUUID());
    const updated = await admin.updateEndpoint(endpoint.id, { events: ["booking.created", "message.received"], description: "Zap", expectedRevision: 1 }, randomUUID());
    expect(updated).toMatchObject({ revision: 2, events: ["booking.created", "message.received"], description: "Zap" });
    const stale = await admin.updateEndpoint(endpoint.id, { enabled: false, expectedRevision: 1 }, randomUUID()).catch((error) => error);
    expect([code(stale), reason(stale)]).toEqual(["Conflict", "stale_revision"]);

    const rotated = await admin.rotateEndpointSecret(endpoint.id, {}, randomUUID());
    expect(rotated.endpoint.secretVersion).toBe(2);
    expect(rotated.endpoint.previousSecretValidUntil).toBe(new Date(h.clock.now().getTime() + 1440 * 60_000).toISOString());
    expect(rotated.signingSecret).toBe(webhookSigningSecret(KEY, h.a.tenantId, endpoint.id, 2));
    const leaked = await admin.rotateEndpointSecret(endpoint.id, { graceMinutes: 0 }, randomUUID());
    expect(leaked.endpoint).toMatchObject({ secretVersion: 3, previousSecretValidUntil: null });
  });

  it("caps endpoints per tenant", async () => {
    const tenant = { ...h.b };
    const have = (await h.admin(tenant).listEndpoints()).items.length;
    for (let i = have; i < AUTOMATION_LIMITS.endpoints; i += 1) await h.admin(tenant).createEndpoint({ url: hook(), events: ["lead.created"] }, randomUUID());
    const over = await h.admin(tenant).createEndpoint({ url: hook(), events: ["lead.created"] }, randomUUID()).catch((error) => error);
    expect([code(over), reason(over)]).toEqual(["Conflict", "endpoint_limit"]);
  });
});

describe("who may manage integrations (W-1)", () => {
  it("is owners only; staff and strangers are denied, and nothing is written", async () => {
    for (const actorId of [h.a.staffId, randomUUID(), h.b.ownerId]) {
      const admin = h.admin(h.a, actorId);
      expect(await admin.createEndpoint({ url: hook(), events: ["lead.created"] }, randomUUID()).catch(code)).toBe("TenantDenied");
      expect(await admin.listEndpoints().catch(code)).toBe("TenantDenied");
      expect(await admin.createToken({ name: "Flow", scopes: ["contacts:propose"] }, randomUUID()).catch(code)).toBe("TenantDenied");
      expect(await admin.listTokens().catch(code)).toBe("TenantDenied");
    }
  });

  it("never lets a member session run an integration or proposal action directly", async () => {
    const session = h.session(h.a);
    for (const actionType of ["webhook.endpoint.create", "automation.token.create", "automation.proposal.create"])
      expect(await session.requestApproval({
        action: { actionType, target: { type: "approval", id: randomUUID() }, payload: {} }, summary: "Sneak",
      }, randomUUID()).catch(code), actionType).toBe("ValidationFailed");
  });

  it("keeps one tenant's endpoints and tokens out of another's reads (two-tenant denial, runtime role)", async () => {
    const { endpoint } = await h.admin(h.a).createEndpoint({ url: hook(), events: ["lead.created"] }, randomUUID());
    const { token } = await h.admin(h.a).createToken({ name: "Mine", scopes: ["contacts:propose"] }, randomUUID());
    expect((await h.admin(h.b).listEndpoints()).items.map((item) => item.id)).not.toContain(endpoint.id);
    expect((await h.admin(h.b).listTokens()).items.map((item) => item.id)).not.toContain(token.id);
    expect(await h.admin(h.b).updateEndpoint(endpoint.id, { enabled: false, expectedRevision: 1 }, randomUUID()).catch(code)).toBe("TenantDenied");
    expect(await h.admin(h.b).revokeToken(token.id, {}, randomUUID()).catch(code)).toBe("TenantDenied");
    for (const table of ["webhook_endpoints", "automation_tokens"])
      expect(await h.fixture.b.run(async (tx) => (await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [h.a.tenantId])).rowCount), table).toBe(0);
  });
});

describe("automation tokens and proposals (W-9..W-13)", () => {
  const contactProposal = (email = `lead-${randomUUID().slice(0, 8)}@haldenrowe.example`) =>
    ({ action: "contact.upsert", input: { displayName: "Rowan Halden", email } });

  it("shows the token once, authenticates it, and refuses forged, revoked and expired tokens with one 401", async () => {
    const admin = h.admin(h.a);
    const created = await admin.createToken({ name: "Lead flow", scopes: ["contacts:propose"], expiresInDays: 30 }, randomUUID());
    expect(created.token).toMatchObject({ name: "Lead flow", scopes: ["contacts:propose"], actorId: automationActorId(h.a.tenantId, created.token.id) });
    const inbound = h.inbound();
    const principal = await inbound.authenticate(`Bearer ${created.secret}`);
    expect(inbound.whoAmI(principal)).toMatchObject({ tokenId: created.token.id, scopes: ["contacts:propose"] });
    // A key rotation keeps the token working through `previous`; a token signed by another key does not.
    expect((await h.inbound({ current: OTHER_KEY, previous: KEY }).authenticate(`Bearer ${created.secret}`)).tokenId).toBe(created.token.id);
    expect(await h.inbound({ current: OTHER_KEY }).authenticate(`Bearer ${created.secret}`).catch(code)).toBe("Unauthenticated");
    for (const header of [undefined, "", created.secret, `Basic ${created.secret}`, `Bearer ${created.secret.slice(0, -2)}AA`])
      expect(await inbound.authenticate(header).catch(code), String(header)).toBe("Unauthenticated");

    h.clock.advance(31 * 86_400_000);
    expect(await inbound.authenticate(`Bearer ${created.secret}`).catch(code)).toBe("Unauthenticated");
    h.clock.set(Date.parse("2026-10-19T08:00:00.000Z"));
    await admin.revokeToken(created.token.id, {}, randomUUID());
    expect(await inbound.authenticate(`Bearer ${created.secret}`).catch(code)).toBe("Unauthenticated");
    // Revoking twice keeps the first revocation.
    const again = await admin.revokeToken(created.token.id, {}, randomUUID());
    expect(again.revokedAt).toBe(new Date(Date.parse("2026-10-19T08:00:00.000Z")).toISOString());
  });

  it("proposes a contact; nothing exists until an owner approves, then it runs once", async () => {
    const { secret } = await h.admin(h.a).createToken({ name: "Lead flow", scopes: ["contacts:propose"] }, randomUUID());
    const inbound = h.inbound();
    const principal = await inbound.authenticate(`Bearer ${secret}`);
    const email = `new-${randomUUID().slice(0, 8)}@haldenrowe.example`;
    const flowKey = randomUUID();
    const proposal = await inbound.propose(principal, contactProposal(email), flowKey);
    expect(proposal).toMatchObject({ action: "contact.upsert", standing: "pending", executed: false, target: { type: "contact" } });
    expect(await inbound.propose(principal, contactProposal(email), flowKey)).toEqual(proposal);
    expect(await h.rows("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2", [h.a.tenantId, email])).toHaveLength(0);

    const approval = await h.session(h.a).getApproval(proposal.id);
    expect(approval).toMatchObject({
      actionType: "crm.contact.create-or-find", requestedBy: principal.actorId,
      payload: { email, consent: { email: null, sms: null }, mode: "interactive" },
    });
    expect(approval.summary).toContain("Activepieces (Lead flow)");
    // Staff cannot see or decide it (approvals.md A-11, A-6).
    expect(await h.session(h.a, h.a.staffId).getApproval(proposal.id).catch(code)).toBe("NotFound");

    const approved = await h.session(h.a).approveApproval(proposal.id, {}, randomUUID());
    expect(approved.approval.result.standing).toBe("approved");
    expect(await h.rows("SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2", [h.a.tenantId, email])).toHaveLength(1);
    expect(await inbound.getProposal(principal, proposal.id)).toMatchObject({ standing: "approved", executed: true });
  });

  it("proposes a booking that is not booked until approved, and the overlap constraint still decides", async () => {
    const { secret } = await h.admin(h.a).createToken({ name: "Bookings", scopes: ["bookings:propose"] }, randomUUID());
    const inbound = h.inbound();
    const principal = await inbound.authenticate(`Bearer ${secret}`);
    const startsAt = "2026-10-21T10:00:00.000Z";
    const first = await inbound.propose(principal, { action: "booking.create", input: { resourceId: h.a.resourceId, startsAt } }, randomUUID());
    const second = await inbound.propose(principal, { action: "booking.create", input: { resourceId: h.a.resourceId, startsAt } }, randomUUID());
    expect(await h.rows("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id IN ($2,$3)", [h.a.tenantId, first.target.id, second.target.id])).toHaveLength(0);
    await h.session(h.a).approveApproval(first.id, {}, randomUUID());
    expect(await h.rows("SELECT 1 FROM bookings WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, first.target.id])).toHaveLength(1);
    // The second proposal for the same slot loses when it runs.
    expect(await h.session(h.a).approveApproval(second.id, {}, randomUUID()).catch(code)).toBe("Conflict");
    expect(await inbound.getProposal(principal, second.id)).toMatchObject({ standing: "approved", executed: false });
  });

  it("allows only the token's scopes, and a token reads only its own proposals", async () => {
    const admin = h.admin(h.a);
    const contacts = await h.inbound().authenticate(`Bearer ${(await admin.createToken({ name: "C", scopes: ["contacts:propose"] }, randomUUID())).secret}`);
    const deals = await h.inbound().authenticate(`Bearer ${(await admin.createToken({ name: "D", scopes: ["deals:propose"] }, randomUUID())).secret}`);
    expect(await h.inbound().propose(contacts, { action: "booking.create", input: { resourceId: h.a.resourceId, startsAt: "2026-10-22T10:00:00.000Z" } }, randomUUID()).catch(code))
      .toBe("TenantDenied");
    const contact = await h.session(h.a).upsertContact({ email: `deal-${randomUUID().slice(0, 8)}@haldenrowe.example` }, randomUUID());
    const proposal = await h.inbound().propose(deals, {
      action: "deal.create", input: { contactId: contact.result.contact.id, pipelineId: h.a.pipelineId, stageId: h.a.openStage, title: "Kitchen refit" },
    }, randomUUID());
    expect(proposal.action).toBe("deal.create");
    expect(await h.inbound().getProposal(contacts, proposal.id).catch(code)).toBe("NotFound");
    expect(await h.inbound().getProposal(deals, randomUUID()).catch(code)).toBe("NotFound");
  });

  it("refuses consent evidence and unknown actions in a proposal", async () => {
    const principal = await h.inbound().authenticate(`Bearer ${(await h.admin(h.a).createToken({ name: "C", scopes: ["contacts:propose"] }, randomUUID())).secret}`);
    expect(await h.inbound().propose(principal, { action: "contact.upsert", input: { email: "x@haldenrowe.example", consent: { email: { status: "granted" } } } }, randomUUID()).catch(code))
      .toBe("ValidationFailed");
    expect(await h.inbound().propose(principal, { action: "inbox.reply.send", input: {} }, randomUUID()).catch(code)).toBe("ValidationFailed");
    expect(await h.inbound().propose(principal, contactProposal(), "approval:abc").catch(code)).toBe("ValidationFailed");
  });

  it("caps pending proposals per token, and revoking the token withdraws them", async () => {
    const { token, secret } = await h.admin(h.a).createToken({ name: "Busy", scopes: ["contacts:propose"] }, randomUUID());
    const principal = await h.inbound().authenticate(`Bearer ${secret}`);
    const made = await Promise.all(Array.from({ length: AUTOMATION_LIMITS.pendingProposalsPerToken }, () =>
      h.inbound().propose(principal, contactProposal(), randomUUID())));
    const over = await h.inbound().propose(principal, contactProposal(), randomUUID()).catch((error) => error);
    expect([code(over), reason(over)]).toEqual(["Conflict", "proposal_limit"]);
    await h.admin(h.a).revokeToken(token.id, {}, randomUUID());
    const standings = await h.rows<{ status: string }>("SELECT status FROM approvals WHERE tenant_id=$1 AND requested_by=$2",
      [h.a.tenantId, principal.actorId]);
    expect(standings).toHaveLength(made.length);
    expect(new Set(standings.map((row) => row.status))).toEqual(new Set(["revoked"]));
    // A principal built before the revocation is stopped inside the proposal's transaction.
    expect(await h.inbound().propose(principal, contactProposal(), randomUUID()).catch(code)).toBe("TenantDenied");
  });

  it("serializes a revocation with concurrent proposals: none commits after it", async () => {
    const { token, secret } = await h.admin(h.a).createToken({ name: "Race", scopes: ["contacts:propose"] }, randomUUID());
    const principal = await h.inbound().authenticate(`Bearer ${secret}`);
    const revoke = h.admin(h.a).revokeToken(token.id, {}, randomUUID());
    const proposals = await Promise.allSettled(Array.from({ length: 8 }, () => h.inbound().propose(principal, contactProposal(), randomUUID())));
    const revoked = await revoke;
    const after = await h.rows<{ requested_at: Date }>(
      "SELECT requested_at FROM approvals WHERE tenant_id=$1 AND requested_by=$2 AND status <> 'revoked'", [h.a.tenantId, principal.actorId]);
    expect(after).toHaveLength(0);
    expect(revoked.revokedAt).not.toBeNull();
    for (const result of proposals) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(TenantDenied);
  });

  it("checks token expiry against the clock read after the token lock: a wait past expiry is refused", async () => {
    h.clock.set(START);
    const { token, secret } = await h.admin(h.a).createToken({ name: "Late", scopes: ["contacts:propose"], expiresInDays: 1 }, randomUUID());
    const principal = await h.inbound().authenticate(`Bearer ${secret}`);
    h.clock.set(START + 86_400_000 - 1);
    // Another writer holds the token row (the superuser pool: the service role has no grant on
    // tokens), so the proposal waits on the lock while the token expires.
    const holder = await h.database.pool.connect();
    await holder.query("BEGIN");
    const pid = (await holder.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid FROM automation_tokens WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [h.a.tenantId, token.id])).rows[0]!.pid;
    let released = false;
    const release = async () => { if (!released) { released = true; await holder.query("ROLLBACK"); holder.release(); } };
    try {
      const outcome = h.inbound().propose(principal, contactProposal(), randomUUID()).then((value) => value, (error: unknown) => error);
      for (let tries = 0; ; tries += 1) {
        const { rowCount } = await h.database.pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND $1::int = ANY(pg_blocking_pids(pid))`, [pid]);
        if (rowCount) break;
        if (tries > 500) throw new Error("the proposal never waited on the token lock");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      h.clock.set(START + 86_400_000);
      await release();
      expect(await outcome).toBeInstanceOf(TenantDenied);
      expect(await h.rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND requested_by=$2", [h.a.tenantId, principal.actorId])).toHaveLength(0);
    } finally {
      await release();
      h.clock.set(START);
    }
  });

  it("records the proposal, its action and its event at the instant read after the token lock", async () => {
    h.clock.set(START);
    const { secret } = await h.admin(h.a).createToken({ name: "Ticking", scopes: ["contacts:propose"] }, randomUUID());
    // Every read is a minute after the last, so the dispatch's first read and the proposal's differ.
    let at = START;
    const inbound = createAutomationInbound({ ...h.deps(), clock: { now: () => new Date((at += 60_000)) } }, { keySecrets: { current: KEY } });
    const principal = await inbound.authenticate(`Bearer ${secret}`);
    const body = { ...contactProposal(), expiresInMinutes: 5 };
    const flowKey = randomUUID();
    const proposal = await inbound.propose(principal, body, flowKey);
    const stamps = await h.rows<{ requested_at: Date; expires_at: Date; action_at: Date; event_at: Date }>(
      `SELECT a.requested_at, a.expires_at, x.created_at AS action_at, o.created_at AS event_at
         FROM actions x JOIN outbox o ON o.tenant_id=x.tenant_id AND o.action_id=x.id
         JOIN approvals a ON a.tenant_id=x.tenant_id AND a.id::text=x.target->>'id'
        WHERE x.tenant_id=$1 AND x.action_type='automation.proposal.create' AND a.id=$2`, [h.a.tenantId, proposal.id]);
    expect(stamps).toHaveLength(1);
    const { requested_at: requestedAt, expires_at: expiresAt, action_at: actionAt, event_at: eventAt } = stamps[0]!;
    expect(actionAt).toEqual(requestedAt);
    expect(eventAt).toEqual(requestedAt);
    expect(expiresAt.getTime() - requestedAt.getTime()).toBe(5 * 60_000);
    expect(proposal).toMatchObject({ requestedAt: requestedAt.toISOString(), expiresAt: expiresAt.toISOString() });
    // A replay returns the stored proposal and writes nothing more.
    expect(await inbound.propose(principal, body, flowKey)).toEqual(proposal);
    expect(await h.rows("SELECT 1 FROM approvals WHERE tenant_id=$1 AND requested_by=$2", [h.a.tenantId, principal.actorId])).toHaveLength(1);
    h.clock.set(START);
  });
});
