// industry-templates.md IT-9 and acceptance 7: owner-run tenant creation. The local entry point
// runs as a child process against a test database; the hosted flow runs against the same
// database through the fake Supabase Auth admin API.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyTemplateResponseSchema } from "@zs/contracts";
import { asService } from "@zs/db";
import { createTestDatabase, readAuthUserTenant, startAuthSession, upsertAuthUser, type TestDatabase } from "@zs/db/testing";
import { parseHostedTenantCreateArgs, runHostedTenantCreate } from "../src/hosted-tenant-create.js";
import { createSupabaseAuthAdmin } from "../src/supabase-auth-admin.js";
import { createTenant, readTenantState, runTenantCreate, tenantIdForKey, type TenantCreateInput, type TenantCreateSummary } from "../src/tenant-create.js";
import { FAKE_REF, FAKE_SERVICE_KEY, fakeGoTrue } from "./fake-gotrue.js";
import { appOnDatabase, call, clock, tokenFor } from "./helpers.js";

const API_DIR = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

let database: TestDatabase;
beforeAll(async () => { database = await createTestDatabase(); }, 60_000);
afterAll(async () => { await database?.close(); });

async function tenantCreate(args: string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn(TSX, ["src/scripts/tenant-create.ts", ...args], {
    cwd: API_DIR,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", DATABASE_URL: database.url },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const [code] = await once(child, "exit");
  return { code: code as number | null, output };
}
const args = (key: string, name: string, email: string, zone?: string) =>
  ["--key", key, "--name", name, "--owner-email", email, ...(zone ? ["--time-zone", zone] : [])];

/** Every row tenant creation touches, for one tenant. */
const advisoryLocks = async (): Promise<number> => Number((await database.pool.query(
  "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())")).rows[0].n);
const rowsOf = (tenantId: string) => asService(database.servicePool, async (tx) => ({
  tenants: (await tx.query("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows,
  profile: (await tx.query("SELECT display_name, time_zone, revision FROM business_profiles WHERE tenant_id=$1", [tenantId])).rows,
  members: (await tx.query("SELECT email, user_id, role::text AS role FROM tenant_members WHERE tenant_id=$1 ORDER BY email", [tenantId])).rows,
}));

describe("tenant:create (local, acceptance 7)", () => {
  const key = "zero-sum";
  const tenantId = tenantIdForKey(key);
  const email = "devin@zerosum.example";

  it("prints the plan on --dry-run, then creates Zero Sum Solutions with a pending owner, and a rerun replays", async () => {
    const dry = await tenantCreate([...args(key, "Zero Sum Solutions", email, "America/Los_Angeles"), "--dry-run"]);
    expect(dry.code).toBe(0);
    const plan = JSON.parse(dry.output);
    expect(plan).toMatchObject({
      mode: "dry-run", result: "nothing written",
      plan: { tenantId, key, name: "Zero Sum Solutions", tenant: "would-create", timeZoneStep: "would-set",
        owner: { kind: "would-provision", email, userExists: false } },
    });
    expect(await rowsOf(tenantId)).toEqual({ tenants: [], profile: [], members: [] });

    const created = await tenantCreate(args(key, "Zero Sum Solutions", email, "America/Los_Angeles"));
    expect(created.code).toBe(0);
    expect(JSON.parse(created.output)).toMatchObject({
      result: "done", tenant: "created", timeZoneStep: "set",
      owner: { kind: "provisioned", summary: { action: "created", role: "owner", userId: null, tenantClaim: "no-user" } },
    });
    const after = await rowsOf(tenantId);
    expect(after).toEqual({
      tenants: [{ name: "Zero Sum Solutions" }],
      profile: [{ display_name: "Zero Sum Solutions", time_zone: "America/Los_Angeles", revision: 2 }],
      members: [{ email, user_id: null, role: "owner" }],
    });

    const rerun = await tenantCreate(args(key, "Zero Sum Solutions", email, "America/Los_Angeles"));
    expect(rerun.code).toBe(0);
    expect(JSON.parse(rerun.output)).toMatchObject({
      tenant: "unchanged", timeZoneStep: "unchanged", owner: { kind: "provisioned", summary: { action: "unchanged" } },
    });
    expect(await rowsOf(tenantId)).toEqual(after);
    // Leaving the zone out keeps the stored one.
    expect((await tenantCreate(args(key, "Zero Sum Solutions", email))).code).toBe(0);
    expect(await rowsOf(tenantId)).toEqual(after);
  });

  it("refuses a rerun with another owner email, name or zone, and a bad key, before writing anything", async () => {
    const before = await rowsOf(tenantId);
    const cases: [string[], RegExp][] = [
      [args(key, "Zero Sum Solutions", "someone@else.example", "America/Los_Angeles"), /another owner email/],
      [args(key, "Zero Sum LLC", email, "America/Los_Angeles"), /another name/],
      [args(key, "Zero Sum Solutions", email, "Europe/Paris"), /another time zone/],
      [args(key, "Zero Sum Solutions", email, "Mars/Olympus_Mons"), /IANA time zone/],
      [args("Zero_Sum", "Zero Sum Solutions", email), /--key must match/],
      [args("zs", "Zero Sum Solutions", email), /--key must match/],
      [args(`z${"a".repeat(40)}`, "Zero Sum Solutions", email), /--key must match/],
      [["--key=-zero", "--name", "Zero Sum Solutions", "--owner-email", email], /--key must match/],
    ];
    for (const [argv, pattern] of cases) {
      const run = await tenantCreate(argv);
      expect(run.code).toBe(1);
      expect(run.output).toMatch(pattern);
    }
    expect(await rowsOf(tenantId)).toEqual(before);
    expect((await rowsOf(tenantIdForKey("zs"))).tenants).toEqual([]);
  });

  it("after the owner's user exists, a rerun binds it with the tenant claim, and the owner applies agency", async () => {
    const userId = await upsertAuthUser(database.pool, { email, appMetadata: { provider: "email" } });
    const bound = await tenantCreate(args(key, "Zero Sum Solutions", email, "America/Los_Angeles"));
    expect(bound.code).toBe(0);
    expect(JSON.parse(bound.output)).toMatchObject({ owner: { summary: { action: "bound", userId, tenantClaim: "set" } } });
    expect(await readAuthUserTenant(database.pool, userId)).toBe(tenantId);

    const sessionId = await startAuthSession(database.pool, userId);
    const token = await tokenFor({ tenantId, actorId: userId, sessionId });
    const app = appOnDatabase(database.db, { activepieces: false });
    const applied = await call(app, "POST", "/v1/setup/apply", { token, body: { templateId: "agency", timeZone: "America/Los_Angeles" } });
    expect(applied.status).toBe(201);
    expect(applyTemplateResponseSchema.parse(applied.body).result).toMatchObject({ templateId: "agency", timeZone: "America/Los_Angeles" });
    expect((await call(app, "GET", "/v1/setup", { token })).body.applied).toMatchObject({ templateId: "agency", published: false });
  });
});

describe("createTenant", () => {
  const deps = (claims: Map<string, { id: string; tenantId: string | null }>) => ({
    service: database.servicePool, clock, generateId: randomUUID,
    auth: {
      findUser: async (email: string) => claims.get(email) ?? null,
      setTenantClaim: async (userId: string, tenantId: string) => {
        for (const [email, user] of claims) if (user.id === userId) claims.set(email, { id: userId, tenantId });
      },
    },
  });
  const input = (over: Partial<TenantCreateInput> = {}): TenantCreateInput =>
    ({ key: `t-${randomUUID().slice(0, 8)}`, name: "Halden & Rowe", ownerEmail: "owner@halden.example", dryRun: false, ...over });

  it("refuses, before any write, an owner email whose user holds another tenant's claim (D2)", async () => {
    const claims = new Map<string, { id: string; tenantId: string | null }>();
    const first = await createTenant(deps(claims), input({ ownerEmail: "shared@owner.example" }));
    const userId = randomUUID();
    claims.set("shared@owner.example", { id: userId, tenantId: first.tenantId });
    const firstRows = await rowsOf(first.tenantId);

    const second = input({ ownerEmail: "shared@owner.example", name: "Rowe Studio" });
    for (const dryRun of [true, false]) {
      await expect(createTenant(deps(claims), { ...second, dryRun })).rejects.toThrow(/already holds the tenant claim of tenant/);
    }
    expect((await rowsOf(tenantIdForKey(second.key))).tenants).toEqual([]);
    expect(await rowsOf(first.tenantId)).toEqual(firstRows);
    expect(claims.get("shared@owner.example")).toEqual({ id: userId, tenantId: first.tenantId });
    await expect(advisoryLocks()).resolves.toBe(0);
  });

  it("refuses an owner email that already has a membership, of any role, on another tenant (D2)", async () => {
    const first = await createTenant(deps(new Map()), input({ ownerEmail: "pending@owner.example" }));
    expect((await rowsOf(first.tenantId)).members).toEqual([{ email: "pending@owner.example", user_id: null, role: "owner" }]);
    const second = input({ ownerEmail: "pending@owner.example", name: "Rowe Studio" });
    await expect(createTenant(deps(new Map()), second)).rejects.toThrow(/already a owner of tenant/);
    // A staff membership elsewhere counts too: the user could not hold two claims either.
    const staffTenant = tenantIdForKey("staff-elsewhere");
    await asService(database.servicePool, async (tx) => {
      await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Elsewhere')", [staffTenant]);
      await tx.query(
        "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,'crew@owner.example',NULL,'staff',now(),now())",
        [staffTenant, randomUUID()]);
    });
    await expect(createTenant(deps(new Map()), input({ ownerEmail: "crew@owner.example" }))).rejects.toThrow(/already a staff of tenant/);
    expect((await rowsOf(tenantIdForKey(second.key))).tenants).toEqual([]);
    // The tenant's own owner email is not "elsewhere": a rerun replays.
    await expect(createTenant(deps(new Map()), input({ key: first.key, ownerEmail: "pending@owner.example" })))
      .resolves.toMatchObject({ tenant: "unchanged" });
  });

  describe("concurrent runs (D3)", () => {
    it("serializes two keys for one owner email: one wins, the other creates nothing, whether the user exists or not", async () => {
      for (const userExists of [false, true]) {
        const email = `race-${randomUUID().slice(0, 8)}@owner.example`;
        const claims = new Map<string, { id: string; tenantId: string | null }>();
        if (userExists) claims.set(email, { id: randomUUID(), tenantId: null });
        const a = input({ ownerEmail: email, name: "Race A" });
        const b = input({ ownerEmail: email, name: "Race B" });
        const results = await Promise.allSettled([createTenant(deps(claims), a), createTenant(deps(claims), b)]);
        expect(results.filter((r) => r.status === "fulfilled"), String(userExists)).toHaveLength(1);
        const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(String(lost.reason), String(userExists)).toMatch(/one tenant claim per user/);
        const created = (await Promise.all([a, b].map((x) => rowsOf(tenantIdForKey(x.key))))).filter((rows) => rows.tenants.length > 0);
        expect(created, String(userExists)).toHaveLength(1);
        expect(created[0]!.members, String(userExists)).toEqual([{ email, user_id: userExists ? claims.get(email)!.id : null, role: "owner" }]);
        await expect(advisoryLocks()).resolves.toBe(0);
      }
    });

    it("serializes one key for two owner emails: the second finds the first's email and refuses", async () => {
      const base = input({ name: "Same Key" });
      const results = await Promise.allSettled([
        createTenant(deps(new Map()), { ...base, ownerEmail: "first@owner.example" }),
        createTenant(deps(new Map()), { ...base, ownerEmail: "second@owner.example" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(String(lost.reason)).toMatch(/another owner email/);
      const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<TenantCreateSummary>).value;
      expect((await rowsOf(winner.tenantId)).members).toEqual([{ email: winner.ownerEmail, user_id: null, role: "owner" }]);
      await expect(advisoryLocks()).resolves.toBe(0);
    });

    it("refuses an interrupted run resumed with another owner email, and finishes it with the same one", async () => {
      const first = input({ ownerEmail: "intended@owner.example", name: "Interrupted" });
      // Phase 1 commits; the owner step then fails, as a crash between the phases would.
      const failing = { ...deps(new Map()), generateId: () => { throw new Error("simulated crash before the owner row"); } };
      await expect(createTenant(failing, first)).rejects.toThrow(/simulated crash/);
      const stored = await asService(database.servicePool, async (tx) => ({
        tenant: (await tx.query("SELECT name, provisioning_owner_email FROM tenants WHERE tenant_id=$1", [tenantIdForKey(first.key)])).rows,
        owners: (await tx.query("SELECT 1 FROM tenant_members WHERE tenant_id=$1", [tenantIdForKey(first.key)])).rowCount,
      }));
      expect(stored).toEqual({ tenant: [{ name: "Interrupted", provisioning_owner_email: "intended@owner.example" }], owners: 0 });
      await expect(advisoryLocks()).resolves.toBe(0);

      await expect(createTenant(deps(new Map()), { ...first, ownerEmail: "someone-else@owner.example" })).rejects.toThrow(/another owner email/);
      expect((await rowsOf(tenantIdForKey(first.key))).members).toEqual([]);
      await expect(createTenant(deps(new Map()), first)).resolves.toMatchObject({
        tenant: "unchanged", owner: { kind: "provisioned", summary: { action: "created" } },
      });
    });
  });

  it("leaves no session lock on a pooled client after a run, a refusal or a failure", async () => {
    await createTenant(deps(new Map()), input());
    await expect(createTenant(deps(new Map()), input({ name: " bad " }))).rejects.toThrow();
    await expect(createTenant({ ...deps(new Map()), auth: { findUser: async () => { throw new Error("auth is down"); }, setTenantClaim: async () => undefined } }, input()))
      .rejects.toThrow(/auth is down/);
    await expect(advisoryLocks()).resolves.toBe(0);
    // The client the pool hands out next carries no lock_timeout from the run either.
    const client = await database.servicePool.connect();
    try {
      expect((await client.query("SHOW lock_timeout")).rows[0].lock_timeout).toBe("0");
    } finally {
      client.release();
    }
  });

  it("verifies the bound owner's tenant claim after an apply", async () => {
    const email = "bound@owner.example";
    const claims = new Map<string, { id: string; tenantId: string | null }>([[email, { id: randomUUID(), tenantId: null }]]);
    const body = input({ ownerEmail: email, name: "Claim Check" });
    const run = (readTenantClaim: (userId: string) => Promise<string | null>) => runTenantCreate({ mode: "apply" }, {
      input: { key: body.key, name: body.name, ownerEmail: email }, target: {},
      create: (request) => createTenant(deps(claims), request),
      readState: (tenantId, address) => readTenantState(database.servicePool, tenantId, address),
      readTenantClaim, clock, log: () => undefined, logError: () => undefined,
    });
    await expect(run(async () => null)).rejects.toThrow(/tenant claim read back/);
    const tenantId = tenantIdForKey(body.key);
    await expect(run(async () => tenantId)).resolves.toMatchObject({ tenant: "unchanged", owner: { summary: { action: "unchanged", tenantClaim: "present" } } });
  });

  it("refuses an explicit empty or non-IANA time zone", async () => {
    for (const timeZone of ["", "Mars"]) await expect(createTenant(deps(new Map()), input({ timeZone }))).rejects.toThrow(/IANA time zone/);
  });

  it("refuses a name the tenant trigger would change", async () => {
    await expect(createTenant(deps(new Map()), input({ name: " Halden " }))).rejects.toThrow(/no outer spaces/);
    await expect(createTenant(deps(new Map()), input({ name: "x".repeat(121) }))).rejects.toThrow(/1 to 120/);
  });
});

describe("db:hosted-tenant-create", () => {
  const SERVICE_URL = `postgres://postgres.${FAKE_REF}:fake-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
  const ENV = { ZS_TARGET_REF: FAKE_REF, SERVICE_DATABASE_URL: SERVICE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY };
  const base = ["--key", "hosted-one", "--name", "Hosted One", "--owner-email", "owner@hosted.example", "--time-zone", "UTC"];

  it("checks its arguments and the target before anything connects", () => {
    expect(() => parseHostedTenantCreateArgs(["--key", "hosted-one", "--dry-run"], ENV)).toThrow(/--owner-email/);
    expect(() => parseHostedTenantCreateArgs(base, ENV)).toThrow(/exactly one of --dry-run or --apply/);
    expect(() => parseHostedTenantCreateArgs([...base, "--apply", "--receipt", "r.json"], ENV)).toThrow(/--backup/);
    expect(() => parseHostedTenantCreateArgs([...base, "--dry-run", "--receipt", "r.json"], ENV)).toThrow(/with --apply only/);
    expect(() => parseHostedTenantCreateArgs([...base, "--dry-run"], { ...ENV, ZS_TARGET_REF: undefined })).toThrow();
    expect(() => parseHostedTenantCreateArgs([...base, "--dry-run"], { ...ENV, SERVICE_DATABASE_URL: database.url })).toThrow();
    expect(() => parseHostedTenantCreateArgs([...base, "--dry-run"], { ...ENV, SUPABASE_SERVICE_ROLE_KEY: undefined })).toThrow(/is required/);
    expect(parseHostedTenantCreateArgs([...base, "--dry-run"], ENV)).toMatchObject({ key: "hosted-one", timeZone: "UTC", mode: { mode: "dry-run" } });
    // An explicit empty zone is forwarded (and refused later), not read as omitted.
    expect(parseHostedTenantCreateArgs([...base.slice(0, -2), "--time-zone", "", "--dry-run"], ENV).timeZone).toBe("");
  });

  it("applies after the backup check and records a receipt; the receipt path must be new", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zs-tenant-create-"));
    try {
      const receiptPath = join(dir, "receipt.json");
      const config = parseHostedTenantCreateArgs([...base, "--apply", "--backup", join(dir, "backup.dump"), "--receipt", receiptPath], ENV);
      const gotrue = fakeGoTrue();
      const logs: string[] = [];
      const checked: string[] = [];
      const run = () => runHostedTenantCreate(config, {
        service: database.servicePool,
        auth: createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: config.serviceKey, fetch: gotrue.fetch }),
        checkBackup: async (path) => { checked.push(path); return { sha256: "0".repeat(64) }; },
        clock, generateId: randomUUID, log: (line) => logs.push(line), logError: (line) => logs.push(line),
      });
      expect(await run()).toMatchObject({ tenant: "created", timeZoneStep: "set", owner: { kind: "provisioned" } });
      expect(checked).toEqual([join(dir, "backup.dump")]);
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      expect(receipt).toMatchObject({
        mode: "apply", key: "hosted-one", result: "done", plan: { tenant: "would-create" },
        applied: { tenant: "created" }, after: { name: "Hosted One", timeZone: "UTC", owner: { role: "owner", user_id: null } },
      });
      expect(JSON.stringify(receipt)).not.toContain(FAKE_SERVICE_KEY);
      await expect(run()).rejects.toThrow(/EEXIST/);
      expect((await rowsOf(tenantIdForKey("hosted-one"))).members).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
