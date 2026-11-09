// The operator command that connects a mailbox (outreach-sequencer.md OS-2, OS-3) against a fake Google on loopback. The
// test plays the browser: it reads the consent URL the command prints and calls the loopback redirect itself. Nothing here
// can reach Google, and no real mail is involved.
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createGmailClient, createGoogleClient, createOutreachOperator, generateSealKeyPair, openRefreshToken, outreachMailboxId, parseSealPrivateKey, parseSealPublicKey } from "@zs/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONNECT_MAILBOX_USAGE,
  ConnectFailed,
  connectMailbox,
  disconnectMailbox,
  OUTREACH_GMAIL_SCOPES,
  parseConnectEnv,
  parseConnectMailboxArgs,
  type ConnectArgs,
  type ConnectDeps,
} from "../src/outreach/connect-mailbox.js";
import { createApiHarness, type ApiHarness } from "./helpers.js";

const pair = generateSealKeyPair();
const SCOPES = [...OUTREACH_GMAIL_SCOPES];

interface Behaviour { refreshToken: string | null; scope: string; profileEmail: string }
const behave = (): Behaviour => ({ refreshToken: "refresh-token-for-test", scope: SCOPES.join(" "), profileEmail: "devin@zerosum-solutions.com" });

/** Google's token, revoke and Gmail profile endpoints on 127.0.0.1. */
async function fakeGoogle() {
  const log = { exchanges: 0, revoked: [] as string[], challenge: "", verifierOk: [] as boolean[] };
  const state = { behaviour: behave() };
  const body = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  };
  const server: Server = createServer((request, response) => {
    void (async () => {
      const send = (status: number, json: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(json));
      if (request.method === "POST" && request.url === "/token") {
        const form = await body(request);
        log.exchanges += 1;
        const verifier = form.get("code_verifier") ?? "";
        log.verifierOk.push(createHash("sha256").update(verifier).digest("base64url") === log.challenge);
        send(200, {
          access_token: "access-token-for-test", expires_in: 3600, scope: state.behaviour.scope, token_type: "Bearer",
          ...(state.behaviour.refreshToken === null ? {} : { refresh_token: state.behaviour.refreshToken }),
        });
      } else if (request.method === "POST" && request.url === "/revoke") {
        log.revoked.push((await body(request)).get("token") ?? "");
        send(200, {});
      } else if (request.method === "GET" && request.url === "/gmail/v1/users/me/profile") {
        send(200, { emailAddress: state.behaviour.profileEmail, historyId: "1000" });
      } else {
        send(404, {});
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, log, state, close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }) };
}

let h: ApiHarness;
let google: Awaited<ReturnType<typeof fakeGoogle>>;
let tenant: string;
const privateKey = parseSealPrivateKey(pair.privateKey);

beforeAll(async () => {
  h = await createApiHarness();
  google = await fakeGoogle();
  tenant = h.a.tenantId;
});
afterAll(async () => { await google?.close(); await h?.close(); });
afterEach(() => { google.state.behaviour = behave(); google.log.revoked.length = 0; google.log.exchanges = 0; google.log.verifierOk.length = 0; });

const DEVIN = "devin@zerosum-solutions.com";
const args = (change: Partial<ConnectArgs> = {}): ConnectArgs => ({
  tenantId: tenant, mailbox: DEVIN, name: "Devin", dailyLimit: 20, dryRun: false, disconnect: false, ...change,
});

function deps(change: { tenants?: readonly string[]; domains?: readonly string[]; waitMs?: number; printed?: string[]; operator?: (real: ConnectDeps["operator"]) => ConnectDeps["operator"] } = {}): ConnectDeps {
  const printed = change.printed ?? [];
  const allowed = change.tenants ?? [tenant];
  return {
    env: { tenants: allowed, domains: change.domains ?? ["zerosum-solutions.com"], publicKey: parseSealPublicKey(pair.publicKey) },
    operator: (change.operator ?? ((real) => real))(createOutreachOperator({ db: h.database.db, clock: { now: () => new Date() }, generateId: randomUUID, outreach: { tenants: allowed } }, tenant)),
    makeGoogle: (redirectUrl) => createGoogleClient({ config: { clientId: "client-id.example", clientSecret: "client-secret-value", redirectUrl, scopes: SCOPES, tokenBaseUrl: google.base } }),
    gmail: createGmailClient({ config: { baseUrl: google.base } }),
    checkTenant: async () => undefined,
    print: (line) => printed.push(line),
    ...(change.waitMs === undefined ? {} : { waitMs: change.waitMs }),
  };
}

/** Starts the command, waits for the consent URL, and plays the browser's redirect with `callback`. */
async function run(options: { callback?: (consent: URL) => string | null; change?: Parameters<typeof deps>[0]; args?: Partial<ConnectArgs> } = {}) {
  const printed: string[] = [];
  const d = deps({ ...options.change, printed });
  const result = connectMailbox(args(options.args), d).then((value) => ({ value, error: null as unknown }), (error: unknown) => ({ value: null, error }));
  let consent: URL | null = null;
  for (let i = 0; i < 200 && consent === null; i += 1) {
    const line = printed.find((entry) => entry.startsWith("http://") || entry.startsWith("https://"));
    if (line) consent = new URL(line);
    else await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(consent).not.toBeNull();
  google.log.challenge = consent!.searchParams.get("code_challenge") ?? "";
  const target = (options.callback ?? ((url) => `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&code=auth-code`))(consent!);
  if (target !== null) await fetch(target);
  return { ...(await result), consent: consent!, printed };
}

const stored = (email: string) => h.fixture.service(async (tx) =>
  (await tx.query<{ id: string; email: string; status: string; sealed_refresh_token: string | null; display_name: string; daily_limit: number }>(
    "SELECT id,email,status,sealed_refresh_token,display_name,daily_limit FROM outreach_mailboxes WHERE tenant_id=$1 AND email=$2", [tenant, email])).rows);
let counter = 0;
/** A fresh address per test: the service role cannot delete mailboxes, so each test names its own. */
const fresh = () => { counter += 1; return `box${counter}@zerosum-solutions.com`; };

describe("the arguments", () => {
  const ID = "6f1c1b0e-3a42-4f6e-8a55-0d1d9b7b3c11";
  it("parses a connect, a dry run and a disconnect", () => {
    expect(parseConnectMailboxArgs(["--tenant", ID, "--mailbox", "Devin@ZeroSum-Solutions.com", "--name", "Devin W"])).toEqual({
      tenantId: ID, mailbox: "devin@zerosum-solutions.com", name: "Devin W", dailyLimit: 20, dryRun: false, disconnect: false });
    expect(parseConnectMailboxArgs(["--tenant", ID, "--mailbox", "a@b.co", "--name", "A", "--daily-limit", "7", "--dry-run"])).toMatchObject({ dailyLimit: 7, dryRun: true });
    expect(parseConnectMailboxArgs(["--tenant", ID, "--mailbox", "a@b.co", "--disconnect"])).toMatchObject({ disconnect: true, name: null });
  });
  it.each([
    [[]],
    [["--tenant", "nope", "--mailbox", "a@b.co", "--name", "A"]],
    [["--tenant", ID, "--mailbox", "not-an-address", "--name", "A"]],
    [["--tenant", ID, "--mailbox", "a@b.co"]],
    [["--tenant", ID, "--mailbox", "a@b.co", "--name", "A", "--daily-limit", "51"]],
    [["--tenant", ID, "--mailbox", "a@b.co", "--name", "A", "--daily-limit", "0"]],
    [["--tenant", ID, "--mailbox", "a@b.co", "--name", "A", "--extra"]],
    [["--tenant", ID, "--mailbox", "a@b.co", "--name"]],
    [["--tenant", ID, "--mailbox", "a@b.co", "--name", "A", "--disconnect"]],
  ])("prints the usage for %j", (argv) => {
    expect(parseConnectMailboxArgs(argv)).toBeNull();
    expect(CONNECT_MAILBOX_USAGE).toContain("outreach:connect-mailbox");
  });
});

describe("parseConnectEnv", () => {
  const good = { OUTREACH_TENANTS: randomUUID(), OUTREACH_TOKEN_PUBLIC_KEY: pair.publicKey };
  it("defaults the domain list and parses the key", () => {
    const parsed = parseConnectEnv(good);
    expect(parsed.domains).toEqual(["zerosum-solutions.com"]);
    expect(parsed.publicKey.asymmetricKeyType).toBe("x25519");
    expect(parseConnectEnv({ ...good, OUTREACH_MAILBOX_DOMAINS: "A.example, b.example" }).domains).toEqual(["a.example", "b.example"]);
  });
  it("names the variable and never the value", () => {
    expect(() => parseConnectEnv({ ...good, OUTREACH_TOKEN_PUBLIC_KEY: undefined })).toThrow(/OUTREACH_TOKEN_PUBLIC_KEY/);
    expect(() => parseConnectEnv({ ...good, OUTREACH_TENANTS: "" })).toThrow(/OUTREACH_TENANTS/);
    let message = "";
    try { parseConnectEnv({ ...good, OUTREACH_TOKEN_PUBLIC_KEY: "secret-looking-garbage" }); } catch (error) { message = String(error); }
    expect(message).toMatch(/OUTREACH_TOKEN_PUBLIC_KEY/);
    expect(message).not.toContain("secret-looking-garbage");
  });
});

describe("storing the grant (OS-3)", () => {
  it("replays the same command when the first answer is lost after the commit, and keeps the live grant", async () => {
    const mailbox = fresh();
    google.state.behaviour.profileEmail = mailbox;
    const keys: string[] = [];
    const out = await run({
      args: { mailbox },
      change: { operator: (real) => ({ ...real, async connectMailbox(input) {
        keys.push(input.idempotencyKey);
        const result = await real.connectMailbox(input);
        if (keys.length === 1) throw new Error("the answer was lost");
        return result;
      } }) },
    });
    expect(out.error).toBeNull();
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
    expect(google.log.revoked).toEqual([]);
    expect(await stored(mailbox)).toHaveLength(1);
  });

  it("revokes the fresh grant only after the store failed three times", async () => {
    const mailbox = fresh();
    google.state.behaviour.profileEmail = mailbox;
    let attempts = 0;
    const out = await run({
      args: { mailbox },
      change: { operator: (real) => ({ ...real, async connectMailbox() { attempts += 1; throw new Error("refused"); } }) },
    });
    expect(out.error).toMatchObject({ code: "store_failed", revoked: true });
    expect(attempts).toBe(3);
    expect(google.log.revoked).toHaveLength(1);
    expect(await stored(mailbox)).toHaveLength(0);
  });
});

describe("connecting a mailbox (OS-2)", () => {
  it("connects a matching account: the consent URL holds exactly the two scopes, and the stored token opens only for its own row", async () => {
    const { value, error, consent, printed } = await run();
    expect(error).toBeNull();
    const mailboxId = outreachMailboxId(tenant, "devin@zerosum-solutions.com");
    expect(value).toEqual({ mailboxId, status: "active" });

    expect(consent.searchParams.get("scope")).toBe(SCOPES.join(" "));
    expect(consent.searchParams.get("access_type")).toBe("offline");
    expect(consent.searchParams.get("prompt")).toBe("consent");
    expect(consent.searchParams.get("login_hint")).toBe("devin@zerosum-solutions.com");
    expect(consent.searchParams.get("hd")).toBe("zerosum-solutions.com");
    expect(consent.searchParams.get("code_challenge_method")).toBe("S256");
    expect(consent.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(google.log.verifierOk).toEqual([true]);

    const [row] = await stored(DEVIN);
    expect(row).toMatchObject({ id: mailboxId, email: "devin@zerosum-solutions.com", status: "active", display_name: "Devin", daily_limit: 20 });
    expect(openRefreshToken(privateKey, { tenantId: tenant, connectionId: mailboxId }, row!.sealed_refresh_token!)).toBe("refresh-token-for-test");
    expect(openRefreshToken(privateKey, { tenantId: tenant, connectionId: randomUUID() }, row!.sealed_refresh_token!)).toBeNull();
    expect(openRefreshToken(privateKey, { tenantId: randomUUID(), connectionId: mailboxId }, row!.sealed_refresh_token!)).toBeNull();
    expect(google.log.revoked).toEqual([]);

    // The output names the mailbox and status and no token.
    const output = printed.join("\n");
    expect(output).toContain(mailboxId);
    expect(output).not.toContain("refresh-token-for-test");
    expect(output).not.toContain("access-token-for-test");
    expect(output).not.toContain("auth-code");
  });

  it("a reconnect replaces the token and keeps one row; a disconnect clears it (OS-3)", async () => {
    google.state.behaviour.refreshToken = "second-refresh-token";
    expect((await run()).error).toBeNull();
    const rows = await stored(DEVIN);
    expect(rows).toHaveLength(1);
    expect(openRefreshToken(privateKey, { tenantId: tenant, connectionId: rows[0]!.id }, rows[0]!.sealed_refresh_token!)).toBe("second-refresh-token");

    const printed: string[] = [];
    const out = await disconnectMailbox(args({ disconnect: true, name: null }), deps({ printed }));
    expect(out.status).toBe("disconnected");
    expect(await stored(DEVIN)).toMatchObject([{ status: "disconnected", sealed_refresh_token: null }]);
    expect(printed.join("\n")).toContain("permissions");
  });

  it("a forged state stores nothing and never exchanges the code", async () => {
    const mailbox = fresh();
    google.state.behaviour.profileEmail = mailbox;
    const { error } = await run({ args: { mailbox }, callback: (url) => `${url.searchParams.get("redirect_uri")}?state=forged&code=auth-code` });
    expect(error).toBeInstanceOf(ConnectFailed);
    expect((error as ConnectFailed).code).toBe("state_mismatch");
    expect(google.log.exchanges).toBe(0);
    expect(await stored(mailbox)).toEqual([]);
  });

  it("stores nothing and revokes the fresh grant when Google sends no refresh token", async () => {
    const mailbox = fresh();
    google.state.behaviour.profileEmail = mailbox;
    google.state.behaviour.refreshToken = null;
    const { error } = await run({ args: { mailbox } });
    expect((error as ConnectFailed).code).toBe("no_refresh_token");
    expect(google.log.revoked).toEqual(["access-token-for-test"]);
    expect(await stored(mailbox)).toEqual([]);
  });

  it("stores nothing and revokes when gmail.metadata is missing", async () => {
    const mailbox = fresh();
    google.state.behaviour.profileEmail = mailbox;
    google.state.behaviour.scope = SCOPES[0]!;
    const { error } = await run({ args: { mailbox } });
    expect((error as ConnectFailed).code).toBe("missing_scope");
    expect(google.log.revoked).toEqual(["refresh-token-for-test"]);
    expect(await stored(mailbox)).toEqual([]);
  });

  it("stores nothing and revokes when another account signed in", async () => {
    const mailbox = fresh();
    google.state.behaviour.profileEmail = "other@zerosum-solutions.com";
    const { error } = await run({ args: { mailbox } });
    expect((error as ConnectFailed).code).toBe("wrong_account");
    expect(google.log.revoked).toEqual(["refresh-token-for-test"]);
    expect(await stored(mailbox)).toEqual([]);
    expect(await stored("other@zerosum-solutions.com")).toEqual([]);
  });

  it("refuses a domain outside the list and a tenant outside the allowlist before any Google call", async () => {
    await expect(connectMailbox(args({ mailbox: "pat@other.example" }), deps())).rejects.toMatchObject({ code: "domain_not_allowed" });
    await expect(connectMailbox(args({ mailbox: fresh() }), deps({ tenants: [randomUUID()] }))).rejects.toMatchObject({ code: "tenant_not_allowed" });
    expect(google.log.exchanges).toBe(0);
    expect(await stored("pat@other.example")).toEqual([]);
  });

  it("times out without storing anything", async () => {
    const mailbox = fresh();
    await expect(connectMailbox(args({ mailbox }), deps({ waitMs: 50 }))).rejects.toMatchObject({ code: "timed_out" });
    expect(await stored(mailbox)).toEqual([]);
  });

  it("answers a denial from Google without exchanging a code", async () => {
    const mailbox = fresh();
    const { error } = await run({ args: { mailbox }, callback: (url) => `${url.searchParams.get("redirect_uri")}?state=${url.searchParams.get("state")}&error=access_denied` });
    expect((error as ConnectFailed).code).toBe("google_denied");
    expect(google.log.exchanges).toBe(0);
    expect(await stored(mailbox)).toEqual([]);
  });

  it("--dry-run checks and writes nothing, and opens no listener", async () => {
    const mailbox = fresh();
    const printed: string[] = [];
    const out = await connectMailbox(args({ mailbox, dryRun: true }), deps({ printed }));
    expect(out.status).toBe("dry_run");
    expect(await stored(mailbox)).toEqual([]);
    expect(printed.join("\n")).toMatch(/Nothing was written/);
  });
});
