// M5 configuration (docs/requirements/stripe.md S-8, S-9): the STRIPE_* variables the API
// function reads through parseServerEnv, and the billing runner's own environment.
import { describe, expect, it } from "vitest";
import { assertBillingCronFits, parseBillingEnv } from "../src/billing/config.js";
import { parseServerEnv } from "../src/config.js";
import { PLACEHOLDER_CRON_SECRET } from "../src/delivery/config.js";
import { SECRET } from "./helpers.js";
import { PREVIOUS_STRIPE_WEBHOOK_SECRET, STRIPE_KEY, STRIPE_LIVE_KEY, STRIPE_WEBHOOK_SECRET } from "./stripe-fixtures.js";

const base = { DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev", SESSION_CHECK: "local-stub", JWT_VERIFIER: "hs256", JWT_SECRET: SECRET };
const STRIPE: Record<string, string> = {
  STRIPE_SECRET_KEY: STRIPE_KEY,
  STRIPE_WEBHOOK_SECRET,
  STRIPE_LIVEMODE: "false",
  STRIPE_SUCCESS_URL: "https://app.haldenrowe.example/billing/success",
  STRIPE_CANCEL_URL: "https://app.haldenrowe.example/billing/cancel",
};
const without = (name: string) => Object.fromEntries(Object.entries(STRIPE).filter(([key]) => key !== name));
const serverError = (env: Record<string, string | undefined>): string => {
  try {
    parseServerEnv({ ...base, ...env });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseServerEnv accepted the environment");
};

describe("parseServerEnv: STRIPE_* (S-9)", () => {
  it("turns Stripe off when no STRIPE_ variable is set, or only empty ones", () => {
    expect(parseServerEnv(base).stripe).toBeNull();
    expect(parseServerEnv({ ...base, STRIPE_SECRET_KEY: "", STRIPE_LIVEMODE: "" }).stripe).toBeNull();
  });

  it("reads a full set, with the optional variables", () => {
    expect(parseServerEnv({ ...base, ...STRIPE }).stripe).toEqual({
      client: { secretKey: STRIPE_KEY, successUrl: STRIPE.STRIPE_SUCCESS_URL, cancelUrl: STRIPE.STRIPE_CANCEL_URL },
      webhook: { livemode: false, secrets: { current: STRIPE_WEBHOOK_SECRET } },
    });
    expect(parseServerEnv({
      ...base, ...STRIPE,
      STRIPE_WEBHOOK_PREVIOUS_SECRET: PREVIOUS_STRIPE_WEBHOOK_SECRET,
      STRIPE_CURRENCY: "eur",
      STRIPE_TOPUP_MIN: "1000",
      STRIPE_TOPUP_MAX: "20000",
      STRIPE_API_VERSION: "2026-09-30.acacia",
      STRIPE_BASE_URL: "http://127.0.0.1:12111",
    }).stripe).toEqual({
      client: {
        secretKey: STRIPE_KEY, successUrl: STRIPE.STRIPE_SUCCESS_URL, cancelUrl: STRIPE.STRIPE_CANCEL_URL,
        currency: "eur", minTopUp: 1000, maxTopUp: 20000, apiVersion: "2026-09-30.acacia", baseUrl: "http://127.0.0.1:12111",
      },
      webhook: { livemode: false, secrets: { current: STRIPE_WEBHOOK_SECRET, previous: PREVIOUS_STRIPE_WEBHOOK_SECRET } },
    });
    expect(parseServerEnv({ ...base, ...STRIPE, STRIPE_SECRET_KEY: STRIPE_LIVE_KEY, STRIPE_LIVEMODE: "true" }).stripe)
      .toMatchObject({ webhook: { livemode: true } });
  });

  it.each(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_LIVEMODE", "STRIPE_SUCCESS_URL", "STRIPE_CANCEL_URL"])(
    "refuses a partial set without %s, naming it",
    (name) => {
      expect(serverError(without(name))).toMatch(new RegExp(`^Invalid environment: .*${name}`));
    },
  );

  it("refuses a lone optional variable as a partial set", () => {
    expect(serverError({ STRIPE_TOPUP_MIN: "500" })).toMatch(/STRIPE_SECRET_KEY.*STRIPE_WEBHOOK_SECRET/);
  });

  it("refuses values of the wrong shape, naming the variable", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["STRIPE_SECRET_KEY", "pk_test_" + "x".repeat(24), /STRIPE_SECRET_KEY/],
      ["STRIPE_WEBHOOK_SECRET", "not-a-whsec", /STRIPE_WEBHOOK_SECRET/],
      ["STRIPE_LIVEMODE", "yes", /STRIPE_LIVEMODE: must be true or false/],
      ["STRIPE_SUCCESS_URL", "http://app.haldenrowe.example/ok", /STRIPE_SUCCESS_URL: successUrl must use https/],
      ["STRIPE_CANCEL_URL", "/billing/cancel", /STRIPE_CANCEL_URL/],
      ["STRIPE_CURRENCY", "USD", /STRIPE_CURRENCY/],
      ["STRIPE_TOPUP_MIN", "0", /STRIPE_TOPUP_MIN/],
      ["STRIPE_TOPUP_MAX", "1.5", /STRIPE_TOPUP_MAX/],
      ["STRIPE_API_VERSION", "latest", /STRIPE_API_VERSION/],
      ["STRIPE_BASE_URL", "http://api.stripe.example", /STRIPE_BASE_URL/],
    ];
    for (const [name, value, pattern] of cases) expect(serverError({ ...STRIPE, [name]: value }), name).toMatch(pattern);
    expect(serverError({ ...STRIPE, STRIPE_TOPUP_MIN: "6000", STRIPE_TOPUP_MAX: "5000" })).toMatch(/minTopUp must not exceed maxTopUp/);
  });

  it("refuses a key whose mode differs from STRIPE_LIVEMODE", () => {
    expect(serverError({ ...STRIPE, STRIPE_LIVEMODE: "true" })).toMatch(/STRIPE_LIVEMODE does not match/);
    expect(serverError({ ...STRIPE, STRIPE_SECRET_KEY: STRIPE_LIVE_KEY })).toMatch(/STRIPE_LIVEMODE does not match/);
  });

  it("never puts a secret value in an error message", () => {
    const shortKey = ["sk", "test", "short"].join("_");
    const badKey = ["sk", "test", "has space", "x".repeat(10)].join("_");
    const badWhsec = "whsec_" + "!".repeat(20);
    const cases: Array<[Record<string, string>, string]> = [
      [{ ...STRIPE, STRIPE_SECRET_KEY: shortKey }, shortKey],
      [{ ...STRIPE, STRIPE_SECRET_KEY: badKey }, badKey],
      [{ ...STRIPE, STRIPE_WEBHOOK_SECRET: badWhsec }, badWhsec],
      [{ ...STRIPE, STRIPE_WEBHOOK_PREVIOUS_SECRET: badWhsec }, badWhsec],
      [{ ...STRIPE, STRIPE_LIVEMODE: "true" }, STRIPE_KEY],
      [without("STRIPE_LIVEMODE"), STRIPE_KEY],
      [{ ...STRIPE, STRIPE_SUCCESS_URL: "ftp://x" }, STRIPE_KEY],
    ];
    for (const [env, secret] of cases) {
      const message = serverError(env);
      expect(message).toMatch(/^Invalid environment/);
      expect(message).not.toContain(secret);
      // Nor any of the valid secrets beside the bad one.
      for (const other of [STRIPE_KEY, STRIPE_WEBHOOK_SECRET, SECRET]) expect(message).not.toContain(other);
    }
  });
});

const CRON_SECRET = ["test", "cron", "b".repeat(32)].join("-");
const DB_PASSWORD = ["pw", "e".repeat(20)].join("-");
const CA_CERT = ["-----BEGIN CERTIFICATE-----", "MIIBtest", "-----END CERTIFICATE-----"].join("\n");
const LOCAL_DB = "postgres://postgres@127.0.0.1:55432/postgres";
const REMOTE_DB = `postgres://postgres:${DB_PASSWORD}@db.abcd.supabase.co:5432/postgres`;
const ON = { BILLING_WORKER: "on", BILLING_DATABASE_URL: LOCAL_DB };
const billingError = (env: Record<string, string | undefined>): string => {
  try {
    parseBillingEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseBillingEnv accepted the environment");
};

describe("parseBillingEnv (S-8, S-9)", () => {
  it("runs nothing and needs nothing else while BILLING_WORKER is unset or off", () => {
    expect(parseBillingEnv({})).toEqual({ runner: null, cronSecret: null });
    expect(parseBillingEnv({ BILLING_WORKER: "off" })).toEqual({ runner: null, cronSecret: null });
    expect(parseBillingEnv({ BILLING_WORKER: "off", BILLING_DATABASE_URL: "not a url", BILLING_CLAIM_LIMIT: "9999" }))
      .toEqual({ runner: null, cronSecret: null });
    expect(parseBillingEnv({ CRON_SECRET })).toEqual({ runner: null, cronSecret: CRON_SECRET });
    // The delivery switch is not the billing switch.
    expect(parseBillingEnv({ DELIVERY_WORKER: "on" })).toEqual({ runner: null, cronSecret: null });
  });

  it.each(["ON", "true", "1", "yes", ""])("refuses BILLING_WORKER=%j", (value) => {
    expect(billingError({ ...ON, BILLING_WORKER: value })).toMatch(/BILLING_WORKER must be on or off/);
  });

  it("reads the switched-on environment with its defaults", () => {
    expect(parseBillingEnv({ ...ON, CRON_SECRET })).toEqual({
      cronSecret: CRON_SECRET,
      runner: { serviceDatabaseUrl: LOCAL_DB, databaseCaCert: undefined, claimLimit: 50, budgetMs: 20_000, intervalMs: 30_000 },
    });
    expect(parseBillingEnv({ ...ON, BILLING_CLAIM_LIMIT: "10", BILLING_RUN_BUDGET_MS: "5000", BILLING_INTERVAL_MS: "60000" }).runner)
      .toMatchObject({ claimLimit: 10, budgetMs: 5_000, intervalMs: 60_000 });
    for (const [name, value] of [
      ["BILLING_CLAIM_LIMIT", "0"], ["BILLING_CLAIM_LIMIT", "501"], ["BILLING_RUN_BUDGET_MS", "999"],
      ["BILLING_RUN_BUDGET_MS", "600001"], ["BILLING_INTERVAL_MS", "abc"],
    ] as const) expect(billingError({ ...ON, [name]: value })).toMatch(new RegExp(name));
  });

  it("lets the Node worker take a long budget, but the cron entry at most 20 s inside its 30 s function", () => {
    const long = parseBillingEnv({ ...ON, BILLING_RUN_BUDGET_MS: "60000" }).runner;
    expect(long).toMatchObject({ budgetMs: 60_000 });
    expect(() => assertBillingCronFits(long)).toThrow(/BILLING_RUN_BUDGET_MS must be at most 20000 for the cron function/);
    expect(() => assertBillingCronFits(parseBillingEnv({ ...ON, BILLING_RUN_BUDGET_MS: "20000" }).runner)).not.toThrow();
    expect(() => assertBillingCronFits(parseBillingEnv({}).runner)).not.toThrow();
  });

  it("with the switch on, requires BILLING_DATABASE_URL", () => {
    expect(billingError({ BILLING_WORKER: "on" })).toMatch(/Invalid environment: BILLING_DATABASE_URL/);
    expect(billingError({ BILLING_WORKER: "on", BILLING_DATABASE_URL: "" })).toMatch(/BILLING_DATABASE_URL/);
  });

  it("needs DATABASE_CA_CERT for a database that is not on loopback", () => {
    expect(billingError({ ...ON, BILLING_DATABASE_URL: REMOTE_DB })).toMatch(/DATABASE_CA_CERT is required/);
    expect(billingError({ ...ON, BILLING_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: "not a certificate" })).toMatch(/DATABASE_CA_CERT/);
    expect(parseBillingEnv({ ...ON, BILLING_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT }).runner)
      .toMatchObject({ serviceDatabaseUrl: REMOTE_DB, databaseCaCert: CA_CERT });
    for (const loopback of ["postgres://postgres@localhost:55432/postgres", "postgres://postgres@[::1]:55432/postgres"])
      expect(parseBillingEnv({ ...ON, BILLING_DATABASE_URL: loopback }).runner).toMatchObject({ databaseCaCert: undefined });
  });

  it("refuses a query string that would replace the pinned TLS settings", () => {
    expect(billingError({ ...ON, BILLING_DATABASE_URL: `${REMOTE_DB}?sslmode=no-verify`, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/must not carry a query string/);
    expect(billingError({ ...ON, BILLING_DATABASE_URL: `${LOCAL_DB}?sslmode=disable`, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/must not carry a query string/);
    // A query `host` that points away from loopback counts as the host.
    expect(billingError({ ...ON, BILLING_DATABASE_URL: `${LOCAL_DB}?host=db.abcd.supabase.co` })).toMatch(/DATABASE_CA_CERT is required/);
    // Plain local development may pass options on a loopback URL.
    expect(parseBillingEnv({ ...ON, BILLING_DATABASE_URL: `${LOCAL_DB}?sslmode=disable` }).runner).not.toBeNull();
  });

  it("refuses a short or placeholder CRON_SECRET, with the switch on or off", () => {
    for (const env of [{}, ON]) {
      expect(billingError({ ...env, CRON_SECRET: "short-cron" })).toMatch(/CRON_SECRET must be at least 32 characters/);
      expect(billingError({ ...env, CRON_SECRET: PLACEHOLDER_CRON_SECRET })).toMatch(/CRON_SECRET is still the .env.example placeholder/);
    }
  });

  it("never puts a secret value in an error message", () => {
    const shortCron = ["cron", "s".repeat(10)].join("-");
    const cases: Array<[Record<string, string>, string]> = [
      [{ CRON_SECRET: shortCron }, shortCron],
      [{ ...ON, CRON_SECRET: shortCron }, shortCron],
      [{ ...ON, BILLING_DATABASE_URL: REMOTE_DB }, DB_PASSWORD],
      [{ ...ON, BILLING_DATABASE_URL: `${REMOTE_DB}?sslmode=no-verify`, DATABASE_CA_CERT: CA_CERT }, DB_PASSWORD],
      [{ ...ON, BILLING_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT, BILLING_CLAIM_LIMIT: "0" }, DB_PASSWORD],
      [{ ...ON, BILLING_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: "MIIB-not-a-pem-" + "x".repeat(10) }, "MIIB-not-a-pem-"],
    ];
    for (const [env, secret] of cases) {
      const message = billingError(env);
      expect(message).toMatch(/^Invalid environment/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain(CRON_SECRET);
    }
  });
});
