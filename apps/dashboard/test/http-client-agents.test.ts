// The HTTP client reads and writes the follow-up agent's routes with the contract schemas (agents.md G-11).
import { describe, expect, it } from "vitest";
import { DEFAULT_FOLLOW_UP_SETTINGS } from "@zs/contracts";
import { isSettingsChanged } from "../src/lib/api/errors";
import { createHttpClient } from "../src/lib/api/http-client";

const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
const USER = "9a1b3c5d-7e9f-4a1b-8c2d-000000000001";
const RUN = "a6e1c3b5-7d9f-4b1c-8e2a-000000000001";
const CONTACT = "5e0c1a2b-7d3f-4c8a-9b1e-000000000001";
const ITEM = "1f4e6a8c-3b5d-4e7f-8a9b-000000000001";

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
const apiError = (status: number, code: string, details: Record<string, unknown> = {}) => json(status, { error: { code, message: "x", details } });
const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;
const body = (call: Call | undefined) => JSON.parse(String(call?.init.body));
const key = (n: number) => ({ idempotencyKey: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });

const status = {
  settings: { ...DEFAULT_FOLLOW_UP_SETTINGS, enabled: true, timeZone: "America/New_York" },
  revision: 3,
  updatedAt: "2026-10-20T12:00:00.000Z",
  killed: null,
  globalKilled: false,
  canDraft: false,
  blockedBy: "quiet_hours",
};
const run = {
  id: RUN, agent: "inquiry_followup", requestedBy: USER, startedAt: "2026-10-20T12:00:00.000Z", finishedAt: "2026-10-20T12:00:05.000Z",
  status: "completed", stopReason: null, considered: 2, drafted: 1, skipped: 1,
};
const detail = {
  ...run,
  decisions: [
    { id: "c4d6e8f0-2a4c-4e6a-9b8d-000000000001", runId: RUN, intakeItemId: ITEM, contactId: CONTACT, outcome: "drafted", reason: null,
      replyId: "e7f9a1b3-5c7d-4e9f-8a1b-000000000009", approvalId: "f2b4d6e8-0a2c-4e4a-8c6e-000000000001", createdAt: "2026-10-20T12:00:01.000Z" },
    { id: "c4d6e8f0-2a4c-4e6a-9b8d-000000000002", runId: RUN, intakeItemId: ITEM, contactId: CONTACT, outcome: "skipped", reason: "no_email",
      replyId: null, approvalId: null, createdAt: "2026-10-20T12:00:02.000Z" },
  ],
};
const page = (items: unknown[], nextCursor: string | null) => ({ items, limit: 20, offset: 0, nextOffset: null, nextCursor });

describe("http client: follow-up agent", () => {
  it("reads the status from GET /v1/agents/followup, and refuses one that is not in contract shape", async () => {
    const { api, calls } = client([json(200, status), json(200, { ...status, blockedBy: "sleeping" })]);
    expect(await api.getFollowUpStatus()).toEqual(status);
    expect(calls[0]!.url.pathname).toBe("/api/v1/agents/followup");
    expect(calls[0]!.init.method).toBe("GET");
    expect(calls[0]!.init.cache).toBe("no-store");
    await expect(api.getFollowUpStatus()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("replaces the settings with PUT, the caller's key and the expected revision, and answers with the status", async () => {
    const { api, calls } = client([json(200, { actionId: ACTION, result: status })]);
    const input = { ...status.settings, maxDraftsPerDay: 12, expectedRevision: 3 };
    expect(await api.updateFollowUpSettings(input, key(1))).toEqual(status);
    expect(calls[0]!.url.pathname).toBe("/api/v1/agents/followup/settings");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(headers(calls[0])["Idempotency-Key"]).toBe(key(1).idempotencyKey);
    expect(headers(calls[0])["Content-Type"]).toBe("application/json");
    expect(body(calls[0])).toEqual(input);
  });

  it("reports a stale revision as changed settings", async () => {
    const { api } = client([apiError(409, "Conflict", { reason: "stale_revision", currentRevision: 4 })]);
    const error = await api.updateFollowUpSettings({ ...status.settings, expectedRevision: 3 }, key(2)).catch((caught: unknown) => caught);
    expect(isSettingsChanged(error)).toBe(true);
    expect(error).toMatchObject({ kind: "conflict", reason: "stale_revision", details: { currentRevision: 4 } });
  });

  it("stops with an optional note and resumes with an empty body", async () => {
    const killed = { ...status, killed: { at: "2026-10-20T12:01:00.000Z", by: USER, note: "Wrong tone" }, blockedBy: "tenant_killed" };
    const { api, calls } = client([
      json(200, { actionId: ACTION, result: killed }),
      json(200, { actionId: ACTION, result: killed }),
      json(200, { actionId: ACTION, result: status }),
    ]);
    expect(await api.killFollowUp({ note: "Wrong tone" }, key(3))).toEqual(killed);
    expect(await api.killFollowUp({}, key(4))).toEqual(killed);
    expect(await api.resumeFollowUp(key(5))).toEqual(status);
    expect(calls.map((call) => `${call.init.method} ${call.url.pathname}`)).toEqual([
      "POST /api/v1/agents/followup/kill",
      "POST /api/v1/agents/followup/kill",
      "POST /api/v1/agents/followup/resume",
    ]);
    expect(calls.map(body)).toEqual([{ note: "Wrong tone" }, {}, {}]);
  });

  it("refuses a write without a caller-owned key and sends nothing", async () => {
    const { api, calls } = client([]);
    await expect(api.killFollowUp({}, { idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError);
    await expect(api.startFollowUpRun({ idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("runs now with POST /runs, and reads a 404 as a server with no model", async () => {
    const { api, calls } = client([json(201, detail), apiError(404, "NotFound")]);
    expect(await api.startFollowUpRun(key(6))).toEqual(detail);
    expect(calls[0]!.url.pathname).toBe("/api/v1/agents/followup/runs");
    expect(calls[0]!.init.method).toBe("POST");
    expect(body(calls[0])).toEqual({});
    await expect(api.startFollowUpRun(key(7))).rejects.toMatchObject({ kind: "not_found", status: 404 });
  });

  it("reads runs a page at a time by cursor", async () => {
    const { api, calls } = client([json(200, page([run], RUN)), json(200, page([], null))]);
    expect(await api.listFollowUpRuns()).toEqual({ items: [run], nextCursor: RUN });
    expect(await api.listFollowUpRuns({ cursor: RUN })).toEqual({ items: [], nextCursor: null });
    expect(calls.map((call) => `${call.url.pathname}${call.url.search}`)).toEqual([
      "/api/v1/agents/followup/runs?limit=20",
      `/api/v1/agents/followup/runs?limit=20&cursor=${RUN}`,
    ]);
  });

  it("reads one run with its decisions, and says not found for a malformed ID without asking, or a 404", async () => {
    const { api, calls } = client([json(200, detail), apiError(404, "NotFound")]);
    expect(await api.getFollowUpRun(RUN)).toEqual(detail);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/agents/followup/runs/${RUN}`);
    await expect(api.getFollowUpRun("../settings")).rejects.toMatchObject({ kind: "not_found" });
    expect(calls).toHaveLength(1);
    await expect(api.getFollowUpRun(RUN)).rejects.toMatchObject({ kind: "not_found", message: "We could not find that run." });
  });

  it("passes on a staff member's 403 for an owner-only step", async () => {
    const { api } = client([apiError(403, "Forbidden")]);
    await expect(api.resumeFollowUp(key(8))).rejects.toMatchObject({ kind: "forbidden", status: 403 });
  });
});
