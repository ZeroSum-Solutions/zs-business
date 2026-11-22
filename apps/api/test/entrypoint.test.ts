// Runs the real `src/main.ts` entry point as a child process: the pool it builds there is
// what has to survive a lost idle connection (W2), and what bounds a saturated checkout (W3).
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from "vitest";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { parseServerEnv } from "../src/config.js";
import { signDevToken } from "../src/dev-token.js";
import { createServer as createApiServer } from "../src/server.js";
import { KEY_SECRET, signedInMember } from "./helpers.js";

const SECRET = ["entry", "point", "x".repeat(32)].join("-");
const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
// A child process starts tsx, compiles the app and checks the runtime login before it listens.
// On a busy machine that alone can take tens of seconds, so each test gets a generous budget;
// nothing below waits a fixed time for the child or times how long it took.
const CHILD_TEST_MS = 180_000;

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

/** Ends the child: SIGTERM, then SIGKILL if it has not exited 10 s later. */
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
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
  // Registered before anything can fail: the child never outlives its test.
  onTestFinished(() => kill(child));
  let output = "";
  let exitCode: number | null = null;
  let changed = () => {};
  const onOutput = (chunk: Buffer) => { output += chunk.toString(); changed(); };
  child.stdout?.on("data", onOutput);
  child.stderr?.on("data", onOutput);
  child.on("exit", (code) => { exitCode = code ?? -1; changed(); });
  // A spawn failure ends the wait below as a failed start instead of crashing the test worker.
  child.on("error", (error) => { output += `\nspawn error: ${error.message}`; exitCode ??= -1; changed(); });
  // Started once it says so, or failed once it exits; the test timeout bounds the wait.
  await new Promise<void>((resolve) => {
    changed = () => { if (exitCode !== null || output.includes("listening")) resolve(); };
    changed();
  });
  if (exitCode !== null || !output.includes("listening")) throw new Error(`API did not start: ${output}`);
  onTestFailed(() => { console.error(`API output on port ${port}:\n${output}`); });
  return { child, port, output: () => output, exited: () => exitCode, stop: () => kill(child) };
}

/** A live owner of tenant A, with a token signed for the child's real clock. */
async function memberToken(): Promise<string> {
  const member = await signedInMember(database, fixture, fixture.a.tenantId, "owner");
  return signDevToken(SECRET, member, { now: () => new Date() }, 600);
}

/** Resolves once the child's output contains `text`; rejects if the child exits first. */
async function logged(api: Running, text: string): Promise<void> {
  while (!api.output().includes(text)) {
    if (api.exited() !== null) throw new Error(`API exited before logging ${text}: ${api.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
      // Startup checked the runtime login, so the pool holds one idle connection. The pool closes
      // a connection after 10 s idle, which a slow machine can outlast before this line runs; a
      // read then leaves a fresh idle one to terminate. Only the count matters, not the timing.
      const token = await memberToken();
      while (await terminateRuntimeBackends() === 0) {
        const read = await fetch(`http://127.0.0.1:${api.port}/v1/booking/resources`, { headers: { Authorization: `Bearer ${token}` } });
        await read.body?.cancel();
        expect(read.status).toBe(200);
      }
      // The pool logs the lost connection (57P01) and the process carries on to serve below.
      await logged(api, "57P01");
      expect(api.exited(), api.output()).toBeNull();

      const response = await fetch(`http://127.0.0.1:${api.port}/v1/booking/resources`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      // The readiness probe has its own short budget, which a slow machine can use up: every
      // answer must be 200 or 503, and it must reach 200. The test's timeout bounds the loop.
      let ready = await fetch(`http://127.0.0.1:${api.port}/readyz`);
      while (ready.status !== 200) {
        expect(ready.status).toBe(503);
        await ready.body?.cancel();
        ready = await fetch(`http://127.0.0.1:${api.port}/readyz`);
      }
      expect(await ready.json()).toEqual({ ok: true });
      // The log names the SQLSTATE but never the connection string or its credentials.
      expect(api.output()).not.toContain(database.name);
    } finally {
      await api.stop();
    }
  }, CHILD_TEST_MS);

  it("builds its pool from DATABASE_POOL_MAX", async () => {
    // In process, through the same parse and build the entry point uses: the pool's own setting
    // is the oracle, since Postgres cannot tell a second pooled backend from an abandoned one.
    const url = new URL(database.url);
    url.username = "zs_runtime";
    const env = parseServerEnv({ DATABASE_URL: url.href, JWT_VERIFIER: "hs256", JWT_SECRET: SECRET, SESSION_CHECK: "local-stub", DATABASE_POOL_MAX: "1" });
    const { pool } = await createApiServer(env, { now: () => new Date() });
    onTestFinished(() => pool.end());
    expect(pool.options.max).toBe(1);
  }, CHILD_TEST_MS);

  // A saturated pool in the real process: a request that cannot get a connection answers 503,
  // and the process lives on. deadline-database.test.ts proves in process, on fake timers, that
  // the request deadline ends each wait.
  it("answers 503 when every connection is busy, then serves again once the lock is gone", async () => {
    // A 4 s deadline, below the 5 s default lock timeout, so the deadline always caps the lock wait.
    const api = await startApi({ DATABASE_POOL_MAX: "1", REQUEST_TIMEOUT_MS: "4000" });
    // Hold the API's only connection: lock a table it reads, then make a request wait on that lock.
    const holder = await database.pool.connect();
    onTestFinished(async () => {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    });
    const token = await memberToken();
    await holder.query("BEGIN");
    await holder.query("LOCK TABLE booking_resources IN ACCESS EXCLUSIVE MODE");
    const headers = { Authorization: `Bearer ${token}` };
    const read = () => fetch(`http://127.0.0.1:${api.port}/v1/booking/resources`, { headers });
    const [first, second] = await Promise.all([read(), read()]);
    for (const reply of [first, second]) {
      expect(reply.status).toBe(503);
      expect(reply.headers.get("retry-after")).toBe("1");
      expect(await reply.json()).toEqual({ error: { code: "Unavailable", message: "Service unavailable", details: {} } });
    }
    await holder.query("ROLLBACK");
    // Once the lock is gone the same process serves again. Its one connection may still be
    // finishing the abandoned work, so a read may answer 503 first; the test's timeout bounds it.
    for (;;) {
      if (api.exited() !== null) throw new Error(`API exited: ${api.output()}`);
      const after = await read();
      await after.body?.cancel();
      if (after.status === 200) break;
      expect(after.status).toBe(503);
    }
    expect(api.exited()).toBeNull();
  }, CHILD_TEST_MS);
});

// P-10 revision 6: two API processes stand in for two serverless instances on one database.
describe("public limits across API instances", () => {
  /** A write from one address to a forged key: it spends the address's write budget, then 404s. */
  const write = (api: Running) => fetch(`http://127.0.0.1:${api.port}/public/v1/pages/zsb1_forged/requests`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
  }).then((response) => response.status);
  const twoApis = (env: Record<string, string>) => Promise.all([0, 1].map(() =>
    startApi({ PUBLIC_BOOKING_KEY_SECRET: KEY_SECRET, PUBLIC_RATE_ADDRESS_WRITES: "2", ...env })));

  it("counts one budget in Postgres by default, whichever instance serves", async () => {
    const [first, second] = await twoApis({});
    try {
      expect([await write(first!), await write(second!), await write(first!), await write(second!)]).toEqual([404, 404, 429, 429]);
    } finally {
      await Promise.all([first!.stop(), second!.stop()]);
    }
  }, CHILD_TEST_MS);

  it("grants each instance the whole budget again with PUBLIC_RATE_LIMIT_STORE=memory", async () => {
    // Why hosted deploys refuse memory: the same four writes all pass.
    const [first, second] = await twoApis({ PUBLIC_RATE_LIMIT_STORE: "memory" });
    try {
      expect([await write(first!), await write(second!), await write(first!), await write(second!)]).toEqual([404, 404, 404, 404]);
      // Logged right after the "listening" line, which may arrive in an earlier chunk.
      expect(first!.output()).toContain("PUBLIC_RATE_LIMIT_STORE=memory");
    } finally {
      await Promise.all([first!.stop(), second!.stop()]);
    }
  }, CHILD_TEST_MS);
});

// document-intake.md DL-3, DL-5 (ZSB-17): the hosted entry point mounts the upload and worker routes when
// DOCUMENT_INTAKE_WORKER_TOKEN is set: the owner routes behind the member auth of /v1, the worker routes behind that
// token. Unset, the owner routes are 404 and a worker call falls under the member auth of /v1 (401).
describe("document intake through the entry point", () => {
  const TOKEN = ["entry", "intake", "w".repeat(32)].join("-");
  const PDF = Buffer.from("%PDF-1.4\n% entry point upload\n%%EOF\n", "latin1");
  const upload = (api: Running, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${api.port}/v1/document-intake/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Filename": "prices.pdf", "Idempotency-Key": crypto.randomUUID(), ...headers },
      body: PDF,
    });

  it("queues an owner's upload, refuses one without a token, and lets only the worker's token claim it", async () => {
    const api = await startApi({ SITES_STORE: "memory", DOCUMENT_INTAKE_WORKER_TOKEN: TOKEN });
    try {
      expect((await upload(api, {})).status).toBe(401);
      const queued = await upload(api, { Authorization: `Bearer ${await memberToken()}` });
      expect(queued.status).toBe(201);
      const job = await queued.json() as { jobId: string; status: string };
      expect(job.status).toBe("queued");
      const claim = (token: string) => fetch(`http://127.0.0.1:${api.port}/v1/workers/document-intake/claim`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
      });
      expect((await claim("x".repeat(40))).status).toBe(401);
      const claimed = await claim(TOKEN);
      expect(claimed.status).toBe(200);
      const lease = (await claimed.json() as { job: { id: string; leaseToken: string } | null }).job;
      expect(lease?.id).toBe(job.jobId);
      // The worker reads back the bytes the upload stored in the site store.
      const file = await fetch(`http://127.0.0.1:${api.port}/v1/workers/document-intake/jobs/${job.jobId}/file`, {
        headers: { Authorization: `Bearer ${TOKEN}`, "X-Lease-Token": lease!.leaseToken },
      });
      expect(file.status).toBe(200);
      expect(Buffer.from(await file.arrayBuffer())).toEqual(PDF);
      expect(api.output()).not.toContain(TOKEN);
    } finally {
      await api.stop();
    }
  }, 30_000);

  it("leaves the routes off until DOCUMENT_INTAKE_WORKER_TOKEN is set: uploads 404, worker calls the member auth's 401", async () => {
    const api = await startApi({ SITES_STORE: "memory" });
    try {
      expect((await upload(api, { Authorization: `Bearer ${await memberToken()}` })).status).toBe(404);
      const claim = await fetch(`http://127.0.0.1:${api.port}/v1/workers/document-intake/claim`, {
        method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(claim.status).toBe(401);
    } finally {
      await api.stop();
    }
  }, 30_000);
});

// hub-launch L9: the dashboard's sign-in limits through the real entry point (env parsing, server wiring, the
// Postgres limiter on the runtime login), with two API processes standing in for two serverless instances.
describe("sign-in limits across API instances", () => {
  const CURRENT = ["entry", "sign-in", "c".repeat(32)].join("-");
  const PREVIOUS = ["entry", "sign-in", "p".repeat(32)].join("-");
  const admit = (api: Running, address: string, secret: string, limits = { perAddress: 4, global: 1000 }) =>
    fetch(`http://127.0.0.1:${api.port}/public/v1/sign-in/admit`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ address, ...limits }),
    });

  it("counts one budget in Postgres for concurrent requests that reach either instance", async () => {
    const [first, second] = await Promise.all([0, 1].map(() => startApi({ SIGN_IN_LIMITER_SECRET: CURRENT, SIGN_IN_LIMITER_PREVIOUS_SECRET: PREVIOUS })));
    try {
      // The route is on, behind the secret.
      expect((await fetch(`http://127.0.0.1:${first!.port}/public/v1/sign-in/admit`, { method: "POST" })).status).toBe(401);
      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => admit(i % 2 ? second! : first!, "192.0.2.201", CURRENT)));
      const statuses = results.map((response) => response.status);
      expect(statuses.filter((status) => status === 204)).toHaveLength(4);
      expect(statuses.filter((status) => status === 429)).toHaveLength(8);
      expect(results.find((response) => response.status === 429)?.headers.get("cache-control")).toBe("no-store");
      // The previous secret works on both instances (the rotation window), a made-up one on neither.
      expect((await admit(first!, "192.0.2.202", PREVIOUS)).status).toBe(204);
      expect((await admit(second!, "192.0.2.203", PREVIOUS)).status).toBe(204);
      expect((await admit(second!, "192.0.2.204", "q".repeat(40))).status).toBe(401);
      // Neither secret reaches the log.
      expect(first!.output() + second!.output()).not.toMatch(new RegExp(`${CURRENT}|${PREVIOUS}`));
    } finally {
      await Promise.all([first!.stop(), second!.stop()]);
    }
  }, CHILD_TEST_MS);

  it("leaves the route off (404) until SIGN_IN_LIMITER_SECRET is set", async () => {
    const api = await startApi();
    try {
      expect((await admit(api, "192.0.2.205", CURRENT)).status).toBe(404);
    } finally {
      await api.stop();
    }
  }, CHILD_TEST_MS);
});
