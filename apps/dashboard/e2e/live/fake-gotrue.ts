/**
 * A stand-in for Supabase Auth (GoTrue), for tests only: the few endpoints the dashboard's
 * server uses, with GoTrue's request and response shapes. Email links are not sent; the last
 * link per address is kept and served at GET /__test/last-link?email=. Access tokens are
 * HS256 JWTs shaped like Supabase's (sub, role, aud, iss, iat, exp, session_id, email,
 * app_metadata), so the real API verifies them. Sessions live in an AuthStore: in memory for
 * unit tests, or the local auth.sessions stub for e2e:live, which the API's
 * auth_session_is_live() reads, so sign-out here is seen by the API at once.
 */
import { createServer, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";

export interface FakeUser {
  id: string;
  email: string;
  appMetadata: Record<string, unknown>;
}

export interface AuthStore {
  userByEmail(email: string): Promise<FakeUser | null>;
  userById(id: string): Promise<FakeUser | null>;
  startSession(userId: string): Promise<string>;
  sessionIsLive(sessionId: string): Promise<boolean>;
  endSession(sessionId: string): Promise<void>;
  /** End every session of the user, except `keep` when given (GoTrue logout scopes global and others). */
  endUserSessions(userId: string, keep?: string): Promise<void>;
}

export function memoryAuthStore(users: FakeUser[]): AuthStore & { sessions: Map<string, string> } {
  const sessions = new Map<string, string>();
  return {
    sessions,
    userByEmail: async (email) => users.find((user) => user.email === email.toLowerCase()) ?? null,
    userById: async (id) => users.find((user) => user.id === id) ?? null,
    async startSession(userId) {
      const id = randomUUID();
      sessions.set(id, userId);
      return id;
    },
    sessionIsLive: async (sessionId) => sessions.has(sessionId),
    async endSession(sessionId) {
      sessions.delete(sessionId);
    },
    async endUserSessions(userId, keep) {
      for (const [id, owner] of sessions) if (owner === userId && id !== keep) sessions.delete(id);
    },
  };
}

export interface FakeGoTrueOptions {
  jwtSecret: string;
  issuer: string;
  anonKey: string;
  store: AuthStore;
  ttlSeconds?: number;
  /** Seconds since the epoch; defaults to the real clock, which supabase-js also uses. */
  now?: () => number;
}

export interface FakeGoTrue {
  handle(request: Request): Promise<Response>;
  /** A fetch that answers from this fake, for unit tests. */
  fetch: typeof fetch;
  lastLink(email: string): string | null;
  /** Calls by path, for assertions. */
  calls: { method: string; path: string }[];
  /** Mint a session for a user directly, as a completed sign-in would. */
  signIn(user: FakeUser): Promise<{ accessToken: string; refreshToken: string; sessionId: string }>;
}

const json = (status: number, body: unknown) => Response.json(body, { status });
const gotrueError = (status: number, code: string, msg: string) => json(status, { code: status, error_code: code, msg });

export function createFakeGoTrue(options: FakeGoTrueOptions): FakeGoTrue {
  const ttl = options.ttlSeconds ?? 3600;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const key = new TextEncoder().encode(options.jwtSecret);
  const links = new Map<string, { userId: string; expiresAt: number }>();
  const lastLinks = new Map<string, string>();
  const refreshTokens = new Map<string, { sessionId: string; userId: string }>();
  const calls: FakeGoTrue["calls"] = [];

  const userJson = (user: FakeUser) => ({
    id: user.id, aud: "authenticated", role: "authenticated", email: user.email,
    email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: user.appMetadata, user_metadata: {},
    identities: [], created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", is_anonymous: false,
  });

  async function sessionFor(user: FakeUser, sessionId: string) {
    const issuedAt = now();
    const accessToken = await new SignJWT({
      role: "authenticated", session_id: sessionId, email: user.email, app_metadata: user.appMetadata,
      user_metadata: {}, aal: "aal1", is_anonymous: false,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(user.id).setAudience("authenticated").setIssuer(options.issuer)
      .setIssuedAt(issuedAt).setExpirationTime(issuedAt + ttl)
      .sign(key);
    const refreshToken = randomBytes(16).toString("hex");
    refreshTokens.set(refreshToken, { sessionId, userId: user.id });
    return {
      access_token: accessToken, token_type: "bearer", expires_in: ttl, expires_at: issuedAt + ttl,
      refresh_token: refreshToken, user: userJson(user),
    };
  }

  async function claimsOf(request: Request) {
    const token = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, key, { issuer: options.issuer, audience: "authenticated" });
      return payload as { sub: string; session_id: string };
    } catch {
      return null;
    }
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname });
    if (url.pathname === "/__test/last-link" && request.method === "GET") {
      const link = lastLinks.get((url.searchParams.get("email") ?? "").toLowerCase());
      return link ? json(200, { link }) : json(404, { error: "no_link" });
    }
    if (request.headers.get("apikey") !== options.anonKey) return gotrueError(401, "no_api_key", "Invalid API key");
    const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};

    if (url.pathname === "/auth/v1/otp" && request.method === "POST") {
      const email = String(body.email ?? "").toLowerCase();
      const user = await options.store.userByEmail(email);
      if (!user) {
        return body.create_user === false
          ? gotrueError(422, "otp_disabled", "Signups not allowed for otp")
          : gotrueError(400, "unsupported", "The fake never creates users");
      }
      const tokenHash = randomBytes(28).toString("hex");
      links.set(tokenHash, { userId: user.id, expiresAt: now() + 3600 });
      // As the Magic Link template {{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email.
      const link = new URL(url.searchParams.get("redirect_to") ?? "http://localhost/");
      link.searchParams.set("token_hash", tokenHash);
      link.searchParams.set("type", "email");
      lastLinks.set(email, link.href);
      return json(200, {});
    }
    if (url.pathname === "/auth/v1/verify" && request.method === "POST") {
      const link = links.get(String(body.token_hash ?? ""));
      links.delete(String(body.token_hash ?? ""));
      const user = link && link.expiresAt > now() ? await options.store.userById(link.userId) : null;
      if (!user || !["email", "magiclink"].includes(String(body.type))) return gotrueError(403, "otp_expired", "Email link is invalid or has expired");
      return json(200, await sessionFor(user, await options.store.startSession(user.id)));
    }
    if (url.pathname === "/auth/v1/token" && url.searchParams.get("grant_type") === "refresh_token" && request.method === "POST") {
      const token = String(body.refresh_token ?? "");
      const entry = refreshTokens.get(token);
      refreshTokens.delete(token);
      const user = entry && (await options.store.sessionIsLive(entry.sessionId)) ? await options.store.userById(entry.userId) : null;
      if (!entry || !user) return gotrueError(400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      return json(200, await sessionFor(user, entry.sessionId));
    }
    if (url.pathname === "/auth/v1/logout" && request.method === "POST") {
      const claims = await claimsOf(request);
      if (!claims || !(await options.store.sessionIsLive(claims.session_id))) return gotrueError(404, "session_not_found", "Session not found");
      // Like GoTrue: scope local ends this session, others every other one, global (the default) all.
      const scope = url.searchParams.get("scope") ?? "global";
      if (scope === "local") await options.store.endSession(claims.session_id);
      else await options.store.endUserSessions(claims.sub, scope === "others" ? claims.session_id : undefined);
      for (const [token, entry] of refreshTokens) {
        if (!(await options.store.sessionIsLive(entry.sessionId))) refreshTokens.delete(token);
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/auth/v1/user" && request.method === "GET") {
      const claims = await claimsOf(request);
      const user = claims && (await options.store.sessionIsLive(claims.session_id)) ? await options.store.userById(claims.sub) : null;
      return user ? json(200, userJson(user)) : gotrueError(403, "session_not_found", "Session not found");
    }
    return gotrueError(404, "not_found", "Not found");
  }

  return {
    handle,
    fetch: (input, init) => handle(new Request(input, init)),
    lastLink: (email) => lastLinks.get(email.toLowerCase()) ?? null,
    calls,
    async signIn(user) {
      const sessionId = await options.store.startSession(user.id);
      const session = await sessionFor(user, sessionId);
      return { accessToken: session.access_token, refreshToken: session.refresh_token, sessionId };
    },
  };
}

/** Serve the fake over HTTP on loopback, on a free port. */
export async function serveFakeGoTrue(fake: FakeGoTrue): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method ?? "GET", headers, ...(body ? { body } : {}) });
      fake.handle(request).then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      }, () => {
        res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake GoTrue did not get a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
