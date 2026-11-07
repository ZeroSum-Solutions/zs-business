// The HTTP client's setup calls (industry-templates.md IT-6, IT-10, IT-11): the setup read, the
// server-keyed apply, the booking page switch and the new-deal write, each parsed with its contract schema.
import { INDUSTRY_TEMPLATE_IDS, INDUSTRY_TEMPLATES, industryTemplatePreview } from "@zs/contracts";
import { describe, expect, it } from "vitest";
import { isApiError } from "../src/lib/api/errors";
import { createHttpClient } from "../src/lib/api/http-client";

const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
const PIPELINE = "a1b2c3d4-1a3f-4b5c-9d7e-000000000002";
const RESOURCE = "a1b2c3d4-1a3f-4b5c-9d7e-000000000003";
const PAGE = "a1b2c3d4-1a3f-4b5c-9d7e-000000000004";
const STAGE = "a1b2c3d4-1a3f-4b5c-9d7e-000000000005";
const CONTACT = "a1b2c3d4-1a3f-4b5c-9d7e-000000000006";
const DEAL = "a1b2c3d4-1a3f-4b5c-9d7e-000000000007";
const TENANT = "a1b2c3d4-1a3f-4b5c-9d7e-000000000008";

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
const templates = INDUSTRY_TEMPLATE_IDS.map((id) => industryTemplatePreview(INDUSTRY_TEMPLATES[id]));
const applied = {
  templateId: "jewelry", templateVersion: 1, timeZone: "Europe/London", appliedAt: "2026-11-07T10:00:00.000Z",
  pipelineId: PIPELINE, stageIds: [STAGE], resourceId: RESOURCE, bookingPageId: PAGE, messageTemplateIds: [],
};

describe("http client: setup", () => {
  it("reads GET /v1/setup with the four previews", async () => {
    const { api, calls } = client([json(200, { applied: null, timeZone: null, templates })]);
    const read = await api.getSetup();
    expect(read.applied).toBeNull();
    expect(read.templates.map((t) => t.id)).toEqual(["jewelry", "crafts", "agency", "fitness"]);
    expect(calls[0]!.url.pathname).toBe("/api/v1/setup");
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("reads the applied page's title and address from GET /v1/setup, and refuses a response without them", async () => {
    const appliedRead = {
      templateId: "jewelry", templateVersion: 1, appliedAt: "2026-11-07T10:00:00.000Z", pipelineId: PIPELINE, resourceId: RESOURCE,
      bookingPageId: PAGE, bookingPageTitle: "Book a consultation", bookingUrl: "https://book.example.com/book/k", published: true,
    };
    const ok = client([json(200, { applied: appliedRead, timeZone: "Europe/London", templates })]);
    expect((await ok.api.getSetup()).applied).toMatchObject({ bookingPageTitle: "Book a consultation", bookingUrl: "https://book.example.com/book/k" });
    const { bookingPageTitle: _title, bookingUrl: _url, ...old } = appliedRead;
    const stale = client([json(200, { applied: old, timeZone: null, templates })]);
    await expect(stale.api.getSetup()).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("applies with POST and no idempotency key, and passes replayed through", async () => {
    const { api, calls } = client([json(200, { actionId: ACTION, result: applied, replayed: true })]);
    const answer = await api.applyTemplate({ templateId: "jewelry", timeZone: "Europe/London" });
    expect(answer.replayed).toBe(true);
    expect(answer.result.bookingPageId).toBe(PAGE);
    expect(calls[0]!.url.pathname).toBe("/api/v1/setup/apply");
    expect(calls[0]!.init.method).toBe("POST");
    expect(headers(calls[0])["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ templateId: "jewelry", timeZone: "Europe/London" });
  });

  it("raises another template as a template_already_applied conflict", async () => {
    const { api } = client([json(409, { error: { code: "Conflict", message: "x", details: { reason: "template_already_applied", templateId: "crafts" } } })]);
    const error = await api.applyTemplate({ templateId: "jewelry", timeZone: "Europe/London" }).catch((caught: unknown) => caught);
    expect(isApiError(error, "conflict") && error.reason).toBe("template_already_applied");
    expect((error as Error).message).toBe("This business already has a setup. It cannot be changed here.");
  });

  it("raises an unknown zone as a validation error", async () => {
    const { api } = client([json(422, { error: { code: "ValidationFailed", message: "x", details: { reason: "invalid_time_zone" } } })]);
    const error = await api.applyTemplate({ templateId: "jewelry", timeZone: "Mars/Olympus" }).catch((caught: unknown) => caught);
    expect(isApiError(error, "validation")).toBe(true);
    expect((error as Error).message).toBe("We do not know that time zone. Choose one from the list.");
  });

  it("switches the booking page with the caller's key and returns the result", async () => {
    const { api, calls } = client([json(200, { actionId: ACTION, result: { pageId: PAGE, published: true, changed: true }, replayed: false })]);
    const result = await api.setBookingPagePublished(PAGE, true, { idempotencyKey: "key-1" });
    expect(result).toEqual({ pageId: PAGE, published: true, changed: true });
    expect(calls[0]!.url.pathname).toBe(`/api/v1/setup/booking-pages/${PAGE}/published`);
    expect(headers(calls[0])["Idempotency-Key"]).toBe("key-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ published: true });
  });

  it("creates a deal with POST /v1/crm/deals and returns the record", async () => {
    const record = { id: DEAL, tenantId: TENANT, contactId: CONTACT, pipelineId: PIPELINE, stageId: STAGE, title: "Ring resize", revision: 1, createdAt: "2026-11-07T10:00:00.000Z", updatedAt: "2026-11-07T10:00:00.000Z" };
    const { api, calls } = client([json(201, { actionId: ACTION, result: record })]);
    const deal = await api.createDeal({ contactId: CONTACT, pipelineId: PIPELINE, stageId: STAGE, title: "Ring resize" }, { idempotencyKey: "key-2" });
    expect(deal).toEqual(record);
    expect(calls[0]!.url.pathname).toBe("/api/v1/crm/deals");
    expect(headers(calls[0])["Idempotency-Key"]).toBe("key-2");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ contactId: CONTACT, pipelineId: PIPELINE, stageId: STAGE, title: "Ring resize" });
  });
});
