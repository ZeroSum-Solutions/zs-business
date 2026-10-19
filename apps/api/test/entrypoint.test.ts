// Runs the real `src/main.ts` entry point as a child process: the pool it builds there is
// what has to survive a lost idle connection (W2), and what bounds a saturated checkout (W3).
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { signDevToken } from "../src/dev-token.js";
import { signedInMember } from "./helpers.js";

const SECRET = ["entry", "point", "x".repeat(32)].join("-");
const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

let database: TestDatabase;
let fixture: TwoTenantFixture;

async function freePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

interface Running {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: () => number | null;
  stop(): Promise<void>;
}

async function startApi(extraEnv: Record<string, string> = {}): Promise<Running> {
  const port = await freePort();
  const url = new URL(database.url);
  url.username = "zs_runtime";
  const child = spawn(TSX, ["src/main.ts"], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: url.href,
      JWT_VERIFIER: "hs256",
      JWT_SECRET: SECRET,
      SESSION_CHECK: "local-stub",
      PORT: String(port),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let exitCode: number | null = null;
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.on("exit", (code) => { exitCode = code ?? -1; });
  for (let i = 0; i < 200 && !output.includes("listening") && exitCode === null; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 50));
  if (exitCode !== null || !output.includes("listening")) throw new Error(`API did not start: ${output}`);
  return {
    child, port, output: () => output, exited: () => exitCode,
    async stop() {
      if (exitCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

/** A live owner of tenant A, with a token signed for the child's real clock. */
async function memberToken(): Promise<string> {
  const member = await signedInMember(database, fixture, fixture.a.tenantId, "owner");
  return signDevToken(SECRET, member, { now: () => new Date() }, 600);
}

/**
 * Ends every backend the runtime login holds in this test database. Only the child uses that
 * login here: this file never reads through the harness's own runtime pool.
 */
async function terminateRuntimeBackends(): Promise<number> {
  const { rows } = await database.pool.query<{ n: number }>(
    `SELECT count(*) FILTER (WHERE pg_terminate_backend(pid))::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'zs_runtime'`,
  );
  return rows[0]?.n ?? 0;
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
}, 60_000);
afterAll(async () => {
  await database?.close();
});

describe("API entry point", () => {
  it("survives a terminated idle connection and serves the next request on a new one", async () => {
    const api = await startApi();
    try {
      // Startup checked the runtime login, so the pool holds one idle connection now.
      expect(await terminateRuntimeBackends()).toBeGreaterThan(0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(api.exited(), api.output()).toBeNull();
      expect(api.output()).toContain("57P01");

      const token = await memberToken();
      const response = await fetch(`http://127.0.0.1:${api.port}/v1/booking/resources`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      const ready = await fetch(`http://127.0.0.1:${api.port}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ok: true });
      // The log names the SQLSTATE but never the connection string or its credentials.
      expect(api.output()).not.toContain(database.name);
    } finally {
      await api.stop();
    }
  }, 30_000);

  it("answers 503 within the request deadline when every connection is busy", async () => {
    const api = await startApi({ DATABASE_POOL_MAX: "1", REQUEST_TIMEOUT_MS: "1000", DATABASE_CONNECT_TIMEOUT_MS: "500" });
    // Hold the API's only connection: lock a row it needs, then make it wait on that lock.
    const holder = await database.pool.connect();
    try {
      const token = await memberToken();
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE booking_resources IN ACCESS EXCLUSIVE MODE");
      const headers = { Authorization: `Bearer ${token}` };
      const first = fetch(`http://127.0.0.1:${api.port}/v1/booking/resources`, { headers });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const started = performance.now();
      const second = await fetch(`http://127.0.0.1:${api.port}/v1/booking/resources`, { headers });
      const elapsed = performance.now() - started;
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBe("1");
      expect(await second.json()).toEqual({ error: { code: "Unavailable", message: "Service unavailable", details: {} } });
      expect(elapsed).toBeLessThan(1500);
      expect((await first).status).toBe(503);
      // The deadline reached Postgres too: the first request's statement stopped waiting on
      // the lock, though the lock is still held, instead of holding the connection for the
      // 5 s lock timeout.
      const waiting = async () => (await database.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND usename = 'zs_runtime' AND wait_event_type = 'Lock'`,
      )).rows[0]?.n;
      await expect.poll(waiting, { timeout: 1500, interval: 100 }).toBe(0);
      await holder.query("ROLLBACK");
      // Once the lock is gone the same process serves again.
      const after = await fetch(`http://127.0.0.1:${api.port}/v1/booking/resources`, { headers });
      expect(after.status).toBe(200);
      expect(api.exited()).toBeNull();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      await api.stop();
    }
  }, 30_000);
});
