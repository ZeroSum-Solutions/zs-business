// The HTTP client reads and writes the M3c routes with the contract schemas (inbox-home.md I-8, H-1, H-3).
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/lib/api/http-client";

const TENANT = "6f1c2a9e-3b4d-4e8f-9a1b-2c3d4e5f6a70";
const CONTACT = "5e0c1a2b-7d3f-4c8a-9b1e-000000000001";
const ITEM = "1f4e6a8c-3b5d-4e7f-8a9b-000000000001";
const REPLY = "e7f9a1b3-5c7d-4e9f-8a1b-000000000001";
const DEAL = "d3a17b5c-2e4f-4a6b-8c9d-000000000001";
const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
const USER = "9a1b3c5d-7e9f-4a1b-8c2d-000000000001";

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
const conflict = (details: Record<string, unknown>) => json(409, { error: { code: "Conflict", message: "Request conflicts with the current state", details } });
const headers = (call: Call | undefined) => (call?.init.headers ?? {}) as Record<string, string>;
const body = (call: Call | undefined) => JSON.parse(String(call?.init.body));
const key = (n: number) => ({ idempotencyKey: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}` });

const summary = {
  id: `c_${CONTACT}`, kind: "customer", contactId: CONTACT, intakeItemId: null, name: "Maren Ashby", email: "maren.ashby@example.com",
  preview: "Can we move it?", lastActivityAt: "2026-10-20T12:00:00.000Z", needsReply: true, needsReview: false, drafts: 1,
};
const reply = {
  id: REPLY, tenantId: TENANT, contactId: CONTACT, channel: "email", subject: "Your visit", body: "See you then.", status: "draft",
  draftedBy: { userId: USER, email: "owner@example.com" }, createdAt: "2026-10-20T12:05:00.000Z",
  approvedBy: null, approvedAt: null, discardedAt: null, settledAt: null,
};
const detail = {
  ...summary,
  phone: "+12125550142",
  entries: [
    {
      type: "request", id: ITEM, at: "2026-10-20T12:00:00.000Z", channel: "widget", status: "linked", name: "M. Ashby", notes: "Can we move it?",
      booking: { id: "b8c2d4e6-1a3f-4b5c-9d7e-000000000001", resourceId: "0b7e5c1a-9d2f-4a3b-8c6d-1e2f3a4b5c61", startsAt: "2026-10-22T14:00:00.000Z", endsAt: "2026-10-22T14:45:00.000Z" },
    },
    { type: "reply", at: reply.createdAt, reply },
  ],
  olderEntries: false,
};
const results = {
  zone: "America/New_York", weekStart: "monday",
  thisWeek: { from: "2026-10-19T04:00:00.000Z", to: "2026-10-26T04:00:00.000Z" },
  lastWeek: { from: "2026-10-12T04:00:00.000Z", to: "2026-10-13T16:00:00.000Z" },
  leads: { thisWeek: 2, lastWeek: 1, bySource: [{ source: "website", thisWeek: 1, lastWeek: 0 }, { source: "manual", thisWeek: 1, lastWeek: 1 }] },
  bookings: { thisWeek: 3, lastWeek: 2, bySource: [{ source: "website", thisWeek: 2, lastWeek: 1 }, { source: "owner", thisWeek: 1, lastWeek: 1 }] },
  wonDeals: { thisWeek: 1, lastWeek: 0 },
  revenue: [{ currency: "USD", thisWeek: 640000, lastWeek: 0, bySource: [{ source: "walk_in", thisWeek: 640000, lastWeek: 0 }] }],
};

describe("http client: inbox", () => {
  it("reads one page of threads and passes the cursor for the next", async () => {
    const page = { items: [summary], limit: 30, offset: 0, nextOffset: null, nextCursor: "abc_1" };
    const { api, calls } = client([json(200, page), json(200, { ...page, nextCursor: null })]);
    expect(await api.listThreads()).toEqual({ items: [summary], nextCursor: "abc_1" });
    expect(await api.listThreads({ cursor: "abc_1" })).toEqual({ items: [summary], nextCursor: null });
    expect(calls.map((call) => `${call.url.pathname}${call.url.search}`)).toEqual([
      "/api/v1/inbox/threads?limit=30",
      "/api/v1/inbox/threads?limit=30&cursor=abc_1",
    ]);
    expect(calls.map((call) => call.init.cache)).toEqual(["no-store", "no-store"]);
  });

  it("reads a thread with its entries, and refuses one that is not in contract shape", async () => {
    const { api, calls } = client([json(200, detail), json(200, { ...detail, entries: [{ type: "note", at: "x" }] })]);
    const thread = await api.getThread(`c_${CONTACT}`);
    expect(thread.entries.map((entry) => entry.type)).toEqual(["request", "reply"]);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/inbox/threads/c_${CONTACT}`);
    await expect(api.getThread(`c_${CONTACT}`)).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("says not found for a malformed ID without asking, and for a 404", async () => {
    const { api, calls } = client([json(404, { error: { code: "NotFound", message: "Not found", details: {} } })]);
    await expect(api.getThread("../x")).rejects.toMatchObject({ kind: "not_found" });
    expect(calls).toHaveLength(0);
    await expect(api.getThread(`v_${ITEM}`)).rejects.toMatchObject({ kind: "not_found", message: expect.stringMatching(/could not find that conversation/) });
  });

  it("drafts with the caller's key and only the contract's fields", async () => {
    const { api, calls } = client([json(201, { actionId: ACTION, result: reply })]);
    expect(await api.draftReply({ contactId: CONTACT, subject: "Your visit", body: "See you then." }, key(1))).toEqual(reply);
    expect(calls[0]!.url.pathname).toBe("/api/v1/inbox/replies");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers(calls[0])["Idempotency-Key"]).toBe(key(1).idempotencyKey);
    expect(body(calls[0])).toEqual({ contactId: CONTACT, subject: "Your visit", body: "See you then." });
  });

  it("approves and discards with an empty body", async () => {
    const approved = { ...reply, status: "approved", approvedBy: { userId: USER, email: null }, approvedAt: "2026-10-20T12:06:00.000Z" };
    const { api, calls } = client([json(200, { actionId: ACTION, result: approved }), json(200, { actionId: ACTION, result: { ...reply, status: "discarded", discardedAt: "2026-10-20T12:07:00.000Z" } })]);
    expect((await api.approveReply(REPLY, key(2))).status).toBe("approved");
    expect((await api.discardReply(REPLY, key(3))).status).toBe("discarded");
    expect(calls.map((call) => call.url.pathname)).toEqual([`/api/v1/inbox/replies/${REPLY}/approve`, `/api/v1/inbox/replies/${REPLY}/discard`]);
    expect(calls.map(body)).toEqual([{}, {}]);
  });

  it("refuses a reply step without a caller-owned key", async () => {
    const { api, calls } = client([]);
    await expect(api.approveReply(REPLY, { idempotencyKey: "" })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("maps not_draft and no_email to plain copy", async () => {
    const { api } = client([conflict({ reason: "not_draft", status: "approved" }), conflict({ reason: "no_email" })]);
    await expect(api.approveReply(REPLY, key(4))).rejects.toMatchObject({
      kind: "conflict", reason: "not_draft", details: { status: "approved" }, message: "This reply is no longer a draft. Someone approved or discarded it first.",
    });
    await expect(api.approveReply(REPLY, key(5))).rejects.toMatchObject({ kind: "conflict", reason: "no_email", message: expect.stringMatching(/no email address/) });
  });
});

describe("http client: home and deal details", () => {
  it("asks for results in a zone and week start", async () => {
    const { api, calls } = client([json(200, results), json(403, { error: { code: "Forbidden", message: "Forbidden", details: {} } })]);
    expect(await api.getResults({ zone: "America/New_York", weekStart: "monday" })).toEqual(results);
    expect(`${calls[0]!.url.pathname}${calls[0]!.url.search}`).toBe("/api/v1/home/results?zone=America%2FNew_York&weekStart=monday");
    // Staff have no `reports`.
    await expect(api.getResults({ zone: "UTC", weekStart: "sunday" })).rejects.toMatchObject({ kind: "forbidden", status: 403 });
  });

  it("sets deal details with the expected revision, and reports a stale one", async () => {
    const deal = {
      id: DEAL, tenantId: TENANT, contactId: CONTACT, pipelineId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e01", stageId: "2a4c6e80-1b3d-4f5a-9c7e-0d2f4a6c8e02",
      title: "Signet ring", revision: 4, createdAt: "2026-10-01T12:00:00.000Z", updatedAt: "2026-10-20T12:00:00.000Z",
      value: { amountMinor: 310000, currency: "USD" }, leadSource: "website", wonAt: null,
    };
    const { api, calls } = client([json(200, { actionId: ACTION, result: deal }), conflict({ reason: "stale_revision", currentRevision: 5 })]);
    const change = { dealId: DEAL, expectedRevision: 3, value: { amountMinor: 310000, currency: "USD" }, leadSource: "website" as const };
    expect(await api.setDealDetails(change, key(6))).toEqual(deal);
    expect(calls[0]!.url.pathname).toBe(`/api/v1/crm/deals/${DEAL}/details`);
    expect(body(calls[0])).toEqual({ expectedRevision: 3, value: { amountMinor: 310000, currency: "USD" }, leadSource: "website" });
    await expect(api.setDealDetails({ ...change, value: null, leadSource: null }, key(7))).rejects.toMatchObject({ reason: "stale_revision", details: { currentRevision: 5 } });
    expect(body(calls[1])).toEqual({ expectedRevision: 3, value: null, leadSource: null });
  });
});
