// M5 Google client (docs/requirements/google-calendar.md G-1, G-2, G-6, G-8, G-9, G-10) against
// the in-process fake Google. No database, no network beyond 127.0.0.1. Tokens and secrets are
// minted at runtime by the fake, so nothing here looks like a real credential.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createGoogleClient,
  GOOGLE_DEFAULT_API_BASE_URL,
  GOOGLE_DEFAULT_OAUTH_BASE_URL,
  GOOGLE_DEFAULT_TOKEN_BASE_URL,
  GoogleRequestFailed,
  googleClientConfigSchema,
  pkceChallenge,
  pkceVerifier,
  type ConfiguredGoogleClient,
  type GoogleClientConfig,
} from "../../src/index.js";
import { createFakeGoogle, googleApiError, type FakeGoogle, type FakeGoogleBehaviour, type FakeGoogleEndpoint } from "./fake-google.js";

const START = Date.parse("2026-10-20T09:00:00.000Z");
const clock = (() => {
  let at = START;
  return { now: () => new Date(at), set(instant: number) { at = instant; }, advance(ms: number) { at += ms; } };
})();
const REDIRECT = "https://api.haldenrowe.example/oauth/google/callback";
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

let google: FakeGoogle;
beforeAll(async () => { google = await createFakeGoogle({ clock }); });
afterAll(async () => { await google?.close(); });

type Fetch = (input: string, init: RequestInit) => Promise<Response>;
const client = (over: Partial<GoogleClientConfig> = {}, fetchImpl?: Fetch): ConfiguredGoogleClient => createGoogleClient({
  config: google.clientConfig({ redirectUrl: REDIRECT, ...over }),
  ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
});

/** The GoogleRequestFailed a call rejects with (fails the test if it resolves or throws otherwise). */
async function failure(promise: Promise<unknown>): Promise<GoogleRequestFailed> {
  const outcome = await promise.then(() => null, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(GoogleRequestFailed);
  return outcome as GoogleRequestFailed;
}

const verifierFor = () => pkceVerifier(randomBytes(32).toString("hex"), randomUUID());
let calendars = 0;
/** A fresh calendar per test, so tests on the shared fake do not see each other's events. */
const freshCalendar = () => google.calendar(`cal-${++calendars}@group.calendar.test`);
const timed = (id: string, startMs: number, minutes = 30, extra: Record<string, unknown> = {}) =>
  ({ id, start: { dateTime: iso(startMs) }, end: { dateTime: iso(startMs + minutes * 60_000) }, ...extra });

describe("the consent URL (G-1)", () => {
  it("names the client, redirect, scopes, offline access, consent, state and the S256 challenge", () => {
    const verifier = verifierFor();
    const url = new URL(client().authorizeUrl({ state: "zgs1.state-value", codeChallenge: pkceChallenge(verifier) }));
    expect(`${url.origin}${url.pathname}`).toBe(`${google.baseUrl}/o/oauth2/v2/auth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: google.clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state: "zgs1.state-value",
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: "S256",
    });
    expect(url.searchParams.has("client_secret")).toBe(false);
    expect(url.toString()).not.toContain(google.clientSecret);
  });

  it("uses Google's hosts by default and trims trailing slashes", () => {
    const real = createGoogleClient({ config: { clientId: "id", clientSecret: "secret", redirectUrl: REDIRECT } });
    expect(real.config).toMatchObject({
      oauthBaseUrl: GOOGLE_DEFAULT_OAUTH_BASE_URL, tokenBaseUrl: GOOGLE_DEFAULT_TOKEN_BASE_URL, apiBaseUrl: GOOGLE_DEFAULT_API_BASE_URL,
    });
    expect(real.authorizeUrl({ state: "s", codeChallenge: "c" })).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    expect(client({ oauthBaseUrl: `${google.baseUrl}//` }).authorizeUrl({ state: "s", codeChallenge: "c" }))
      .toMatch(new RegExp(`^${google.baseUrl}/o/oauth2/v2/auth\\?`));
  });

  it("throws without a redirect URL (the worker's client has none)", async () => {
    const worker = client({ redirectUrl: undefined });
    expect(() => worker.authorizeUrl({ state: "s", codeChallenge: "c" })).toThrow(/redirectUrl/);
    await expect(worker.exchangeCode({ code: "x", codeVerifier: "y" })).rejects.toThrow(/redirectUrl/);
  });

  it("the fake's consent page redirects back with a code the client can exchange", async () => {
    const verifier = verifierFor();
    const consent = await fetch(client().authorizeUrl({ state: "st-1", codeChallenge: pkceChallenge(verifier) }), { redirect: "manual" });
    expect(consent.status).toBe(302);
    const back = new URL(consent.headers.get("location")!);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("st-1");
    const grant = await client().exchangeCode({ code: back.searchParams.get("code")!, codeVerifier: verifier });
    expect(grant.refreshToken).toMatch(/^fake-rt\./);

    google.setConsent({ deny: true });
    try {
      const denied = await fetch(client().authorizeUrl({ state: "st-2", codeChallenge: pkceChallenge(verifier) }), { redirect: "manual" });
      const deniedBack = new URL(denied.headers.get("location")!);
      expect(deniedBack.searchParams.get("error")).toBe("access_denied");
      expect(deniedBack.searchParams.get("state")).toBe("st-2");
      expect(deniedBack.searchParams.has("code")).toBe(false);
    } finally {
      google.setConsent({});
    }
  });
});

describe("the code exchange (G-2)", () => {
  it("posts the form with the verifier and returns tokens, scope and the verified email", async () => {
    const verifier = verifierFor();
    const code = google.registerCode({ codeChallenge: pkceChallenge(verifier), redirectUri: REDIRECT, email: "owner@haldenrowe.example" });
    const before = google.requests.length;
    const grant = await client().exchangeCode({ code, codeVerifier: verifier });
    const sent = google.requests.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ endpoint: "token", method: "POST", path: "/token" });
    expect(sent[0]!.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(sent[0]!.form).toEqual({
      code, client_id: google.clientId, client_secret: google.clientSecret, redirect_uri: REDIRECT,
      grant_type: "authorization_code", code_verifier: verifier,
    });
    expect(sent[0]!.headers.authorization).toBeUndefined();
    const stored = google.grants().find((entry) => entry.refreshToken === grant.refreshToken)!;
    expect(grant).toEqual({
      accessToken: stored.accessTokens[0],
      expiresInSeconds: 3599,
      refreshToken: stored.refreshToken,
      scope: "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email openid",
      email: "owner@haldenrowe.example",
    });
  });

  it("refuses a verifier that does not hash to the challenge, and a missing one, as invalid_grant", async () => {
    const verifier = verifierFor();
    const code = google.registerCode({ codeChallenge: pkceChallenge(verifier), redirectUri: REDIRECT });
    const wrong = await failure(client().exchangeCode({ code, codeVerifier: verifierFor() }));
    expect(wrong).toMatchObject({ code: "invalid_grant", retry: false, status: 400 });
    const missing = await failure(client().exchangeCode({ code, codeVerifier: "" }));
    expect(missing).toMatchObject({ code: "invalid_grant", retry: false });
    // A refused attempt does not use the code up.
    await expect(client().exchangeCode({ code, codeVerifier: verifier })).resolves.toMatchObject({ refreshToken: expect.any(String) });
  });

  it("a code works once", async () => {
    const verifier = verifierFor();
    const code = google.registerCode({ codeChallenge: pkceChallenge(verifier), redirectUri: REDIRECT });
    await client().exchangeCode({ code, codeVerifier: verifier });
    expect(await failure(client().exchangeCode({ code, codeVerifier: verifier }))).toMatchObject({ code: "invalid_grant", retry: false });
  });

  it("an expired code, an unknown code and another redirect URI are refused without retry", async () => {
    const verifier = verifierFor();
    const code = google.registerCode({ codeChallenge: pkceChallenge(verifier), redirectUri: REDIRECT });
    clock.advance(11 * 60 * 1000);
    try {
      expect(await failure(client().exchangeCode({ code, codeVerifier: verifier }))).toMatchObject({ code: "invalid_grant", retry: false });
    } finally {
      clock.set(START);
    }
    expect((await failure(client().exchangeCode({ code: "fake-code.unknown", codeVerifier: verifier }))).code).toBe("invalid_grant");
    const other = google.registerCode({ codeChallenge: pkceChallenge(verifier), redirectUri: REDIRECT });
    const mismatch = await failure(client({ redirectUrl: "https://api.haldenrowe.example/elsewhere" }).exchangeCode({ code: other, codeVerifier: verifier }));
    expect(mismatch).toMatchObject({ code: "redirect_uri_mismatch", retry: false });
  });

  it("a wrong client secret is invalid_client (401, no retry)", async () => {
    const verifier = verifierFor();
    const code = google.registerCode({ codeChallenge: pkceChallenge(verifier) });
    const error = await failure(client({ clientSecret: "not-the-secret" }).exchangeCode({ code, codeVerifier: verifier }));
    expect(error).toMatchObject({ code: "invalid_client", retry: false, status: 401 });
  });

  it("reports no refresh token when Google sends none", async () => {
    const verifier = verifierFor();
    const code = google.registerCode({ codeChallenge: pkceChallenge(verifier), refreshToken: false });
    const grant = await client().exchangeCode({ code, codeVerifier: verifier });
    expect(grant.refreshToken).toBeNull();
    expect(grant.accessToken).toMatch(/^fake-at\./);
  });

  it("passes the granted scope through, so the callback can see calendar.events missing", async () => {
    const verifier = verifierFor();
    const code = google.registerCode({ codeChallenge: pkceChallenge(verifier), scope: "openid https://www.googleapis.com/auth/userinfo.email" });
    expect((await client().exchangeCode({ code, codeVerifier: verifier })).scope).toBe("openid https://www.googleapis.com/auth/userinfo.email");
  });

  it("reads the email only when present, verified and meant for this client", async () => {
    const exchange = async (input: Parameters<FakeGoogle["registerCode"]>[0], over: Partial<GoogleClientConfig> = {}) => {
      const code = google.registerCode(input);
      return (await client(over).exchangeCode({ code, codeVerifier: verifierForChallenge.get(input.codeChallenge)! })).email;
    };
    const verifierForChallenge = new Map<string, string>();
    const challenge = () => {
      const verifier = verifierFor();
      verifierForChallenge.set(pkceChallenge(verifier), verifier);
      return pkceChallenge(verifier);
    };
    expect(await exchange({ codeChallenge: challenge(), email: "a@b.example" })).toBe("a@b.example");
    expect(await exchange({ codeChallenge: challenge(), email: "a@b.example", emailVerified: false })).toBeNull();
    expect(await exchange({ codeChallenge: challenge(), email: null })).toBeNull();
    expect(await exchange({ codeChallenge: challenge(), idToken: false })).toBeNull();
  });

  it("ignores an id_token for another audience or one that is not JWT-shaped", async () => {
    const claims = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const answer = (idToken: string): FakeGoogleBehaviour => ({
      status: 200, body: { access_token: "fake-at.x", expires_in: 3599, refresh_token: "fake-rt.x", scope: "openid", id_token: idToken },
    });
    const header = claims({ alg: "none" });
    const cases: Array<[string, string | null]> = [
      [`${header}.${claims({ aud: google.clientId, email: "ok@b.example", email_verified: true })}.sig`, "ok@b.example"],
      [`${header}.${claims({ aud: [google.clientId, "other"], email: "list@b.example" })}.sig`, "list@b.example"],
      [`${header}.${claims({ aud: "someone-else", email: "x@b.example", email_verified: true })}.sig`, null],
      [`${header}.${claims({ aud: google.clientId, email: "x@b.example", email_verified: "false" })}.sig`, null],
      [`${header}.${claims({ aud: google.clientId, email: 42 })}.sig`, null],
      [`${header}.not-json!.sig`, null],
      ["only.two", null],
    ];
    for (const [idToken, email] of cases) {
      google.failNext("token", answer(idToken));
      expect((await client().exchangeCode({ code: "c", codeVerifier: "v" })).email).toBe(email);
    }
  });
});

describe("refreshing and revoking (G-6, G-9)", () => {
  it("a refresh token mints a working access token", async () => {
    const { refreshToken, grantId } = google.issueGrant();
    const before = google.requests.length;
    const fresh = await client({ redirectUrl: undefined }).refreshAccessToken(refreshToken);
    const sent = google.requests.slice(before);
    expect(sent[0]!.form).toEqual({ refresh_token: refreshToken, grant_type: "refresh_token", client_id: google.clientId, client_secret: google.clientSecret });
    expect(sent[0]!.grantId).toBe(grantId);
    expect(fresh).toEqual({ accessToken: google.grants().find((grant) => grant.id === grantId)!.accessTokens[1], expiresInSeconds: 3599 });
    const calendar = freshCalendar();
    await expect(client().listEvents(fresh.accessToken, { calendarId: calendar.id, timeMin: iso(START), timeMax: iso(START + HOUR) }))
      .resolves.toMatchObject({ items: [] });
  });

  it("after a revoke the refresh answers invalid_grant (retry false) and access tokens stop working", async () => {
    const { refreshToken, accessToken } = google.issueGrant();
    await client().revoke(refreshToken);
    expect(google.requestsTo("revoke").at(-1)!.form).toEqual({ token: refreshToken });
    expect(await failure(client().refreshAccessToken(refreshToken))).toMatchObject({ code: "invalid_grant", retry: false, status: 400 });
    const calendar = freshCalendar();
    const refused = await failure(client().listEvents(accessToken, { calendarId: calendar.id, timeMin: iso(START), timeMax: iso(START + HOUR) }));
    expect(refused).toMatchObject({ code: "google_401_autherror", retry: false, status: 401 });
  });

  it("a grant the user removed in Google answers invalid_grant too", async () => {
    const { refreshToken } = google.issueGrant();
    google.revokeGrant(refreshToken);
    expect((await failure(client().refreshAccessToken(refreshToken))).code).toBe("invalid_grant");
  });

  it("revoking an already revoked or unknown token resolves (invalid_token)", async () => {
    const { refreshToken } = google.issueGrant();
    await client().revoke(refreshToken);
    await expect(client().revoke(refreshToken)).resolves.toBeUndefined();
    await expect(client().revoke("fake-rt.never-issued")).resolves.toBeUndefined();
  });

  it("other revoke refusals throw, with retry only for 429 and 5xx", async () => {
    google.failNext("revoke", { status: 503 }, { status: 400, body: { error: "invalid_request" } }, { status: 429 }, "drop");
    expect(await failure(client().revoke("fake-rt.x"))).toMatchObject({ code: "google_503_temporarily_unavailable", retry: true, status: 503 });
    expect(await failure(client().revoke("fake-rt.x"))).toMatchObject({ code: "invalid_request", retry: false });
    expect(await failure(client().revoke("fake-rt.x"))).toMatchObject({ code: "google_429_rate_limit_exceeded", retry: true });
    expect(await failure(client().revoke("fake-rt.x"))).toMatchObject({ code: "google_network", retry: true, status: null });
  });
});

describe("listing events (G-6)", () => {
  it("a full list pages with nextPageToken and ends with a nextSyncToken", async () => {
    const calendar = freshCalendar();
    for (let i = 0; i < 5; i++) calendar.put(timed(`event${i}`, START + i * HOUR));
    calendar.put(timed("outside", START + 30 * 24 * HOUR));
    calendar.put(timed("before", START - 3 * HOUR));
    const { accessToken } = google.issueGrant();
    const gc = client();
    google.setPageSize(2);
    try {
      const window = { calendarId: calendar.id, timeMin: iso(START - HOUR), timeMax: iso(START + 24 * HOUR) };
      const ids: string[] = [];
      let page = await gc.listEvents(accessToken, window);
      const pages = [page];
      while (page.nextPageToken) {
        expect(page.nextSyncToken).toBeNull();
        page = await gc.listEvents(accessToken, { ...window, pageToken: page.nextPageToken });
        pages.push(page);
      }
      for (const each of pages) ids.push(...each.items.map((item) => item.id));
      expect(pages.map((each) => each.items.length)).toEqual([2, 2, 1]);
      expect(ids).toEqual(["event0", "event1", "event2", "event3", "event4"]);
      expect(page.nextSyncToken).toEqual(expect.any(String));
      const sent = google.requestsTo("list").slice(-3);
      expect(sent[0]!.path).toBe(`/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events`);
      expect(sent[0]!.query).toEqual({
        singleEvents: "true", maxResults: "250", showDeleted: "true", timeMin: window.timeMin, timeMax: window.timeMax,
      });
      expect(sent[1]!.query.pageToken).toBe(pages[0]!.nextPageToken);
      expect(sent[0]!.headers.authorization).toBe(`Bearer ${accessToken}`);
    } finally {
      google.setPageSize(2500);
    }
  });

  it("an incremental list returns only changes, cancelled events included, and a new sync token", async () => {
    const calendar = freshCalendar();
    calendar.put(timed("keepme", START + HOUR));
    calendar.put(timed("dropme", START + 2 * HOUR));
    const { accessToken } = google.issueGrant();
    const gc = client();
    const full = await gc.listEvents(accessToken, { calendarId: calendar.id, timeMin: iso(START), timeMax: iso(START + 24 * HOUR) });
    expect(full.items.map((item) => item.id)).toEqual(["keepme", "dropme"]);

    calendar.remove("dropme");
    calendar.put(timed("newone", START + 3 * HOUR, 60, { transparency: "transparent" }));
    const changes = await gc.listEvents(accessToken, { calendarId: calendar.id, syncToken: full.nextSyncToken! });
    expect(changes.items).toEqual([
      { id: "dropme", status: "cancelled", start: { dateTime: iso(START + 2 * HOUR) }, end: { dateTime: iso(START + 2 * HOUR + 30 * 60_000) } },
      { id: "newone", status: "confirmed", transparency: "transparent", start: { dateTime: iso(START + 3 * HOUR) }, end: { dateTime: iso(START + 4 * HOUR) } },
    ]);
    expect(google.requestsTo("list").at(-1)!.query).toEqual({ singleEvents: "true", maxResults: "250", showDeleted: "true", syncToken: full.nextSyncToken });
    expect(changes.nextSyncToken).not.toBe(full.nextSyncToken);

    const quiet = await gc.listEvents(accessToken, { calendarId: calendar.id, syncToken: changes.nextSyncToken! });
    expect(quiet).toEqual({ items: [], nextPageToken: null, nextSyncToken: changes.nextSyncToken });
  });

  it("a full list also shows cancelled instances (showDeleted) and expands recurring events", async () => {
    const calendar = freshCalendar();
    calendar.put(timed("weekly", START, 60, { recurrence: { everyMs: 7 * 24 * HOUR, count: 3 } }));
    calendar.put(timed("gone", START + HOUR));
    calendar.remove("gone");
    const { accessToken } = google.issueGrant();
    const page = await client().listEvents(accessToken, { calendarId: calendar.id, timeMin: iso(START - HOUR), timeMax: iso(START + 10 * 24 * HOUR) });
    expect(page.items.map((item) => [item.id, item.status])).toEqual([["weekly_0", "confirmed"], ["weekly_1", "confirmed"], ["gone", "cancelled"]]);
    expect(page.items[1]!.start).toEqual({ dateTime: iso(START + 7 * 24 * HOUR) });
  });

  it("a 410 on an incremental list is sync_token_expired (retry false)", async () => {
    const calendar = freshCalendar();
    const { accessToken } = google.issueGrant();
    const gc = client();
    const full = await gc.listEvents(accessToken, { calendarId: calendar.id, timeMin: iso(START), timeMax: iso(START + HOUR) });
    google.expireSyncTokens(calendar.id);
    const expired = await failure(gc.listEvents(accessToken, { calendarId: calendar.id, syncToken: full.nextSyncToken! }));
    expect(expired).toMatchObject({ code: "sync_token_expired", retry: false, status: 410 });
    // A 410 on a full list is not a sync token problem.
    google.failNext("list", { status: 410, reason: "deleted" });
    const gone = await failure(gc.listEvents(accessToken, { calendarId: calendar.id, timeMin: iso(START), timeMax: iso(START + HOUR) }));
    expect(gone).toMatchObject({ code: "google_410_deleted", retry: false });
    // After a fresh full list, the new sync token works again.
    const again = await gc.listEvents(accessToken, { calendarId: calendar.id, timeMin: iso(START), timeMax: iso(START + HOUR) });
    await expect(gc.listEvents(accessToken, { calendarId: calendar.id, syncToken: again.nextSyncToken! })).resolves.toMatchObject({ items: [] });
  });

  it("keeps only the fields it reads, each with the right type, and drops items without a string id", async () => {
    const { accessToken } = google.issueGrant();
    google.failNext("list", {
      status: 200,
      body: {
        kind: "calendar#events",
        items: [
          {
            id: "full", status: "confirmed", transparency: "opaque", eventType: "default", summary: "Private lunch",
            description: "not read", location: "nowhere", organizer: { email: "o@x.example" },
            start: { dateTime: "2026-10-21T10:00:00Z", timeZone: "Europe/London", extra: 1 },
            end: { dateTime: "2026-10-21T11:00:00Z" },
            attendees: [{ email: "me@x.example", self: true, responseStatus: "declined" }, "junk", { self: "yes" }],
            extendedProperties: { private: { zs_booking: "b1", count: 3 }, shared: { s: "x" } },
          },
          { id: "allday", start: { date: "2026-10-22" }, end: { date: "2026-10-23" }, status: 7 },
          { id: 42, status: "confirmed" },
          { summary: "no id" },
          "string item",
          null,
        ],
        nextSyncToken: "sync-1",
      },
    });
    const page = await client().listEvents(accessToken, { calendarId: "primary", timeMin: iso(START), timeMax: iso(START + HOUR) });
    expect(page).toEqual({
      items: [
        {
          id: "full", status: "confirmed", transparency: "opaque", eventType: "default",
          start: { dateTime: "2026-10-21T10:00:00Z", timeZone: "Europe/London" },
          end: { dateTime: "2026-10-21T11:00:00Z" },
          attendees: [{ self: true, responseStatus: "declined" }, {}],
          extendedProperties: { private: { zs_booking: "b1" } },
        },
        { id: "allday", start: { date: "2026-10-22" }, end: { date: "2026-10-23" } },
      ],
      nextPageToken: null,
      nextSyncToken: "sync-1",
    });
  });

  it("a page without items is empty, and a page that is not an event list is unreadable (retry)", async () => {
    const { accessToken } = google.issueGrant();
    const query = { calendarId: "primary", timeMin: iso(START), timeMax: iso(START + HOUR) };
    google.failNext("list", { status: 200, body: { nextSyncToken: "s" } }, { status: 200, body: { items: "nope" } }, { status: 200, body: "<html>" });
    expect(await client().listEvents(accessToken, query)).toEqual({ items: [], nextPageToken: null, nextSyncToken: "s" });
    expect(await failure(client().listEvents(accessToken, query))).toMatchObject({ code: "google_unreadable_response", retry: true, status: 200 });
    expect(await failure(client().listEvents(accessToken, query))).toMatchObject({ code: "google_unreadable_response", retry: true });
  });

  it("caps the response body at 4 MiB", async () => {
    const { accessToken } = google.issueGrant();
    const query = { calendarId: "primary", timeMin: iso(START), timeMax: iso(START + HOUR) };
    google.failNext("list", { huge: 4 * 1024 * 1024 - 64 }, { huge: 4 * 1024 * 1024 + 1 });
    await expect(client().listEvents(accessToken, query)).resolves.toMatchObject({ items: [] });
    expect(await failure(client().listEvents(accessToken, query))).toMatchObject({ code: "google_response_too_large", retry: false });
  });

  it("encodes the calendar ID into the path", async () => {
    const calendar = google.calendar("team/room #1@group.calendar.test");
    calendar.put(timed("roomevt", START));
    const { accessToken } = google.issueGrant();
    const page = await client().listEvents(accessToken, { calendarId: calendar.id, timeMin: iso(START), timeMax: iso(START + HOUR) });
    expect(page.items.map((item) => item.id)).toEqual(["roomevt"]);
    expect(google.requestsTo("list").at(-1)!.path).toBe("/calendar/v3/calendars/team%2Froom%20%231%40group.calendar.test/events");
  });

  it("an expired access token is refused as google_401_autherror", async () => {
    const { accessToken } = google.issueGrant();
    clock.advance(3600 * 1000);
    try {
      const error = await failure(client().listEvents(accessToken, { calendarId: "primary", timeMin: iso(START), timeMax: iso(START + HOUR) }));
      expect(error).toMatchObject({ code: "google_401_autherror", retry: false });
    } finally {
      clock.set(START);
    }
  });
});

describe("inserting events (G-10)", () => {
  const event = () => ({
    id: randomUUID().replace(/-/g, ""),
    summary: "Booked",
    start: iso(START + 2 * HOUR),
    end: iso(START + 3 * HOUR),
    privateProperties: { zs_booking: randomUUID(), zs_tenant: randomUUID() },
  });

  it("posts the event as JSON and answers created, then exists for the same ID", async () => {
    const calendar = freshCalendar();
    const { accessToken } = google.issueGrant();
    const input = event();
    expect(await client().insertEvent(accessToken, calendar.id, input)).toBe("created");
    const sent = google.requestsTo("insert").at(-1)!;
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.json).toEqual({
      id: input.id, summary: "Booked", start: { dateTime: input.start }, end: { dateTime: input.end },
      transparency: "opaque", extendedProperties: { private: input.privateProperties },
    });
    expect(calendar.get(input.id)).toMatchObject({ status: "confirmed", extendedProperties: { private: input.privateProperties } });
    expect(await client().insertEvent(accessToken, calendar.id, input)).toBe("exists");
    expect(calendar.events()).toHaveLength(1);
  });

  it("a refused event is not retried, a 5xx or 429 is", async () => {
    const { accessToken } = google.issueGrant();
    const bad = await failure(client().insertEvent(accessToken, "primary", { ...event(), id: "UPPER-case" }));
    expect(bad).toMatchObject({ code: "google_400_invalid", retry: false, status: 400 });
    google.failNext("insert", { status: 500 }, { status: 429 }, { status: 403, reason: "rateLimitExceeded" }, { status: 403, reason: "forbidden" }, "drop");
    expect(await failure(client().insertEvent(accessToken, "primary", event()))).toMatchObject({ code: "google_500_backenderror", retry: true });
    expect(await failure(client().insertEvent(accessToken, "primary", event()))).toMatchObject({ code: "google_429_ratelimitexceeded", retry: true });
    expect(await failure(client().insertEvent(accessToken, "primary", event()))).toMatchObject({ code: "google_403_ratelimitexceeded", retry: true });
    expect(await failure(client().insertEvent(accessToken, "primary", event()))).toMatchObject({ code: "google_403_forbidden", retry: false });
    expect(await failure(client().insertEvent(accessToken, "primary", event()))).toMatchObject({ code: "google_network", retry: true });
  });
});

describe("push channels (G-8, G-9)", () => {
  it("watch opens a channel and push notifications reach the address with the X-Goog headers", async () => {
    const received: Array<{ headers: Record<string, string | string[] | undefined>; body: string }> = [];
    const hook = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", () => resolve()));
    try {
      const address = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/webhooks/google/calendar`;
      const calendar = freshCalendar();
      const { accessToken } = google.issueGrant();
      const channelId = randomUUID();
      const opened = await client().watch(accessToken, { calendarId: calendar.id, channelId, address, token: "channel-token-value" });
      const channel = google.channel(channelId)!;
      expect(opened).toEqual({ resourceId: channel.resourceId, expiresAt: START + 7 * 24 * HOUR });
      expect(google.requestsTo("watch").at(-1)!.json).toEqual({ id: channelId, type: "web_hook", address, token: "channel-token-value" });
      expect(google.requestsTo("watch").at(-1)!.path).toBe(`/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events/watch`);

      expect(await google.notify(channelId)).toBe(200);
      expect(await google.notifyCalendar(calendar.id)).toEqual([200]);
      expect(received.map((each) => [each.headers["x-goog-resource-state"], each.headers["x-goog-message-number"]])).toEqual([["sync", "1"], ["exists", "2"]]);
      expect(received[0]!.headers).toMatchObject({
        "x-goog-channel-id": channelId, "x-goog-channel-token": "channel-token-value", "x-goog-resource-id": channel.resourceId,
      });
      expect(received[0]!.body).toBe("");

      await client().stopChannel(accessToken, { channelId, resourceId: opened.resourceId });
      expect(google.requestsTo("stop").at(-1)).toMatchObject({ path: "/calendar/v3/channels/stop", json: { id: channelId, resourceId: opened.resourceId } });
      expect(google.channel(channelId)!.stopped).toBe(true);
      await expect(google.notify(channelId)).rejects.toThrow(/closed/);
      // Stopping again, or a channel Google never knew, resolves (404).
      await expect(client().stopChannel(accessToken, { channelId, resourceId: opened.resourceId })).resolves.toBeUndefined();
      await expect(client().stopChannel(accessToken, { channelId: randomUUID(), resourceId: "nope" })).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => hook.close(() => resolve()));
    }
  });

  it("a duplicate channel ID is refused, and stop failures other than 404 throw", async () => {
    const { accessToken } = google.issueGrant();
    const channelId = randomUUID();
    const input = { calendarId: "primary", channelId, address: "https://api.haldenrowe.example/webhooks/google/calendar", token: "t" };
    await client().watch(accessToken, input);
    expect(await failure(client().watch(accessToken, input))).toMatchObject({ code: "google_400_channelidnotunique", retry: false });
    google.failNext("stop", { status: 502 }, { status: 401 });
    expect(await failure(client().stopChannel(accessToken, { channelId, resourceId: "r" }))).toMatchObject({ code: "google_502_backenderror", retry: true });
    expect(await failure(client().stopChannel(accessToken, { channelId, resourceId: "r" }))).toMatchObject({ code: "google_401_autherror", retry: false });
  });

  it("an unreadable watch answer is google_unreadable_response", async () => {
    const { accessToken } = google.issueGrant();
    const input = { calendarId: "primary", channelId: randomUUID(), address: "https://h.example/w", token: "t" };
    google.failNext("watch",
      { status: 200, body: { resourceId: "r1", expiration: 1_800_000_000_000 } },
      { status: 200, body: { resourceId: "r1" } },
      { status: 200, body: { resourceId: "r".repeat(256), expiration: "1" } },
      { status: 200, body: { resourceId: "r1", expiration: "soon" } });
    await expect(client().watch(accessToken, input)).resolves.toEqual({ resourceId: "r1", expiresAt: 1_800_000_000_000 });
    for (let i = 0; i < 3; i++) expect((await failure(client().watch(accessToken, input))).code).toBe("google_unreadable_response");
  });
});

describe("error classification and hygiene", () => {
  it("token endpoint: 400/401 carry Google's error, 429 and 5xx retry, transport failures retry", async () => {
    const cases: Array<[FakeGoogleBehaviour, { code: string; retry: boolean }]> = [
      [{ status: 400, body: { error: "invalid_grant", error_description: "Bad Request" } }, { code: "invalid_grant", retry: false }],
      [{ status: 401, body: { error: "unauthorized_client" } }, { code: "unauthorized_client", retry: false }],
      [{ status: 400, body: "not json" }, { code: "google_400", retry: false }],
      [{ status: 403, body: { error: "access_denied" } }, { code: "google_403_access_denied", retry: false }],
      [{ status: 429 }, { code: "google_429_rate_limit_exceeded", retry: true }],
      [{ status: 500 }, { code: "google_500_internal_failure", retry: true }],
      [{ status: 503, body: "" }, { code: "google_503", retry: true }],
      [{ status: 302, headers: { location: "https://elsewhere.example/" } }, { code: "google_302_server_error", retry: false }],
      [{ status: 200, body: { access_token: "fake-at.x" } }, { code: "google_unreadable_response", retry: true }],
      [{ huge: 64 * 1024 + 1 }, { code: "google_response_too_large", retry: false }],
      ["drop", { code: "google_network", retry: true }],
    ];
    for (const [behaviour, expected] of cases) {
      google.failNext("token", behaviour);
      expect(await failure(client().refreshAccessToken("fake-rt.x"))).toMatchObject(expected);
    }
  });

  it("an unreachable host and an aborted request are google_network (retry)", async () => {
    const closed = await createFakeGoogle({ clock });
    const url = closed.baseUrl;
    await closed.close();
    expect(await failure(client({ tokenBaseUrl: url }).refreshAccessToken("fake-rt.x"))).toMatchObject({ code: "google_network", retry: true, status: null });
    const controller = new AbortController();
    let release!: () => void;
    google.failNext("list", { hold: new Promise<void>((resolve) => { release = resolve; }), reached: () => controller.abort() });
    const { accessToken } = google.issueGrant();
    const aborted = await failure(client().listEvents(accessToken, { calendarId: "primary", timeMin: iso(START), timeMax: iso(START + HOUR) }, { signal: controller.signal }));
    release();
    expect(aborted).toMatchObject({ code: "google_network", retry: true });
  });

  it("never follows redirects and sends the injected fetch every request", async () => {
    const inits: Array<[string, RequestInit]> = [];
    const gc = client({}, (input, init) => {
      inits.push([input, init]);
      return fetch(input, init);
    });
    const { refreshToken, accessToken } = google.issueGrant();
    await gc.refreshAccessToken(refreshToken);
    await gc.listEvents(accessToken, { calendarId: "primary", timeMin: iso(START), timeMax: iso(START + HOUR) });
    await gc.revoke(refreshToken);
    expect(inits.map(([input, init]) => [new URL(input).pathname, init.method, init.redirect])).toEqual([
      ["/token", "POST", "manual"], ["/calendar/v3/calendars/primary/events", "GET", "manual"], ["/revoke", "POST", "manual"],
    ]);
  });

  it("keeps tokens and secrets out of every error, even when Google echoes them", async () => {
    const { refreshToken, accessToken } = google.issueGrant();
    const secrets = [refreshToken, accessToken, google.clientSecret, "fake-sync.secretish"];
    const echo = secrets.join(" ");
    const errors: GoogleRequestFailed[] = [];
    const endpoints: FakeGoogleEndpoint[] = ["token", "revoke", "list", "insert", "watch", "stop"];
    for (const endpoint of endpoints) {
      google.failNext(endpoint,
        { status: 400, body: { error: refreshToken, error_description: echo } },
        { status: 500, body: googleApiError(500, accessToken, echo) },
        { status: 403, body: { error: { errors: [{ reason: google.clientSecret }], status: refreshToken, message: echo } } });
    }
    const calls = (gc: ConfiguredGoogleClient) => [
      () => gc.refreshAccessToken(refreshToken),
      () => gc.revoke(refreshToken),
      () => gc.listEvents(accessToken, { calendarId: "primary", syncToken: "fake-sync.secretish" }),
      () => gc.insertEvent(accessToken, "primary", { id: "abcde12345", summary: "Booked", start: iso(START), end: iso(START + HOUR), privateProperties: {} }),
      () => gc.watch(accessToken, { calendarId: "primary", channelId: randomUUID(), address: "https://h.example/w", token: "t" }),
      () => gc.stopChannel(accessToken, { channelId: randomUUID(), resourceId: "r" }),
    ];
    for (const call of calls(client())) for (let i = 0; i < 3; i++) errors.push(await failure(call()));
    expect(errors).toHaveLength(18);
    for (const error of errors) {
      const text = `${error.message} ${error.code} ${String(error.stack)} ${JSON.stringify(error)}`;
      for (const secret of secrets) expect(text).not.toContain(secret);
      expect(error.code).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe("configuration", () => {
  const base = { clientId: "id.apps.example", clientSecret: "s" };
  it("accepts https and loopback http, and defaults the base URLs", () => {
    expect(googleClientConfigSchema.parse(base)).toEqual({
      ...base, oauthBaseUrl: GOOGLE_DEFAULT_OAUTH_BASE_URL, tokenBaseUrl: GOOGLE_DEFAULT_TOKEN_BASE_URL, apiBaseUrl: GOOGLE_DEFAULT_API_BASE_URL,
    });
    for (const url of ["https://g.example", "http://127.0.0.1:9999", "http://localhost:1", "http://[::1]:2"])
      expect(googleClientConfigSchema.safeParse({ ...base, apiBaseUrl: url, tokenBaseUrl: url, oauthBaseUrl: url, redirectUrl: url }).success).toBe(true);
  });

  it("refuses plain http elsewhere, credentials in URLs, empty client fields and unknown keys", () => {
    const bad: Array<Record<string, unknown>> = [
      { ...base, apiBaseUrl: "http://www.googleapis.com" },
      { ...base, tokenBaseUrl: "http://10.0.0.1" },
      { ...base, oauthBaseUrl: "ftp://accounts.google.com" },
      { ...base, redirectUrl: "http://api.haldenrowe.example/oauth/google/callback" },
      { ...base, apiBaseUrl: "https://user:pass@g.example" },
      { ...base, apiBaseUrl: "not a url" },
      { ...base, clientId: "" },
      { ...base, clientSecret: "" },
      { clientId: "x" },
      { ...base, extra: true },
    ];
    for (const config of bad) expect(googleClientConfigSchema.safeParse(config).success, JSON.stringify(config)).toBe(false);
    expect(() => createGoogleClient({ config: { ...base, apiBaseUrl: "http://www.googleapis.com" } })).toThrow(/apiBaseUrl: apiBaseUrl must use https/);
  });

  it("does not name the client secret in a config error", () => {
    const secret = `cs-${randomBytes(12).toString("hex")}`;
    let message = "";
    try {
      createGoogleClient({ config: { clientId: "", clientSecret: secret } });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/clientId/);
    expect(message).not.toContain(secret);
  });
});
