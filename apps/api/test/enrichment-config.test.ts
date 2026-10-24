// enrichment.md E-5, E-9: the worker's environment. Off by default; a Treg token only where the provider needs it.
import { describe, expect, it } from "vitest";
import { parseEnrichmentEnv } from "@zs/core";
import { parseEnrichmentRunnerEnv } from "../src/enrichment/config.js";

const base = { ENRICHMENT_WORKER: "on", ENRICHMENT_DATABASE_URL: "postgres://svc@127.0.0.1:5432/zs" };

describe("enrichment runner environment", () => {
  it("is off unless ENRICHMENT_WORKER is exactly on, and then needs nothing else", () => {
    expect(parseEnrichmentRunnerEnv({})).toBeNull();
    expect(parseEnrichmentRunnerEnv({ ENRICHMENT_WORKER: "ON", ENRICHMENT_DATABASE_URL: "x" })).toBeNull();
  });

  it("needs a database login, a CA outside loopback, and a token for Treg", () => {
    expect(() => parseEnrichmentRunnerEnv({ ENRICHMENT_WORKER: "on" })).toThrow(/ENRICHMENT_DATABASE_URL/);
    expect(() => parseEnrichmentRunnerEnv({ ...base, ENRICHMENT_DATABASE_URL: "postgres://svc@db.example.com:5432/zs" })).toThrow(/DATABASE_CA_CERT/);
    expect(() => parseEnrichmentRunnerEnv({ ...base, ENRICHMENT_PROVIDER: "treg" })).toThrow(/TREG_TOKEN/);
    const env = parseEnrichmentRunnerEnv({ ...base, ENRICHMENT_PROVIDER: "treg", TREG_TOKEN: "treg-test-token", TREG_ARCHIVE_CONFIRMED_OFF: "true" });
    expect(env).toMatchObject({ claimLimit: 5, providerTimeoutMs: 15_000, tregToken: "treg-test-token", enrichment: { provider: "treg", archiveConfirmedOff: true } });
  });

  it("runs the fake without a token", () => {
    expect(parseEnrichmentRunnerEnv({ ...base, ENRICHMENT_PROVIDER: "fake" })?.tregToken).toBeUndefined();
  });
});

describe("enrichment gates from the environment", () => {
  it("treats anything but exact values as off", () => {
    expect(parseEnrichmentEnv({ ENRICHMENT_PROVIDER: "treg", TREG_ARCHIVE_CONFIRMED_OFF: "TRUE" })).toMatchObject({ archiveConfirmedOff: false });
    expect(parseEnrichmentEnv({ ENRICHMENT_PROVIDER: "other" }).provider).toBeUndefined();
    expect(parseEnrichmentEnv({ ENRICHMENT_DISABLED: "1" }).disabled).toBe(true);
    expect(parseEnrichmentEnv({ ENRICHMENT_PRICE_COMPANY_CENTS: "0" }).prices["company.enrich"]).toBe(5);
  });
});
