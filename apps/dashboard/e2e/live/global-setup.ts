/**
 * e2e:live stack: a throwaway database on the local test cluster, the demo seed, the real
 * API (as the unprivileged runtime role) and a production build of the dashboard pointed at
 * it. Everything started here is stopped, and the database dropped, in the returned teardown.
 *
 * Auth runs as in production: a random per-run secret, a required issuer and the default
 * one-hour lifetime cap. The seed's 7-day token is only a source of the demo principal; the
 * dashboard gets a one-hour token for that principal, which the API accepts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, decodeJwt } from "jose";
import pg from "pg";
import { LIVE } from "./env";

/** Required `iss` for this run; the API checks it because JWT_ISSUER is set. */
const ISSUER = "https://zs-e2e-live.local/auth/v1";
/** The API default, set explicitly so the harness never inherits a longer local-dev cap. */
const MAX_TTL_SECONDS = 3600;

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

function run(name: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const log = createWriteStream(path.join(logDir, `${name}.log`));
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
function start(name: string, command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const log = createWriteStream(path.join(logDir, `${name}.log`));
  const child = spawn(command, args, { ...options, detached: true, stdio: ["ignore", "pipe", "pipe"] });
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

  const adminClient = async <T>(work: (client: pg.Client) => Promise<T>) => {
    const client = new pg.Client({ connectionString: admin.href });
    await client.connect();
    try {
      return await work(client);
    } finally {
      await client.end();
    }
  };

  const teardown = async () => {
    for (const child of children.reverse()) await stop(child);
    await adminClient((client) => client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`));
  };

  await adminClient((client) => client.query(`CREATE DATABASE "${database}"`));
  try {
    const base = { ...process.env, FORCE_COLOR: "0" };

    // seed:demo applies the migrations, makes sure zs_runtime exists, seeds Halden & Rowe and prints a JWT.
    const seedOutput = await run("seed", "pnpm", ["run", "seed:demo"], {
      cwd: apiDir, env: { ...base, DATABASE_URL: databaseUrl.href, JWT_SECRET: jwtSecret },
    });
    const token = /Dev JWT[^\n]*:\n(\S+)/.exec(seedOutput)?.[1];
    if (!token) throw new Error("seed:demo did not print a dev JWT; see test-results/live/seed.log");

    const seedClaims = decodeJwt(token) as { sub?: string; app_metadata?: { tenant_id?: string } };
    const tenantId = seedClaims.app_metadata?.tenant_id;
    if (!seedClaims.sub || !tenantId) throw new Error("Dev JWT has no user or tenant");
    const now = Math.floor(Date.now() / 1000);
    const sign = (sub: string, claims: { role: string; iss?: string }, ttlSeconds = MAX_TTL_SECONDS) => {
      const { iss, ...rest } = claims;
      const jwt = new SignJWT({ ...rest, app_metadata: { tenant_id: tenantId } })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setSubject(sub)
        .setAudience("authenticated")
        .setIssuedAt(now)
        .setExpirationTime(now + ttlSeconds);
      return (iss ? jwt.setIssuer(iss) : jwt).sign(new TextEncoder().encode(jwtSecret));
    };
    const ownerToken = await sign(seedClaims.sub, { role: "authenticated", iss: ISSUER });
    // A second person in the same business, for the conflicting writes.
    const otherToken = await sign(randomUUID(), { role: "authenticated", iss: ISSUER });
    // Tokens the API must refuse: wrong role, missing issuer, and one second over the cap.
    const refusedTokens = {
      anonRole: await sign(seedClaims.sub, { role: "anon", iss: ISSUER }),
      noIssuer: await sign(seedClaims.sub, { role: "authenticated" }),
      tooLong: await sign(seedClaims.sub, { role: "authenticated", iss: ISSUER }, MAX_TTL_SECONDS + 1),
      seedSevenDay: token,
    };

    const api = start("api", "pnpm", ["run", "start"], {
      cwd: apiDir,
      env: {
        ...base,
        DATABASE_URL: runtimeUrl.href,
        JWT_SECRET: jwtSecret,
        JWT_ISSUER: ISSUER,
        JWT_MAX_TTL_SECONDS: String(MAX_TTL_SECONDS),
        ALLOWED_ORIGINS: `${LIVE.webUrl},http://127.0.0.1:${LIVE.webPort}`,
        PORT: String(LIVE.apiPort),
      },
    });
    children.push(api);
    await waitFor(`${LIVE.apiUrl}/healthz`, api, "api", 30_000);

    const webEnv = {
      ...base,
      NEXT_DIST_DIR: ".next-live",
      NEXT_PUBLIC_API_URL: LIVE.apiUrl,
      NEXT_PUBLIC_API_TOKEN: ownerToken,
      NEXT_TELEMETRY_DISABLED: "1",
    };
    await run("build", "pnpm", ["exec", "next", "build", "--webpack"], { cwd: dashboardDir, env: webEnv });
    const web = start("web", "pnpm", ["exec", "next", "start", "--port", String(LIVE.webPort)], { cwd: dashboardDir, env: webEnv });
    children.push(web);
    await waitFor(LIVE.webUrl, web, "web", 60_000);

    // Workers inherit these.
    process.env.ZS_LIVE_TOKEN = ownerToken;
    process.env.ZS_LIVE_OTHER_TOKEN = otherToken;
    process.env.ZS_LIVE_REFUSED_TOKENS = JSON.stringify(refusedTokens);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
