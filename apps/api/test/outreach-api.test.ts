// outreach-sequencer.md OS-1, OS-22, OS-23 over HTTP: each route round-trips, a missing key is 400, staff are 403, another
// tenant's id is 404, and a tenant outside the allowlist (or an API without one) gets 404 everywhere. No Gmail is involved.
import { randomUUID } from "node:crypto";
import {
  apiErrorBodySchema,
  OUTREACH_ERROR_CODES,
  outreachCampaignDetailSchema,
  outreachCampaignListSchema,
  outreachCampaignOutputSchema,
  outreachMailboxListSchema,
  outreachProspectPageSchema,
} from "@zs/contracts";
import { generateSealKeyPair, parseSealPublicKey, sealRefreshToken } from "@zs/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, createApiHarness, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";

let h: ApiHarness;
let staff: MemberSetup;
/** The API's allowlist; filled once the harness knows its tenant ids. */
const allowed: string[] = [];
let mailboxA: string;
let mailboxB: string;
let unlisted: ApiHarness;

const seal = parseSealPublicKey(generateSealKeyPair().publicKey);
async function seedTenant(harness: ApiHarness, tenantId: string, address: string) {
  const id = randomUUID();
  await harness.fixture.service(async (tx) => {
    await tx.query(
      `UPDATE business_profiles SET time_zone='America/Los_Angeles', legal_name='Zero Sum Solutions LLC',
         postal_address='{"line1":"1 Market St","city":"San Francisco","region":"CA","postalCode":"94105","country":"US"}'::jsonb WHERE tenant_id=$1`, [tenantId]);
    await tx.query(
      `INSERT INTO outreach_mailboxes (tenant_id,id,email,display_name,status,sealed_refresh_token,granted_scopes,daily_limit,created_at,updated_at)
       VALUES ($1,$2,$3,'Sam Sender','active',$4,'{}',20,now(),now())`,
      [tenantId, id, address, sealRefreshToken(seal, { tenantId, connectionId: id }, `fake-refresh-${address}`)]);
  });
  return id;
}

beforeAll(async () => {
  h = await createApiHarness({ outreach: { tenants: allowed } });
  allowed.push(h.a.tenantId, h.b.tenantId);
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
  mailboxA = await seedTenant(h, h.a.tenantId, "devin@zerosum-solutions.com");
  mailboxB = await seedTenant(h, h.b.tenantId, "other@zerosum-solutions.com");
  unlisted = await createApiHarness({ outreach: { tenants: [] } });
});
afterAll(async () => { await h?.close(); await unlisted?.close(); });

const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;
const campaignBody = (mailboxId: string, change: Record<string, unknown> = {}) => ({
  name: "Spring outreach",
  steps: [
    { subject: "Quick idea for {{company}}", body: "Hi {{first_name}}, I help {{industry}} teams.", delayBusinessDays: 0 },
    { body: "Following up, {{first_name}}.", delayBusinessDays: 3 },
  ],
  window: { start: "08:00", end: "10:30" },
  dailyCapPerMailbox: 5,
  mailboxIds: [mailboxId],
  ...change,
});
let serial = 0;
const rows = (n: number) => Array.from({ length: n }, () => {
  serial += 1;
  return { email: `pat${serial}@acme${serial}.example`, firstName: `Pat${serial}`, company: `Acme ${serial}`, industry: "Plumbing" };
});

async function draft(harness = h, tenant = h.a, mailboxId = mailboxA) {
  const response = await call(harness.app, "POST", "/v1/outreach/campaigns", { token: tenant.token, key: randomUUID(), body: campaignBody(mailboxId) });
  expect(response.status).toBe(201);
  return outreachCampaignOutputSchema.parse(response.body).result;
}

describe("the body limit", () => {
  it("lets only the prospect import carry more than 64 KiB", async () => {
    const created = await draft();
    const pad = "x".repeat(90);
    const many = Array.from({ length: 450 }, () => { serial += 1; return { email: `big${serial}@acme${serial}.example`, firstName: `Pat${serial}`, company: `Acme ${serial}`, industry: pad, website: `https://${pad}.example` }; });
    const imported = await call(h.app, "POST", `/v1/outreach/campaigns/${created.id}/prospects`, { token: h.a.token, key: randomUUID(), body: { prospects: many } });
    expect(JSON.stringify({ prospects: many }).length).toBeGreaterThan(64 * 1024);
    expect(imported.status).toBe(200);
    const big = await call(h.app, "POST", "/v1/outreach/campaigns", { token: h.a.token, key: randomUUID(), body: campaignBody(mailboxA, { name: "N".repeat(70 * 1024) }) });
    expect(big.status).toBe(413);
  });
});

describe("the owner routes (OS-22)", () => {
  it("creates, imports, asks for activation, takes the owner's approval, reads, pauses and stops", async () => {
    const created = await draft();
    expect(created).toMatchObject({ name: "Spring outreach", status: "draft", mailboxIds: [mailboxA] });

    const imported = await call(h.app, "POST", `/v1/outreach/campaigns/${created.id}/prospects`, {
      token: h.a.token, key: randomUUID(), body: { prospects: [...rows(3), { email: "not-an-email", firstName: "X", company: "Y" }] },
    });
    expect(imported.status).toBe(200);
    expect(imported.body).toMatchObject({ result: { imported: 3, excluded: 0, rejected: [{ index: 3, reason: "invalid_email" }] } });
    for (const row of (imported.body as { result: { rejected: { reason: string }[] } }).result.rejected) expect(OUTREACH_ERROR_CODES).toContain(row.reason);

    const asked = await call(h.app, "POST", `/v1/outreach/campaigns/${created.id}/activation`, { token: h.a.token, key: randomUUID() });
    expect(asked.status).toBe(201);
    const { approvalId } = asked.body as { approvalId: string };
    expect((await call(h.app, "GET", `/v1/outreach/campaigns/${created.id}`, { token: h.a.token })).body).toMatchObject({ campaign: { status: "draft" } });

    const approved = await call(h.app, "POST", `/v1/approvals/${approvalId}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(approved.status).toBe(200);

    const detail = outreachCampaignDetailSchema.parse((await call(h.app, "GET", `/v1/outreach/campaigns/${created.id}`, { token: h.a.token })).body);
    expect(detail.campaign.status).toBe("active");
    expect(detail.steps).toHaveLength(2);
    expect(Object.values(detail.prospectCounts).reduce((a, b) => a + b, 0)).toBe(3);

    const list = outreachCampaignListSchema.parse((await call(h.app, "GET", "/v1/outreach/campaigns", { token: h.a.token })).body);
    expect(list.items.map((item) => item.id)).toContain(created.id);

    const first = outreachProspectPageSchema.parse((await call(h.app, "GET", `/v1/outreach/campaigns/${created.id}/prospects?limit=2`, { token: h.a.token })).body);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = outreachProspectPageSchema.parse((await call(h.app, "GET",
      `/v1/outreach/campaigns/${created.id}/prospects?limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`, { token: h.a.token })).body);
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const filtered = outreachProspectPageSchema.parse((await call(h.app, "GET", `/v1/outreach/campaigns/${created.id}/prospects?status=pending`, { token: h.a.token })).body);
    expect(filtered.items).toEqual([]);

    const stopped = await call(h.app, "POST", `/v1/outreach/prospects/${first.items[0]!.id}/stop`, { token: h.a.token, key: randomUUID() });
    expect(stopped.status).toBe(200);
    expect(stopped.body).toMatchObject({ result: { status: "stopped" } });

    const paused = await call(h.app, "POST", `/v1/outreach/campaigns/${created.id}/pause`, { token: h.a.token, key: randomUUID() });
    expect(paused.status).toBe(200);
    expect(outreachCampaignOutputSchema.parse(paused.body).result).toMatchObject({ status: "paused", pausedReason: "owner" });
  });

  it("lists mailboxes without a token, a cursor or a lease", async () => {
    const response = await call(h.app, "GET", "/v1/outreach/mailboxes", { token: h.a.token });
    expect(response.status).toBe(200);
    const list = outreachMailboxListSchema.parse(response.body);
    expect(list.items.map((item) => item.email)).toEqual(["devin@zerosum-solutions.com"]);
    expect(JSON.stringify(response.body)).not.toMatch(/zsg1|sealed|history|lease/);
  });

  it("replays a create under the same key and refuses an unknown variable with a validation error", async () => {
    const key = randomUUID();
    const first = await call(h.app, "POST", "/v1/outreach/campaigns", { token: h.a.token, key, body: campaignBody(mailboxA) });
    const again = await call(h.app, "POST", "/v1/outreach/campaigns", { token: h.a.token, key, body: campaignBody(mailboxA) });
    expect(again.status).toBe(201);
    expect(again.body).toEqual(first.body);
    const bad = await call(h.app, "POST", "/v1/outreach/campaigns", {
      token: h.a.token, key: randomUUID(),
      body: campaignBody(mailboxA, { steps: [{ subject: "Hi {{nope}}", body: "Hello", delayBusinessDays: 0 }] }),
    });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("unknown_variable");
  });
});

describe("the keys, the role and the tenant (OS-1, OS-22)", () => {
  it("answers 400 to a write without an Idempotency-Key", async () => {
    const created = await draft();
    const prospect = (await call(h.app, "POST", `/v1/outreach/campaigns/${created.id}/prospects`, { token: h.a.token, key: randomUUID(), body: { prospects: rows(1).map((r) => ({ ...r, email: "solo@solo.example" })) } }));
    expect(prospect.status).toBe(200);
    const id = (outreachProspectPageSchema.parse((await call(h.app, "GET", `/v1/outreach/campaigns/${created.id}/prospects`, { token: h.a.token })).body)).items[0]!.id;
    const writes: Array<[string, string, unknown?]> = [
      ["/v1/outreach/campaigns", "POST", campaignBody(mailboxA)],
      [`/v1/outreach/campaigns/${created.id}/prospects`, "POST", { prospects: rows(1) }],
      [`/v1/outreach/campaigns/${created.id}/activation`, "POST"],
      [`/v1/outreach/campaigns/${created.id}/pause`, "POST"],
      [`/v1/outreach/prospects/${id}/stop`, "POST"],
    ];
    for (const [path, method, body] of writes) {
      const response = await call(h.app, method, path, { token: h.a.token, ...(body === undefined ? {} : { body }) });
      expect(response.status, path).toBe(400);
    }
  });

  it("answers 403 to staff on every route", async () => {
    const created = await draft();
    const attempts: Array<[string, string, unknown?]> = [
      ["GET", "/v1/outreach/campaigns"],
      ["POST", "/v1/outreach/campaigns", campaignBody(mailboxA)],
      ["GET", `/v1/outreach/campaigns/${created.id}`],
      ["POST", `/v1/outreach/campaigns/${created.id}/prospects`, { prospects: rows(1) }],
      ["GET", `/v1/outreach/campaigns/${created.id}/prospects`],
      ["POST", `/v1/outreach/campaigns/${created.id}/activation`],
      ["POST", `/v1/outreach/campaigns/${created.id}/pause`],
      ["GET", "/v1/outreach/mailboxes"],
    ];
    for (const [method, path, body] of attempts) {
      const response = await call(h.app, method, path, { token: staff.token, key: randomUUID(), ...(body === undefined ? {} : { body }) });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("answers 404 for another tenant's campaign, prospect and mailbox", async () => {
    const created = await draft();
    await call(h.app, "POST", `/v1/outreach/campaigns/${created.id}/prospects`, { token: h.a.token, key: randomUUID(), body: { prospects: rows(1) } });
    const prospectId = outreachProspectPageSchema.parse((await call(h.app, "GET", `/v1/outreach/campaigns/${created.id}/prospects`, { token: h.a.token })).body).items[0]!.id;
    const calls: Array<[string, string, unknown?]> = [
      ["GET", `/v1/outreach/campaigns/${created.id}`],
      ["GET", `/v1/outreach/campaigns/${created.id}/prospects`],
      ["POST", `/v1/outreach/campaigns/${created.id}/prospects`, { prospects: rows(1) }],
      ["POST", `/v1/outreach/campaigns/${created.id}/activation`],
      ["POST", `/v1/outreach/campaigns/${created.id}/pause`],
      ["POST", `/v1/outreach/prospects/${prospectId}/stop`],
    ];
    for (const [method, path, body] of calls) {
      const response = await call(h.app, method, path, { token: h.b.token, key: randomUUID(), ...(body === undefined ? {} : { body }) });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(outreachCampaignListSchema.parse((await call(h.app, "GET", "/v1/outreach/campaigns", { token: h.b.token })).body).items.map((i) => i.id)).not.toContain(created.id);
    expect(outreachMailboxListSchema.parse((await call(h.app, "GET", "/v1/outreach/mailboxes", { token: h.b.token })).body).items.map((m) => m.id)).toEqual([mailboxB]);
    // B cannot build a campaign on A's mailbox either.
    const foreign = await call(h.app, "POST", "/v1/outreach/campaigns", { token: h.b.token, key: randomUUID(), body: campaignBody(mailboxA) });
    expect(foreign.status).toBe(400);
  });

  it("answers 404 on every route for a tenant outside the allowlist", async () => {
    const calls: Array<[string, string, unknown?]> = [
      ["GET", "/v1/outreach/campaigns"],
      ["POST", "/v1/outreach/campaigns", campaignBody(mailboxA)],
      ["GET", `/v1/outreach/campaigns/${randomUUID()}`],
      ["POST", `/v1/outreach/campaigns/${randomUUID()}/activation`],
      ["GET", "/v1/outreach/mailboxes"],
    ];
    for (const [method, path, body] of calls) {
      const response = await call(unlisted.app, method, path, { token: unlisted.a.token, key: randomUUID(), ...(body === undefined ? {} : { body }) });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(errorOf(response).code).toBe("NotFound");
    }
    expect(await unlisted.fixture.service((tx) => tx.query("SELECT 1 FROM outreach_campaigns"))).toMatchObject({ rowCount: 0 });
  });

  it("has no outreach routes while the API has no allowlist", async () => {
    const bare = await createApiHarness();
    try {
      const response = await call(bare.app, "GET", "/v1/outreach/campaigns", { token: bare.a.token });
      expect(response.status).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
