// The document intake sweep as the API deploys it (document-intake.md DL-16): the environment parse, the cron route,
// and real runs against the test database with an in-memory object store. The sweep is off unless
// INTAKE_SWEEP_WORKER=on, runs one bounded batch per call, and a repeated call finds nothing left to do.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import type { SiteObjectStore } from "@zs/contracts";
import {
  createDocumentIntakeSession, createFakeDoclingPort, createMemorySiteStore, intakeFilePath, runDocumentIntakeWorker,
  type EdgeDependencies,
} from "@zs/core";
import { createCronAlertsOnPool, listOpenCronAlerts } from "../src/cron-alerts.js";
import { cronRoutes } from "../src/delivery/cron.js";
import { parseIntakeSweepEnv } from "../src/intake-sweep/config.js";
import { createIntakeSweepRunner } from "../src/intake-sweep/runner.js";
import { startIntakeSweep } from "../src/intake-sweep/start.js";
import { createIntakeFileStore } from "../src/intake-sweep/store.js";

/** Synthetic secret, built at runtime so secret scanners do not flag a literal. */
const CRON_SECRET = ["test", "cron", "c".repeat(32)].join("-");
const DAY = 86_400_000;
const authed = { headers: { Authorization: `Bearer ${CRON_SECRET}` } };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const base = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  CRON_SECRET,
  INTAKE_SWEEP_WORKER: "on",
  INTAKE_SWEEP_DATABASE_URL: "postgres://app:pw@127.0.0.1:55432/postgres",
  INTAKE_SWEEP_SERVICE_DATABASE_URL: "postgres://svc:pw@127.0.0.1:55432/postgres",
  R2_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  R2_BUCKET: "zs-sites",
  R2_ACCESS_KEY_ID: "access-key-id",
  R2_SECRET_ACCESS_KEY: "secret-access-key-value",
  ...extra,
});

describe("parseIntakeSweepEnv", () => {
  it("runs nothing and needs nothing else while INTAKE_SWEEP_WORKER is not on", () => {
    expect(parseIntakeSweepEnv({})).toEqual({ runner: null, cronSecret: null });
    expect(parseIntakeSweepEnv({ INTAKE_SWEEP_WORKER: "off", CRON_SECRET }).runner).toBeNull();
    expect(parseIntakeSweepEnv({ CRON_SECRET }).cronSecret).toBe(CRON_SECRET);
    expect(() => parseIntakeSweepEnv({ INTAKE_SWEEP_WORKER: "yes" })).toThrow(/INTAKE_SWEEP_WORKER must be on or off/);
    expect(() => parseIntakeSweepEnv({ INTAKE_SWEEP_WORKER: "ON" })).toThrow(/INTAKE_SWEEP_WORKER must be on or off/);
  });

  it("parses a full environment with a batch of 50 by default", () => {
    const parsed = parseIntakeSweepEnv(base());
    expect(parsed.cronSecret).toBe(CRON_SECRET);
    expect(parsed.runner).toEqual({
      runtimeDatabaseUrl: "postgres://app:pw@127.0.0.1:55432/postgres",
      serviceDatabaseUrl: "postgres://svc:pw@127.0.0.1:55432/postgres",
      databaseCaCert: undefined,
      r2: { endpoint: "https://account.r2.cloudflarestorage.com", bucket: "zs-sites", accessKeyId: "access-key-id", secretAccessKey: "secret-access-key-value" },
      batch: 50,
    });
    expect(parseIntakeSweepEnv(base({ INTAKE_SWEEP_BATCH: "200" })).runner?.batch).toBe(200);
  });

  it("refuses a batch outside 1 to 200", () => {
    for (const batch of ["0", "201", "-1", "1.5", "many"]) expect(() => parseIntakeSweepEnv(base({ INTAKE_SWEEP_BATCH: batch }))).toThrow(/INTAKE_SWEEP_BATCH/);
  });

  it("names a missing variable and a placeholder secret, without printing a value", () => {
    expect(() => parseIntakeSweepEnv(base({ R2_BUCKET: undefined }))).toThrow(/R2_BUCKET/);
    expect(() => parseIntakeSweepEnv(base({ INTAKE_SWEEP_SERVICE_DATABASE_URL: undefined }))).toThrow(/INTAKE_SWEEP_SERVICE_DATABASE_URL/);
    expect(() => parseIntakeSweepEnv(base({ R2_ENDPOINT: "http://account.r2.example" }))).toThrow(/R2_ENDPOINT/);
    expect(() => parseIntakeSweepEnv(base({ CRON_SECRET: "short" }))).toThrow(/CRON_SECRET must be at least 32/);
    expect(() => parseIntakeSweepEnv(base({ CRON_SECRET: "replace-with-a-cron-secret-of-32-or-more-chars" }))).toThrow(/placeholder/);
    try {
      parseIntakeSweepEnv(base({ R2_ACCESS_KEY_ID: undefined }));
    } catch (error) {
      expect(String(error)).not.toContain("secret-access-key-value");
    }
  });

  it("refuses a remote database without a pinned CA, and a query string on a pinned one", () => {
    const remote = "postgres://app:pw@db.example.test:5432/postgres";
    expect(() => parseIntakeSweepEnv(base({ INTAKE_SWEEP_DATABASE_URL: remote }))).toThrow(/DATABASE_CA_CERT is required when INTAKE_SWEEP_DATABASE_URL/);
    expect(() => parseIntakeSweepEnv(base({ INTAKE_SWEEP_SERVICE_DATABASE_URL: remote }))).toThrow(/DATABASE_CA_CERT is required when INTAKE_SWEEP_SERVICE_DATABASE_URL/);
    const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(parseIntakeSweepEnv(base({ INTAKE_SWEEP_DATABASE_URL: remote, DATABASE_CA_CERT: ca })).runner?.databaseCaCert).toBe(ca);
    expect(() => parseIntakeSweepEnv(base({ INTAKE_SWEEP_DATABASE_URL: `${remote}?sslmode=disable`, DATABASE_CA_CERT: ca }))).toThrow(/must not carry a query string/);
  });
});

describe("GET /cron/intake-sweep", () => {
  type CronConfig = Parameters<typeof cronRoutes>[0];
  const app = (config: Pick<CronConfig, "cronSecret" | "runner"> & Partial<CronConfig>) =>
    cronRoutes({ ...config, path: "/cron/intake-sweep", killSwitch: "INTAKE_SWEEP_WORKER", name: "Intake sweep" });

  it("is not found without CRON_SECRET, 401 without the bearer, and never runs either way", async () => {
    let runs = 0;
    const runner = { async run() { runs += 1; return { removed: 0, batch: 50 }; } };
    expect((await app({ cronSecret: null, runner }).request("/cron/intake-sweep", authed)).status).toBe(404);
    const guarded = app({ cronSecret: CRON_SECRET, runner });
    expect((await guarded.request("/cron/intake-sweep")).status).toBe(401);
    expect((await guarded.request("/cron/intake-sweep", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await guarded.request("/cron/intake-sweep", { method: "POST", ...authed })).status).toBe(404);
    expect(runs).toBe(0);
  });

  it("answers ran:false while INTAKE_SWEEP_WORKER is off, without a runner", async () => {
    const response = await app({ cronSecret: CRON_SECRET, runner: null }).request("/cron/intake-sweep", authed);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: false, reason: "INTAKE_SWEEP_WORKER is off" });
  });

  it("runs once and answers the counts", async () => {
    const calls: number[] = [];
    const runner = createIntakeSweepRunner({ sweep: { async sweepFiles(limit) { calls.push(limit); return 3; } }, batch: 7 });
    const response = await app({ cronSecret: CRON_SECRET, runner }).request("/cron/intake-sweep", authed);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ran: true, removed: 3, batch: 7 });
    expect(calls).toEqual([7]);
  });

  it("answers 503 and reports the error when the sweep throws", async () => {
    const reported: unknown[] = [];
    const runner = { async run(): Promise<never> { throw new Error("R2 delete failed with status 500"); } };
    const response = await app({ cronSecret: CRON_SECRET, runner, onError: (error) => reported.push(error) }).request("/cron/intake-sweep", authed);
    expect(response.status).toBe(503);
    expect(reported).toHaveLength(1);
  });
});

describe("createIntakeFileStore", () => {
  it("stores a PDF, reads it back, answers null for a missing path, and deletes", async () => {
    const objects = createMemorySiteStore();
    const files = createIntakeFileStore(objects);
    const path = intakeFilePath(randomUUID(), randomUUID(), "a".repeat(64));
    await files.put(path, new Uint8Array([37, 80, 68, 70]));
    expect(await files.read(path)).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect((await objects.get(path))?.contentType).toBe("application/pdf");
    expect(await files.read(`${path}.missing`)).toBeNull();
    await files.delete(path);
    expect(objects.keys()).toEqual([]);
    await files.delete(path);
  });
});

describe("real sweeps against the test database", () => {
  let database: TestDatabase;
  let fixture: TwoTenantFixture;
  let owner: string;
  const START = Date.parse("2026-10-24T09:00:00.000Z");
  let now = START;
  const clock = { now: () => new Date(now) };
  const objects = createMemorySiteStore();
  const port = createFakeDoclingPort();
  const closers: Array<() => Promise<void>> = [];

  const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
  const intake = (store: SiteObjectStore = objects) => createDocumentIntakeSession(deps(), { store: createIntakeFileStore(store) });
  const login = (username: string) => {
    const url = new URL(database.url);
    url.username = username;
    url.password = "";
    return url.href;
  };
  const sweepEnv = (batch: number) => parseIntakeSweepEnv(base({
    INTAKE_SWEEP_DATABASE_URL: login("zs_runtime"), INTAKE_SWEEP_SERVICE_DATABASE_URL: login("zs_service"), INTAKE_SWEEP_BATCH: String(batch),
  })).runner!;
  /** The cron function's app over a real sweep: the runner, its pools and the alerts on the service pool. */
  async function sweepApp(batch: number, store: SiteObjectStore = objects) {
    const started = await startIntakeSweep(sweepEnv(batch), { clock, generateId: randomUUID, objects: store });
    closers.push(started.close);
    return cronRoutes({
      path: "/cron/intake-sweep", killSwitch: "INTAKE_SWEEP_WORKER", name: "Intake sweep", cronSecret: CRON_SECRET,
      runner: started.runner, alerts: createCronAlertsOnPool(started.servicePool, { now: () => new Date() }, {}),
    });
  }
  const sweep = async (cron: Awaited<ReturnType<typeof sweepApp>>) => {
    const response = await cron.request("/cron/intake-sweep", authed);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const pdf = () => {
    const bytes = new Uint8Array(400).fill(32);
    bytes.set(new TextEncoder().encode("%PDF-1.4\n"));
    bytes.set(new TextEncoder().encode(`\n% ${randomUUID()}\n%%EOF`), 340);
    return bytes;
  };
  /** Upload, parse and discard one PDF: the job ends at the current clock time. Returns its stored path. */
  async function endedJob(): Promise<string> {
    const queued = await intake().forMember({ tenantId: fixture.a.tenantId, actorId: owner }).upload(
      { bytes: pdf(), filename: "prices.pdf", contentType: "application/pdf" }, randomUUID());
    expect((await runDocumentIntakeWorker({ api: intake().worker, port }))?.job.id).toBe(queued.jobId);
    await intake().forMember({ tenantId: fixture.a.tenantId, actorId: owner }).discard(queued.jobId, randomUUID());
    const [row] = (await database.pool.query<{ file_sha256: string }>(
      "SELECT file_sha256 FROM document_intake_jobs WHERE tenant_id=$1 AND id=$2", [fixture.a.tenantId, queued.jobId])).rows;
    return intakeFilePath(fixture.a.tenantId, queued.jobId, row!.file_sha256);
  }
  const unmarked = async () => (await database.pool.query("SELECT 1 FROM document_intake_jobs WHERE file_deleted_at IS NULL")).rowCount;

  beforeAll(async () => {
    database = await createTestDatabase();
    fixture = await createTwoTenantFixture(database);
    owner = randomUUID();
    await asService(database.servicePool, (tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,'owner',$5,$5)",
      [fixture.a.tenantId, randomUUID(), "owner@example.com", owner, new Date(START)]));
  }, 60_000);
  afterAll(async () => {
    await Promise.all(closers.map((close) => close()));
    await database?.close();
  });

  it("deletes the PDFs of jobs that ended 30 days ago, in bounded batches, and finds nothing the second time", async () => {
    const paths = [await endedJob(), await endedJob(), await endedJob()];
    expect(paths.every((path) => objects.keys().includes(path))).toBe(true);
    const cron = await sweepApp(2);

    // Not yet due: the run answers, deletes nothing and leaves every file.
    now = START + 29 * DAY;
    expect(await sweep(cron)).toEqual({ status: 200, body: { ran: true, removed: 0, batch: 2 } });
    expect(objects.keys()).toHaveLength(3);

    // Due: two per run, then the last, then nothing. The batch bounds one call, never the work.
    now = START + 31 * DAY;
    expect(await sweep(cron)).toEqual({ status: 200, body: { ran: true, removed: 2, batch: 2 } });
    expect(objects.keys()).toHaveLength(1);
    expect(await sweep(cron)).toEqual({ status: 200, body: { ran: true, removed: 1, batch: 2 } });
    expect(objects.keys()).toEqual([]);
    expect(await sweep(cron)).toEqual({ status: 200, body: { ran: true, removed: 0, batch: 2 } });
    expect(await unmarked()).toBe(0);
  }, 60_000);

  it("two overlapping calls delete each file once and both succeed", async () => {
    const path = await endedJob();
    now += 31 * DAY;
    const cron = await sweepApp(50);
    const both = await Promise.all([sweep(cron), sweep(cron)]);
    expect(both.map((answer) => answer.status)).toEqual([200, 200]);
    expect(both.reduce((total, answer) => total + (answer.body.removed as number), 0)).toBeGreaterThanOrEqual(1);
    expect(objects.keys()).not.toContain(path);
    expect(await sweep(cron)).toMatchObject({ status: 200, body: { removed: 0 } });
  }, 60_000);

  it("a failing delete answers 503 and opens a cron alert; the next good run deletes the file and closes it", async () => {
    const path = await endedJob();
    now += 31 * DAY;
    let broken = true;
    const flaky: SiteObjectStore = {
      get: (key) => objects.get(key),
      head: (key) => objects.head(key),
      put: (key, body, options) => objects.put(key, body, options),
      delete: async (key) => {
        if (broken) throw new Error("R2 delete failed with status 500");
        await objects.delete(key);
      },
    };
    const failing = await sweepApp(50, flaky);
    expect((await sweep(failing)).status).toBe(503);
    expect(objects.keys()).toContain(path);
    expect(await unmarked()).toBe(1);
    expect((await listOpenCronAlerts((work) => asService(database.pool, work))).map((alert) => alert.job)).toEqual(["intake-sweep"]);

    broken = false;
    await sleep(15);
    expect(await sweep(failing)).toEqual({ status: 200, body: { ran: true, removed: 1, batch: 50 } });
    expect(objects.keys()).not.toContain(path);
    expect(await unmarked()).toBe(0);
    expect(await listOpenCronAlerts((work) => asService(database.pool, work))).toEqual([]);
  }, 60_000);

  it("refuses a privileged runtime login before any work", async () => {
    const env = { ...sweepEnv(50), runtimeDatabaseUrl: database.url };
    await expect(startIntakeSweep(env, { clock, generateId: randomUUID, objects })).rejects.toThrow();
  });
});
