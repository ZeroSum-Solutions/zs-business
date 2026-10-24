// Company-detail proposals (enrichment.md E-14, E-17): the demo adapter seeds and decides them with the
// API's rules, and the HTTP client lists them and decides them through the approval routes.
import { describe, expect, it } from "vitest";
import { contactEnrichmentSchema, enrichmentProposalSchema } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { BRENNAN_ID, proposalId, VANDERMEER_ID } from "../src/lib/api/demo/enrichment";
import { createHttpClient } from "../src/lib/api/http-client";

const NOW = new Date("2026-10-23T10:00:00.000Z");
const adapter = () => createDemoAdapter({ clock: { now: () => NOW } });
let keys = 0;
const key = () => ({ idempotencyKey: `proposal-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);

async function proposal(api: ReturnType<typeof adapter>, contactId: string, field: string) {
  const found = (await api.listEnrichmentProposals()).find((item) => item.contactId === contactId && item.field === field);
  if (!found) throw new Error(`no ${field} proposal for ${contactId}`);
  return found;
}

describe("demo adapter: company-detail proposals", () => {
  it("seeds Celeste Vandermeer's and Colm Brennan's proposals, oldest first, with current values", async () => {
    const api = adapter();
    const items = await api.listEnrichmentProposals();
    for (const item of items) enrichmentProposalSchema.parse(item);
    // As the API orders them: oldest request first, then by customer and field.
    expect(items.map((item) => [item.contactName, item.field, item.currentValue, item.proposedValue])).toEqual([
      ["Celeste Vandermeer", "founded", null, "2009"],
      ["Celeste Vandermeer", "industry", "Art dealer", "Fine art advisory"],
      ["Celeste Vandermeer", "name", "Vandermeer Gallery", "Vandermeer & Co."],
      ["Colm Brennan", "employees", null, "12"],
      ["Colm Brennan", "industry", null, "Architecture and interior design"],
      ["Colm Brennan", "linkedin_url", null, "https://www.linkedin.com/company/brennan-studio"],
      ["Colm Brennan", "location", null, "Brooklyn, NY, US"],
      ["Colm Brennan", "name", null, "Brennan Studio"],
    ]);
    expect(new Set(items.map((item) => item.approvalId)).size).toBe(8);
    expect(items[0]).toMatchObject({
      approvalId: proposalId(3), contactId: VANDERMEER_ID, provider: "treg", callId: "call_demo_vandermeer",
      fetchedAt: "2026-10-23T05:00:00.000Z", expiresAt: "2026-11-22T05:00:00.000Z",
    });
    expect(items.find((item) => item.contactId === BRENNAN_ID)).toMatchObject({ callId: "call_demo_brennan", fetchedAt: "2026-10-23T07:00:00.000Z" });
    // Another load starts from the same seed.
    expect(await adapter().listEnrichmentProposals()).toEqual(items);
  });

  it("shows the seeded profile and the pending results on the customer page", async () => {
    const api = adapter();
    const read = contactEnrichmentSchema.parse(await api.getContactEnrichment(VANDERMEER_ID));
    expect(read.profile).toMatchObject({ companyName: "Vandermeer Gallery", companyIndustry: "Art dealer", companyFounded: null });
    expect(read.requests).toMatchObject([{ status: "succeeded", domain: "vandermeer.example" }]);
    expect(read.results.map((result) => result.approvalId)).toEqual([proposalId(1), proposalId(2), proposalId(3)]);
    expect((await api.getContactEnrichment(BRENNAN_ID)).profile).toBeNull();
  });

  it("approves into the profile, as a number for employees and founded, and drops it from the list", async () => {
    const api = adapter();
    const founded = await proposal(api, VANDERMEER_ID, "founded");
    const name = await proposal(api, VANDERMEER_ID, "name");
    await api.decideEnrichmentProposal(founded.approvalId, "approve", key());
    await api.decideEnrichmentProposal(name.approvalId, "approve", key());
    const read = contactEnrichmentSchema.parse(await api.getContactEnrichment(VANDERMEER_ID));
    expect(read.profile).toMatchObject({ companyName: "Vandermeer & Co.", companyIndustry: "Art dealer", companyFounded: 2009, revision: 3 });
    // Like the API, a result keeps its approval id after the decision.
    expect(read.results.find((result) => result.field === "founded")?.approvalId).toBe(founded.approvalId);
    const left = await api.listEnrichmentProposals();
    expect(left.map((item) => item.approvalId)).not.toContain(founded.approvalId);
    expect(left).toHaveLength(6);

    const employees = await proposal(api, BRENNAN_ID, "employees");
    await api.decideEnrichmentProposal(employees.approvalId, "approve", key());
    expect((await api.getContactEnrichment(BRENNAN_ID)).profile).toMatchObject({ contactId: BRENNAN_ID, companyEmployees: 12, companyName: null, revision: 1 });
    // The next proposal for that customer now shows nothing to replace, and an approved name would show as current.
    expect((await proposal(api, BRENNAN_ID, "name")).currentValue).toBeNull();
  });

  it("rejects without touching the profile", async () => {
    const api = adapter();
    const industry = await proposal(api, VANDERMEER_ID, "industry");
    await api.decideEnrichmentProposal(industry.approvalId, "reject", key());
    expect((await api.getContactEnrichment(VANDERMEER_ID)).profile).toMatchObject({ companyIndustry: "Art dealer", revision: 1 });
    expect((await api.listEnrichmentProposals()).map((item) => item.approvalId)).not.toContain(industry.approvalId);
  });

  it("refuses staff, an unknown or malformed id, and a second decision", async () => {
    const api = adapter();
    const name = await proposal(api, BRENNAN_ID, "name");
    api.actAs("staff");
    expect(await failure(api.decideEnrichmentProposal(name.approvalId, "approve", key()))).toMatchObject({ kind: "forbidden", status: 403 });
    expect(await api.listEnrichmentProposals()).toHaveLength(8);
    api.actAs("owner");
    expect((await api.listEnrichmentProposals()).every((item) => item.status === "pending")).toBe(true);
    // The API answers an unknown approval like a foreign one: 403.
    expect(await failure(api.decideEnrichmentProposal("00000000-0000-4000-8000-000000000000", "approve", key()))).toMatchObject({ kind: "forbidden", status: 403 });
    expect(await failure(api.decideEnrichmentProposal("not-an-id", "reject", key()))).toMatchObject({ kind: "not_found" });
    await api.decideEnrichmentProposal(name.approvalId, "reject", key());
    const again = await failure(api.decideEnrichmentProposal(name.approvalId, "approve", key()));
    expect(again).toMatchObject({ kind: "conflict", status: 409, reason: "approval_not_pending" });
    expect(again?.message).toMatch(/already decided/);
    expect((await api.getContactEnrichment(BRENNAN_ID)).profile).toBeNull();
  });

  it("replays a decision sent twice with one key, and logs every write", async () => {
    const api = adapter();
    const location = await proposal(api, BRENNAN_ID, "location");
    const options = key();
    await api.decideEnrichmentProposal(location.approvalId, "approve", options);
    await api.decideEnrichmentProposal(location.approvalId, "approve", options);
    expect((await api.getContactEnrichment(BRENNAN_ID)).profile).toMatchObject({ companyLocation: "Brooklyn, NY, US", revision: 1 });
    const linkedin = await proposal(api, BRENNAN_ID, "linkedin_url");
    await api.decideEnrichmentProposal(linkedin.approvalId, "reject", key());
    await failure(api.decideEnrichmentProposal(linkedin.approvalId, "reject", key()));
    expect(api.writeLog().filter((write) => write.operation.startsWith("enrichment.proposal.")).map(({ operation, payload, outcome, idempotencyKey }) => ({ operation, payload, outcome, sameKey: idempotencyKey === options.idempotencyKey }))).toEqual([
      { operation: "enrichment.proposal.approve", payload: { approvalId: location.approvalId }, outcome: "applied", sameKey: true },
      { operation: "enrichment.proposal.approve", payload: { approvalId: location.approvalId }, outcome: "replayed", sameKey: true },
      { operation: "enrichment.proposal.reject", payload: { approvalId: linkedin.approvalId }, outcome: "applied", sameKey: false },
      { operation: "enrichment.proposal.reject", payload: { approvalId: linkedin.approvalId }, outcome: "rejected", sameKey: false },
    ]);
  });
});

describe("http client: company-detail proposals", () => {
  const APPROVAL = "a1b2c3d4-1a3f-4b5c-9d7e-000000000030";
  const CONTACT = "a1b2c3d4-1a3f-4b5c-9d7e-000000000010";
  const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
  const TENANT = "a1b2c3d4-1a3f-4b5c-9d7e-000000000002";
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const item = {
    approvalId: APPROVAL, status: "pending", contactId: CONTACT, contactName: "Sam", resultId: "a1b2c3d4-1a3f-4b5c-9d7e-000000000040", field: "industry",
    currentValue: null, proposedValue: "Jewelry", provider: "treg", callId: "call_1", fetchedAt: NOW.toISOString(),
    requestedAt: NOW.toISOString(), expiresAt: "2026-11-22T10:00:00.000Z",
  };
  const approval = (status: "approved" | "rejected") => ({
    actionId: ACTION,
    result: {
      id: APPROVAL, tenantId: TENANT, actionType: "contact.profile.apply", target: { tenantId: TENANT, type: "contact", id: CONTACT },
      payload: { contactId: CONTACT, resultId: item.resultId }, summary: "Set industry", status, standing: status,
      requestedBy: ACTION, requestedAt: NOW.toISOString(), expiresAt: item.expiresAt, decidedBy: ACTION, decidedAt: NOW.toISOString(),
      decisionNote: null, revokedBy: null, revokedAt: null, revokeNote: null, executedActionId: null,
    },
  });

  function client(response: Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const api = createHttpClient({
      baseUrl: "/api",
      fetch: async (input, init) => { calls.push({ url: new URL(String(input), "http://127.0.0.1:3218"), init: init ?? {} }); return response; },
    });
    return { api, calls };
  }

  it("reads GET /v1/enrichment/proposals with the contract schema", async () => {
    const { api, calls } = client(json(200, { items: [item] }));
    expect(await api.listEnrichmentProposals()).toEqual([item]);
    expect(calls[0]!.url.pathname).toBe("/api/v1/enrichment/proposals");
    expect(calls[0]!.init.method).toBe("GET");
    await expect(client(json(200, { items: [{ ...item, field: "phone" }] })).api.listEnrichmentProposals()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects with POST /v1/approvals/:id/reject, an empty body and the idempotency key", async () => {
    const { api, calls } = client(json(200, approval("rejected")));
    await expect(api.decideEnrichmentProposal(APPROVAL, "reject", { idempotencyKey: "key-r" })).resolves.toBeUndefined();
    expect(calls[0]!.url.pathname).toBe(`/api/v1/approvals/${APPROVAL}/reject`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({});
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-r");
  });

  it("approves with POST /v1/approvals/:id/approve and checks the answer's shape", async () => {
    const execution = { actionId: ACTION, result: {} };
    const { api, calls } = client(json(200, { approval: approval("approved"), execution }));
    await api.decideEnrichmentProposal(APPROVAL, "approve", { idempotencyKey: "key-a" });
    expect(calls[0]!.url.pathname).toBe(`/api/v1/approvals/${APPROVAL}/approve`);
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-a");
    await expect(client(json(200, approval("approved"))).api.decideEnrichmentProposal(APPROVAL, "approve", { idempotencyKey: "key-b" }))
      .rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("turns a 404 or a malformed id into not_found, and carries a decided proposal's conflict", async () => {
    await expect(client(json(404, { error: { code: "NotFound", message: "Not found", details: {} } })).api.decideEnrichmentProposal(APPROVAL, "approve", { idempotencyKey: "k1" }))
      .rejects.toMatchObject({ kind: "not_found", message: expect.stringMatching(/suggested detail/) });
    const unused = client(json(200, {}));
    await expect(unused.api.decideEnrichmentProposal("not-an-id", "reject", { idempotencyKey: "k2" })).rejects.toMatchObject({ kind: "not_found" });
    expect(unused.calls).toHaveLength(0);
    const decided = client(json(409, { error: { code: "Conflict", message: "Request conflicts with the current state", details: { reason: "approval_not_pending" } } }));
    await expect(decided.api.decideEnrichmentProposal(APPROVAL, "reject", { idempotencyKey: "k3" })).rejects.toMatchObject({ kind: "conflict", reason: "approval_not_pending" });
    await expect(client(json(403, { error: { code: "Forbidden", message: "Forbidden", details: {} } })).api.decideEnrichmentProposal(APPROVAL, "approve", { idempotencyKey: "k4" }))
      .rejects.toMatchObject({ kind: "forbidden" });
  });
});
