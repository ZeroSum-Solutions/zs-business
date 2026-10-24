import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, browserClaimResponseSchema, browserRunDetailSchema, browserRunListSchema, browserStatusSchema, type BrowserClaim } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import {
  FAKE_MODEL_PRICES, browserConfig, createBrowserRunnerService, createFakeBrowserRunner, createInvoicePlanner, createLocalStubSessionCheck,
  createMemoryArtifactStore, createStaticCredentialResolver, creditWallet, fixturePdf, startFixtureSite,
  type BrowserHooks, type FixtureSite, type MemoryArtifactStore,
} from "@zs/core";
import { createApp, createHs256Verifier, type App } from "../src/app.js";
import { signDevToken } from "../src/dev-token.js";
import { call, createApiHarness, NOW, ORIGIN, SECRET, signedInMember, type ApiHarness, type MemberSetup } from "./helpers.js";

// browser-tasks.md over HTTP, as zs_runtime on a real database: the owner's /v1/browser routes and
// the runner's job interface under /browser-runner/v1. The browser is the fake runner against a
// loopback supplier site; the runner drives the job interface through the app, not through core.
const clock = { now: () => new Date(NOW) };
const RUNNER_TOKEN = "runner-token-for-tests-0123456789";
const PASSWORD = "p4ss-PLANTED-HTTP-5521";
const config = browserConfig({ stepPrice: 10, modelPrices: FAKE_MODEL_PRICES, allowLoopback: true });

let h: ApiHarness;
let app: App;
let site: FixtureSite;
let store: MemoryArtifactStore;
let staff: MemberSetup;
const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(h.database.servicePool, work);

beforeAll(async () => {
  h = await createApiHarness();
  site = await startFixtureSite({
    username: "buyer@clinic.example", password: PASSWORD,
    invoices: [{ name: "2026-09-001.pdf", bytes: fixturePdf("one") }, { name: "2026-09-002.pdf", bytes: fixturePdf("two") }],
  });
  store = createMemoryArtifactStore();
  const secretRef = `browser/${h.a.tenantId}/supplier`;
  const runnerService = createBrowserRunnerService({
    service, clock, generateId: randomUUID, newToken: () => `${randomUUID()}${randomUUID()}`, config,
    credentials: createStaticCredentialResolver({ [secretRef]: { username: "buyer@clinic.example", password: PASSWORD } }), artifacts: store,
  });
  app = createApp({
    verifier: createHs256Verifier(SECRET, { clock }),
    sessionCheck: createLocalStubSessionCheck(h.database.db, clock),
    clock, db: h.database.db, generateId: randomUUID, config: { allowedOrigins: [ORIGIN] },
    browser: { config, artifacts: store, runner: { token: RUNNER_TOKEN, service: runnerService } },
  });
  await service((tx) => creditWallet(tx, { tenantId: h.a.tenantId, ledgerId: randomUUID(), amount: 10_000, idempotencyKey: "credit:browser", now: clock.now() }));
  staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
});
afterAll(async () => { await site?.close(); await h?.close(); });

const tokenOf = (member: MemberSetup) => signDevToken(SECRET, member, clock, 3600);
const owner = async (method: string, path: string, body?: unknown, member: MemberSetup = h.a, theApp: App = app) =>
  call(theApp, method, `/v1/browser${path}`, { token: await tokenOf(member), ...(body === undefined ? {} : { body, key: randomUUID() }) });
const runnerCall = async (method: string, path: string, options: { lease?: string; body?: unknown; token?: string; raw?: Uint8Array } = {}) => {
  const headers: Record<string, string> = { Authorization: `Bearer ${options.token ?? RUNNER_TOKEN}` };
  if (options.lease) headers["Lease-Token"] = options.lease;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await app.request(`/browser-runner/v1${path}`, {
    method, headers, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : options.raw ? { body: new Blob([new Uint8Array(options.raw).buffer as ArrayBuffer]) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const errorOf = (response: { body: unknown }) => apiErrorBodySchema.parse(response.body).error;

/** The runner's hooks, spoken over the job interface. */
function httpHooks(claim: BrowserClaim): BrowserHooks {
  const base = `/runs/${claim.runId}`;
  const lease = claim.leaseToken;
  return {
    async beforeStep() {
      const response = await runnerCall("POST", `${base}/control`, { lease });
      if (response.status !== 200) throw new Error(`control ${response.status}`);
      return response.body.stop;
    },
    async recordStep(input) {
      const response = await runnerCall("POST", `${base}/events`, { lease, body: input });
      if (response.status !== 201) throw new Error(`event ${response.status} ${JSON.stringify(response.body)}`);
      return response.body;
    },
    async saveArtifact(input) {
      const response = await runnerCall("POST", `${base}/artifacts?kind=${input.kind}&name=${encodeURIComponent(input.name)}`, { lease, raw: input.bytes });
      if (response.status !== 201) throw new Error(`artifact ${response.status}`);
      return response.body;
    },
  };
}

describe("owner routes and the runner interface over HTTP", () => {
  it("sets up a target, runs the task through the job interface and downloads the files; tenant B sees none of it", async () => {
    expect((await owner("GET", "")).status).toBe(200);
    const settings = await owner("PUT", "/settings", { expectedRevision: 0, enabled: true, maxRunsPerDay: 5, maxCostMicrosPerDay: 5_000_000 });
    expect(settings.status, JSON.stringify(settings.body)).toBe(200);
    const saved = await owner("POST", "/targets", {
      expectedRevision: 0, name: "Supplier portal", taskKind: "supplier_invoice_download", allowedOrigins: [site.origin],
      allowedPaths: ["/invoices"], assetPaths: [], signInPath: "/login", enabled: true, secretRef: `browser/${h.a.tenantId}/supplier`,
      attestation: { termsAllowAutomatedAccess: true, notInsurerOrPayerPortal: true },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    const targetId = saved.body.result.id as string;
    expect(saved.body.result).toMatchObject({ enabled: true, hasCredentials: true, attestedBy: h.a.actorId });
    expect(JSON.stringify(saved.body)).not.toContain(PASSWORD);

    const requested = await owner("POST", "/runs", { targetId, month: "2026-09" });
    expect(requested.status, JSON.stringify(requested.body)).toBe(201);
    const runId = requested.body.result.id as string;

    // The runner: no member session, a bearer token and a lease.
    expect((await runnerCall("POST", "/claim", { token: "wrong-token" })).status).toBe(401);
    expect((await call(app, "POST", "/browser-runner/v1/claim")).status).toBe(401);
    const claimed = browserClaimResponseSchema.parse((await runnerCall("POST", "/claim")).body).claim!;
    expect(claimed).toMatchObject({ runId, tenantId: h.a.tenantId, targetId, month: "2026-09", attempt: 1 });
    // A missing or wrong lease is denied and tells nothing about the run.
    expect(errorOf(await runnerCall("POST", `/runs/${runId}/control`)).code).toBe("Forbidden");
    expect(errorOf(await runnerCall("POST", `/runs/${runId}/control`, { lease: "x".repeat(40) })).code).toBe("Forbidden");

    const runner = createFakeBrowserRunner({ model: createInvoicePlanner() });
    const outcome = await runner.plan({ claim: claimed, profileDir: `/var/zs-browser/${claimed.tenantId}/${claimed.targetId}/profile`, hooks: httpHooks(claimed) });
    expect(outcome).toMatchObject({ outcome: "read_done", artifacts: 2 });
    const finished = await runnerCall("POST", `/runs/${runId}/finish`, { lease: claimed.leaseToken, body: { outcome: "read_done" } });
    expect(finished.body).toMatchObject({ status: "completed", artifactCount: 2, steps: 5 });

    const detail = browserRunDetailSchema.parse((await owner("GET", `/runs/${runId}`)).body);
    expect(detail.artifacts).toHaveLength(2);
    const file = await app.request(`/v1/browser/runs/${runId}/artifacts/${detail.artifacts[0]!.id}`, { headers: { Authorization: `Bearer ${await tokenOf(h.a)}` } });
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toBe("application/pdf");
    expect(file.headers.get("content-disposition")).toMatch(/^attachment; filename="2026-09-00[12]\.pdf"$/);
    expect(new TextDecoder().decode((await file.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
    expect(browserRunListSchema.parse((await owner("GET", "/runs")).body).items).toHaveLength(1);
    expect(browserStatusSchema.parse((await owner("GET", "")).body)).toMatchObject({ runsToday: 1 });
    // A closed run's lease is no longer valid for events.
    expect((await runnerCall("POST", `/runs/${runId}/events`, { lease: claimed.leaseToken, body: { action: "open" } })).status).toBe(403);

    // Tenant B: nothing of A's, whatever the ID.
    expect((await owner("GET", `/runs/${runId}`, undefined, h.b)).status).toBe(404);
    expect((await owner("GET", "/runs", undefined, h.b)).body.items).toEqual([]);
    const crossFile = await app.request(`/v1/browser/runs/${runId}/artifacts/${detail.artifacts[0]!.id}`, { headers: { Authorization: `Bearer ${await tokenOf(h.b)}` } });
    expect(crossFile.status).toBe(404);
    // B has not turned the feature on, so the refusal says nothing about A's target.
    expect((await owner("POST", "/runs", { targetId, month: "2026-09" }, h.b)).status).toBe(409);
  });

  it("lets staff stop the tasks but not change settings or resume, and refuses a write task", async () => {
    const stopped = await owner("POST", "/kill", { note: "wrong supplier" }, staff);
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(stopped.body.result.killed).toMatchObject({ by: staff.actorId, note: "wrong supplier" });
    expect((await owner("POST", "/resume", {}, staff)).status).toBe(403);
    expect((await owner("PUT", "/settings", { expectedRevision: 1, enabled: false, maxRunsPerDay: 1, maxCostMicrosPerDay: 0 }, staff)).status).toBe(403);
    expect((await owner("POST", "/runs", { targetId: randomUUID(), month: "2026-09" })).status).toBe(409);
    expect((await owner("POST", "/resume", {})).status).toBe(200);
    // No submit route exists: a write task is not part of this revision (BT-11).
    expect((await owner("POST", "/submit", {})).status).toBe(404);
    // Stale revision and a payload naming another tenant are refused with the documented shapes.
    const stale = await owner("PUT", "/settings", { expectedRevision: 0, enabled: true, maxRunsPerDay: 5, maxCostMicrosPerDay: 1 });
    expect(errorOf(stale)).toMatchObject({ code: "Conflict", details: { reason: "stale_revision" } });
    expect(errorOf(await owner("POST", "/runs", { targetId: randomUUID(), month: "2026-09", tenantId: h.b.tenantId })).code).toBe("ValidationFailed");
  });

  it("is off without the browser configuration", async () => {
    const response = await call(h.app, "GET", "/v1/browser", { token: await tokenOf(h.a) });
    expect(response.status).toBe(404);
    expect((await call(h.app, "POST", "/browser-runner/v1/claim", { token: RUNNER_TOKEN })).status).toBe(404);
  });
});
