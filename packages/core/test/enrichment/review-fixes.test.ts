// Fixes from the Sol review of the first slice (enrichment.md E-1, E-7, E-12, E-13): free-text
// locations, Aland, LinkedIn paths and the Treg adapter's handling of redirects, tokens and bad bodies.
import { describe, expect, it, vi } from "vitest";
import {
  createTregEnrichment,
  domainInRefusedRegion,
  refusedCountryInLocation,
  regionVerdict,
  type EnrichmentCall,
} from "../../src/index.js";
import { minimizeField } from "../../src/enrichment/minimize.js";

const none = { phone: null, country: null, companyDomain: null, emailDomain: null, attested: false };
const TOKEN = "treg_secret_token_value_0123456789";
const clock = { now: () => new Date("2026-10-23T09:00:00.000Z") };
const call: EnrichmentCall = { op: "company.enrich", domain: "acme.example", idempotencyKey: "enrichment:req-1", priceCents: 5, tenantId: "11111111-2222-4333-8444-555555555555" };

describe("free-text locations, Aland and LinkedIn paths (E-7, E-13)", () => {
  it("reads a country name with punctuation around it", () => {
    expect(refusedCountryInLocation("Paris (France)")).toBe("FR");
    expect(refusedCountryInLocation("Paris / France")).toBe("FR");
    expect(refusedCountryInLocation("Paris - France")).toBe("FR");
    expect(refusedCountryInLocation("Austin, Texas, United States")).toBeNull();
  });
  it("refuses Aland by code, name and ccTLD", () => {
    expect(domainInRefusedRegion("firma.ax")).toBe(true);
    expect(refusedCountryInLocation("Mariehamn, Åland Islands")).toBe("AX");
    expect(regionVerdict({ ...none, country: "AX" })).toBe("blocked");
  });
  it("drops a LinkedIn URL that normalizes outside /company/", () => {
    const now = clock.now();
    expect(minimizeField("linkedin_url", "https://www.linkedin.com/company/acme", now)).not.toBeNull();
    expect(minimizeField("linkedin_url", "https://www.linkedin.com/company/../in/person", now)).toBeNull();
  });
});

describe("the Treg adapter (E-1, E-12)", () => {
  const stub = (responder: () => Response) => {
    const seen: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { seen.push(init ?? {}); return responder(); });
    return { seen, fetcher: fetcher as unknown as typeof fetch };
  };
  it("refuses redirects and a non-HTTPS base URL, and never echoes the token from a provider error", async () => {
    const { seen, fetcher } = stub(() => new Response(JSON.stringify({ error: `bad token ${TOKEN}` }), { status: 400, headers: { "content-type": "application/json" } }));
    const outcome = await createTregEnrichment({ token: TOKEN, fetch: fetcher, clock }).run(call);
    expect(seen[0]!.redirect).toBe("error");
    expect(outcome).toMatchObject({ status: "rejected" });
    expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    expect(() => createTregEnrichment({ token: TOKEN, baseUrl: "http://api.treg.example", fetch: fetcher, clock })).toThrow(/HTTPS/);
  });
  it("treats a 200 whose body cannot be read as unknown, not as a miss", async () => {
    const { fetcher } = stub(() => new Response("{not json", { status: 200 }));
    expect(await createTregEnrichment({ token: TOKEN, fetch: fetcher, clock }).run(call)).toMatchObject({ status: "uncertain", code: "unreadable_response" });
  });
});
