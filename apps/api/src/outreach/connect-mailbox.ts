// The operator command that connects one outreach mailbox (docs/requirements/outreach-sequencer.md OS-2, OS-3). It runs on
// the owner's Mac: a loopback listener receives Google's redirect for one consent, the code is exchanged with a PKCE
// verifier, the grant is checked (a refresh token, both Gmail scopes, and the signed-in account is the mailbox), and only
// then is the refresh token sealed with the public key and stored through the shared action path. Any failure after the
// exchange revokes the fresh grant and stores nothing. This module never prints a token and never reads process.env.
import { createHash, randomBytes, timingSafeEqual, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  outreachMailboxId,
  parseOutreachTenants,
  parseSealPublicKey,
  sealRefreshToken,
  type GmailPort,
  type GoogleClient,
  type OutreachOperator,
} from "@zs/core";
import { uuidSchema } from "@zs/contracts";

/** Exactly the scopes OS-2 asks for. */
export const OUTREACH_GMAIL_SCOPES: readonly string[] = Object.freeze([
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.metadata",
]);
export const DEFAULT_MAILBOX_DOMAINS: readonly string[] = Object.freeze(["zerosum-solutions.com"]);
export const CONNECT_WAIT_MS = 5 * 60_000;

export const CONNECT_MAILBOX_USAGE =
  'Usage: pnpm --filter @zs/api outreach:connect-mailbox --tenant <uuid> --mailbox <address> --name "<From name>" [--daily-limit 20] [--dry-run]\n' +
  "       pnpm --filter @zs/api outreach:connect-mailbox --tenant <uuid> --mailbox <address> --disconnect";

export type ConnectFailureCode =
  | "tenant_not_allowed"
  | "domain_not_allowed"
  | "timed_out"
  | "google_denied"
  | "state_mismatch"
  | "no_refresh_token"
  | "missing_scope"
  | "wrong_account"
  | "profile_failed"
  | "store_failed"
  | "exchange_failed"
  | "listen_failed";

/** A failure with a fixed code and a fixed message; it never carries a code, state, token or URL. */
export class ConnectFailed extends Error {
  constructor(readonly code: ConnectFailureCode, message: string, readonly revoked = false) {
    super(message);
    this.name = "ConnectFailed";
  }
}

export interface ConnectArgs {
  readonly tenantId: string;
  readonly mailbox: string;
  readonly name: string | null;
  readonly dailyLimit: number;
  readonly dryRun: boolean;
  readonly disconnect: boolean;
}

const addressSchema = z.string().trim().toLowerCase().min(3).max(254).regex(/^[^\s@<>"',;]+@[a-z0-9.-]+\.[a-z]{2,}$/, "must be an email address");

/** Null means print the usage. A flag with no value, an unknown flag or a stray word is a usage error. */
export function parseConnectMailboxArgs(argv: readonly string[]): ConnectArgs | null {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--dry-run" || arg === "--disconnect") {
      flags.add(arg);
    } else if (arg === "--tenant" || arg === "--mailbox" || arg === "--name" || arg === "--daily-limit") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--") || values.has(arg)) return null;
      values.set(arg, value);
      i += 1;
    } else {
      return null;
    }
  }
  const tenant = uuidSchema.safeParse(values.get("--tenant"));
  const mailbox = addressSchema.safeParse(values.get("--mailbox"));
  if (!tenant.success || !mailbox.success) return null;
  const disconnect = flags.has("--disconnect");
  const name = values.get("--name")?.trim() ?? null;
  if (disconnect) {
    if (name !== null || values.has("--daily-limit") || flags.has("--dry-run")) return null;
  } else if (name === null || name.length < 1 || name.length > 100 || /[\r\n]/.test(name)) {
    return null;
  }
  const limitText = values.get("--daily-limit");
  const limit = limitText === undefined ? 20 : /^\d{1,2}$/.test(limitText) ? Number(limitText) : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return null;
  return { tenantId: tenant.data.toLowerCase(), mailbox: mailbox.data, name, dailyLimit: limit, dryRun: flags.has("--dry-run"), disconnect };
}

export interface ConnectEnv {
  /** OUTREACH_TENANTS. */
  readonly tenants: readonly string[];
  /** OUTREACH_MAILBOX_DOMAINS, default `zerosum-solutions.com`. */
  readonly domains: readonly string[];
  /** OUTREACH_TOKEN_PUBLIC_KEY, parsed. */
  readonly publicKey: KeyObject;
}

/** Reads the three settings this module owns; the Google client and the database come from the script. Names variables only. */
export function parseConnectEnv(env: Readonly<Record<string, string | undefined>>): ConnectEnv {
  const problems: string[] = [];
  let tenants: string[] = [];
  try {
    tenants = parseOutreachTenants(env.OUTREACH_TENANTS);
    if (tenants.length === 0) problems.push("OUTREACH_TENANTS is required");
  } catch {
    problems.push("OUTREACH_TENANTS must hold comma-separated tenant UUIDs");
  }
  const rawDomains = env.OUTREACH_MAILBOX_DOMAINS;
  const domains = rawDomains === undefined || rawDomains.trim() === ""
    ? [...DEFAULT_MAILBOX_DOMAINS]
    : rawDomains.split(",").map((domain) => domain.trim().toLowerCase());
  if (domains.some((domain) => !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(domain)))
    problems.push("OUTREACH_MAILBOX_DOMAINS must hold comma-separated domains");
  let publicKey: KeyObject | null = null;
  if (env.OUTREACH_TOKEN_PUBLIC_KEY === undefined || env.OUTREACH_TOKEN_PUBLIC_KEY === "") {
    problems.push("OUTREACH_TOKEN_PUBLIC_KEY is required");
  } else {
    try {
      publicKey = parseSealPublicKey(env.OUTREACH_TOKEN_PUBLIC_KEY);
    } catch {
      problems.push("OUTREACH_TOKEN_PUBLIC_KEY must be base64 of the DER SPKI of an X25519 public key");
    }
  }
  if (problems.length > 0 || publicKey === null) throw new Error(`Invalid environment: ${problems.join("; ")}`);
  return { tenants, domains, publicKey };
}

type Listener = {
  readonly port: number;
  /** Resolves with the first request to /callback; null when `ms` pass first. */
  next(ms: number): Promise<URLSearchParams | null>;
  close(): Promise<void>;
};

/** A one-shot listener on 127.0.0.1 and a free port. Every other path answers 404; the page it shows holds no parameter. */
export async function listenLoopback(): Promise<Listener> {
  let deliver: (params: URLSearchParams) => void = () => undefined;
  const arrived = new Promise<URLSearchParams>((resolve) => { deliver = resolve; });
  const server: Server = createServer((request, response) => {
    const url = URL.parse(request.url ?? "", "http://127.0.0.1");
    if (request.method !== "GET" || url === null || url.pathname !== "/callback") {
      response.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
      .end("You can close this tab and return to the terminal.");
    deliver(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  return {
    port: (server.address() as AddressInfo).port,
    next: (ms) => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      void arrived.then((params) => { clearTimeout(timer); resolve(params); });
    }),
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

export interface ConnectDeps {
  readonly env: ConnectEnv;
  readonly operator: OutreachOperator;
  /** The Google client for one redirect URL; asks for exactly OUTREACH_GMAIL_SCOPES. */
  readonly makeGoogle: (redirectUrl: string) => Pick<GoogleClient, "authorizeUrl" | "exchangeCode" | "revoke">;
  readonly gmail: Pick<GmailPort, "getProfile">;
  /** The dry run's database check: the tenant answers under the runtime login. Throws when it does not. */
  readonly checkTenant: (tenantId: string) => Promise<void>;
  readonly print: (line: string) => void;
  readonly listen?: () => Promise<Listener>;
  readonly random?: (bytes: number) => Buffer;
  readonly waitMs?: number;
}

export interface ConnectResult {
  readonly mailboxId: string;
  /** `dry_run` when nothing was written. */
  readonly status: string;
}

const b64url = (bytes: Buffer) => bytes.toString("base64url");
const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function refuse(args: Pick<ConnectArgs, "tenantId" | "mailbox">, deps: ConnectDeps): void {
  if (!deps.env.tenants.some((tenant) => tenant.toLowerCase() === args.tenantId) || !deps.operator.allowed())
    throw new ConnectFailed("tenant_not_allowed", "The tenant is not in OUTREACH_TENANTS");
  const domain = args.mailbox.slice(args.mailbox.lastIndexOf("@") + 1);
  if (!deps.env.domains.includes(domain)) throw new ConnectFailed("domain_not_allowed", "The mailbox domain is not in OUTREACH_MAILBOX_DOMAINS");
}

/** OS-3: disconnect clears the stored token. The grant at Google is not revoked here (the runtime login cannot read the token). */
export async function disconnectMailbox(args: ConnectArgs, deps: ConnectDeps): Promise<ConnectResult> {
  refuse(args, deps);
  const mailboxId = outreachMailboxId(args.tenantId, args.mailbox);
  const result = await deps.operator.disconnectMailbox(mailboxId, `outreach:mailbox:${mailboxId}:disconnect-${b64url((deps.random ?? randomBytes)(9))}`);
  const status = String((result.result as { status?: unknown } | null)?.status ?? "disconnected");
  deps.print(`Mailbox ${mailboxId} is ${status}. Revoke the app at https://myaccount.google.com/permissions while signed in as ${args.mailbox}.`);
  return { mailboxId, status };
}

export async function connectMailbox(args: ConnectArgs, deps: ConnectDeps): Promise<ConnectResult> {
  refuse(args, deps);
  const mailboxId = outreachMailboxId(args.tenantId, args.mailbox);
  if (args.dryRun) {
    await deps.checkTenant(args.tenantId);
    deps.print(`Dry run: ${args.mailbox} could be connected for tenant ${args.tenantId} as mailbox ${mailboxId}. Nothing was written.`);
    return { mailboxId, status: "dry_run" };
  }
  const random = deps.random ?? randomBytes;
  const state = b64url(random(32));
  const verifier = b64url(random(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());

  let listener: Listener;
  try {
    listener = await (deps.listen ?? listenLoopback)();
  } catch {
    throw new ConnectFailed("listen_failed", "Could not listen on 127.0.0.1");
  }
  try {
    const google = deps.makeGoogle(`http://127.0.0.1:${listener.port}/callback`);
    const domain = args.mailbox.slice(args.mailbox.lastIndexOf("@") + 1);
    deps.print(`Open this URL in EGO Lite, signed in as ${args.mailbox} (waiting up to ${Math.round((deps.waitMs ?? CONNECT_WAIT_MS) / 60_000)} minutes):`);
    deps.print(google.authorizeUrl({ state, codeChallenge: challenge, loginHint: args.mailbox, hostedDomain: domain }));
    const params = await listener.next(deps.waitMs ?? CONNECT_WAIT_MS);
    if (params === null) throw new ConnectFailed("timed_out", "No consent arrived in time; nothing was stored");
    if (!sameText(params.get("state") ?? "", state)) throw new ConnectFailed("state_mismatch", "The redirect did not carry our state; nothing was stored");
    const code = params.get("code");
    if (params.get("error") !== null || code === null || code === "") throw new ConnectFailed("google_denied", "Google did not grant access; nothing was stored");

    let grant;
    try {
      grant = await google.exchangeCode({ code, codeVerifier: verifier });
    } catch {
      throw new ConnectFailed("exchange_failed", "Google refused the code exchange; nothing was stored");
    }
    // From here on a fresh grant exists: any failure revokes it before the command ends.
    const revoke = async () => {
      try {
        await google.revoke(grant.refreshToken ?? grant.accessToken);
        return true;
      } catch {
        return false;
      }
    };
    const fail = async (code: ConnectFailureCode, message: string): Promise<never> => {
      const revoked = await revoke();
      throw new ConnectFailed(code, `${message}; nothing was stored${revoked ? " and the new grant was revoked" : " (revoking the new grant failed: remove it at https://myaccount.google.com/permissions)"}`, revoked);
    };
    if (grant.refreshToken === null || grant.refreshToken === "") return await fail("no_refresh_token", "Google sent no refresh token");
    const granted = new Set(grant.scope.split(/\s+/).filter(Boolean));
    if (!OUTREACH_GMAIL_SCOPES.every((scope) => granted.has(scope))) return await fail("missing_scope", "Google did not grant both Gmail scopes");
    let profile;
    try {
      profile = await deps.gmail.getProfile(grant.accessToken);
    } catch {
      return await fail("profile_failed", "Gmail would not tell which account signed in");
    }
    if (profile.emailAddress.toLowerCase() !== args.mailbox) return await fail("wrong_account", "The signed-in account is not the mailbox you named");

    const sealed = sealRefreshToken(deps.env.publicKey, { tenantId: args.tenantId, connectionId: mailboxId }, grant.refreshToken);
    // The same command, with the same key, three times at most: a first try that committed but lost its answer replays its
    // stored result, so the live grant is revoked only when the database really refused (OS-3).
    const command = {
      mailboxId, email: args.mailbox, displayName: args.name ?? "", dailyLimit: args.dailyLimit,
      sealedRefreshToken: sealed, grantedScopes: [...OUTREACH_GMAIL_SCOPES],
      idempotencyKey: `outreach:mailbox:${mailboxId}:${createHash("sha256").update(sealed).digest("hex").slice(0, 16)}`,
    };
    let stored;
    for (let attempt = 1; stored === undefined; attempt += 1) {
      try {
        stored = await deps.operator.connectMailbox(command);
      } catch {
        if (attempt >= 3) return await fail("store_failed", "The database refused the mailbox");
      }
    }
    const status = String((stored.result as { status?: unknown } | null)?.status ?? "active");
    deps.print(`Connected ${args.mailbox}: mailbox ${mailboxId}, status ${status}.`);
    return { mailboxId, status };
  } finally {
    await listener.close();
  }
}
