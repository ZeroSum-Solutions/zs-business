// Company details on the customer page (enrichment.md E-4, E-6, E-7, E-17): the demo adapter keeps the
// API's rules, and the HTTP client reads and asks with the contract schemas.
import { describe, expect, it } from "vitest";
import { contactEnrichmentSchema } from "@zs/contracts";
import type { ApiError } from "../src/lib/api/errors";
import { createDemoAdapter } from "../src/lib/api/demo/adapter";
import { createHttpClient } from "../src/lib/api/http-client";

const NOW = new Date("2026-10-23T10:00:00.000Z");
const adapter = () => createDemoAdapter({ clock: { now: () => NOW } });
let keys = 0;
const key = () => ({ idempotencyKey: `enrichment-key-${++keys}` });
const failure = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => error as ApiError);

async function customer(api: ReturnType<typeof adapter>, email: string) {
  return (await api.createOrFindContact({ displayName: "Sam", email, phone: null }, key())).contact.id;
}

describe("demo adapter: company details", () => {
  it("starts with no profile and no lookups", async () => {
    const api = adapter();
    const id = await customer(api, "sam@acme.example");
    expect(contactEnrichmentSchema.parse(await api.getContactEnrichment(id))).toEqual({ profile: null, requests: [], results: [] });
  });

  it("lets an owner ask once per key, answers 'no match' and lists it", async () => {
    const api = adapter();
    const id = await customer(api, "sam@acme.example");
    const options = key();
    const first = await api.requestEnrichment(id, options);
    expect(first).toMatchObject({ contactId: id, domain: "acme.example", status: "no_match" });
    expect(await api.requestEnrichment(id, options)).toEqual(first);
    expect((await api.getContactEnrichment(id)).requests).toEqual([first]);
  });

  it("refuses a free-mail address, an EU or UK domain and an unknown customer", async () => {
    const api = adapter();
    expect(await failure(api.requestEnrichment(await customer(api, "sam@gmail.com"), key()))).toMatchObject({ kind: "conflict", reason: "enrichment_no_company_domain" });
    expect(await failure(api.requestEnrichment(await customer(api, "sam@firma.de"), key()))).toMatchObject({ kind: "conflict", reason: "enrichment_region_blocked" });
    expect(await failure(api.requestEnrichment("00000000-0000-4000-8000-000000000000", key()))).toMatchObject({ kind: "forbidden" });
    expect(await failure(api.getContactEnrichment("00000000-0000-4000-8000-000000000000"))).toMatchObject({ kind: "not_found" });
  });

  it("answers staff 403 on a request but lets them read", async () => {
    const api = adapter();
    const id = await customer(api, "sam@acme.example");
    api.actAs("staff");
    expect(await failure(api.requestEnrichment(id, key()))).toMatchObject({ kind: "forbidden", status: 403 });
    expect((await api.getContactEnrichment(id)).requests).toEqual([]);
  });

  it("words a refusal in plain language", async () => {
    const api = adapter();
    const error = await failure(api.requestEnrichment(await customer(api, "sam@gmail.com"), key()));
    expect(error?.message).toMatch(/no company email address/);
  });
});

describe("http client: company details", () => {
  const ID = "a1b2c3d4-1a3f-4b5c-9d7e-000000000010";
  const ACTION = "a1b2c3d4-1a3f-4b5c-9d7e-000000000001";
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const record = {
    id: "a1b2c3d4-1a3f-4b5c-9d7e-000000000020", contactId: ID, op: "company.enrich", status: "pending", reason: null,
    domain: "acme.example", priceCents: 5, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  };

  function client(response: Response) {
    const calls: { url: URL; init: RequestInit }[] = [];
    const api = createHttpClient({
      baseUrl: "/api",
      fetch: async (input, init) => { calls.push({ url: new URL(String(input), "http://127.0.0.1:3218"), init: init ?? {} }); return response; },
    });
    return { api, calls };
  }

  it("asks with POST /v1/enrichment/requests, the op and the idempotency key", async () => {
    const { api, calls } = client(json(201, { actionId: ACTION, result: record }));
    expect(await api.requestEnrichment(ID, { idempotencyKey: "key-1" })).toEqual(record);
    expect(calls[0]!.url.pathname).toBe("/api/v1/enrichment/requests");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ op: "company.enrich", contactId: ID });
    expect((calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
  });

  it("reads GET /v1/contacts/:id/enrichment, and turns a 404 into not_found", async () => {
    const ok = client(json(200, { profile: null, requests: [record], results: [] }));
    expect((await ok.api.getContactEnrichment(ID)).requests).toHaveLength(1);
    expect(ok.calls[0]!.url.pathname).toBe(`/api/v1/contacts/${ID}/enrichment`);
    const missing = client(json(404, { error: { code: "NotFound", message: "Not found", details: {} } }));
    await expect(missing.api.getContactEnrichment(ID)).rejects.toMatchObject({ kind: "not_found" });
    await expect(client(json(200, {})).api.getContactEnrichment("not-an-id")).rejects.toMatchObject({ kind: "not_found" });
  });

  it("carries a refusal's reason to the screen", async () => {
    const { api } = client(json(409, { error: { code: "Conflict", message: "Request conflicts with the current state", details: { reason: "enrichment_blocked" } } }));
    await expect(api.requestEnrichment(ID, { idempotencyKey: "key-2" })).rejects.toMatchObject({ kind: "conflict", reason: "enrichment_blocked" });
  });
});
