// BT-8, BT-9, BT-10: stored sign-in values never reach the planner, the audit trail or a file name,
// even when the supplier's page echoes them back; and a paid planner call is recorded even when its
// answer is rejected. The browser is the fake runner against a real loopback supplier site.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import {
  FAKE_MODEL_PRICES, browserConfig, createBrowserRunnerService, createBrowserSession, createFakeBrowserRunner, createFakeTextModel,
  createMemoryArtifactStore, createStaticCredentialResolver, creditWallet, fixturePdf, invoicePlannerAnswer, runBrowserJob,
  startFixtureSite, type BrowserConfig, type EdgeDependencies, type FixtureSite, type MemoryArtifactStore, type TextModelRequest,
} from "../src/index.js";

let now = Date.parse("2026-10-20T12:00:00.000Z");
const clock = { now: () => new Date(now) };
const USERNAME = "alice.planted@clinic.example";
const PASSWORD = "Zq-PLANTED-pw-4417";
const STEP_PRICE = 10;
/** What one fake planner call costs: 120 input and 60 output tokens at the fake price. */
const CALL_COST = 87;

let database: TestDatabase;
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => service(async (tx) => (await tx.query(sql, params)).rows as T[]);
const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID });
const config: BrowserConfig = browserConfig({ stepPrice: STEP_PRICE, modelPrices: FAKE_MODEL_PRICES, allowLoopback: true, stepModelReserveMicros: 1_000 });

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

/** The page the supplier shows after sign-in: it echoes both values in text, attributes and links. */
const ECHO_HTML = [
  `<p>Welcome ${USERNAME}! Your password is ${PASSWORD}. SHOUTING: ${USERNAME.toUpperCase()} ${PASSWORD.toLowerCase()}</p>`,
  `<form method="get" action="/invoices/profile"><input name="who" value="${USERNAME}"><input name="${PASSWORD}"></form>`,
  `<a href="/invoices/profile?u=${encodeURIComponent(USERNAME)}&p=${encodeURIComponent(PASSWORD)}" title="${PASSWORD}">Profile of ${USERNAME}</a>`,
  `<a href="/users/${USERNAME}/settings">Settings</a>`,
  `<button data-requests="GET /invoices/ping?u=${USERNAME}">Ping ${PASSWORD}</button>`,
].join("\n");

interface World {
  tenantId: string;
  owner: string;
  site: FixtureSite;
  store: MemoryArtifactStore;
  runner: ReturnType<typeof createBrowserRunnerService>;
  session: ReturnType<typeof createBrowserSession>;
}

async function world(): Promise<World> {
  const tenantId = randomUUID();
  await service((tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [tenantId, "Clinic"]));
  const owner = await member(tenantId, "owner");
  await service((tx) => creditWallet(tx, { tenantId, ledgerId: randomUUID(), amount: 100_000, idempotencyKey: `credit:${randomUUID()}`, now: clock.now() }));
  const site = await startFixtureSite({
    username: USERNAME, password: PASSWORD,
    // The sign-in lands on a page whose path is the user name, and two invoice files are named after the values.
    signInRedirect: `/users/${USERNAME}`,
    invoices: [
      { name: "2026-09-001.pdf", bytes: fixturePdf("one") },
      { name: `${USERNAME}-2026-09.pdf`, bytes: fixturePdf("named after the user") },
      { name: `${PASSWORD}.pdf`, bytes: fixturePdf("named after the password") },
    ],
    listExtraHtml: ECHO_HTML,
  });
  sites.push(site);
  const store = createMemoryArtifactStore();
  const secretRef = `browser/${tenantId}/supplier`;
  const runner = createBrowserRunnerService({
    service, clock, generateId: randomUUID, newToken: () => `${randomUUID()}${randomUUID()}`, config,
    credentials: createStaticCredentialResolver({ [secretRef]: { username: USERNAME, password: PASSWORD } }), artifacts: store,
  });
  const session = createBrowserSession(deps(), { tenantId, actorId: owner }, { config, artifacts: store });
  await session.updateSettings({ expectedRevision: 0, enabled: true, maxRunsPerDay: 50, maxCostMicrosPerDay: 5_000_000 }, randomUUID());
  await session.saveTarget({
    expectedRevision: 0, name: "Supplier portal", taskKind: "supplier_invoice_download", allowedOrigins: [site.origin],
    allowedPaths: ["/invoices", "/users"], assetPaths: [], signInPath: "/login", enabled: true, secretRef,
    attestation: { termsAllowAutomatedAccess: true, notInsurerOrPayerPortal: true },
  }, randomUUID());
  return { tenantId, owner, site, store, runner, session };
}

const requestRun = async (w: World) => {
  const targets = await rows<{ id: string }>("SELECT id FROM browser_targets WHERE tenant_id=$1", [w.tenantId]);
  return w.session.requestRun({ targetId: targets[0]!.id, month: "2026-09" }, randomUUID());
};

/** Every form a planted value could take in stored text: as is, URL-encoded, and in another case. */
function leaks(text: string): string[] {
  const forms = [USERNAME, PASSWORD, encodeURIComponent(USERNAME), encodeURIComponent(PASSWORD)];
  const lower = text.toLowerCase();
  return forms.filter((form) => lower.includes(form.toLowerCase()));
}

describe("credentials never leave the sign-in (BT-8)", () => {
  it("keeps values the page echoes out of the planner input, history, events, run rows and file names", async () => {
    const logs: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    const w = await world();
    const requested = await requestRun(w);
    const runner = createFakeBrowserRunner({ model: createFakeTextModel("personal_data", invoicePlannerAnswer) });
    const done = await runBrowserJob({ service: w.runner, runner, browserRoot: "/var/zs-browser" });
    expect(done?.run.status).toBe("completed");

    // The site really echoed both values and the runner really fetched the files named after them.
    expect(w.site.requests.some((request) => request.path === `/users/${USERNAME}`)).toBe(true);
    expect(w.site.requests.some((request) => request.path === `/invoices/${USERNAME}-2026-09.pdf`)).toBe(true);
    expect(w.site.requests.some((request) => request.path === `/invoices/${PASSWORD}.pdf`)).toBe(true);

    // The planner saw placeholders where the values were.
    expect(runner.modelRequests.join("\n")).toContain("{{username}}");
    expect(runner.modelRequests.join("\n")).toContain("{{password}}");
    expect(leaks(runner.modelRequests.join("\n"))).toEqual([]);

    const detail = await w.session.getRun(requested.result.id);
    expect(detail.artifacts).toHaveLength(3);
    expect(leaks(JSON.stringify(detail.artifacts.map((artifact) => artifact.name)))).toEqual([]);
    const everything = JSON.stringify({
      detail,
      runs: await rows("SELECT t::text AS row FROM browser_runs t WHERE tenant_id=$1", [w.tenantId]),
      events: await rows("SELECT t::text AS row FROM browser_run_events t WHERE tenant_id=$1", [w.tenantId]),
      artifacts: await rows("SELECT t::text AS row FROM browser_run_artifacts t WHERE tenant_id=$1", [w.tenantId]),
      keys: w.store.keys(), logs,
    });
    expect(leaks(everything)).toEqual([]);
  });

  it("redacts what a runner hands the hooks, whatever runner it is", async () => {
    const w = await world();
    const requested = await requestRun(w);
    const done = await runBrowserJob({
      service: w.runner, browserRoot: "/var/zs-browser",
      runner: {
        async plan({ claim, hooks }) {
          await hooks.recordStep({ action: "open", url: `${claim.target.allowedOrigins[0]}/users/${encodeURIComponent(USERNAME)}/${PASSWORD}` });
          await hooks.saveArtifact({ kind: "invoice_pdf", name: `${PASSWORD.toUpperCase()}-${USERNAME}.pdf`, bytes: fixturePdf("hook") });
          return { outcome: "read_done", steps: 1, artifacts: 1 };
        },
        async execute(): Promise<never> { throw new Error("unused"); },
      },
    });
    expect(done?.run.status).toBe("completed");
    const everything = JSON.stringify({
      events: await rows("SELECT t::text AS row FROM browser_run_events t WHERE tenant_id=$1", [w.tenantId]),
      artifacts: await rows("SELECT t::text AS row FROM browser_run_artifacts t WHERE tenant_id=$1", [w.tenantId]),
      detail: await w.session.getRun(requested.result.id),
    });
    expect(leaks(everything)).toEqual([]);
  });
});

describe("a rejected planner answer is still paid for (BT-9)", () => {
  it("records the call's usage as a stop event before it stops with model_error", async () => {
    const w = await world();
    const requested = await requestRun(w);
    let calls = 0;
    const answer = (request: TextModelRequest) => {
      calls += 1;
      return (request.input as { page: unknown }).page ? { action: "fly", to: "the moon" } : invoicePlannerAnswer(request);
    };
    const done = await runBrowserJob({
      service: w.runner, browserRoot: "/var/zs-browser",
      runner: createFakeBrowserRunner({ model: createFakeTextModel("personal_data", answer) }),
    });
    expect(done?.run).toMatchObject({ status: "stopped", stopReason: "model_error", steps: 1 });
    expect(calls).toBe(2);
    const stored = await rows<{ seq: number; action: string; model: string | null; cost_micros: string }>(
      "SELECT seq, action, model, cost_micros::text FROM browser_run_events WHERE tenant_id=$1 AND run_id=$2 ORDER BY seq",
      [w.tenantId, requested.result.id]);
    expect(stored.map((event) => event.action)).toEqual(["open", "stop"]);
    expect(stored[1]!.model).not.toBeNull();
    expect(Number(stored[1]!.cost_micros)).toBe(CALL_COST);
    expect(done?.run.costMicros).toBe(2 * CALL_COST);
  });
});
