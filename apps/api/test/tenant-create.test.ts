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
import { createTenant, tenantIdForKey, type TenantCreateInput } from "../src/tenant-create.js";
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
      [args(key, "Zero Sum Solutions", email, "Mars/Olympus_Mons"), /not a time zone PostgreSQL knows/],
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

  it("gives an email that owns another tenant a pending membership on the new tenant only", async () => {
    const claims = new Map<string, { id: string; tenantId: string | null }>();
    const first = await createTenant(deps(claims), input({ ownerEmail: "shared@owner.example" }));
    const userId = randomUUID();
    claims.set("shared@owner.example", { id: userId, tenantId: first.tenantId });
    const firstRows = await rowsOf(first.tenantId);

    const second = await createTenant(deps(claims), input({ ownerEmail: "shared@owner.example", name: "Rowe Studio" }));
    expect(second.owner).toMatchObject({ kind: "membership-only", created: true, otherTenantId: first.tenantId });
    expect((await rowsOf(second.tenantId)).members).toEqual([{ email: "shared@owner.example", user_id: null, role: "owner" }]);
    expect(await rowsOf(first.tenantId)).toEqual(firstRows);
    expect(claims.get("shared@owner.example")).toEqual({ id: userId, tenantId: first.tenantId });
    const again = await createTenant(deps(claims), input({ key: second.key, ownerEmail: "shared@owner.example", name: "Rowe Studio" }));
    expect(again.owner).toMatchObject({ kind: "membership-only", created: false });
    expect((await rowsOf(second.tenantId)).members).toHaveLength(1);
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
