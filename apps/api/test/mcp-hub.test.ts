// hub-access.md H-3..H-11 over HTTP: an MCP SDK client against the real Hono app, as zs_runtime on
// a real database. One token and one endpoint serve any agent; a token reads only what its
// scopes allow, proposes only what an owner then decides, and stops at once when revoked or
// expired. Fake data only: Halden & Rowe.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  apiErrorBodySchema,
  automationTokenWithSecretSchema,
  automationUsageSchema,
  businessProfileSchema,
  proposalRecordSchema,
  READ_SCOPES,
  type AutomationScope,
} from "@zs/contracts";
import { DatabaseUnavailable, type ScopedDatabase, type Transaction } from "@zs/db";
import { appOnDatabase, call, contactAndDeal, createApiHarness, NOW, signedInMember, type ApiHarness, type MemberSetup, type TenantSetup } from "./helpers.js";

const URL_BASE = "http://hub.test/mcp";
const ALL_SCOPES: AutomationScope[] = [
  "contacts:propose", "deals:propose", "bookings:propose", "contacts:read", "deals:read", "bookings:read", "inbox:read", "results:read", "business:read",
];
const PROPOSE_TOOLS = ["propose_booking_create", "propose_contact_upsert", "propose_deal_create", "propose_deal_move_stage"];
const READ_TOOLS = [
  "get_business", "get_contact", "get_thread", "home_results", "list_bookings", "list_contacts", "list_deals", "list_pipelines",
  "list_resources", "list_threads",
];

let h: ApiHarness;
let clockMs = Date.parse(NOW);
const clock = { now: () => new Date(clockMs) };
beforeAll(async () => { h = await createApiHarness({ clock, activepieces: {} }); });
afterAll(async () => { await h?.close(); });

/** The 20-active-token limit (W-15) is per tenant: each test's tokens are revoked when it ends. */
const minted: { owner: MemberSetup; id: string }[] = [];
afterEach(async () => {
  for (const { owner, id } of minted.splice(0))
    await call(h.app, "POST", `/v1/integrations/activepieces/tokens/${id}/revoke`, { token: owner.token, key: randomUUID(), body: {} });
});

async function mint(owner: MemberSetup, scopes: AutomationScope[], extra: { expiresInDays?: number | null } = {}) {
  const response = await call(h.app, "POST", "/v1/integrations/activepieces/tokens", {
    token: owner.token, key: randomUUID(), body: { name: `Agent ${scopes.length}`, scopes, ...extra },
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  const created = automationTokenWithSecretSchema.parse(response.body);
  minted.push({ owner, id: created.token.id });
  return created;
}

const headersFor = (secret: string | null, extra: Record<string, string> = {}) => ({
  "Content-Type": "application/json", Accept: "application/json, text/event-stream",
  ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }), ...extra,
});
/** One raw JSON-RPC request, as a client without the SDK would send it. */
const rpc = (app: ApiHarness["app"], secret: string | null, body: unknown, extra: Record<string, string> = {}) =>
  app.fetch(new Request(URL_BASE, {
    method: "POST", headers: headersFor(secret, extra), body: typeof body === "string" ? body : JSON.stringify(body),
  }));
let rpcId = 0;
const method = (name: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: ++rpcId, method: name, params });
const callTool = (name: string, args: Record<string, unknown> = {}) => method("tools/call", { name, arguments: args });
const INITIALIZE = () => method("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "raw", version: "1" } });

async function connect(secret: string, app: ApiHarness["app"] = h.app) {
  const transport = new StreamableHTTPClientTransport(new URL(URL_BASE), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
    fetch: async (url, init) => app.fetch(new Request(url, init)),
  });
  const client = new Client({ name: "hub-test", version: "1.0.0" });
  // The SDK types its transport's optional `sessionId` loosely; exactOptionalPropertyTypes asks for the cast.
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return { client, transport };
}
type ToolReply = { isError?: boolean; content: unknown; structuredContent?: unknown };
const text = (reply: ToolReply) => JSON.parse((reply.content as { text: string }[])[0]!.text);
const names = async (client: Client) => (await client.listTools()).tools.map((tool) => tool.name).sort();
const owner = (tenant: TenantSetup) => tenant;
const queryCount = async (sql: string, params: unknown[]) =>
  Number((await h.database.pool.query<{ n: string }>(sql, params)).rows[0]!.n);

async function seedContact(tenant: TenantSetup, name: string) {
  const email = `${name.toLowerCase()}-${randomUUID().slice(0, 6)}@haldenrowe.example`;
  const { contactId } = await contactAndDeal(h, tenant, email);
  return { contactId, email };
}

describe("an MCP SDK client against the real app (H-5, H-6)", () => {
  it("initializes, lists, reads, proposes, replays, conflicts and errors, with no session", async () => {
    const { secret, token } = await mint(owner(h.a), ALL_SCOPES);
    const { client, transport } = await connect(secret);
    expect(client.getServerVersion()?.name).toBe("zs-business");
    expect(transport.sessionId).toBeUndefined();
    expect(await names(client)).toEqual(["get_proposal", "whoami", ...PROPOSE_TOOLS, ...READ_TOOLS].sort());

    const me = text(await client.callTool({ name: "whoami", arguments: {} }) as ToolReply);
    expect(me).toMatchObject({ tokenId: token.id, scopes: expect.arrayContaining(["contacts:read", "contacts:propose"]) });

    // A read.
    const seeded = await seedContact(h.a, "Rowan");
    const listed = await client.callTool({ name: "list_contacts", arguments: { search: seeded.email } }) as ToolReply;
    expect(listed.isError).toBeUndefined();
    expect(text(listed).items.map((item: { id: string }) => item.id)).toEqual([seeded.contactId]);
    expect((listed.structuredContent as { items: unknown[] }).items).toHaveLength(1);

    // A proposal, a replay of it, a conflicting reuse of its key, and an error.
    const key = randomUUID();
    const email = `lead-${randomUUID().slice(0, 6)}@haldenrowe.example`;
    const args = { idempotencyKey: key, displayName: "Wren Halden", email };
    const proposed = await client.callTool({ name: "propose_contact_upsert", arguments: args }) as ToolReply;
    expect(proposed.isError, JSON.stringify(proposed.content)).toBeUndefined();
    const proposal = proposalRecordSchema.parse(text(proposed));
    expect(proposal).toMatchObject({ action: "contact.upsert", standing: "pending", executed: false });
    const replay = proposalRecordSchema.parse(text(await client.callTool({ name: "propose_contact_upsert", arguments: args }) as ToolReply));
    expect(replay.id).toBe(proposal.id);
    const conflict = await client.callTool({
      name: "propose_contact_upsert", arguments: { ...args, email: `other-${randomUUID().slice(0, 6)}@haldenrowe.example` },
    }) as ToolReply;
    expect(conflict.isError).toBe(true);
    expect(apiErrorBodySchema.parse(text(conflict)).error.code).toBe("Conflict");
    const missing = await client.callTool({ name: "get_contact", arguments: { contactId: randomUUID() } }) as ToolReply;
    expect(missing.isError).toBe(true);
    expect(apiErrorBodySchema.parse(text(missing)).error.code).toBe("NotFound");
    const noKey = await client.callTool({ name: "propose_contact_upsert", arguments: { email } }) as ToolReply;
    expect(noKey.isError).toBe(true);
    expect(apiErrorBodySchema.parse(text(noKey)).error.code).toBe("ValidationFailed");

    // The token reads its proposal back; the owner has not approved it, so nothing exists yet.
    expect(proposalRecordSchema.parse(text(await client.callTool({ name: "get_proposal", arguments: { proposalId: proposal.id } }) as ToolReply)).id)
      .toBe(proposal.id);
    expect(await queryCount("SELECT count(*) AS n FROM crm_contacts WHERE tenant_id=$1 AND normalized_email=$2", [h.a.tenantId, email])).toBe(0);
    await client.close();
  });

  it("serves a second, independent client at the same time, and keeps no state between requests", async () => {
    const [one, two] = await Promise.all([mint(owner(h.a), ["contacts:read"]), mint(owner(h.b), ["contacts:read", "business:read"])]);
    const a = await seedContact(h.a, "Ada");
    const b = await seedContact(h.b, "Bea");
    const [clientOne, clientTwo] = await Promise.all([connect(one.secret), connect(two.secret)]);
    expect(clientOne.transport.sessionId).toBeUndefined();
    expect(clientTwo.transport.sessionId).toBeUndefined();
    const replies = await Promise.all([
      clientOne.client.callTool({ name: "list_contacts", arguments: { search: a.email } }),
      clientTwo.client.callTool({ name: "list_contacts", arguments: { search: b.email } }),
      clientOne.client.listTools(),
      clientTwo.client.listTools(),
      clientTwo.client.callTool({ name: "get_business", arguments: {} }),
    ]);
    expect(text(replies[0] as ToolReply).items.map((item: { id: string }) => item.id)).toEqual([a.contactId]);
    expect(text(replies[1] as ToolReply).items.map((item: { id: string }) => item.id)).toEqual([b.contactId]);
    expect((replies[2] as { tools: unknown[] }).tools).toHaveLength(4);
    expect((replies[3] as { tools: unknown[] }).tools).toHaveLength(5);
    expect(businessProfileSchema.parse(text(replies[4] as ToolReply)).displayName).toBe("Tenant B");
    await Promise.all([clientOne.client.close(), clientTwo.client.close()]);
  });

  it("answers JSON, issues no session ID, and never opens a stream", async () => {
    const { secret } = await mint(owner(h.a), ["business:read"]);
    const response = await rpc(h.app, secret, INITIALIZE());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).result.serverInfo.name).toBe("zs-business");
    expect((await rpc(h.app, secret, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });
});

describe("what a token's scopes allow (H-2, H-6)", () => {
  it("lists a contacts:read token's two tools plus whoami and get_proposal, and refuses list_deals with -32601", async () => {
    const { secret } = await mint(owner(h.a), ["contacts:read"]);
    const { client } = await connect(secret);
    expect(await names(client)).toEqual(["get_contact", "get_proposal", "list_contacts", "whoami"]);
    const seeded = await seedContact(h.a, "Cora");
    expect(text(await client.callTool({ name: "get_contact", arguments: { contactId: seeded.contactId } }) as ToolReply).id).toBe(seeded.contactId);
    for (const name of ["list_deals", "propose_contact_upsert", "get_business", "no_such_tool"])
      await expect(client.callTool({ name, arguments: { idempotencyKey: randomUUID() } }), name).rejects.toMatchObject({ code: -32601, message: /Method not found/ });
    await client.close();
  });

  it("treats a propose-only token as one that reads nothing but its own proposals", async () => {
    const legacy = await mint(owner(h.a), ["contacts:propose", "deals:propose", "bookings:propose"]);
    const other = await mint(owner(h.a), ["contacts:propose"]);
    const { client } = await connect(legacy.secret);
    expect(await names(client)).toEqual(["get_proposal", "whoami", ...PROPOSE_TOOLS].sort());
    for (const name of ["list_contacts", "get_contact", "list_deals", "list_bookings", "list_threads", "home_results", "get_business"])
      await expect(client.callTool({ name, arguments: {} }), name).rejects.toMatchObject({ code: -32601 });
    const proposed = proposalRecordSchema.parse(text(await client.callTool({
      name: "propose_contact_upsert", arguments: { idempotencyKey: randomUUID(), email: `p-${randomUUID().slice(0, 6)}@haldenrowe.example` },
    }) as ToolReply));
    expect(proposalRecordSchema.parse(text(await client.callTool({ name: "get_proposal", arguments: { proposalId: proposed.id } }) as ToolReply)).id)
      .toBe(proposed.id);
    // Another token of the same tenant gets not found, and so does a made-up ID.
    const { client: stranger } = await connect(other.secret);
    for (const proposalId of [proposed.id, randomUUID()]) {
      const reply = await stranger.callTool({ name: "get_proposal", arguments: { proposalId } }) as ToolReply;
      expect(reply.isError).toBe(true);
      expect(apiErrorBodySchema.parse(text(reply)).error.code).toBe("NotFound");
    }
    // A token cannot propose beyond its scopes: unlisted, so -32601.
    await expect(stranger.callTool({ name: "propose_deal_create", arguments: {} })).rejects.toMatchObject({ code: -32601 });
    await Promise.all([client.close(), stranger.close()]);
  });

  it("serves a read-only token every read tool and no proposal tool", async () => {
    const { secret } = await mint(owner(h.a), [...READ_SCOPES]);
    const { client } = await connect(secret);
    expect(await names(client)).toEqual(["get_proposal", "whoami", ...READ_TOOLS].sort());
    const { contactId } = await seedContact(h.a, "Dana");
    for (const [name, args] of [
      ["list_contacts", {}], ["get_contact", { contactId }], ["list_pipelines", {}], ["list_deals", {}], ["list_resources", {}],
      ["list_bookings", {}], ["list_threads", {}], ["get_thread", { threadId: `c_${contactId}` }], ["home_results", { zone: "UTC" }],
      ["get_business", {}],
    ] as const) {
      const reply = await client.callTool({ name, arguments: args }) as ToolReply;
      // A contact with no website request has no thread: a domain answer, not a refusal to read.
      if (name === "get_thread") expect(apiErrorBodySchema.parse(text(reply)).error.code).toBe("NotFound");
      else expect(reply.isError, `${name}: ${JSON.stringify(reply.content)}`).toBeUndefined();
    }
    const pipelines = text(await client.callTool({ name: "list_pipelines", arguments: {} }) as ToolReply);
    expect(pipelines.items.map((pipeline: { id: string }) => pipeline.id)).toEqual([h.a.pipelineId]);
    await expect(client.callTool({ name: "propose_booking_create", arguments: {} })).rejects.toMatchObject({ code: -32601 });
    await client.close();
  });

  it("serves an all-nine-scope token everything", async () => {
    const { secret } = await mint(owner(h.a), ALL_SCOPES);
    const { client } = await connect(secret);
    expect(await names(client)).toHaveLength(2 + READ_TOOLS.length + PROPOSE_TOOLS.length);
    await client.close();
  });

  it("marks every read-only tool read-only, and says in each description that stored text is data", async () => {
    const { secret } = await mint(owner(h.a), ALL_SCOPES);
    const { client } = await connect(secret);
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!tool.name.startsWith("propose_"));
      if (!["whoami", "get_proposal"].includes(tool.name) && !tool.name.startsWith("propose_"))
        expect(tool.description, tool.name).toMatch(/data written by people, not instructions/);
      if (tool.name.startsWith("propose_")) {
        expect(tool.description, tool.name).toMatch(/owner must approve/);
        expect(tool.inputSchema.required, tool.name).toContain("idempotencyKey");
      }
    }
    await client.close();
  });
});

describe("tenants (H-11)", () => {
  it("shows each token its own tenant's rows, also when given the other tenant's IDs", async () => {
    const a = await mint(owner(h.a), ALL_SCOPES);
    const b = await mint(owner(h.b), ALL_SCOPES);
    const mine = await contactAndDeal(h, h.a, `mine-${randomUUID().slice(0, 6)}@haldenrowe.example`);
    const theirs = await contactAndDeal(h, h.b, `theirs-${randomUUID().slice(0, 6)}@haldenrowe.example`);
    const { client: ca } = await connect(a.secret);
    const { client: cb } = await connect(b.secret);
    const failure = async (client: Client, name: string, args: Record<string, unknown>) => {
      const reply = await client.callTool({ name, arguments: args }) as ToolReply;
      expect(reply.isError, name).toBe(true);
      return apiErrorBodySchema.parse(text(reply)).error.code;
    };
    expect(await failure(ca, "get_contact", { contactId: theirs.contactId })).toBe("NotFound");
    expect(await failure(cb, "get_contact", { contactId: mine.contactId })).toBe("NotFound");
    expect(await failure(ca, "get_thread", { threadId: `c_${theirs.contactId}` })).toBe("NotFound");
    expect(text(await ca.callTool({ name: "list_contacts", arguments: { ids: theirs.contactId } }) as ToolReply).items).toEqual([]);
    expect(text(await ca.callTool({ name: "list_deals", arguments: { contactId: theirs.contactId } }) as ToolReply).items).toEqual([]);
    expect(text(await ca.callTool({ name: "list_bookings", arguments: { resourceId: h.b.resourceId } }) as ToolReply).items).toEqual([]);
    expect(businessProfileSchema.parse(text(await ca.callTool({ name: "get_business", arguments: {} }) as ToolReply)).displayName).toBe("Tenant A");
    expect(businessProfileSchema.parse(text(await cb.callTool({ name: "get_business", arguments: {} }) as ToolReply)).displayName).toBe("Tenant B");
    // A proposal that names the other tenant's rows is made for this tenant and cannot reach theirs.
    const moved = await ca.callTool({
      name: "propose_deal_move_stage",
      arguments: { idempotencyKey: randomUUID(), dealId: theirs.dealId, pipelineId: h.a.pipelineId, stageId: h.a.stages[1], expectedRevision: 1 },
    }) as ToolReply;
    const proposal = proposalRecordSchema.parse(text(moved));
    expect(proposal.standing).toBe("pending");
    const approved = await call(h.app, "POST", `/v1/approvals/${proposal.id}/approve`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(approved.status).not.toBe(200);
    expect(await queryCount("SELECT count(*) AS n FROM crm_deals WHERE tenant_id=$1 AND stage_id=$2", [h.b.tenantId, h.a.stages[1]])).toBe(0);
    expect(await names(cb)).toHaveLength(16);
    await Promise.all([ca.close(), cb.close()]);
  });
});

describe("no tool writes but a pending proposal (H-4)", () => {
  it("offers no approve, reject, send or other write tool, and four proposals change no business row", async () => {
    const { secret } = await mint(owner(h.a), ALL_SCOPES);
    const { client } = await connect(secret);
    const all = await names(client);
    expect(all.filter((name) => /approve|reject|send|revoke|delete|remove|update|decide|cancel|draft|run|execute/.test(name))).toEqual([]);
    for (const name of ["approve_proposal", "reject_proposal", "send_reply", "create_booking", "upsert_contact", "request_approval", "revoke_token"])
      await expect(client.callTool({ name, arguments: {} }), name).rejects.toMatchObject({ code: -32601 });

    const counts = () => h.database.pool.query<{ kind: string; n: string }>(
      `SELECT 'contacts' AS kind, count(*) AS n FROM crm_contacts WHERE tenant_id=$1
       UNION ALL SELECT 'deals', count(*) FROM crm_deals WHERE tenant_id=$1
       UNION ALL SELECT 'bookings', count(*) FROM bookings WHERE tenant_id=$1`, [h.a.tenantId]).then((result) => result.rows);
    const { contactId, dealId } = await contactAndDeal(h, h.a, `base-${randomUUID().slice(0, 6)}@haldenrowe.example`);
    const before = await counts();
    const events = async () => Object.fromEntries((await h.database.pool.query<{ event_type: string; n: string }>(
      "SELECT event_type, count(*) AS n FROM outbox WHERE tenant_id=$1 GROUP BY 1", [h.a.tenantId])).rows.map((row) => [row.event_type, Number(row.n)]));
    const eventsBefore = await events();
    const proposals = [
      ["propose_contact_upsert", { displayName: "Neo", email: `neo-${randomUUID().slice(0, 6)}@haldenrowe.example` }],
      ["propose_deal_create", { contactId, pipelineId: h.a.pipelineId, stageId: h.a.stages[0], title: "Bracelet" }],
      ["propose_deal_move_stage", { dealId, pipelineId: h.a.pipelineId, stageId: h.a.stages[1], expectedRevision: 1 }],
      ["propose_booking_create", { resourceId: h.a.resourceId, startsAt: "2026-10-19T11:00:00.000Z" }],
    ] as const;
    for (const [name, args] of proposals) {
      const reply = await client.callTool({ name, arguments: { idempotencyKey: randomUUID(), ...args } }) as ToolReply;
      expect(reply.isError, `${name}: ${JSON.stringify(reply.content)}`).toBeUndefined();
      expect(proposalRecordSchema.parse(text(reply))).toMatchObject({ standing: "pending", executed: false });
    }
    expect(await counts()).toEqual(before);
    // The only events the proposals added are for the approval record, never a contact, deal, booking or message.
    const eventsAfter = await events();
    const grown = Object.keys(eventsAfter).filter((type) => eventsAfter[type] !== (eventsBefore[type] ?? 0));
    expect(grown.length).toBeGreaterThan(0);
    expect(grown.filter((type) => !/approval/.test(type))).toEqual([]);
    await client.close();
  });
});

describe("authentication (H-5, W-9)", () => {
  it("refuses a revoked token on its next request, and an owner's revoke is immediate", async () => {
    const { secret, token } = await mint(owner(h.a), ["contacts:read"]);
    const { client } = await connect(secret);
    await client.callTool({ name: "list_contacts", arguments: {} });
    const revoked = await call(h.app, "POST", `/v1/integrations/activepieces/tokens/${token.id}/revoke`, { token: h.a.token, key: randomUUID(), body: {} });
    expect(revoked.status).toBe(200);
    const response = await rpc(h.app, secret, method("tools/list"));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    await expect(client.callTool({ name: "list_contacts", arguments: {} })).rejects.toBeDefined();
  });

  it("refuses a token another request replays after the tag changed, before any database query", async () => {
    const { secret } = await mint(owner(h.a), ["contacts:read"]);
    let queries = 0;
    const counting: ScopedDatabase = {
      tenant: (...args) => { queries += 1; return h.database.db.tenant(...args); },
      withoutTenant: (...args) => { queries += 1; return h.database.db.withoutTenant(...args); },
    };
    const app = appOnDatabase(counting, { clock });
    const flipped = secret.slice(0, -1) + (secret.endsWith("A") ? "B" : "A");
    const swapped = `zsap1_${secret.slice(6, 42)}${"A".repeat(secret.length - 42)}`;
    for (const bad of [flipped, swapped, "zsap1_nope", "nope", ""]) {
      const response = await rpc(app, bad === "" ? null : bad, method("tools/list"));
      expect(response.status, bad).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
      expect(apiErrorBodySchema.parse(await response.json()).error.code).toBe("Unauthorized");
    }
    expect((await app.fetch(new Request(URL_BASE, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${secret}` }, body: "{}" }))).status).toBe(401);
    expect(queries).toBe(0);
    // The real token works on the same app, and does query.
    expect((await rpc(app, secret, method("tools/list"))).status).toBe(200);
    expect(queries).toBeGreaterThan(0);
  });

  it("refuses a member's session token, which is not an automation token", async () => {
    expect((await rpc(h.app, h.a.token, method("tools/list"))).status).toBe(401);
  });
});

describe("transport answers before MCP handling (H-5)", () => {
  it("answers GET and DELETE with 405, and a missing automation key with 404", async () => {
    const { secret } = await mint(owner(h.a), ["business:read"]);
    for (const verb of ["GET", "DELETE", "PUT"]) {
      const response = await h.app.fetch(new Request(URL_BASE, { method: verb, headers: headersFor(secret) }));
      expect(response.status, verb).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    }
    const off = appOnDatabase(h.database.db, { clock, activepieces: false });
    expect((await rpc(off, secret, method("tools/list"))).status).toBe(404);
    expect((await off.fetch(new Request(URL_BASE, { method: "GET" }))).status).toBe(404);
  });

  it("answers an oversized body with 413, a batch or bad JSON with 400, and a session ID with 404", async () => {
    const { secret } = await mint(owner(h.a), ["business:read"]);
    const big = await rpc(h.app, secret, JSON.stringify({ ...method("tools/list"), pad: "x".repeat(65 * 1024) }));
    expect(big.status).toBe(413);
    // The limit is checked before the token: an anonymous caller gets 413 too, and no database work.
    expect((await rpc(h.app, null, JSON.stringify({ pad: "x".repeat(65 * 1024) }))).status).toBe(413);
    const batch = await rpc(h.app, secret, [method("tools/list"), method("tools/list")]);
    expect(batch.status).toBe(400);
    expect((await batch.json()).error.code).toBe(-32600);
    const broken = await rpc(h.app, secret, "{not json");
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.code).toBe(-32700);
    const session = await rpc(h.app, secret, method("tools/list"), { "Mcp-Session-Id": randomUUID() });
    expect(session.status).toBe(404);
    expect((await session.json()).error.code).toBe(-32001);
    // An anonymous caller learns nothing else: 401 wins over a batch or a session header.
    expect((await rpc(h.app, null, [method("tools/list")])).status).toBe(401);
    expect((await rpc(h.app, null, method("tools/list"), { "Mcp-Session-Id": randomUUID() })).status).toBe(401);
  });
});

describe("usage record and the owner route (H-8)", () => {
  it("counts requests, reads, proposals and refusals per hour, and an owner reads them", async () => {
    const { secret, token } = await mint(owner(h.a), ALL_SCOPES);
    const send = async (body: unknown, status = 200) => expect((await rpc(h.app, secret, body)).status).toBe(status);
    await send(INITIALIZE());
    await send({ jsonrpc: "2.0", method: "notifications/initialized" }, 202);
    await send(method("tools/list"));
    await send(callTool("list_contacts"));
    await send(callTool("whoami"));
    await send(callTool("propose_contact_upsert", { idempotencyKey: randomUUID(), email: `u-${randomUUID().slice(0, 6)}@haldenrowe.example` }));
    await send(callTool("get_contact", { contactId: randomUUID() }));
    await send(callTool("no_such_tool"));
    await send([method("tools/list")], 400);

    const usage = automationUsageSchema.parse((await call(h.app, "GET", `/v1/integrations/activepieces/tokens/${token.id}/usage`, { token: h.a.token })).body);
    expect(usage.tokenId).toBe(token.id);
    expect(usage.hours).toHaveLength(1);
    expect(usage.hours[0]!.hour).toBe(new Date(Math.floor(clockMs / 3_600_000) * 3_600_000).toISOString());
    // Requests: 9. Reads: list_contacts and whoami returned. Proposals: one. Refusals: the
    // unknown contact (a tool error), the unknown tool (-32601) and the batch (400).
    expect(usage.totals).toEqual({ requests: 9, reads: 2, proposals: 1, refusals: 3 });
    expect(usage.hours[0]).toMatchObject(usage.totals);
  });

  it("belongs to the owner: staff and the other tenant's owner are refused", async () => {
    const { token } = await mint(owner(h.a), ["contacts:read"]);
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    const path = `/v1/integrations/activepieces/tokens/${token.id}/usage`;
    expect((await call(h.app, "GET", path, { token: staff.token })).status).toBe(403);
    expect((await call(h.app, "GET", path, { token: h.b.token })).status).toBe(404);
    expect((await call(h.app, "GET", path)).status).toBe(401);
    const empty = automationUsageSchema.parse((await call(h.app, "GET", path, { token: h.a.token })).body);
    expect(empty).toMatchObject({ hours: [], totals: { requests: 0, reads: 0, proposals: 0, refusals: 0 } });
  });

  it("never fails a request when the increment fails, and reports it", async () => {
    const { secret } = await mint(owner(h.a), ["business:read"]);
    const reported: unknown[] = [];
    const breaking: ScopedDatabase = {
      ...h.database.db,
      tenant: (tenantId, work, options) => h.database.db.tenant(tenantId, (tx) => work({
        query: ((sql: string, params?: unknown[]) => /automation_token_usage/.test(sql)
          ? Promise.reject(new Error("usage store down"))
          : tx.query(sql as never, params as never)) as Transaction["query"],
      }), options),
    };
    const app = appOnDatabase(breaking, { clock, onError: (error) => { reported.push(error); } });
    const response = await rpc(app, secret, callTool("get_business"));
    expect(response.status).toBe(200);
    expect(businessProfileSchema.parse(JSON.parse((await response.json()).result.content[0].text)).displayName).toBe("Tenant A");
    expect(reported.map((error) => (error as Error).message)).toEqual(["usage store down"]);
  });
});

describe("deadline, disconnect and outage (H-5)", () => {
  /** A database that holds the first statement matching `pattern` until `release()`, and logs what became of it. */
  function holding(pattern: RegExp, onStatement?: (sql: string) => Error | undefined) {
    let reached!: () => void;
    const atStatement = new Promise<void>((resolve) => { reached = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const outcomes: string[] = [];
    const db: ScopedDatabase = {
      ...h.database.db,
      tenant: (tenantId, work, options) => h.database.db.tenant(tenantId, (tx) => work({
        query: (async (sql: string, params?: unknown[]) => {
          const failure = onStatement?.(sql);
          if (failure) throw failure;
          if (!pattern.test(sql)) return tx.query(sql as never, params as never);
          reached();
          await gate;
          try {
            const result = await tx.query(sql as never, params as never);
            outcomes.push("ran");
            return result;
          } catch (error) {
            outcomes.push((error as Error).message);
            throw error;
          }
        }) as Transaction["query"],
      }), options),
    };
    return { db, atStatement, release, outcomes };
  }

  it("cancels the request's database work when the client disconnects", async () => {
    const { secret } = await mint(owner(h.a), ["contacts:read"]);
    const held = holding(/FROM crm_contacts/i);
    const app = appOnDatabase(held.db, { clock });
    const gone = new AbortController();
    const pending = app.fetch(new Request(URL_BASE, {
      method: "POST", headers: headersFor(secret), body: JSON.stringify(callTool("list_contacts")), signal: gone.signal,
    }));
    await held.atStatement;
    gone.abort();
    // The read now sends its customer query late: the request's signal has fired, so it never reaches the database.
    held.release();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(apiErrorBodySchema.parse(await response.json()).error.code).toBe("Unavailable");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(held.outcomes).toEqual(["Database unavailable (aborted)"]);
  });

  it("answers a database outage with 503 and Retry-After, whether it hits the token check or a read", async () => {
    const { secret } = await mint(owner(h.a), ["contacts:read"]);
    const readDown = holding(/never-matches/, (sql) => (/FROM crm_contacts/i.test(sql) ? new DatabaseUnavailable("connect") : undefined));
    const mid = await rpc(appOnDatabase(readDown.db, { clock }), secret, callTool("list_contacts"));
    expect(mid.status).toBe(503);
    expect(mid.headers.get("retry-after")).toBe("1");
    const allDown = holding(/never-matches/, () => new DatabaseUnavailable("connect"));
    const start = await rpc(appOnDatabase(allDown.db, { clock }), secret, callTool("list_contacts"));
    expect(start.status).toBe(503);
    expect(apiErrorBodySchema.parse(await start.json()).error.code).toBe("Unavailable");
  });

  it("ends a read past the request deadline with 503", async () => {
    const { secret } = await mint(owner(h.a), ["contacts:read"]);
    const held = holding(/FROM crm_contacts/i);
    const app = appOnDatabase(held.db, { clock, requestTimeoutMs: 150 });
    const response = await rpc(app, secret, callTool("list_contacts"));
    expect(response.status).toBe(503);
    held.release();
  });
});

describe("expiry (H-1)", () => {
  it("refuses an expired token on its next request", async () => {
    const { secret } = await mint(owner(h.a), ["business:read"], { expiresInDays: 1 });
    expect((await rpc(h.app, secret, method("tools/list"))).status).toBe(200);
    clockMs += 25 * 3_600_000;
    try {
      const response = await rpc(h.app, secret, method("tools/list"));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    } finally {
      clockMs = Date.parse(NOW);
    }
  });

  it("asks for an expiry on a read token: 90 days by default, and no null", async () => {
    const created = await mint(owner(h.a), ["business:read"]);
    expect(created.token.expiresAt).toBe(new Date(Date.parse(NOW) + 90 * 86_400_000).toISOString());
    const refused = await call(h.app, "POST", "/v1/integrations/activepieces/tokens", {
      token: h.a.token, key: randomUUID(), body: { name: "Forever", scopes: ["business:read"], expiresInDays: null },
    });
    expect(refused.status).toBe(400);
    expect((await call(h.app, "POST", "/v1/integrations/activepieces/tokens", {
      token: h.a.token, key: randomUUID(), body: { name: "Old", scopes: ["deals:propose"] },
    })).status).toBe(201);
  });
});
