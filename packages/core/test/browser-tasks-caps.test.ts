// Browser task caps under concurrency and at accept time (docs/requirements/browser-tasks.md BT-9, BT-12).
// Admission reserves one step's model cost and one step before a step starts; events and the final
// report re-check the caps; the daily cost counts recorded usage, not when a run was queued.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { BrowserClaim } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import {
  FAKE_MODEL_PRICES, browserConfig, createBrowserRunnerService, createBrowserSession, createMemoryArtifactStore,
  createStaticCredentialResolver, creditWallet, getWallet, startFixtureSite, type BrowserConfig, type EdgeDependencies, type FixtureSite,
} from "../src/index.js";

const HOUR = 3_600_000;
let now = Date.parse("2026-10-20T12:00:00.000Z");
const clock = { now: () => new Date(now) };
const PASSWORD = "p4ss-PLANTED-7731-zq";
const USERNAME = "buyer@clinic.example";
const STEP_PRICE = 10;
/** What one planner call of 120 input and 60 output tokens costs at the fake price. */
const CALL_COST = 87;
/** The model cost one admitted step reserves. */
const RESERVE = 100;
const USAGE = { lane: "personal_data" as const, model: "fake-follow-up", inputTokens: 120, outputTokens: 60 };

let database: TestDatabase;
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => service(async (tx) => (await tx.query(sql, params)).rows as T[]);
const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const config: BrowserConfig = browserConfig({
  stepPrice: STEP_PRICE, modelPrices: FAKE_MODEL_PRICES, allowLoopback: true, stepModelReserveMicros: RESERVE,
});

const sites: FixtureSite[] = [];
afterEach(async () => { await Promise.all(sites.splice(0).map((site) => site.close())); });
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

async function member(tenantId: string, role: "owner" | "staff") {
  const userId = randomUUID();
  await service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, clock.now()]));
  return userId;
}

/** A fresh tenant with the feature on, funds, a supplier site and an enabled target with sign-in details. */
async function world(options: { maxCostMicrosPerDay?: number } = {}) {
  const tenantId = randomUUID();
  await service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [tenantId, "Clinic"]));
  const owner = await member(tenantId, "owner");
  const staff = await member(tenantId, "staff");
  await service((tx) => creditWallet(tx, { tenantId, ledgerId: randomUUID(), amount: 100_000, idempotencyKey: `credit:${randomUUID()}`, now: clock.now() }));
  const site = await startFixtureSite({ username: USERNAME, password: PASSWORD, invoices: [] });
  sites.push(site);
  const store = createMemoryArtifactStore();
  const secretRef = `browser/${tenantId}/supplier`;
  const runner = createBrowserRunnerService({
    service, clock, generateId: randomUUID, newToken: () => `${randomUUID()}${randomUUID()}`, config,
    credentials: createStaticCredentialResolver({ [secretRef]: { username: USERNAME, password: PASSWORD } }), artifacts: store,
  });
  const sessionFor = (actor: string) => createBrowserSession(deps(), { tenantId, actorId: actor }, { config, artifacts: store });
  await sessionFor(owner).updateSettings({
    expectedRevision: 0, enabled: true, maxRunsPerDay: 50, maxCostMicrosPerDay: options.maxCostMicrosPerDay ?? 5_000_000,
  }, randomUUID());
  const target = await sessionFor(owner).saveTarget({
    expectedRevision: 0, name: "Supplier portal", taskKind: "supplier_invoice_download", allowedOrigins: [site.origin],
    allowedPaths: ["/invoices"], assetPaths: [], signInPath: "/login", enabled: true, secretRef,
    attestation: { termsAllowAutomatedAccess: true, notInsurerOrPayerPortal: true },
  }, randomUUID());
  const requestRun = (extra: Record<string, unknown> = {}) =>
    sessionFor(owner).requestRun({ targetId: target.result.id, month: "2026-09", ...extra }, randomUUID());
  const claim = async () => {
    const claimed = (await runner.claim()) as BrowserClaim;
    expect(claimed).not.toBeNull();
    return { runId: claimed.runId, token: claimed.leaseToken };
  };
  const run = (runId: string) => runner.getRun(tenantId, runId);
  const wallet = () => service((tx) => getWallet(tx, tenantId));
  return { tenantId, owner, staff, site, runner, sessionFor, requestRun, claim, run, wallet };
}

const step = (site: FixtureSite) => ({ action: "open" as const, url: `${site.origin}/invoices`, usage: USAGE });
const stops = (results: { stop: string | null }[]) => results.map((result) => result.stop).sort();

describe("finding 2: admission reserves before a step starts (BT-9)", () => {
  it("admits exactly one of two concurrent steps when one step of run cost budget remains", async () => {
    const w = await world();
    const requested = await w.requestRun({ maxCostMicros: RESERVE + 50 });
    const lease = await w.claim();
    const results = await Promise.all([w.runner.control(lease), w.runner.control(lease)]);
    expect(stops(results)).toEqual(["cost_cap", null]);
    // The admitted step still records its usage; the run never passes its cost cap.
    expect((await w.runner.appendEvent(lease, step(w.site))).stop).toBeNull();
    const run = (await w.run(requested.result.id))!;
    expect(run.costMicros).toBe(CALL_COST);
    expect(run.costMicros).toBeLessThanOrEqual(run.maxCostMicros);
    await w.runner.finish(lease, { outcome: "stopped", reason: "cost_cap" });
    expect(await w.wallet()).toMatchObject({ reserved: 0, balance: 100_000 - STEP_PRICE });
  });

  it("admits exactly one of two concurrent steps when one step remains, and the wallet hold is never exceeded", async () => {
    const w = await world();
    const requested = await w.requestRun({ maxSteps: 1 });
    const lease = await w.claim();
    expect(await w.wallet()).toMatchObject({ reserved: STEP_PRICE });
    const results = await Promise.all([w.runner.control(lease), w.runner.control(lease)]);
    expect(stops(results)).toEqual([null, "step_cap"]);
    // Two events arrive anyway: only the admitted one counts as a step.
    const recorded = [await w.runner.appendEvent(lease, step(w.site)), await w.runner.appendEvent(lease, step(w.site))];
    expect(recorded.map((entry) => entry.stop)).toEqual([null, "step_cap"]);
    const run = (await w.run(requested.result.id))!;
    expect(run).toMatchObject({ status: "stopped", stopReason: "step_cap", steps: 1 });
    expect(await w.wallet()).toMatchObject({ reserved: 0, balance: 100_000 - STEP_PRICE });
  });

  it("admits exactly one step across two runs when one step of the daily cost budget remains", async () => {
    const w = await world({ maxCostMicrosPerDay: RESERVE + 50 });
    await w.requestRun();
    await w.requestRun();
    const first = await w.claim();
    const second = await w.claim();
    const results = await Promise.all([w.runner.control(first), w.runner.control(second)]);
    expect(stops(results)).toEqual(["cost_cap", null]);
    for (const lease of [first, second]) await w.runner.finish(lease, { outcome: "stopped", reason: "cost_cap" });
    expect(await w.wallet()).toMatchObject({ reserved: 0 });
  });
});

describe("finding 6: the daily cost counts recorded usage (BT-9)", () => {
  it("counts usage recorded now by a run requested more than 24 hours ago", async () => {
    const w = await world({ maxCostMicrosPerDay: RESERVE + 50 });
    now -= 25 * HOUR;
    await w.requestRun();
    now += 25 * HOUR;
    const lease = await w.claim();
    expect((await w.runner.control(lease)).stop).toBeNull();
    await w.runner.appendEvent(lease, step(w.site));
    expect(await w.sessionFor(w.owner).getStatus()).toMatchObject({ costTodayMicros: CALL_COST });
    // 87 recorded plus one more step's reserve passes the daily cap of 150.
    expect((await w.runner.control(lease)).stop).toBe("cost_cap");
  });
});

describe("finding 7: caps hold when events and results arrive (BT-9, BT-12)", () => {
  it("closes step_cap on an event past max_steps and does not count it", async () => {
    const w = await world();
    const requested = await w.requestRun({ maxSteps: 1 });
    const lease = await w.claim();
    expect((await w.runner.control(lease)).stop).toBeNull();
    expect((await w.runner.appendEvent(lease, step(w.site))).stop).toBeNull();
    expect((await w.runner.appendEvent(lease, step(w.site))).stop).toBe("step_cap");
    expect(await w.run(requested.result.id)).toMatchObject({ status: "stopped", stopReason: "step_cap", steps: 1 });
    expect(await w.wallet()).toMatchObject({ reserved: 0, balance: 100_000 - STEP_PRICE });
  });

  it("closes deadline on an event that arrives past the deadline", async () => {
    const w = await world();
    const requested = await w.requestRun({ deadlineMs: 1000 });
    const lease = await w.claim();
    expect((await w.runner.control(lease)).stop).toBeNull();
    now += 2000;
    expect((await w.runner.appendEvent(lease, step(w.site))).stop).toBe("deadline");
    expect(await w.run(requested.result.id)).toMatchObject({ status: "stopped", stopReason: "deadline" });
    expect(await w.wallet()).toMatchObject({ reserved: 0 });
  });

  it("closes killed on an event that arrives after the tenant's kill switch", async () => {
    const w = await world();
    const requested = await w.requestRun();
    const lease = await w.claim();
    expect((await w.runner.control(lease)).stop).toBeNull();
    await w.sessionFor(w.staff).kill({ note: "wrong supplier" }, randomUUID());
    expect((await w.runner.appendEvent(lease, step(w.site))).stop).toBe("killed");
    expect(await w.run(requested.result.id)).toMatchObject({ status: "stopped", stopReason: "killed" });
    expect(await w.wallet()).toMatchObject({ reserved: 0 });
  });

  it("closes a read_done result past the deadline as stopped deadline, not completed", async () => {
    const w = await world();
    const requested = await w.requestRun({ deadlineMs: 1000 });
    const lease = await w.claim();
    expect((await w.runner.control(lease)).stop).toBeNull();
    expect((await w.runner.appendEvent(lease, step(w.site))).stop).toBeNull();
    now += 2000;
    expect(await w.runner.finish(lease, { outcome: "read_done" })).toMatchObject({ status: "stopped", stopReason: "deadline" });
    expect(await w.run(requested.result.id)).toMatchObject({ status: "stopped", stopReason: "deadline", steps: 1 });
    expect(await w.wallet()).toMatchObject({ reserved: 0, balance: 100_000 - STEP_PRICE });
  });

  it("still completes a read_done result inside the caps", async () => {
    const w = await world();
    await w.requestRun();
    const claimed = await w.claim();
    expect((await w.runner.control(claimed)).stop).toBeNull();
    await w.runner.appendEvent(claimed, step(w.site));
    expect(await w.runner.finish(claimed, { outcome: "read_done" })).toMatchObject({ status: "completed", steps: 1 });
  });
});

// Rows the reviewer cares about stay consistent: no reservation outlives a closed run.
describe("reservations are cleared on close", () => {
  it("leaves no in-flight step or reserved cost on a closed run", async () => {
    const w = await world();
    const requested = await w.requestRun();
    const lease = await w.claim();
    await w.runner.control(lease);
    await w.runner.finish(lease, { outcome: "stopped", reason: "runner_error" });
    const [row] = await rows<{ steps_inflight: number; reserved_cost_micros: string }>(
      "SELECT steps_inflight, reserved_cost_micros::text FROM browser_runs WHERE tenant_id=$1 AND id=$2", [w.tenantId, requested.result.id]);
    expect(row).toEqual({ steps_inflight: 0, reserved_cost_micros: "0" });
  });
});
