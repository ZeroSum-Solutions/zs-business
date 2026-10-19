/**
 * e2e:live stack: a throwaway database on the local test cluster, the demo seed, the real
 * API (as the unprivileged runtime role) and a production build of the dashboard pointed at
 * it. Everything started here is stopped, and the database dropped, in the returned teardown.
 *
 * Auth runs as in production: a random per-run secret, a required issuer, a required `iat`
 * and the default one-hour lifetime cap. The seed's 7-day token is only a source of the demo
 * principal. Every token names a session in the auth stub (auth.sessions), which the API checks
 * on each request, and its user must be a member of the business.
 *
 * Sign-in runs as in production too, except for the email: a fake Supabase Auth (fake-gotrue.ts)
 * on a free loopback port keeps its users and sessions in this run's auth stub and, instead of
 * sending the link, serves the last one at /__test/last-link. The dashboard server gets its URL
 * and a random anon key; the browser never sees a token or the key: the build is scanned for them.
 *
 * Children never inherit the shell's environment (see child-env.ts): each gets an allowlist
 * plus what is set here, and every database URL must name this run's zs_e2e_* database.
 *
 * Logs go through redactingLog, so no JWT is ever written to disk. Teardown deletes the
 * live build (.next-live) and test-results/live; set ZS_LIVE_KEEP_LOGS=1 to keep the logs.
 * After setup the seeded rows are snapshotted, and fixtures.ts puts them back before each test.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, decodeJwt } from "jose";
import pg from "pg";
import { findBundleLeaks } from "../../scripts/bundle-secrets";
import { createFakeGoTrue, serveFakeGoTrue } from "./fake-gotrue";
import { pgAuthStore } from "./pg-auth-store";
import { assertThrowawayDatabaseEnv, childEnv, type Env } from "./child-env";
import { LIVE } from "./env";
import { redactingLog } from "./redact";
import { SNAPSHOT_SQL } from "./reset";

/** Required `iss` for this run; the API checks it because JWT_ISSUER is set. */
const ISSUER = "https://zs-e2e-live.local/auth/v1";
/** The API default, set explicitly so the harness never inherits a longer local-dev cap. */
const MAX_TTL_SECONDS = 3600;
/** The API default for how far `iat` may lie ahead, also set explicitly. */
const CLOCK_SKEW_SECONDS = 60;

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardDir = path.resolve(here, "../..");
const apiDir = path.resolve(dashboardDir, "../api");
const logDir = path.join(dashboardDir, "test-results", "live");

/** Same boundary as the db test harness: loopback only, never a default or Supabase port. */
function adminUrl(): URL {
  const url = new URL(process.env.ZS_TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:55432/postgres");
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
  if (!loopback || !url.port || ["5432", "54322"].includes(url.port) || url.search) {
    throw new Error("e2e:live only runs against the local test cluster (127.0.0.1:55432)");
  }
  return url;
}

async function assertPortFree(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => reject(new Error(`Port ${port} is in use. Stop whatever runs there and retry.`)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve()));
  });
}

function run(name: string, command: string, args: string[], options: { cwd: string; env: Env }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const log = redactingLog(path.join(logDir, `${name}.log`));
    child.stdout.on("data", (chunk: Buffer) => { output += chunk; log.write(chunk); });
    child.stderr.on("data", (chunk: Buffer) => log.write(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      log.end();
      if (code === 0) resolve(output);
      else reject(new Error(`${name} exited with ${code}; see test-results/live/${name}.log`));
    });
  });
}

/** Long-running server in its own process group, so teardown stops pnpm and its children. */
function start(name: string, command: string, args: string[], options: { cwd: string; env: Env }): ChildProcess {
  const log = redactingLog(path.join(logDir, `${name}.log`));
  const child = spawn(command, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout!.pipe(log);
  child.stderr!.pipe(log);
  return child;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  const timer = setTimeout(() => signal("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

async function waitFor(url: string, child: ChildProcess, name: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${name} stopped early; see test-results/live/${name}.log`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not answer ${url} within ${timeoutMs / 1000}s`);
}

export default async function globalSetup() {
  mkdirSync(logDir, { recursive: true });
  await assertPortFree(LIVE.apiPort);
  await assertPortFree(LIVE.webPort);

  const admin = adminUrl();
  const database = `zs_e2e_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
  const databaseUrl = new URL(admin);
  databaseUrl.pathname = `/${database}`;
  const runtimeUrl = new URL(databaseUrl);
  runtimeUrl.username = "zs_runtime";
  runtimeUrl.password = "";
  const jwtSecret = randomBytes(32).toString("hex");
  const children: ChildProcess[] = [];
  const closers: (() => Promise<void>)[] = [];

  const adminClient = async <T>(work: (client: pg.Client) => Promise<T>) => {
    const client = new pg.Client({ connectionString: admin.href });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };

  /** Stop everything, drop the database and delete the build; logs stay only on request. */
  const teardown = async (keepLogs = process.env.ZS_LIVE_KEEP_LOGS === "1") => {
    for (const child of children.reverse()) await stop(child);
    for (const close of closers.reverse()) await close();
    await adminClient((client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
    rmSync(path.join(dashboardDir, ".next-live"), { recursive: true, force: true });
    if (!keepLogs) rmSync(logDir, { recursive: true, force: true });
  };

  await adminClient((client) => client.query(`CREATE DATABASE "${database}"`));
  try {
    /** A clean env for one child; refuses to start it unless every database URL is this run's. */
    const envFor = (set: Record<string, string>) => {
      const env = childEnv(set);
      assertThrowawayDatabaseEnv(env, database);
      return env;
    };

    // seed:demo applies the migrations, makes sure zs_runtime exists, seeds Halden & Rowe and prints a JWT.
    const seedOutput = await run("seed", "pnpm", ["run", "seed:demo"], {
      cwd: apiDir,
      env: envFor({ DATABASE_URL: databaseUrl.href, RUNTIME_DATABASE_URL: runtimeUrl.href, JWT_SECRET: jwtSecret }),
    });
    const token = /Dev JWT[^\n]*:\n(\S+)/.exec(seedOutput)?.[1];
    if (!token) throw new Error("seed:demo did not print a dev JWT; see test-results/live/seed.log");

    // Snapshot the seeded rows, so each test can start from them (see fixtures.ts).
    const runClient = new pg.Client({ connectionString: databaseUrl.href });
    await runClient.connect();
    try {
      await runClient.query(SNAPSHOT_SQL);
    } finally {
      await runClient.end();
    }

    const seedClaims = decodeJwt(token) as { sub?: string; app_metadata?: { tenant_id?: string } };
    const tenantId = seedClaims.app_metadata?.tenant_id;
    if (!seedClaims.sub || !tenantId) throw new Error("Dev JWT has no user or tenant");
    const ownerId = seedClaims.sub;

    // The fake Supabase Auth and the people it knows, in this run's auth stub.
    const authPool = new pg.Pool({ connectionString: databaseUrl.href, max: 4 });
    closers.push(() => authPool.end());
    const store = pgAuthStore(authPool);
    const owner = await store.userById(ownerId);
    if (!owner) throw new Error("seed:demo did not add the owner to the auth stub");
    // A second person in the same business (staff), for the conflicting writes, and a signed-in
    // person who belongs to no business.
    const addUser = async (email: string, role?: "staff") => {
      const id = randomUUID();
      await authPool.query("INSERT INTO auth.users (id, email, raw_app_meta_data) VALUES ($1, $2, $3::jsonb)", [id, email, JSON.stringify({ tenant_id: tenantId })]);
      if (role) {
        await authPool.query(
          `INSERT INTO public.tenant_members (tenant_id, id, email, user_id, role, invited_by, created_at, updated_at)
           VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, now(), now())`,
          [tenantId, email, id, role, ownerId],
        );
      }
      return id;
    };
    const staffId = await addUser("staff@example.com", "staff");
    const outsiderId = await addUser("outsider@example.com");
    const anonKey = randomBytes(24).toString("base64url");
    const gotrue = createFakeGoTrue({ jwtSecret, issuer: ISSUER, anonKey, store, ttlSeconds: MAX_TTL_SECONDS });
    const auth = await serveFakeGoTrue(gotrue);
    closers.push(auth.close);

    const now = Math.floor(Date.now() / 1000);
    // Every token carries iat: the API requires it and checks exp - iat against the cap.
    const sign = async (sub: string, claims: { role: string; iss?: string; sessionId?: string }, ttlSeconds = MAX_TTL_SECONDS, withIat = true) => {
      const { iss, sessionId, ...rest } = claims;
      let jwt = new SignJWT({ ...rest, session_id: sessionId ?? (await store.startSession(sub)), app_metadata: { tenant_id: tenantId } })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(sub)
        .setAudience("authenticated")
        .setExpirationTime(now + ttlSeconds);
      if (withIat) jwt = jwt.setIssuedAt(now);
      return (iss ? jwt.setIssuer(iss) : jwt).sign(new TextEncoder().encode(jwtSecret));
    };
    const ownerToken = await sign(ownerId, { role: "authenticated", iss: ISSUER });
    const otherToken = await sign(staffId, { role: "authenticated", iss: ISSUER });
    const outsiderToken = await sign(outsiderId, { role: "authenticated", iss: ISSUER });
    const endedSession = await store.startSession(ownerId);
    // Tokens the API must refuse: wrong role, missing issuer, missing iat, one second over the
    // cap, and a session that was signed out.
    const refusedTokens = {
      anonRole: await sign(ownerId, { role: "anon", iss: ISSUER }),
      noIssuer: await sign(ownerId, { role: "authenticated" }),
      noIssuedAt: await sign(ownerId, { role: "authenticated", iss: ISSUER }, MAX_TTL_SECONDS, false),
      tooLong: await sign(ownerId, { role: "authenticated", iss: ISSUER }, MAX_TTL_SECONDS + 1),
      signedOut: await sign(ownerId, { role: "authenticated", iss: ISSUER, sessionId: endedSession }),
      seedSevenDay: token,
    };
    await store.endSession(endedSession);

    const api = start("api", "pnpm", ["run", "start"], {
      cwd: apiDir,
      // No ALLOWED_ORIGINS: the browser only talks to the dashboard, never to the API.
      env: envFor({
        DATABASE_URL: runtimeUrl.href,
        JWT_VERIFIER: "hs256",
        JWT_SECRET: jwtSecret,
        JWT_ISSUER: ISSUER,
        JWT_MAX_TTL_SECONDS: String(MAX_TTL_SECONDS),
        JWT_CLOCK_SKEW_SECONDS: String(CLOCK_SKEW_SECONDS),
        PORT: String(LIVE.apiPort),
      }),
    });
    children.push(api);
    await waitFor(`${LIVE.apiUrl}/healthz`, api, "api", 30_000);

    // All server-only: the dashboard's server reads them at request time. The build gets them
    // too, so the scan below would catch code that inlines one into the browser bundle.
    const webEnv = envFor({
      NEXT_DIST_DIR: ".next-live",
      ZS_API_URL: LIVE.apiUrl,
      SUPABASE_URL: auth.url,
      SUPABASE_ANON_KEY: anonKey,
      // One address for every test (no trusted proxy): lift the sign-in limits for the run.
      DASHBOARD_SIGN_IN_PER_ADDRESS: "10000",
      DASHBOARD_SIGN_IN_GLOBAL: "10000",
      NEXT_TELEMETRY_DISABLED: "1",
    });
    await run("build", "pnpm", ["exec", "next", "build", "--webpack"], { cwd: dashboardDir, env: webEnv });
    const leaks = findBundleLeaks(path.join(dashboardDir, ".next-live"), [ownerToken, otherToken, outsiderToken, token, jwtSecret, anonKey]);
    if (leaks.length > 0) {
      throw new Error(`The dashboard build ships a token or secret: ${leaks.map((leak) => `${leak.kind} in ${leak.file}`).join(", ")}`);
    }
    const web = start("web", "pnpm", ["exec", "next", "start", "--hostname", "127.0.0.1", "--port", String(LIVE.webPort)], { cwd: dashboardDir, env: webEnv });
    children.push(web);
    await waitFor(LIVE.webUrl, web, "web", 60_000);

    // Workers inherit these.
    process.env.ZS_LIVE_TOKEN = ownerToken;
    process.env.ZS_LIVE_OTHER_TOKEN = otherToken;
    process.env.ZS_LIVE_OUTSIDER_TOKEN = outsiderToken;
    process.env.ZS_LIVE_REFUSED_TOKENS = JSON.stringify(refusedTokens);
    process.env.ZS_LIVE_AUTH_URL = auth.url;
    process.env.ZS_LIVE_OWNER_EMAIL = owner.email;
    // Superuser URL for this run's database only; reset.ts checks the name before using it.
    process.env.ZS_LIVE_RESET_DB_URL = databaseUrl.href;
  } catch (error) {
    // Keep the (redacted) logs the error message points at.
    await teardown(true);
    throw error;
  }
  return teardown;
}
