// The HTTP client reads and writes the templated kinds' routes with the contract schemas
// (agents.md G-14, G-19, approvals.md A-15), sending the caller's Idempotency-Key on every write.
import { describe, expect, it } from "vitest";
import { defaultAgentKindSettings, TEMPLATE_VARIABLES } from "@zs/contracts";
import { createHttpClient } from "../src/lib/api/http-client";

const ID = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
const USER = "9a1b3c5d-7e9f-4a1b-8c2d-000000000001";
const NOW = "2026-10-20T12:00:00.000Z";

interface Call { url: URL; init: RequestInit }
function client(responses: Response[]) {
  const calls: Call[] = [];
  const queue = [...responses];
  const api = createHttpClient({
    baseUrl: "/api",
    fetch: async (input, init) => {
      calls.push({ url: new URL(String(input), "http://127.0.0.1:3218"), init: init ?? {} });
      const next = queue.shift();
      if (!next) throw new Error("no response queued");
      return next;
    },
  });
  return { api, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;
const body = (call: Call | undefined) => JSON.parse(String(call?.init.body));
const key = { idempotencyKey: "00000000-0000-4000-8000-000000000009" };

const state = {
  agentKind: "review_request", templateId: ID, purpose: "marketing", variables: [...TEMPLATE_VARIABLES.review_request], currentRevision: 1,
  revisions: [{
    id: ID, revision: 1, channel: "sms", purpose: "marketing", subject: null, body: "Thanks! {review_link}", variables: ["review_link"],
    timingHours: 24, contentDigest: "b".repeat(64), createdBy: USER, createdAt: NOW, current: true, standing: null, pendingApprovalId: null, approved: false,
  }],
};
const kindStatus = {
  agentKind: "review_request", settings: defaultAgentKindSettings("review_request"), revision: 0, updatedAt: null, killed: null, globalKilled: false,
  canRun: false, blockedBy: "disabled", costSpentMicros: 0, costCapMicros: 1_000_000, costWarning: false,
};

describe("http client: templated kinds", () => {
  it("reads a kind's status and template, and writes a revision with the caller's key", async () => {
    const { api, calls } = client([json(200, kindStatus), json(200, state), json(201, state)]);
    expect(await api.getAgentKindStatus("review_request")).toMatchObject({ agentKind: "review_request", revision: 0 });
    expect(await api.getTemplate("review_request")).toMatchObject({ currentRevision: 1 });
    const request = { expectedRevision: 0, channel: "sms" as const, subject: null, body: "Thanks! {review_link}", timingHours: 24 };
    await api.createTemplateRevision("review_request", request, key);
    expect(calls.map((call) => [call.init.method, call.url.pathname])).toEqual([
      ["GET", "/api/v1/agents/review_request"],
      ["GET", "/api/v1/agents/review_request/template"],
      ["POST", "/api/v1/agents/review_request/template/revisions"],
    ]);
    expect(headers(calls[2])["Idempotency-Key"]).toBe(key.idempotencyKey);
    expect(body(calls[2])).toEqual(request);
  });

  it("approves by revision and digest, and saves the kind's settings with PUT", async () => {
    const approval = {
      id: ID, tenantId: USER, actionType: "template.standing.grant", target: { tenantId: USER, type: "message_template_revision", id: ID },
      payload: {}, summary: "x", status: "approved", standing: "approved", requestedBy: USER, requestedAt: NOW, expiresAt: NOW,
      decidedBy: USER, decidedAt: NOW, decisionNote: null, revokedBy: null, revokedAt: null, revokeNote: null, executedActionId: ID,
    };
    const { api, calls } = client([
      json(200, { approval: { actionId: ID, result: approval }, execution: { actionId: ID, result: {} } }),
      json(200, { actionId: ID, result: kindStatus }),
    ]);
    await api.approveTemplate("review_request", { revision: 1, contentDigest: "b".repeat(64) }, key);
    expect(body(calls[0])).toEqual({ revision: 1, contentDigest: "b".repeat(64) });
    const saved = await api.updateAgentKindSettings("review_request", { ...defaultAgentKindSettings("review_request"), expectedRevision: 0 }, key);
    expect(saved).toMatchObject({ agentKind: "review_request" });
    expect([calls[1]?.init.method, calls[1]?.url.pathname]).toEqual(["PUT", "/api/v1/agents/review_request/settings"]);
  });

  it("asks for a suggestion and starts a run, and a suggestion route that is off is not_found", async () => {
    const run = {
      id: ID, agent: "review_request", requestedBy: USER, startedAt: NOW, finishedAt: NOW, status: "completed", stopReason: null,
      considered: 0, drafted: 0, skipped: 0, decisions: [],
    };
    const { api, calls } = client([json(404, { error: { code: "NotFound", message: "Not found", details: {} } }), json(201, run)]);
    await expect(api.suggestTemplate("review_request", { channel: "email" }, key)).rejects.toMatchObject({ kind: "not_found" });
    expect(await api.startKindRun("review_request", key)).toMatchObject({ status: "completed", decisions: [] });
    expect(calls.map((call) => call.url.pathname)).toEqual(["/api/v1/agents/review_request/template-suggestion", "/api/v1/agents/review_request/runs"]);
    expect(body(calls[1])).toEqual({});
  });
});
