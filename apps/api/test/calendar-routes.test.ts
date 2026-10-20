// M5 Google Calendar connections through the real app (docs/requirements/google-calendar.md G-1,
// G-2, G-3, G-5): the consent URL, the OAuth callback against the in-process fake Google (real
// client, real PKCE), the sealed token, and the owner's list and disconnect. No network.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiErrorBodySchema, calendarConnectionListSchema, calendarConnectionSchema, connectGoogleCalendarResponseSchema } from "@zs/contracts";
import { DatabaseUnavailable, derivedId, openRefreshToken, pkceChallenge, pkceVerifier, signConnectState, verifyConnectState } from "@zs/core";
import type { ScopedDatabase } from "@zs/db";
import { call, createApiHarness, NOW, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";
import {
  calendarApp, createFakeGoogle, fakeClient, googleConfig, PREVIOUS_STATE_SECRET, REDIRECT_URL, RETURN_URL, STATE_SECRET, TOKEN_PRIVATE_KEY,
  type FakeGoogle,
} from "./calendar-fixtures.js";

let now = Date.parse(NOW);
const clock = { now: () => new Date(now) };
let h: ApiHarness;
let google: FakeGoogle;
let app: ReturnType<typeof calendarApp>;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;

beforeAll(async () => {
  h = await createApiHarness({ clock });
  google = await createFakeGoogle({ clock });
});
afterAll(async () => {
  await google?.close();
  await h?.close();
});
beforeEach(() => {
  now = Date.parse(NOW);
  onError = vi.fn<(error: unknown) => void>();
  app = calendarApp(h, { clock, googleCalendar: googleConfig(fakeClient(google)), onError });
});

/** A booking resource of its own, so connections in one test never retire another's. */
async function newResource(tenantId: string): Promise<string> {
  const id = randomUUID();
  await h.fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'UTC','[]'::jsonb,'[]'::jsonb,60,30,0,0,0,20160)`, [tenantId, id]));
  return id;
}

const startConnect = (token: string, resourceId: unknown, key: string | null = randomUUID(), target = app) =>
  call(target, "POST", "/v1/calendar/google/connect", { token, body: { resourceId }, ...(key === null ? {} : { key }) });

/** The consent URL for one resource, and what it names. */
async function consentFor(member: Pick<MemberSetup, "token" | "tenantId">, resourceId: string, key = randomUUID()) {
  const response = await startConnect(member.token, resourceId, key);
  expect(response.status).toBe(200);
  const { authorizeUrl } = connectGoogleCalendarResponseSchema.parse(response.body);
  const query = new URL(authorizeUrl).searchParams;
  return { authorizeUrl, query, state: query.get("state")!, connectionId: derivedId(member.tenantId, key, "calendar_connection") };
}

/** What the browser does at Google: follow the consent screen, which redirects back with a code. */
async function consent(authorizeUrl: string): Promise<URLSearchParams> {
  const response = await fetch(authorizeUrl, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URL);
  return location.searchParams;
}

async function callback(query: Record<string, string>, target = app) {
  const response = await target.request(`/oauth/google/callback?${new URLSearchParams(query)}`);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as unknown : null };
}
/** The redirect's query, after checking it lands on GOOGLE_RETURN_URL and leaks nothing. */
function landing(response: Awaited<ReturnType<typeof callback>>) {
  expect(response.status).toBe(303);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const location = new URL(response.headers.get("location")!);
  const expected = new URL(RETURN_URL);
  expect(`${location.origin}${location.pathname}`).toBe(`${expected.origin}${expected.pathname}`);
  expect(location.searchParams.get("tab")).toBe("google");
  for (const name of ["code", "state"]) expect(location.searchParams.has(name)).toBe(false);
  return Object.fromEntries([...location.searchParams].filter(([name]) => name !== "tab"));
}

interface Row { id: string; status: string; resource_id: string; created_by: string; refresh_token_sealed: string | null; account_email: string | null; scope: string }
const rows = (tenantId: string) => h.fixture.service(async (tx) => (await tx.query<Row>(
  `SELECT id, status::text AS status, resource_id, created_by, refresh_token_sealed, account_email, scope
     FROM calendar_connections WHERE tenant_id=$1 ORDER BY created_at, id`, [tenantId])).rows);
const row = async (tenantId: string, id: string) => (await rows(tenantId)).find((found) => found.id === id);
const tokenCalls = () => google.requestsTo("token").length;
/** The tokens the callback sent to Google's revoke endpoint, oldest first. */
const revoked = () => google.requestsTo("revoke").map((request) => request.form.token);
/** The fake's grant for a code registered with this email. */
const grantOf = (email: string) => google.grants().find((grant) => grant.email === email)!;
const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@calendar.test`;

/** Holds the next request to the token endpoint until released, after the exchange has started. */
function holdExchange() {
  let release!: () => void;
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  google.failNext("token", { hold: new Promise<void>((resolve) => { release = resolve; }), reached });
  return { arrived, release: () => release() };
}

describe("POST /v1/calendar/google/connect (G-1)", () => {
  it("answers the consent URL with a signed state and the PKCE challenge, and stores nothing", async () => {
    const resourceId = await newResource(h.a.tenantId);
    const key = randomUUID();
    const before = await rows(h.a.tenantId);
    const response = await startConnect(h.a.token, resourceId, key);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { authorizeUrl } = connectGoogleCalendarResponseSchema.parse(response.body);
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${google.baseUrl}/o/oauth2/v2/auth`);
    const query = url.searchParams;
    expect(Object.fromEntries([...query].filter(([name]) => !["state", "code_challenge"].includes(name)))).toEqual({
      client_id: google.clientId,
      redirect_uri: REDIRECT_URL,
      response_type: "code",
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      code_challenge_method: "S256",
    });
    const connectionId = derivedId(h.a.tenantId, key, "calendar_connection");
    expect(verifyConnectState({ current: STATE_SECRET }, query.get("state")!, clock.now())).toEqual({
      tenantId: h.a.tenantId, actorId: h.a.actorId, resourceId, connectionId, expiresAt: now + 10 * 60_000,
    });
    // Signed by the current secret only: another secret does not verify it.
    expect(verifyConnectState({ current: PREVIOUS_STATE_SECRET }, query.get("state")!, clock.now())).toBeNull();
    expect(query.get("code_challenge")).toBe(pkceChallenge(pkceVerifier(STATE_SECRET, connectionId)));
    expect(await rows(h.a.tenantId)).toEqual(before);

    // The same key names the same connection again.
    const again = connectGoogleCalendarResponseSchema.parse((await startConnect(h.a.token, resourceId, key)).body);
    expect(new URL(again.authorizeUrl).searchParams.get("code_challenge")).toBe(query.get("code_challenge"));
  });

  it("refuses staff, anonymous callers, another tenant's resource, a missing key and a bad body", async () => {
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    const resourceId = await newResource(h.a.tenantId);
    const refused = await startConnect(staff.token, resourceId);
    expect(refused.status).toBe(403);
    expect(apiErrorBodySchema.parse(refused.body).error.code).toBe("Forbidden");
    expect((await call(app, "POST", "/v1/calendar/google/connect", { body: { resourceId }, key: randomUUID() })).status).toBe(401);
    expect((await startConnect(h.a.token, h.b.resourceId)).status).toBe(403);
    expect((await startConnect(h.a.token, resourceId, null)).status).toBe(400);
    expect((await startConnect(h.a.token, resourceId, `oauth-google:${randomUUID()}`)).status).toBe(400);
    expect((await startConnect(h.a.token, "not-a-uuid")).status).toBe(400);
    expect((await call(app, "POST", "/v1/calendar/google/connect", { token: h.a.token, key: randomUUID(), body: { resourceId, extra: 1 } })).status)
      .toBe(400);
  });

  it("is not found without Google config, and the callback is not served", async () => {
    const off = calendarApp(h, { clock });
    const response = await startConnect(h.a.token, h.a.resourceId, randomUUID(), off);
    expect(response.status).toBe(404);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("NotFound");
    expect((await callback({ state: "x", code: "y" }, off)).status).toBe(404);
    expect((await callback({ state: "x", code: "y" }, h.app)).status).toBe(404);
  });
});

describe("GET /oauth/google/callback (G-2, G-3)", () => {
  it("connects: an active connection whose sealed token opens only with the worker's key for its own row", async () => {
    const resourceId = await newResource(h.a.tenantId);
    const flow = await consentFor(h.a, resourceId);
    google.setConsent({ email: "studio@calendar.test" });
    const back = await consent(flow.authorizeUrl);
    expect(back.get("state")).toBe(flow.state);
    const response = await callback({ state: back.get("state")!, code: back.get("code")!, scope: "ignored" });
    expect(landing(response)).toEqual({ calendar: "connected" });

    const stored = (await row(h.a.tenantId, flow.connectionId))!;
    expect(stored).toMatchObject({
      status: "active", resource_id: resourceId, created_by: h.a.actorId, account_email: "studio@calendar.test",
    });
    expect(stored.scope.split(" ")).toContain("https://www.googleapis.com/auth/calendar.events");
    // The grant the fake issued for this code is what the row holds, sealed.
    const grant = google.grants().find((candidate) => candidate.email === "studio@calendar.test")!;
    const context = { tenantId: h.a.tenantId, connectionId: flow.connectionId };
    expect(openRefreshToken(TOKEN_PRIVATE_KEY, context, stored.refresh_token_sealed!)).toBe(grant.refreshToken);
    expect(openRefreshToken(TOKEN_PRIVATE_KEY, { ...context, connectionId: randomUUID() }, stored.refresh_token_sealed!)).toBeNull();
    expect(openRefreshToken(TOKEN_PRIVATE_KEY, { ...context, tenantId: h.b.tenantId }, stored.refresh_token_sealed!)).toBeNull();
    // The exchange sent the verifier derived for this connection.
    const exchange = google.requestsTo("token").at(-1)!;
    expect(exchange.form).toMatchObject({
      grant_type: "authorization_code", code: back.get("code"), redirect_uri: REDIRECT_URL,
      code_verifier: pkceVerifier(STATE_SECRET, flow.connectionId),
    });

    // The action ran as the member under the reserved key; no access token was kept anywhere.
    const action = await h.fixture.service(async (tx) => (await tx.query<{ actor_id: string; idempotency_key: string; result: unknown; payload: unknown }>(
      "SELECT actor_id, idempotency_key, result, payload FROM actions WHERE tenant_id=$1 AND action_type='calendar.google.connect' AND target->>'id'=$2",
      [h.a.tenantId, flow.connectionId])).rows);
    expect(action).toHaveLength(1);
    expect(action[0]).toMatchObject({ actor_id: h.a.actorId, idempotency_key: `oauth-google:${flow.connectionId}` });
    for (const accessToken of grant.accessTokens) expect(JSON.stringify(action[0])).not.toContain(accessToken);
    expect(JSON.stringify(action[0]!.result)).not.toContain("zsg1.");

    // A reload replays: still connected, one row, and the spent code is not sent again.
    expect(revoked()).not.toContain(grant.refreshToken);
    const calls = tokenCalls();
    expect(landing(await callback({ state: back.get("state")!, code: back.get("code")! }))).toEqual({ calendar: "connected" });
    expect(tokenCalls()).toBe(calls);
    expect((await rows(h.a.tenantId)).filter((found) => found.id === flow.connectionId)).toHaveLength(1);

    // The owner's list shows it, without a token.
    const list = await call(app, "GET", "/v1/calendar/connections", { token: h.a.token });
    expect(list.status).toBe(200);
    const items = calendarConnectionListSchema.parse(list.body).items;
    expect(items.find((item) => item.id === flow.connectionId)).toEqual({
      id: flow.connectionId, provider: "google", resourceId, calendarId: "primary", accountEmail: "studio@calendar.test",
      status: "active", lastSyncedAt: null, lastError: null, createdAt: NOW,
    });
    expect(JSON.stringify(list.body)).not.toContain("zsg1.");
    expect(onError).not.toHaveBeenCalled();
  });

  it("answers 400 JSON, never a redirect, for a missing, forged, tampered or expired state", async () => {
    const flow = await consentFor(h.a, await newResource(h.a.tenantId));
    const forged = signConnectState(["forged", "x".repeat(40)].join("-"), verifyConnectState({ current: STATE_SECRET }, flow.state, clock.now())!);
    const [body, tag] = flow.state.slice("zgs1.".length).split(".");
    const tampered = `zgs1.${body!.slice(0, -2)}AA.${tag}`;
    const calls = tokenCalls();
    for (const query of [{ code: "c" }, { state: "", code: "c" }, { state: forged, code: "c" }, { state: tampered, code: "c" }, { state: "garbage", error: "access_denied" }]) {
      const response = await callback(query);
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.body).toEqual({ error: { code: "ValidationFailed", message: "Invalid OAuth state", details: {} } });
    }
    now += 10 * 60_000;
    expect((await callback({ state: flow.state, code: "c" })).status).toBe(400);
    expect(tokenCalls()).toBe(calls);
    expect(await row(h.a.tenantId, flow.connectionId)).toBeUndefined();
  });

  it("accepts a state signed with the previous secret during a rotation, deriving its verifier from that secret", async () => {
    const resourceId = await newResource(h.a.tenantId);
    // Started before the rotation: the old secret was current then.
    const before = calendarApp(h, { clock, googleCalendar: googleConfig(fakeClient(google), { stateSecrets: { current: PREVIOUS_STATE_SECRET } }) });
    const key = randomUUID();
    const started = connectGoogleCalendarResponseSchema.parse((await startConnect(h.a.token, resourceId, key, before)).body);
    const back = await consent(started.authorizeUrl);
    const rotated = calendarApp(h, {
      clock, googleCalendar: googleConfig(fakeClient(google), { stateSecrets: { current: STATE_SECRET, previous: PREVIOUS_STATE_SECRET } }),
    });
    expect(landing(await callback({ state: back.get("state")!, code: back.get("code")! }, rotated))).toEqual({ calendar: "connected" });
    expect(google.requestsTo("token").at(-1)!.form.code_verifier).toBe(pkceVerifier(PREVIOUS_STATE_SECRET, derivedId(h.a.tenantId, key, "calendar_connection")));
  });

  it("redirects with reason=denied when Google sent an error, without exchanging anything", async () => {
    const flow = await consentFor(h.a, await newResource(h.a.tenantId));
    google.setConsent({ deny: true });
    const back = await consent(flow.authorizeUrl);
    google.setConsent({});
    expect(back.get("error")).toBe("access_denied");
    const calls = tokenCalls();
    const revokes = revoked().length;
    expect(landing(await callback({ state: back.get("state")!, error: back.get("error")! }))).toEqual({ calendar: "error", reason: "denied" });
    expect(tokenCalls()).toBe(calls);
    expect(revoked()).toHaveLength(revokes);
    expect(await row(h.a.tenantId, flow.connectionId)).toBeUndefined();
  });

  it("redirects with reason=exchange_failed for an unknown code, a wrong verifier, a Google outage or no code", async () => {
    const resourceId = await newResource(h.a.tenantId);
    const flow = await consentFor(h.a, resourceId);
    const reason = async (query: Record<string, string>) => landing(await callback({ state: flow.state, ...query }));
    const revokes = revoked().length;
    expect(await reason({ code: "4/never-issued" })).toEqual({ calendar: "error", reason: "exchange_failed" });
    // A code issued for another challenge: PKCE fails at Google.
    const other = google.registerCode({ codeChallenge: pkceChallenge(pkceVerifier(STATE_SECRET, randomUUID())), redirectUri: REDIRECT_URL });
    expect(await reason({ code: other })).toEqual({ calendar: "error", reason: "exchange_failed" });
    const good = google.registerCode({ codeChallenge: flow.query.get("code_challenge")!, redirectUri: REDIRECT_URL });
    google.failNext("token", { status: 503 });
    expect(await reason({ code: good })).toEqual({ calendar: "error", reason: "exchange_failed" });
    google.failNext("token", "drop");
    expect(await reason({ code: good })).toEqual({ calendar: "error", reason: "exchange_failed" });
    expect(await reason({})).toEqual({ calendar: "error", reason: "exchange_failed" });
    expect(await row(h.a.tenantId, flow.connectionId)).toBeUndefined();
    // Nothing was issued, so nothing is revoked.
    expect(revoked()).toHaveLength(revokes);
    // The code itself was never spent, so the owner's next try with it still connects.
    expect(await reason({ code: good })).toEqual({ calendar: "connected" });
    expect(onError).not.toHaveBeenCalled();
  });

  it("redirects with reason=no_refresh_token or scope_missing, stores nothing and leaves the grant alone", async () => {
    const flow = await consentFor(h.a, await newResource(h.a.tenantId));
    const challenge = flow.query.get("code_challenge")!;
    const revokes = revoked().length;
    const code = (email: string, over: { refreshToken?: boolean; scope?: string }) =>
      google.registerCode({ codeChallenge: challenge, redirectUri: REDIRECT_URL, email, ...over });
    const noRefreshEmail = uniqueEmail("no-refresh");
    expect(landing(await callback({ state: flow.state, code: code(noRefreshEmail, { refreshToken: false }) })))
      .toEqual({ calendar: "error", reason: "no_refresh_token" });
    const narrowEmail = uniqueEmail("narrow");
    expect(landing(await callback({ state: flow.state, code: code(narrowEmail, { scope: "openid https://www.googleapis.com/auth/userinfo.email" }) })))
      .toEqual({ calendar: "error", reason: "scope_missing" });
    // A read-only calendar scope is not calendar.events.
    const readonlyEmail = uniqueEmail("readonly");
    expect(landing(await callback({ state: flow.state, code: code(readonlyEmail, { scope: "openid https://www.googleapis.com/auth/calendar.events.readonly" }) })))
      .toEqual({ calendar: "error", reason: "scope_missing" });
    expect(await row(h.a.tenantId, flow.connectionId)).toBeUndefined();
    // Google revokes a whole grant for the user and client, so a revoke here could end another
    // live connection on the same account; the unused grant is stored nowhere and left alone.
    expect(revoked()).toHaveLength(revokes);
    for (const email of [noRefreshEmail, narrowEmail, readonlyEmail]) expect(grantOf(email).revoked, email).toBe(false);
  });

  it("answers forbidden when the member is demoted during the exchange, revoking nothing", async () => {
    const owner = await signedInMember(h.database, h.fixture, h.a.tenantId, "owner");
    const flow = await consentFor(owner, await newResource(h.a.tenantId));
    const email = uniqueEmail("demoted");
    const code = google.registerCode({ codeChallenge: flow.query.get("code_challenge")!, redirectUri: REDIRECT_URL, email });
    const revokes = revoked().length;
    const exchange = holdExchange();
    const pending = callback({ state: flow.state, code });
    await exchange.arrived;
    await h.fixture.service((tx) => tx.query("UPDATE tenant_members SET role='staff' WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, owner.memberId]));
    exchange.release();
    expect(landing(await pending)).toEqual({ calendar: "error", reason: "forbidden" });
    expect(revoked()).toHaveLength(revokes);
    expect(grantOf(email).revoked).toBe(false);
    expect(await row(h.a.tenantId, flow.connectionId)).toBeUndefined();
  });

  it("when a second tab connected during the exchange: connected while it is active, else conflict; nothing revoked", async () => {
    for (const status of ["active", "disconnecting"] as const) {
      const flow = await consentFor(h.a, await newResource(h.a.tenantId));
      const challenge = flow.query.get("code_challenge")!;
      const slow = uniqueEmail("slow-tab");
      const fast = uniqueEmail("fast-tab");
      const slowCode = google.registerCode({ codeChallenge: challenge, redirectUri: REDIRECT_URL, email: slow });
      const revokes = revoked().length;
      const exchange = holdExchange();
      const pending = callback({ state: flow.state, code: slowCode });
      await exchange.arrived;
      const fastCode = google.registerCode({ codeChallenge: challenge, redirectUri: REDIRECT_URL, email: fast });
      expect(landing(await callback({ state: flow.state, code: fastCode }))).toEqual({ calendar: "connected" });
      if (status !== "active")
        await h.fixture.service((tx) => tx.query("UPDATE calendar_connections SET status=$3 WHERE tenant_id=$1 AND id=$2",
          [h.a.tenantId, flow.connectionId, status]));
      exchange.release();
      expect(landing(await pending), status).toEqual(status === "active" ? { calendar: "connected" } : { calendar: "error", reason: "conflict" });
      // Revoking at Google could end the winning tab's grant too, so neither grant is revoked.
      expect(revoked()).toHaveLength(revokes);
      expect(grantOf(slow).revoked).toBe(false);
      // The winning tab's grant is the one the row holds.
      const stored = (await row(h.a.tenantId, flow.connectionId))!;
      expect(openRefreshToken(TOKEN_PRIVATE_KEY, { tenantId: h.a.tenantId, connectionId: flow.connectionId }, stored.refresh_token_sealed!))
        .toBe(grantOf(fast).refreshToken);
      expect(grantOf(fast).revoked).toBe(false);
    }
  });

  it("answers a reload connected only while the connection is active, and conflict once it is not", async () => {
    const flow = await consentFor(h.a, await newResource(h.a.tenantId));
    const back = await consent(flow.authorizeUrl);
    const reload = async () => landing(await callback({ state: back.get("state")!, code: back.get("code")! }));
    expect(await reload()).toEqual({ calendar: "connected" });
    const calls = tokenCalls();
    const revokes = revoked().length;
    expect(await reload()).toEqual({ calendar: "connected" });
    const setStatus = (status: string) => h.fixture.service((tx) => tx.query(
      `UPDATE calendar_connections SET status=$3::calendar_connection_status,
         refresh_token_sealed=CASE WHEN $3='disconnected' THEN NULL ELSE refresh_token_sealed END WHERE tenant_id=$1 AND id=$2`,
      [h.a.tenantId, flow.connectionId, status]));
    for (const status of ["reauthorize", "disconnecting"]) {
      await setStatus(status);
      expect(await reload(), status).toEqual({ calendar: "error", reason: "conflict" });
    }
    await setStatus("active");
    expect(await reload()).toEqual({ calendar: "connected" });
    await setStatus("disconnected");
    expect(await reload()).toEqual({ calendar: "error", reason: "conflict" });
    // A reload never spends the code again or touches Google.
    expect(tokenCalls()).toBe(calls);
    expect(revoked()).toHaveLength(revokes);
  });

  it("binds a connect key to its resource: reused for another, it is refused and never reads as connected", async () => {
    const key = randomUUID();
    const first = await newResource(h.a.tenantId);
    const other = await newResource(h.a.tenantId);
    // Two states for one key, both signed before the connection exists.
    const flow = await consentFor(h.a, first, key);
    const stale = await consentFor(h.a, other, key);
    const back = await consent(flow.authorizeUrl);
    expect(landing(await callback({ state: back.get("state")!, code: back.get("code")! }))).toEqual({ calendar: "connected" });
    // Once the key's connection exists, the key starts no flow for another resource.
    const reused = await startConnect(h.a.token, other, key);
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ error: { code: "Conflict", details: { reason: "idempotency_key_reused" } } });
    // The other resource's state lands on the first resource's row: a conflict, before the code is spent.
    const calls = tokenCalls();
    const staleBack = await consent(stale.authorizeUrl);
    expect(landing(await callback({ state: staleBack.get("state")!, code: staleBack.get("code")! })))
      .toEqual({ calendar: "error", reason: "conflict" });
    expect(tokenCalls()).toBe(calls);
    expect((await row(h.a.tenantId, flow.connectionId))!.resource_id).toBe(first);
    // The same resource still answers as it did; a retired connection's key starts no new flow.
    expect((await startConnect(h.a.token, first, key)).status).toBe(200);
    await h.fixture.service((tx) => tx.query("UPDATE calendar_connections SET status='disconnecting' WHERE tenant_id=$1 AND id=$2",
      [h.a.tenantId, flow.connectionId]));
    expect((await startConnect(h.a.token, first, key)).status).toBe(409);
  });

  it("refuses a member demoted to staff before the callback, before the code is spent", async () => {
    const owner = await signedInMember(h.database, h.fixture, h.a.tenantId, "owner");
    const flow = await consentFor(owner, await newResource(h.a.tenantId));
    const back = await consent(flow.authorizeUrl);
    await h.fixture.service((tx) => tx.query("UPDATE tenant_members SET role='staff' WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, owner.memberId]));
    const calls = tokenCalls();
    expect(landing(await callback({ state: back.get("state")!, code: back.get("code")! }))).toEqual({ calendar: "error", reason: "forbidden" });
    expect(tokenCalls()).toBe(calls);
    expect(await row(h.a.tenantId, flow.connectionId)).toBeUndefined();
    // A removed member likewise.
    const gone = await signedInMember(h.database, h.fixture, h.a.tenantId, "owner");
    const goneFlow = await consentFor(gone, await newResource(h.a.tenantId));
    await h.fixture.service((tx) => tx.query("DELETE FROM tenant_members WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, gone.memberId]));
    expect(landing(await callback({ state: goneFlow.state, code: "4/any" }))).toEqual({ calendar: "error", reason: "forbidden" });
  });

  it("reconnecting a resource retires its connection to disconnecting", async () => {
    const resourceId = await newResource(h.a.tenantId);
    const connect = async () => {
      const flow = await consentFor(h.a, resourceId);
      const back = await consent(flow.authorizeUrl);
      expect(landing(await callback({ state: back.get("state")!, code: back.get("code")! }))).toEqual({ calendar: "connected" });
      return flow.connectionId;
    };
    const first = await connect();
    const second = await connect();
    expect((await row(h.a.tenantId, first))!.status).toBe("disconnecting");
    expect((await row(h.a.tenantId, second))!.status).toBe("active");
    // The retired row keeps its sealed token until the worker revokes it (G-9).
    expect((await row(h.a.tenantId, first))!.refresh_token_sealed).not.toBeNull();
  });

  it("answers 503 when the database is down, keeping the browser headers", async () => {
    const flow = await consentFor(h.a, await newResource(h.a.tenantId));
    const down = calendarApp(h, {
      clock, googleCalendar: googleConfig(fakeClient(google)),
      db: {
        tenant: () => Promise.reject(new DatabaseUnavailable("connect")),
        withoutTenant: () => Promise.reject(new DatabaseUnavailable("connect")),
      } satisfies ScopedDatabase,
    });
    const response = await callback({ state: flow.state, code: "4/any" }, down);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("Unavailable");
  });
});

describe("GET /v1/calendar/connections and POST /v1/calendar/connections/:id/disconnect (G-5)", () => {
  async function connected(member: Pick<MemberSetup, "token" | "tenantId">): Promise<string> {
    const flow = await consentFor(member, await newResource(member.tenantId));
    const back = await consent(flow.authorizeUrl);
    expect(landing(await callback({ state: back.get("state")!, code: back.get("code")! }))).toEqual({ calendar: "connected" });
    return flow.connectionId;
  }
  const disconnect = (token: string, id: string, key: string | null = randomUUID()) =>
    call(app, "POST", `/v1/calendar/connections/${id}/disconnect`, { token, ...(key === null ? {} : { key }) });

  it("lists the caller's own tenant only, to owners and staff", async () => {
    const mine = await connected(h.a);
    const theirs = await connected(h.b);
    const listA = calendarConnectionListSchema.parse((await call(app, "GET", "/v1/calendar/connections", { token: h.a.token })).body).items;
    const listB = calendarConnectionListSchema.parse((await call(app, "GET", "/v1/calendar/connections", { token: h.b.token })).body).items;
    expect(listA.map((item) => item.id)).toContain(mine);
    expect(listA.map((item) => item.id)).not.toContain(theirs);
    expect(listB.map((item) => item.id)).toContain(theirs);
    expect(listB.map((item) => item.id)).not.toContain(mine);
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    const staffList = await call(app, "GET", "/v1/calendar/connections", { token: staff.token });
    expect(staffList.status).toBe(200);
    expect(calendarConnectionListSchema.parse(staffList.body).items.map((item) => item.id).sort()).toEqual(listA.map((item) => item.id).sort());
    expect((await call(app, "GET", "/v1/calendar/connections")).status).toBe(401);
  });

  it("moves an active connection to disconnecting, replays, and answers a retired one as it is", async () => {
    const id = await connected(h.a);
    const key = randomUUID();
    const first = await disconnect(h.a.token, id, key);
    expect(first.status).toBe(200);
    expect(calendarConnectionSchema.parse((first.body as { result: unknown }).result)).toMatchObject({ id, status: "disconnecting" });
    expect(await disconnect(h.a.token, id, key)).toMatchObject({ status: 200, body: first.body });
    expect((await disconnect(h.a.token, id)).body).toMatchObject({ result: { status: "disconnecting" } });
    await h.fixture.service((tx) => tx.query(
      "UPDATE calendar_connections SET status='disconnected', refresh_token_sealed=NULL WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, id]));
    expect((await disconnect(h.a.token, id)).body).toMatchObject({ result: { status: "disconnected" } });
    const reauthorize = await connected(h.a);
    await h.fixture.service((tx) => tx.query("UPDATE calendar_connections SET status='reauthorize' WHERE tenant_id=$1 AND id=$2", [h.a.tenantId, reauthorize]));
    expect((await disconnect(h.a.token, reauthorize)).body).toMatchObject({ result: { status: "disconnecting" } });
  });

  it("refuses staff and missing keys, and answers unknown or another tenant's connection 404", async () => {
    const id = await connected(h.a);
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    expect((await disconnect(staff.token, id)).status).toBe(403);
    expect((await disconnect(h.a.token, id, null)).status).toBe(400);
    expect((await disconnect(h.a.token, "not-a-uuid")).status).toBe(400);
    expect((await disconnect(h.a.token, randomUUID())).status).toBe(404);
    const response = await disconnect(h.b.token, id);
    expect(response.status).toBe(404);
    expect(apiErrorBodySchema.parse(response.body).error.code).toBe("NotFound");
    expect((await row(h.a.tenantId, id))!.status).toBe("active");
  });
});
