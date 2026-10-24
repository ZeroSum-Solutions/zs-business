// Read-only browser tasks (docs/requirements/browser-tasks.md BT-1..BT-13) under the runtime role.
// The browser is the fake runner against a real loopback supplier site; models are fakes. Nothing
// reaches a vendor or a real site.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ActionError, Conflict, NotFound, TenantDenied, ValidationFailed, type BrowserClaim } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import {
  ACTION_PERMISSIONS, FAKE_MODEL_PRICES, browserConfig, createBrowserRunnerService, createBrowserSession, createFakeBrowserRunner,
  createFakeTextModel, createMemoryArtifactStore, createStaticCredentialResolver, creditWallet, fixturePdf, getWallet,
  invoicePlannerAnswer, runBrowserJob, startFixtureSite, type BrowserConfig, type EdgeDependencies, type FixtureSite,
  type MemoryArtifactStore, type TextModelRequest,
} from "../src/index.js";

const HOUR = 3_600_000;
let now = Date.parse("2026-10-20T12:00:00.000Z");
const clock = { now: () => new Date(now) };
const PASSWORD = "p4ss-PLANTED-7731-zq";
const USERNAME = "buyer@clinic.example";
const STEP_PRICE = 10;
/** What one fake planner call costs: 120 input and 60 output tokens at the fake price. */
const CALL_COST = 87;

let database: TestDatabase;
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => service(async (tx) => (await tx.query(sql, params)).rows as T[]);
const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
/** The model cost one admitted step reserves (at least one planner call). */
const STEP_RESERVE = 100;
const config: BrowserConfig = browserConfig({ stepPrice: STEP_PRICE, modelPrices: FAKE_MODEL_PRICES, allowLoopback: true, stepModelReserveMicros: STEP_RESERVE });

async function rejection(promise: Promise<unknown>): Promise<ActionError> {
  try { await promise; } catch (error) { if (error instanceof ActionError) return error; throw error; }
  throw new Error("Expected a rejection");
}

interface World {
  tenantId: string;
  owner: string;
  staff: string;
  targetId: string;
  site: FixtureSite;
  store: MemoryArtifactStore;
  sessionFor(actor: string, cfg?: BrowserConfig): ReturnType<typeof createBrowserSession>;
  runner: ReturnType<typeof createBrowserRunnerService>;
  secrets: Record<string, { username: string; password: string }>;
}
const sites: FixtureSite[] = [];
afterEach(async () => { await Promise.all(sites.splice(0).map((site) => site.close())); vi.restoreAllMocks(); });
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

async function member(tenantId: string, role: "owner" | "staff") {
  const userId = randomUUID();
  await service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, randomUUID(), `${role}-${userId.slice(0, 8)}@example.com`, userId, role, clock.now()]));
  return userId;
}

/** A fresh tenant with the feature on, funds, a supplier site and an enabled target. */
async function world(options: { credit?: number; extraHtml?: string; credentials?: boolean; maxRunsPerDay?: number } = {}): Promise<World> {
  const tenantId = randomUUID();
  await service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [tenantId, "Clinic"]));
  const owner = await member(tenantId, "owner");
  const staff = await member(tenantId, "staff");
  await service((tx) => creditWallet(tx, { tenantId, ledgerId: randomUUID(), amount: options.credit ?? 100_000, idempotencyKey: `credit:${randomUUID()}`, now: clock.now() }));
  const site = await startFixtureSite({
    username: USERNAME, password: PASSWORD,
    invoices: [{ name: "2026-09-001.pdf", bytes: fixturePdf("one") }, { name: "2026-09-002.pdf", bytes: fixturePdf("two") }],
    ...(options.extraHtml ? { listExtraHtml: options.extraHtml } : {}),
  });
  sites.push(site);
  const store = createMemoryArtifactStore();
  const secretRef = `browser/${tenantId}/supplier`;
  const secrets = options.credentials === false ? {} : { [secretRef]: { username: USERNAME, password: PASSWORD } };
  const runner = createBrowserRunnerService({
    service, clock, generateId: randomUUID, newToken: () => `${randomUUID()}${randomUUID()}`, config,
    credentials: createStaticCredentialResolver(secrets), artifacts: store,
  });
  const sessionFor = (actor: string, cfg: BrowserConfig = config) => createBrowserSession(deps(), { tenantId, actorId: actor }, { config: cfg, artifacts: store });
  const ownerSession = sessionFor(owner);
  await ownerSession.updateSettings({ expectedRevision: 0, enabled: true, maxRunsPerDay: options.maxRunsPerDay ?? 50, maxCostMicrosPerDay: 5_000_000 }, randomUUID());
  const target = await ownerSession.saveTarget({
    expectedRevision: 0, name: "Supplier portal", taskKind: "supplier_invoice_download", allowedOrigins: [site.origin],
    allowedPaths: ["/invoices"], assetPaths: [], signInPath: "/login", enabled: true,
    ...(options.credentials === false ? {} : { secretRef }),
    attestation: { termsAllowAutomatedAccess: true, notInsurerOrPayerPortal: true },
  }, randomUUID());
  return { tenantId, owner, staff, targetId: target.result.id, site, store, sessionFor, runner, secrets };
}

const requestRun = (w: World, extra: Record<string, unknown> = {}) =>
  w.sessionFor(w.owner).requestRun({ targetId: w.targetId, month: "2026-09", ...extra }, randomUUID());
const wallet = (w: World) => service((tx) => getWallet(tx, w.tenantId));
const events = (w: World, runId: string) =>
  rows<{ seq: number; action: string; origin: string | null; path: string | null; model: string | null }>(
    "SELECT seq, action, origin, path, model FROM browser_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY seq", [w.tenantId, runId]);

type Answer = (request: TextModelRequest) => unknown;
function runnerFor(answer: Answer = invoicePlannerAnswer) {
  return createFakeBrowserRunner({ model: createFakeTextModel("personal_data", answer) });
}
/** The standard planner until the date filter is set, then `trap` once, then the standard planner again. */
function trapPlanner(trap: (page: { forms: unknown[]; elements: unknown[] }) => unknown): Answer {
  let sprung = false;
  return (request) => {
    const input = request.input as { page: { forms: unknown[]; elements: unknown[] } | null; history: { action: string }[] };
    if (!sprung && input.page && input.history.some((step) => step.action === "set_date_filter")) { sprung = true; return trap(input.page); }
    return invoicePlannerAnswer(request);
  };
}

describe("acceptance: download last month's invoices (BT-13)", () => {
  it("signs in, downloads both invoices into artifacts, and holds, captures and releases the wallet", async () => {
    const w = await world();
    const requested = await requestRun(w);
    expect(requested.result).toMatchObject({ status: "queued", month: "2026-09", artifactCount: 0 });
    const before = await wallet(w);

    const runner = runnerFor();
    const done = await runBrowserJob({ service: w.runner, runner, browserRoot: "/var/zs-browser" });
    expect(done?.run).toMatchObject({ status: "completed", stopReason: null, steps: 5, attempt: 1 });

    const detail = await w.sessionFor(w.owner).getRun(requested.result.id);
    expect(detail.artifacts.map((a) => a.name)).toEqual(["2026-09-001.pdf", "2026-09-002.pdf"]);
    expect(detail.artifacts.every((a) => a.kind === "invoice_pdf")).toBe(true);
    expect(w.store.keys().every((key) => key.startsWith(`tenants/${w.tenantId}/browser-runs/${requested.result.id}/`))).toBe(true);
    const file = await w.sessionFor(w.owner).getArtifact(requested.result.id, detail.artifacts[0]!.id);
    expect(new TextDecoder().decode(file.bytes.slice(0, 5))).toBe("%PDF-");
    // The files are not handed to intake: no intake item or source row came from this run (BT-13).
    expect(await rows("SELECT 1 FROM intake_items WHERE tenant_id=$1", [w.tenantId])).toEqual([]);

    // BT-9: five steps at the step price are captured; the rest of the hold is released.
    const after = await wallet(w);
    expect(before.reserved).toBe(0);
    expect(after).toMatchObject({ reserved: 0, balance: 100_000 - 5 * STEP_PRICE });
    expect(await events(w, requested.result.id)).toHaveLength(6);
    expect(detail.run.costMicros).toBe(6 * CALL_COST);
    expect(runner.profiles).toHaveLength(1);
  });

  it("reads the status, lists runs and refuses a second run past the daily cap", async () => {
    const w = await world({ maxRunsPerDay: 1 });
    const owner = w.sessionFor(w.owner);
    await requestRun(w);
    expect(await rejection(requestRun(w))).toBeInstanceOf(Conflict);
    expect((await owner.getStatus())).toMatchObject({ blockedBy: "daily_cap", runsToday: 1 });
    expect((await owner.listRuns()).items).toHaveLength(1);
    await runBrowserJob({ service: w.runner, runner: runnerFor(), browserRoot: "/var/zs-browser" });
  });
});

describe("tenant isolation and the profile (BT-6, BT-8)", () => {
  it("keeps tenant B out of A's runs, events, files and profile; a foreign tenant in a payload changes nothing", async () => {
    const a = await world();
    const b = await world();
    const requested = await requestRun(a);
    const runner = runnerFor();
    await runBrowserJob({ service: a.runner, runner, browserRoot: "/var/zs-browser" });
    const artifactId = (await a.sessionFor(a.owner).getRun(requested.result.id)).artifacts[0]!.id;

    const bOwner = b.sessionFor(b.owner);
    await expect(bOwner.getRun(requested.result.id)).rejects.toBeInstanceOf(NotFound);
    await expect(bOwner.getArtifact(requested.result.id, artifactId)).rejects.toBeInstanceOf(NotFound);
    expect((await bOwner.listRuns()).items).toEqual([]);
    for (const table of ["browser_runs", "browser_run_events", "browser_run_artifacts", "browser_targets", "browser_credentials"]) {
      const seen = await database.db.tenant(b.tenantId, async (tx) => (await tx.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1`, [a.tenantId])).rowCount);
      expect(seen, table).toBe(0);
    }
    // A payload that names another tenant is refused outright, and B cannot reach A's target.
    expect((await rejection(bOwner.requestRun({ targetId: a.targetId, month: "2026-09", tenantId: a.tenantId }, randomUUID()))).name).toBe("ValidationFailed");
    await expect(bOwner.requestRun({ targetId: a.targetId, month: "2026-09" }, randomUUID())).rejects.toBeInstanceOf(NotFound);
    // The profile is built from the claim's own tenant and target.
    expect(runner.profiles[0]).toBe(`/var/zs-browser/${a.tenantId}/${a.targetId}/profile`);
    expect(runner.profiles[0]).not.toContain(b.tenantId);
  });

  it("refuses another tenant's secret reference and an http origin outside the fixture config", async () => {
    const w = await world();
    const owner = w.sessionFor(w.owner);
    const base = {
      expectedRevision: 0, name: "Other", taskKind: "supplier_invoice_download" as const, allowedOrigins: ["https://portal.example"],
      allowedPaths: ["/invoices"], assetPaths: [], signInPath: "/login", enabled: false,
    };
    await expect(owner.saveTarget({ ...base, secretRef: `browser/${randomUUID()}/supplier` }, randomUUID())).rejects.toBeInstanceOf(ValidationFailed);
    const strict = browserConfig({ stepPrice: STEP_PRICE, modelPrices: FAKE_MODEL_PRICES, stepModelReserveMicros: STEP_RESERVE });
    await expect(w.sessionFor(w.owner, strict).saveTarget({ ...base, allowedOrigins: [w.site.origin] }, randomUUID())).rejects.toBeInstanceOf(ValidationFailed);
    // Enabling a target without the attestation is refused by the schema.
    expect((await rejection(owner.saveTarget({ ...base, enabled: true }, randomUUID()))).name).toBe("ValidationFailed");
  });
});

describe("the request policy decides, the model proposes (BT-5)", () => {
  it("stops at a link to another origin with origin_denied and loads nothing from it", async () => {
    const w = await world({ extraHtml: `<a href="{{outside}}/invoices/2026-09-001.pdf">Mirror</a>` });
    const requested = await requestRun(w);
    const runner = runnerFor(trapPlanner((page) => {
      const link = (page.elements as { text: string; href: string }[]).find((entry) => entry.text === "Mirror")!;
      return { action: "click_link", href: link.href };
    }));
    const done = await runBrowserJob({ service: w.runner, runner, browserRoot: "/var/zs-browser" });
    expect(done?.run).toMatchObject({ status: "stopped", stopReason: "origin_denied" });
    expect(w.site.outsideHits()).toBe(0);
    expect(runner.sent.some((request) => request.url.startsWith(w.site.outsideOrigin))).toBe(false);
    const last = (await events(w, requested.result.id)).at(-1)!;
    expect(last).toMatchObject({ action: "stop", origin: w.site.outsideOrigin });
  });

  const cases: [string, string, (page: { forms: unknown[]; elements: unknown[] }) => unknown][] = [
    ["a second form", `<form method="post" action="/invoices/archive"><input name="x"></form>`, () => ({ action: "submit_form", index: 1 })],
    ["a GET to a delete endpoint", `<a href="/delete?id=42">Remove</a>`, () => ({ action: "click_link", href: "/delete?id=42" })],
    ["a page script that POSTs", `<button data-requests="POST /invoices/archive">Archive</button>`, () => ({ action: "click_button", index: 1 })],
    ["a link handler that fetches the delete endpoint", `<a href="/invoices/2026-09-001.pdf?via=handler" data-requests="GET /delete?id=42">Open</a>`,
      () => ({ action: "click_link", href: "/invoices/2026-09-001.pdf?via=handler" })],
  ];
  for (const [name, html, trap] of cases) {
    it(`ends write_refused on ${name}, and the delete endpoint receives nothing`, async () => {
      const w = await world({ extraHtml: html });
      await requestRun(w);
      const done = await runBrowserJob({ service: w.runner, runner: runnerFor(trapPlanner(trap)), browserRoot: "/var/zs-browser" });
      expect(done?.run).toMatchObject({ status: "stopped", stopReason: "write_refused" });
      expect(w.site.deleteHits()).toBe(0);
      expect(w.site.requests.filter((request) => request.method !== "GET").map((request) => request.path)).toEqual(["/login"]);
      expect(w.site.requests.some((request) => request.path.startsWith("/delete"))).toBe(false);
    });
  }

  it("refuses write tasks: execute throws and there is no submit action", async () => {
    const runner = runnerFor();
    const error = await runner.execute({ runId: randomUUID(), approvalId: randomUUID() }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Conflict);
    expect((error as Conflict).details).toMatchObject({ reason: "write_tasks_disabled" });
    expect(ACTION_PERMISSIONS["browser.submit"]).toBeUndefined();
  });

  it("hands the run back when the planner cannot read the page", async () => {
    const w = await world({ credit: 100_000 });
    await requestRun(w);
    const done = await runBrowserJob({
      service: w.runner, browserRoot: "/var/zs-browser",
      runner: runnerFor((request) => ((request.input as { page: unknown }).page ? { action: "stop", reason: "needs_vision" } : invoicePlannerAnswer(request))),
    });
    expect(done?.run).toMatchObject({ status: "stopped", stopReason: "needs_vision", steps: 1 });
  });
});

describe("secrets and the audit trail (BT-8, BT-9, BT-10)", () => {
  it("never carries the planted password into a prompt, event, row, file name or log", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    const w = await world();
    const requested = await requestRun(w);
    const runner = runnerFor();
    const done = await runBrowserJob({ service: w.runner, runner, browserRoot: "/var/zs-browser" });
    expect(done?.run.status).toBe("completed");
    // The sign-in did use the password: the supplier accepted it, so the run got past the login page.
    expect(w.site.requests.some((request) => request.path === "/invoices/2026-09-001.pdf")).toBe(true);
    const everything = JSON.stringify({
      prompts: runner.modelRequests,
      detail: await w.sessionFor(w.owner).getRun(requested.result.id),
      status: await w.sessionFor(w.owner).getStatus(),
      runs: await rows("SELECT * FROM browser_runs WHERE tenant_id=$1", [w.tenantId]),
      events: await rows("SELECT * FROM browser_run_events WHERE tenant_id=$1", [w.tenantId]),
      artifacts: await rows("SELECT * FROM browser_run_artifacts WHERE tenant_id=$1", [w.tenantId]),
      targets: await rows("SELECT * FROM browser_targets WHERE tenant_id=$1", [w.tenantId]),
      credentials: await rows("SELECT * FROM browser_credentials WHERE tenant_id=$1", [w.tenantId]),
      outbox: await rows("SELECT * FROM outbox WHERE tenant_id=$1", [w.tenantId]),
      keys: w.store.keys(), logs,
    });
    expect(everything).not.toContain(PASSWORD);
    // Events keep an origin and a path, never a query string (BT-9).
    const stored = await events(w, requested.result.id);
    expect(stored.every((event) => !(event.path ?? "").includes("?"))).toBe(true);
    expect(stored.some((event) => event.action === "set_date_filter")).toBe(true);
  });

  it("refuses model usage from any lane but the personal-data lane", async () => {
    const w = await world();
    await requestRun(w);
    const claim = (await w.runner.claim())!;
    const lease = { runId: claim.runId, token: claim.leaseToken };
    await expect(w.runner.appendEvent(lease, {
      action: "open", url: `${w.site.origin}/login`, usage: { lane: "no_personal_data", model: "fake-follow-up", inputTokens: 1, outputTokens: 1 },
    })).rejects.toBeInstanceOf(ValidationFailed);
    await expect(w.runner.appendEvent(lease, {
      action: "open", url: `${w.site.origin}/login`, usage: { lane: "personal_data", model: "unpriced-model", inputTokens: 1, outputTokens: 1 },
    })).rejects.toBeInstanceOf(ValidationFailed);
    const crashed = createFakeBrowserRunner({ model: { ...createFakeTextModel("personal_data"), lane: "no_personal_data" } as never });
    await w.runner.finish(lease, { outcome: "stopped", reason: "runner_error" });
    await requestRun(w);
    const done = await runBrowserJob({ service: w.runner, runner: crashed, browserRoot: "/var/zs-browser" });
    expect(done?.run).toMatchObject({ status: "stopped", stopReason: "runner_error", steps: 0 });
  });
});

describe("stop switches and caps (BT-9, BT-12)", () => {
  it("stops a kill between steps: no request is sent after the next step is due", async () => {
    const w = await world();
    const requested = await requestRun(w);
    let calls = 0;
    const answer: Answer = async (request) => {
      calls += 1;
      if (calls === 3) await w.sessionFor(w.staff).kill({ note: "wrong supplier" }, randomUUID());
      return invoicePlannerAnswer(request);
    };
    const done = await runBrowserJob({ service: w.runner, runner: runnerFor(answer), browserRoot: "/var/zs-browser" });
    expect(done?.run).toMatchObject({ status: "stopped", stopReason: "killed", steps: 3 });
    expect(w.site.requests.some((request) => request.path.endsWith(".pdf"))).toBe(false);
    expect(await wallet(w)).toMatchObject({ reserved: 0, balance: 100_000 - 3 * STEP_PRICE });
    expect((await events(w, requested.result.id)).filter((event) => event.action !== "stop")).toHaveLength(3);
    // Staff may stop the tasks but only an owner may turn them back on.
    expect((await w.sessionFor(w.owner).getStatus()).killed).not.toBeNull();
    await expect(w.sessionFor(w.staff).resume({}, randomUUID())).rejects.toBeInstanceOf(ActionError);
    await expect(requestRun(w)).rejects.toBeInstanceOf(Conflict);
    await w.sessionFor(w.owner).resume({}, randomUUID());
    expect((await w.sessionFor(w.owner).getStatus()).killed).toBeNull();
  });

  it("stops at the step cap, the deadline and the run cost cap", async () => {
    const w = await world();
    await requestRun(w, { maxSteps: 2 });
    expect((await runBrowserJob({ service: w.runner, runner: runnerFor(), browserRoot: "/var/zs-browser" }))?.run)
      .toMatchObject({ status: "stopped", stopReason: "step_cap", steps: 2 });

    await requestRun(w, { deadlineMs: 1000 });
    const slow: Answer = (request) => { now += 2000; return invoicePlannerAnswer(request); };
    expect((await runBrowserJob({ service: w.runner, runner: runnerFor(slow), browserRoot: "/var/zs-browser" }))?.run)
      .toMatchObject({ status: "stopped", stopReason: "deadline" });

    await requestRun(w, { maxCostMicros: 100 });
    const priced = (await runBrowserJob({ service: w.runner, runner: runnerFor(), browserRoot: "/var/zs-browser" }))?.run;
    // The second step's reservation does not fit next to the first step's cost: it never starts.
    expect(priced).toMatchObject({ status: "stopped", stopReason: "cost_cap", steps: 1 });
    expect(priced!.costMicros).toBe(CALL_COST);
    expect(await wallet(w)).toMatchObject({ reserved: 0 });
  });

  it("refuses a run when the feature is off and closes a queued one when the global switch is engaged", async () => {
    const w = await world();
    const owner = w.sessionFor(w.owner);
    const status = await owner.getStatus();
    await owner.updateSettings({ expectedRevision: status.revision, enabled: false, maxRunsPerDay: 5, maxCostMicrosPerDay: 1_000_000 }, randomUUID());
    expect((await rejection(requestRun(w))).details).toMatchObject({ reason: "disabled" });
    // A stale revision is a conflict, not an overwrite.
    expect((await rejection(owner.updateSettings({ expectedRevision: status.revision, enabled: true, maxRunsPerDay: 5, maxCostMicrosPerDay: 1 }, randomUUID()))).details)
      .toMatchObject({ reason: "stale_revision" });
  });
});

describe("the wallet (BT-9, delivery.md D-11)", () => {
  it("closes insufficient_funds without a step when the hold does not fit", async () => {
    const w = await world({ credit: 100 });
    await requestRun(w);
    const done = await runBrowserJob({ service: w.runner, runner: runnerFor(), browserRoot: "/var/zs-browser" });
    expect(done).toBeNull();
    const [run] = await rows<{ status: string; stop_reason: string; steps: number }>("SELECT status, stop_reason, steps FROM browser_runs WHERE tenant_id=$1", [w.tenantId]);
    expect(run).toMatchObject({ status: "stopped", stop_reason: "insufficient_funds", steps: 0 });
    expect(w.site.requests).toEqual([]);
    expect(await wallet(w)).toMatchObject({ balance: 100, reserved: 0 });
  });

  it("hands a run without sign-in details back to the owner and releases the whole hold", async () => {
    const w = await world({ credentials: false });
    await requestRun(w);
    expect(await runBrowserJob({ service: w.runner, runner: runnerFor(), browserRoot: "/var/zs-browser" })).toBeNull();
    const [run] = await rows<{ stop_reason: string }>("SELECT stop_reason FROM browser_runs WHERE tenant_id=$1", [w.tenantId]);
    expect(run!.stop_reason).toBe("needs_owner");
    expect(await wallet(w)).toMatchObject({ balance: 100_000, reserved: 0 });
    expect(await rows("SELECT 1 FROM wallet_ledger WHERE tenant_id=$1 AND kind='capture'", [w.tenantId])).toEqual([]);
  });

  it("re-claims a run whose lease ran out on the same hold, and the old lease is dead", async () => {
    const w = await world();
    const requested = await requestRun(w);
    const first = (await w.runner.claim()) as BrowserClaim;
    expect(first).toMatchObject({ runId: requested.result.id, attempt: 1, tenantId: w.tenantId, targetId: w.targetId });
    expect(first.credentials).toEqual({ username: USERNAME, password: PASSWORD });
    expect(await wallet(w)).toMatchObject({ reserved: 25 * STEP_PRICE });
    now += config.leaseMs + 1;
    const stale = { runId: first.runId, token: first.leaseToken };
    await expect(w.runner.control(stale)).rejects.toBeInstanceOf(TenantDenied);
    const second = (await w.runner.claim()) as BrowserClaim;
    expect(second).toMatchObject({ runId: first.runId, attempt: 2 });
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(await wallet(w)).toMatchObject({ reserved: 25 * STEP_PRICE });
    await expect(w.runner.control(stale)).rejects.toBeInstanceOf(TenantDenied);
    await expect(w.runner.appendEvent(stale, { action: "open" })).rejects.toBeInstanceOf(TenantDenied);
    const lease = { runId: second.runId, token: second.leaseToken };
    expect((await w.runner.finish(lease, { outcome: "stopped", reason: "runner_error" })).status).toBe("stopped");
    // finish is idempotent once the run is closed.
    expect((await w.runner.finish(lease, { outcome: "read_done" })).status).toBe("stopped");
    expect(await wallet(w)).toMatchObject({ reserved: 0, balance: 100_000 });
  });

  it("closes a run that is still running past its deadline as stalled and releases the hold", async () => {
    const w = await world();
    const requested = await requestRun(w, { deadlineMs: 1000 });
    await w.runner.claim();
    expect(await w.runner.closeStalledRuns()).toBe(0);
    now += 1000 + config.stallGraceMs + 1000;
    expect(await w.runner.closeStalledRuns()).toBe(1);
    expect(await w.runner.getRun(w.tenantId, requested.result.id)).toMatchObject({ status: "stopped", stopReason: "stalled" });
    expect(await wallet(w)).toMatchObject({ reserved: 0, balance: 100_000 });
  });
});

describe("the runner's credential is one lease (BT-7)", () => {
  it("cannot act on another run with its own token, and a wrong token is denied", async () => {
    const w = await world();
    await requestRun(w);
    await requestRun(w);
    const mine = (await w.runner.claim())!;
    const theirs = (await w.runner.claim())!;
    const [one, two] = [mine, theirs];
    await expect(w.runner.control({ runId: one.runId, token: two.leaseToken })).rejects.toBeInstanceOf(TenantDenied);
    await expect(w.runner.putArtifact({ runId: two.runId, token: one.leaseToken }, { kind: "invoice_pdf", name: "x.pdf", bytes: fixturePdf("x") }))
      .rejects.toBeInstanceOf(TenantDenied);
    await expect(w.runner.control({ runId: randomUUID(), token: one.leaseToken })).rejects.toBeInstanceOf(TenantDenied);
    for (const claim of [one, two]) await w.runner.finish({ runId: claim.runId, token: claim.leaseToken }, { outcome: "stopped", reason: "runner_error" });
  });

  it("keeps only PDFs and PNGs of a sane size, deduplicates by content, and names files safely", async () => {
    const w = await world();
    await requestRun(w);
    const claim = (await w.runner.claim())!;
    const lease = { runId: claim.runId, token: claim.leaseToken };
    await expect(w.runner.putArtifact(lease, { kind: "invoice_pdf", name: "a.pdf", bytes: new TextEncoder().encode("<html>") })).rejects.toBeInstanceOf(ValidationFailed);
    await expect(w.runner.putArtifact(lease, { kind: "invoice_pdf", name: "a.pdf", bytes: new Uint8Array() })).rejects.toBeInstanceOf(ValidationFailed);
    const first = await w.runner.putArtifact(lease, { kind: "invoice_pdf", name: "../../etc/<x>.pdf", bytes: fixturePdf("a") });
    const again = await w.runner.putArtifact(lease, { kind: "invoice_pdf", name: "renamed.pdf", bytes: fixturePdf("a") });
    expect(again).toEqual({ id: first.id, duplicate: true });
    const [row] = await rows<{ name: string }>("SELECT name FROM browser_run_artifacts WHERE tenant_id=$1 AND id=$2", [w.tenantId, first.id]);
    expect(row!.name).not.toMatch(/[\\/<>]/);
    await w.runner.finish(lease, { outcome: "read_done" });
  });
});
