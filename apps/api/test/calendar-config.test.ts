// M5 configuration (docs/requirements/google-calendar.md G-12): the API's GOOGLE_* variables through
// parseServerEnv, all or none, and the calendar runner's own environment. Errors name variables,
// never values.
import { describe, expect, it } from "vitest";
import { generateSealKeyPair } from "@zs/core";
import { assertCalendarCronFits, parseCalendarEnv } from "../src/calendar/config.js";
import { parseServerEnv } from "../src/config.js";
import { PLACEHOLDER_CRON_SECRET } from "../src/delivery/config.js";
import { SECRET } from "./helpers.js";

const base = { DATABASE_URL: "postgres://zs_runtime@127.0.0.1:55432/zs_dev", SESSION_CHECK: "local-stub", JWT_VERIFIER: "hs256", JWT_SECRET: SECRET };
const keys = generateSealKeyPair();
/** Synthetic values, built at runtime so secret scanners do not flag a literal. */
const CLIENT_SECRET = ["fake", "client", "z".repeat(20)].join("-");
const STATE_SECRET = ["test", "state", "s".repeat(32)].join("-");
const PREVIOUS_STATE_SECRET = ["test", "state", "p".repeat(32)].join("-");
const CHANNEL_SECRET = ["test", "channel", "c".repeat(32)].join("-");
const GOOGLE: Record<string, string> = {
  GOOGLE_CLIENT_ID: "1234-fake.apps.googleusercontent.test",
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_REDIRECT_URL: "https://api.haldenrowe.example/oauth/google/callback",
  GOOGLE_RETURN_URL: "https://app.haldenrowe.example/settings/calendar",
  GOOGLE_STATE_SECRET: STATE_SECRET,
  GOOGLE_TOKEN_PUBLIC_KEY: keys.publicKey,
  GOOGLE_CHANNEL_SECRET: CHANNEL_SECRET,
};
const SECRETS = [CLIENT_SECRET, STATE_SECRET, PREVIOUS_STATE_SECRET, CHANNEL_SECRET, keys.publicKey, keys.privateKey, SECRET];
const without = (name: string) => Object.fromEntries(Object.entries(GOOGLE).filter(([key]) => key !== name));
const serverError = (env: Record<string, string | undefined>): string => {
  try {
    parseServerEnv({ ...base, ...env });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseServerEnv accepted the environment");
};

describe("parseServerEnv: GOOGLE_* (G-12)", () => {
  it("turns Google off when no API Google variable is set, or only empty ones, or only the worker's", () => {
    expect(parseServerEnv(base).google).toBeNull();
    expect(parseServerEnv({ ...base, GOOGLE_CLIENT_ID: "", GOOGLE_STATE_SECRET: "" }).google).toBeNull();
    expect(parseServerEnv({ ...base, GOOGLE_TOKEN_PRIVATE_KEY: keys.privateKey, GOOGLE_WEBHOOK_URL: "https://x.test", GOOGLE_EVENT_TITLE: "Busy" }).google)
      .toBeNull();
  });

  it("reads a full set, with the optional variables", () => {
    const google = parseServerEnv({ ...base, ...GOOGLE }).google!;
    expect(google).toMatchObject({
      client: { clientId: GOOGLE.GOOGLE_CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUrl: GOOGLE.GOOGLE_REDIRECT_URL },
      returnUrl: GOOGLE.GOOGLE_RETURN_URL,
      stateSecrets: { current: STATE_SECRET },
      channelSecret: CHANNEL_SECRET,
    });
    expect(Object.keys(google.client).sort()).toEqual(["clientId", "clientSecret", "redirectUrl"]);
    expect(google.stateSecrets).not.toHaveProperty("previous");
    expect(google.tokenPublicKey.asymmetricKeyType).toBe("x25519");
    expect(google.tokenPublicKey.type).toBe("public");

    const local = "http://127.0.0.1:9911";
    expect(parseServerEnv({
      ...base, ...GOOGLE,
      GOOGLE_STATE_PREVIOUS_SECRET: PREVIOUS_STATE_SECRET,
      GOOGLE_OAUTH_BASE_URL: local, GOOGLE_TOKEN_BASE_URL: local, GOOGLE_API_BASE_URL: local,
      GOOGLE_REDIRECT_URL: "http://localhost:8787/oauth/google/callback",
    }).google).toMatchObject({
      client: { oauthBaseUrl: local, tokenBaseUrl: local, apiBaseUrl: local, redirectUrl: "http://localhost:8787/oauth/google/callback" },
      stateSecrets: { current: STATE_SECRET, previous: PREVIOUS_STATE_SECRET },
    });
  });

  it.each(Object.keys(GOOGLE))("refuses a partial set without %s, naming it", (name) => {
    expect(serverError(without(name))).toMatch(new RegExp(`^Invalid environment: .*${name}: is required`));
  });

  it("refuses a lone optional variable as a partial set", () => {
    expect(serverError({ GOOGLE_STATE_PREVIOUS_SECRET: PREVIOUS_STATE_SECRET })).toMatch(/GOOGLE_CLIENT_ID.*GOOGLE_CLIENT_SECRET/);
    expect(serverError({ GOOGLE_API_BASE_URL: "https://www.googleapis.com" })).toMatch(/GOOGLE_REDIRECT_URL/);
  });

  it("refuses values of the wrong shape, naming the variable", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["GOOGLE_REDIRECT_URL", "http://api.haldenrowe.example/oauth/google/callback", /GOOGLE_REDIRECT_URL: must use https/],
      ["GOOGLE_REDIRECT_URL", "/oauth/google/callback", /GOOGLE_REDIRECT_URL: must be a URL/],
      ["GOOGLE_RETURN_URL", "ftp://app.haldenrowe.example", /GOOGLE_RETURN_URL: must use https/],
      ["GOOGLE_RETURN_URL", "https://user:pw@app.haldenrowe.example", /GOOGLE_RETURN_URL: must not carry credentials/],
      ["GOOGLE_STATE_SECRET", "short", /GOOGLE_STATE_SECRET: must be at least 32 characters/],
      ["GOOGLE_STATE_PREVIOUS_SECRET", "short", /GOOGLE_STATE_PREVIOUS_SECRET: must be at least 32 characters/],
      ["GOOGLE_CHANNEL_SECRET", "x".repeat(31), /GOOGLE_CHANNEL_SECRET: must be at least 32 characters/],
      ["GOOGLE_TOKEN_PUBLIC_KEY", "bm90IGEga2V5", /GOOGLE_TOKEN_PUBLIC_KEY: must be base64 of the DER SPKI/],
      // The private key is not a public key.
      ["GOOGLE_TOKEN_PUBLIC_KEY", keys.privateKey, /GOOGLE_TOKEN_PUBLIC_KEY/],
      ["GOOGLE_CLIENT_ID", "x".repeat(513), /GOOGLE_CLIENT_ID: must be at most 512/],
      ["GOOGLE_OAUTH_BASE_URL", "http://accounts.google.example", /GOOGLE_OAUTH_BASE_URL: must use https/],
      ["GOOGLE_TOKEN_BASE_URL", "nope", /GOOGLE_TOKEN_BASE_URL/],
      ["GOOGLE_API_BASE_URL", "http://www.googleapis.example", /GOOGLE_API_BASE_URL/],
    ];
    for (const [name, value, pattern] of cases) expect(serverError({ ...GOOGLE, [name]: value }), name).toMatch(pattern);
  });

  it("never puts a secret value in an error message", () => {
    const shortSecret = ["short", "s".repeat(10)].join("-");
    const cases: Array<Record<string, string>> = [
      { ...GOOGLE, GOOGLE_STATE_SECRET: shortSecret },
      { ...GOOGLE, GOOGLE_STATE_PREVIOUS_SECRET: shortSecret },
      { ...GOOGLE, GOOGLE_CHANNEL_SECRET: shortSecret },
      { ...GOOGLE, GOOGLE_TOKEN_PUBLIC_KEY: keys.privateKey },
      { ...GOOGLE, GOOGLE_TOKEN_PUBLIC_KEY: shortSecret },
      { ...GOOGLE, GOOGLE_CLIENT_SECRET: "q".repeat(600) },
      { ...GOOGLE, GOOGLE_REDIRECT_URL: `https://u:${shortSecret}@api.test/cb` },
      without("GOOGLE_CLIENT_ID"),
    ];
    for (const env of cases) {
      const message = serverError(env);
      expect(message).toMatch(/^Invalid environment/);
      for (const secret of [...SECRETS, shortSecret, "q".repeat(600)]) expect(message).not.toContain(secret);
    }
  });
});

const CRON_SECRET = ["test", "cron", "b".repeat(32)].join("-");
const DB_PASSWORD = ["pw", "e".repeat(20)].join("-");
const CA_CERT = ["-----BEGIN CERTIFICATE-----", "MIIBtest", "-----END CERTIFICATE-----"].join("\n");
const LOCAL_DB = "postgres://postgres@127.0.0.1:55432/postgres";
const REMOTE_DB = `postgres://postgres:${DB_PASSWORD}@db.abcd.supabase.co:5432/postgres`;
const ON: Record<string, string> = {
  CALENDAR_WORKER: "on",
  CALENDAR_DATABASE_URL: LOCAL_DB,
  GOOGLE_CLIENT_ID: GOOGLE.GOOGLE_CLIENT_ID!,
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  GOOGLE_TOKEN_PRIVATE_KEY: keys.privateKey,
  GOOGLE_CHANNEL_SECRET: CHANNEL_SECRET,
};
const calendarError = (env: Record<string, string | undefined>): string => {
  try {
    parseCalendarEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("parseCalendarEnv accepted the environment");
};

describe("parseCalendarEnv (G-12)", () => {
  it("runs nothing and needs nothing else while CALENDAR_WORKER is unset or off", () => {
    expect(parseCalendarEnv({})).toEqual({ runner: null, cronSecret: null });
    expect(parseCalendarEnv({ CALENDAR_WORKER: "off", CALENDAR_DATABASE_URL: "not a url", GOOGLE_TOKEN_PRIVATE_KEY: "x" }))
      .toEqual({ runner: null, cronSecret: null });
    expect(parseCalendarEnv({ CRON_SECRET })).toEqual({ runner: null, cronSecret: CRON_SECRET });
    // Another worker's switch is not this one.
    expect(parseCalendarEnv({ BILLING_WORKER: "on", DELIVERY_WORKER: "on" })).toEqual({ runner: null, cronSecret: null });
  });

  it.each(["ON", "true", "1", "yes", ""])("refuses CALENDAR_WORKER=%j", (value) => {
    expect(calendarError({ ...ON, CALENDAR_WORKER: value })).toMatch(/CALENDAR_WORKER must be on or off/);
  });

  it("reads the switched-on environment with its defaults", () => {
    const parsed = parseCalendarEnv({ ...ON, CRON_SECRET });
    expect(parsed.cronSecret).toBe(CRON_SECRET);
    expect(parsed.runner).toMatchObject({
      serviceDatabaseUrl: LOCAL_DB, databaseCaCert: undefined, channelSecret: CHANNEL_SECRET,
      webhookUrl: undefined, eventTitle: undefined, budgetMs: 20_000, intervalMs: 60_000,
      client: { clientId: ON.GOOGLE_CLIENT_ID, clientSecret: CLIENT_SECRET },
    });
    // The worker never exchanges a code, so it has no redirect URL.
    expect(Object.keys(parsed.runner!.client).sort()).toEqual(["clientId", "clientSecret"]);
    expect(parsed.runner!.privateKey.type).toBe("private");
    expect(parsed.runner!.privateKey.asymmetricKeyType).toBe("x25519");

    const local = "http://127.0.0.1:9911";
    expect(parseCalendarEnv({
      ...ON, GOOGLE_WEBHOOK_URL: "https://api.haldenrowe.example/webhooks/google/calendar", GOOGLE_EVENT_TITLE: "  Busy  ",
      CALENDAR_RUN_BUDGET_MS: "5000", CALENDAR_INTERVAL_MS: "120000",
      GOOGLE_OAUTH_BASE_URL: local, GOOGLE_TOKEN_BASE_URL: local, GOOGLE_API_BASE_URL: local,
    }).runner).toMatchObject({
      webhookUrl: "https://api.haldenrowe.example/webhooks/google/calendar", eventTitle: "Busy", budgetMs: 5_000, intervalMs: 120_000,
      client: { oauthBaseUrl: local, tokenBaseUrl: local, apiBaseUrl: local },
    });
    // Empty optional values count as unset.
    expect(parseCalendarEnv({ ...ON, GOOGLE_WEBHOOK_URL: "", GOOGLE_EVENT_TITLE: "" }).runner).toMatchObject({ webhookUrl: undefined, eventTitle: undefined });
  });

  it.each(["CALENDAR_DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_PRIVATE_KEY", "GOOGLE_CHANNEL_SECRET"])(
    "with the switch on, requires %s",
    (name) => {
      const env = Object.fromEntries(Object.entries(ON).filter(([key]) => key !== name));
      expect(calendarError(env)).toMatch(new RegExp(`^Invalid environment: .*${name}`));
      expect(calendarError({ ...env, [name]: "" })).toMatch(new RegExp(name));
    },
  );

  it("refuses values of the wrong shape, naming the variable", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["GOOGLE_TOKEN_PRIVATE_KEY", keys.publicKey, /GOOGLE_TOKEN_PRIVATE_KEY: must be base64 of the DER PKCS#8/],
      ["GOOGLE_TOKEN_PRIVATE_KEY", "bm90IGEga2V5", /GOOGLE_TOKEN_PRIVATE_KEY/],
      ["GOOGLE_CHANNEL_SECRET", "x".repeat(31), /GOOGLE_CHANNEL_SECRET: must be at least 32 characters/],
      ["GOOGLE_WEBHOOK_URL", "http://api.haldenrowe.example/webhooks/google/calendar", /GOOGLE_WEBHOOK_URL: must be an https URL/],
      ["GOOGLE_EVENT_TITLE", "   ", /GOOGLE_EVENT_TITLE: must not be blank/],
      ["GOOGLE_EVENT_TITLE", "x".repeat(201), /GOOGLE_EVENT_TITLE/],
      ["GOOGLE_API_BASE_URL", "http://www.googleapis.example", /GOOGLE_API_BASE_URL: must use https/],
      ["CALENDAR_RUN_BUDGET_MS", "999", /CALENDAR_RUN_BUDGET_MS/],
      ["CALENDAR_RUN_BUDGET_MS", "600001", /CALENDAR_RUN_BUDGET_MS/],
      ["CALENDAR_INTERVAL_MS", "abc", /CALENDAR_INTERVAL_MS/],
    ];
    for (const [name, value, pattern] of cases) expect(calendarError({ ...ON, [name]: value }), name).toMatch(pattern);
  });

  it("lets the Node worker take a long budget, but the cron entry at most 20 s inside its 30 s function", () => {
    const long = parseCalendarEnv({ ...ON, CALENDAR_RUN_BUDGET_MS: "60000" }).runner;
    expect(long).toMatchObject({ budgetMs: 60_000 });
    expect(() => assertCalendarCronFits(long)).toThrow(/CALENDAR_RUN_BUDGET_MS must be at most 20000 for the cron function/);
    expect(() => assertCalendarCronFits(parseCalendarEnv(ON).runner)).not.toThrow();
    expect(() => assertCalendarCronFits(parseCalendarEnv({}).runner)).not.toThrow();
  });

  it("needs DATABASE_CA_CERT for a database that is not on loopback, and no query string", () => {
    expect(calendarError({ ...ON, CALENDAR_DATABASE_URL: REMOTE_DB })).toMatch(/DATABASE_CA_CERT is required/);
    expect(calendarError({ ...ON, CALENDAR_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: "not a certificate" })).toMatch(/DATABASE_CA_CERT/);
    expect(parseCalendarEnv({ ...ON, CALENDAR_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT }).runner)
      .toMatchObject({ serviceDatabaseUrl: REMOTE_DB, databaseCaCert: CA_CERT });
    expect(calendarError({ ...ON, CALENDAR_DATABASE_URL: `${REMOTE_DB}?sslmode=no-verify`, DATABASE_CA_CERT: CA_CERT }))
      .toMatch(/must not carry a query string/);
    expect(calendarError({ ...ON, CALENDAR_DATABASE_URL: `${LOCAL_DB}?host=db.abcd.supabase.co` })).toMatch(/DATABASE_CA_CERT is required/);
    expect(parseCalendarEnv({ ...ON, CALENDAR_DATABASE_URL: `${LOCAL_DB}?sslmode=disable` }).runner).not.toBeNull();
  });

  it("refuses a short or placeholder CRON_SECRET, with the switch on or off", () => {
    for (const env of [{}, ON]) {
      expect(calendarError({ ...env, CRON_SECRET: "short-cron" })).toMatch(/CRON_SECRET must be at least 32 characters/);
      expect(calendarError({ ...env, CRON_SECRET: PLACEHOLDER_CRON_SECRET })).toMatch(/CRON_SECRET is still the .env.example placeholder/);
    }
  });

  it("never puts a secret value in an error message", () => {
    const shortCron = ["cron", "s".repeat(10)].join("-");
    const shortChannel = ["channel", "k".repeat(10)].join("-");
    const cases: Array<[Record<string, string>, string]> = [
      [{ CRON_SECRET: shortCron }, shortCron],
      [{ ...ON, CRON_SECRET: shortCron }, shortCron],
      [{ ...ON, CALENDAR_DATABASE_URL: REMOTE_DB }, DB_PASSWORD],
      [{ ...ON, CALENDAR_DATABASE_URL: `${REMOTE_DB}?sslmode=no-verify`, DATABASE_CA_CERT: CA_CERT }, DB_PASSWORD],
      [{ ...ON, CALENDAR_DATABASE_URL: REMOTE_DB, DATABASE_CA_CERT: CA_CERT, CALENDAR_INTERVAL_MS: "0" }, DB_PASSWORD],
      [{ ...ON, GOOGLE_CHANNEL_SECRET: shortChannel }, shortChannel],
      [{ ...ON, GOOGLE_TOKEN_PRIVATE_KEY: keys.publicKey }, keys.publicKey],
      [{ ...ON, GOOGLE_TOKEN_PRIVATE_KEY: keys.privateKey.slice(0, -4) }, keys.privateKey.slice(0, -4)],
    ];
    for (const [env, secret] of cases) {
      const message = calendarError(env);
      expect(message).toMatch(/^Invalid environment/);
      expect(message).not.toContain(secret);
      for (const other of [CRON_SECRET, CLIENT_SECRET, CHANNEL_SECRET, keys.privateKey]) expect(message).not.toContain(other);
    }
  });
});
