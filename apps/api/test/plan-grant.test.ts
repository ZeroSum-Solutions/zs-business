// db:hosted-plan-grant and db:plan-grant (plans.md PL-24): argument and target guards, then the run
// against local Postgres. No hosted system is touched; the "hosted" target is a fake pooler URL.
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { parseHostedPlanGrantArgs, runHostedPlanGrant, type HostedPlanGrantConfig } from "../src/hosted-plan-grant.js";
import { parseGrantUntil, parsePlanGrantFlags, planGrant, readGrantFacts, runPlanGrant } from "../src/plan-grant.js";
import { FAKE_REF } from "./fake-gotrue.js";
import { clock } from "./helpers.js";

const SERVICE_URL = `postgres://postgres.${FAKE_REF}:fake-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const ENV = { ZS_TARGET_REF: FAKE_REF, SERVICE_DATABASE_URL: SERVICE_URL };
const tenant = randomUUID();
const set = ["--tenant", tenant, "--plan", "pro", "--note", "Retainer, Q1", "--by", "Dana"];
const identity = (path: string) => path;

describe("parseGrantUntil", () => {
  it("reads a date as the end of that day in UTC and an instant as given", () => {
    expect(parseGrantUntil("2027-01-31").toISOString()).toBe("2027-01-31T23:59:59.999Z");
    expect(parseGrantUntil("2027-01-31T17:00:00Z").toISOString()).toBe("2027-01-31T17:00:00.000Z");
    expect(parseGrantUntil("2027-01-31T17:00:00+02:00").toISOString()).toBe("2027-01-31T15:00:00.000Z");
  });

  it.each(["2027-02-30", "2027-13-01", "2027-02-30T17:00:00Z", "2027-04-31T09:00:00+02:00", "2027-01-31T25:00:00Z", "31/01/2027", "2027-01-31T17:00:00", "soon", ""])("refuses %j", (value) => {
    expect(() => parseGrantUntil(value)).toThrow(/--until/);
  });
});

describe("parsePlanGrantFlags", () => {
  const local = { hosted: false, resolve: identity };
  const hosted = { hosted: true, resolve: identity };

  it("reads a set, with and without an end, and a clear", () => {
    expect(parsePlanGrantFlags([...set, "--until", "2027-01-31", "--dry-run"], local)).toEqual({
      tenantId: tenant, mode: { mode: "dry-run" },
      request: { kind: "set", plan: "pro", until: new Date("2027-01-31T23:59:59.999Z"), note: "Retainer, Q1", by: "Dana" },
    });
    expect(parsePlanGrantFlags([...set, "--dry-run"], local).request).toMatchObject({ kind: "set", until: null });
    expect(parsePlanGrantFlags(["--tenant", tenant, "--clear", "--by", " Dana ", "--dry-run"], local).request).toEqual({ kind: "clear", by: "Dana" });
  });

  it("takes a backup with --apply on the hosted script only", () => {
    expect(parsePlanGrantFlags([...set, "--apply", "--backup", "b.dump", "--receipt", "r.json"], hosted).mode)
      .toEqual({ mode: "apply", receiptPath: "r.json", backupPath: "b.dump" });
    expect(parsePlanGrantFlags([...set, "--apply", "--receipt", "r.json"], local).mode).toEqual({ mode: "apply", receiptPath: "r.json" });
  });

  it.each([
    [["--plan", "pro", "--note", "n", "--by", "d", "--dry-run"], /--tenant <uuid>/],
    [["--tenant", "not-a-uuid", "--plan", "pro", "--note", "n", "--by", "d", "--dry-run"], /--tenant <uuid>/],
    [[...set.slice(0, 4), "--note", "n", "--dry-run"], /--by/],
    [["--tenant", tenant, "--plan", "enterprise", "--note", "n", "--by", "d", "--dry-run"], /--plan solo, studio or pro/],
    [["--tenant", tenant, "--note", "n", "--by", "d", "--dry-run"], /--plan solo, studio or pro/],
    [["--tenant", tenant, "--plan", "pro", "--by", "d", "--dry-run"], /--note/],
    [["--tenant", tenant, "--plan", "pro", "--note", " ", "--by", "d", "--dry-run"], /--note/],
    [["--tenant", tenant, "--plan", "pro", "--note", "x".repeat(201), "--by", "d", "--dry-run"], /--note/],
    [["--tenant", tenant, "--plan", "pro", "--note", "n", "--by", "d".repeat(81), "--dry-run"], /--by is at most 80/],
    [[...set, "--until", "someday", "--dry-run"], /--until/],
    [[...set], /exactly one of --dry-run or --apply/],
    [[...set, "--dry-run", "--apply", "--receipt", "r.json"], /exactly one of --dry-run or --apply/],
    [[...set, "--dry-run", "--receipt", "r.json"], /go with --apply only/],
    [[...set, "--apply"], /--apply needs --receipt/],
    [["--tenant", tenant, "--clear", "--plan", "pro", "--by", "d", "--dry-run"], /--clear goes with/],
    [["--tenant", tenant, "--clear", "--note", "n", "--by", "d", "--dry-run"], /--clear goes with/],
    [["--tenant", tenant, "--clear", "--dry-run"], /--by/],
  ])("refuses %j (local)", (argv, pattern) => {
    expect(() => parsePlanGrantFlags(argv, local)).toThrow(pattern);
  });

  it("requires a backup with --apply on the hosted script and refuses one locally", () => {
    expect(() => parsePlanGrantFlags([...set, "--apply", "--receipt", "r.json"], hosted)).toThrow(/--backup <file> and --receipt <file>/);
    expect(() => parsePlanGrantFlags([...set, "--apply", "--backup", "b.dump"], hosted)).toThrow(/--backup <file> and --receipt <file>/);
    expect(() => parsePlanGrantFlags([...set, "--apply", "--backup", "b.dump", "--receipt", "r.json"], local)).toThrow(/hosted script only/);
  });
});

describe("parseHostedPlanGrantArgs", () => {
  it("reads the target and the flags, and needs no Supabase Auth key", () => {
    const config = parseHostedPlanGrantArgs([...set, "--dry-run"], ENV);
    expect(config).toMatchObject({ tenantId: tenant, mode: { mode: "dry-run" }, target: { projectRef: FAKE_REF, role: "postgres" } });
  });

  it("refuses a local or another project's database URL and a missing ref, before connecting", () => {
    const dry = [...set, "--dry-run"];
    expect(() => parseHostedPlanGrantArgs(dry, { ...ENV, SERVICE_DATABASE_URL: "postgres://postgres@127.0.0.1:55432/zs_dev" })).toThrow(/Supabase pooler host/);
    expect(() => parseHostedPlanGrantArgs(dry, { ...ENV, SERVICE_DATABASE_URL: SERVICE_URL.replace(FAKE_REF, "zyxwvutsrqponmlkjihg") })).toThrow(/must log in as postgres on project/);
    expect(() => parseHostedPlanGrantArgs(dry, { ...ENV, SERVICE_DATABASE_URL: `${SERVICE_URL}?sslmode=disable` })).toThrow(/query parameters/);
    expect(() => parseHostedPlanGrantArgs(dry, { ...ENV, ZS_TARGET_REF: "" })).toThrow(/ZS_TARGET_REF/);
    expect(() => parseHostedPlanGrantArgs(dry, {})).toThrow(/ZS_TARGET_REF|SERVICE_DATABASE_URL/);
  });
});

describe("planGrant and runPlanGrant on local Postgres", () => {
  let database: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    database = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "zs-plan-grant-"));
  });
  afterAll(async () => {
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function newTenant(): Promise<string> {
    const tenantId = randomUUID();
    await asService(database.servicePool, (tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Retainer Client')", [tenantId]));
    return tenantId;
  }
  const row = (tenantId: string) => asService(database.servicePool, async (tx) => (await tx.query<Record<string, unknown>>(
    "SELECT * FROM tenant_plans WHERE tenant_id=$1", [tenantId])).rows[0]);
  const deps = () => ({ service: database.servicePool, clock });
  const receiptPath = (name: string) => join(dir, name);
  const backupPath = join(tmpdir(), "zs-fake-backup.dump");

  function setup(tenantId: string, argv: string[], options: { backupFails?: boolean } = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const config: HostedPlanGrantConfig = parseHostedPlanGrantArgs(["--tenant", tenantId, ...argv], ENV);
    const run = () => runHostedPlanGrant(config, {
      service: database.servicePool,
      checkBackup: async (path) => {
        calls.push(`backup ${path}`);
        if (options.backupFails) throw new Error("Refusing to apply: the backup was taken from project zyxwvutsrqponmlkjihg, not ZS_TARGET_REF");
        return { sha256: "0".repeat(64), manifest: { projectRef: FAKE_REF } };
      },
      clock,
      log: (line) => logs.push(line),
      logError: (line) => logs.push(line),
    });
    return { calls, logs, run };
  }
  const grantArgs = ["--plan", "pro", "--note", "Retainer, Q1", "--by", "Dana"];

  it("dry run: reports before and after, writes nothing, takes no backup", async () => {
    const tenantId = await newTenant();
    const { calls, logs, run } = setup(tenantId, [...grantArgs, "--until", "2027-01-31", "--dry-run"]);
    const plan = await run();
    expect(plan).toMatchObject({
      action: "granted", dryRun: true, tenantName: "Retainer Client", by: "Dana", before: null,
      after: { plan: "pro", until: "2027-01-31T23:59:59.999Z", note: "Retainer, Q1", grantedBy: "Dana" },
    });
    expect(JSON.parse(logs[0]!)).toMatchObject({ mode: "dry-run", result: "rolled back", target: { projectRef: FAKE_REF, role: "postgres" } });
    expect(await row(tenantId)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("apply: backup check, a tenant_plans row holding only the grant, read back, receipt with the facts", async () => {
    const tenantId = await newTenant();
    const path = receiptPath("applied.json");
    const { calls, run } = setup(tenantId, [...grantArgs, "--apply", "--backup", backupPath, "--receipt", path]);
    const applied = await run();
    expect(applied).toMatchObject({ action: "granted", dryRun: false, before: null });
    expect(calls).toEqual([`backup ${backupPath}`]);
    expect(await row(tenantId)).toMatchObject({
      status: "none", plan: null, granted_plan: "pro", granted_until: null, grant_note: "Retainer, Q1", granted_by: "Dana",
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      result: "committed", committed: true, by: "Dana", tenantId,
      after: { plan: "pro", until: null, note: "Retainer, Q1", grantedBy: "Dana" },
      backup: { file: backupPath, sha256: "0".repeat(64) }, target: { projectRef: FAKE_REF },
    });
  });

  it("changes no provider column: a subscribed tenant keeps its Stripe row, plan and status", async () => {
    const tenantId = await newTenant();
    await asService(database.servicePool, (tx) => tx.query(
      `INSERT INTO tenant_plans (tenant_id, plan, plan_interval, status, stripe_customer_id, stripe_subscription_id, trial_end, read_only_after, payment_failed_at, created_at, updated_at)
       VALUES ($1,'solo','month','past_due','cus_plan_grant_1','sub_plan_grant_1','2026-12-01T00:00:00Z','2026-11-01T00:00:00Z','2026-10-20T00:00:00Z',now(),now())`, [tenantId]));
    const provider = (r: Record<string, unknown>) => { const { granted_plan, granted_until, grant_note, granted_at, granted_by, updated_at, ...rest } = r; return rest; };
    const before = provider((await row(tenantId))!);
    const { run } = setup(tenantId, [...grantArgs, "--apply", "--backup", backupPath, "--receipt", receiptPath("provider.json")]);
    await run();
    expect(await row(tenantId)).toMatchObject({ granted_plan: "pro", status: "past_due", plan: "solo" });
    expect(provider((await row(tenantId))!)).toEqual(before);
  });

  it("replaces a grant and then clears it; a second clear is unchanged and writes a receipt that says so", async () => {
    const tenantId = await newTenant();
    const first = setup(tenantId, [...grantArgs, "--apply", "--backup", backupPath, "--receipt", receiptPath("r1.json")]);
    await first.run();
    const replace = setup(tenantId, ["--plan", "studio", "--until", "2027-06-30T12:00:00Z", "--note", "Downgraded", "--by", "Sam", "--apply", "--backup", backupPath, "--receipt", receiptPath("r2.json")]);
    expect(await replace.run()).toMatchObject({
      action: "replaced", before: { plan: "pro", grantedBy: "Dana" }, after: { plan: "studio", until: "2027-06-30T12:00:00.000Z", grantedBy: "Sam" },
    });
    expect(await row(tenantId)).toMatchObject({ granted_plan: "studio", grant_note: "Downgraded", granted_by: "Sam" });

    const clear = setup(tenantId, ["--clear", "--by", "Sam", "--apply", "--backup", backupPath, "--receipt", receiptPath("r3.json")]);
    expect(await clear.run()).toMatchObject({ action: "cleared", before: { plan: "studio" }, after: null });
    expect(await row(tenantId)).toMatchObject({ granted_plan: null, granted_until: null, grant_note: null, granted_at: null, granted_by: null });
    expect(JSON.parse(await readFile(receiptPath("r3.json"), "utf8"))).toMatchObject({ result: "committed", committed: true, after: null });

    const again = setup(tenantId, ["--clear", "--by", "Sam", "--apply", "--backup", backupPath, "--receipt", receiptPath("r4.json")]);
    expect(await again.run()).toMatchObject({ action: "unchanged", before: null, after: null });
    expect(JSON.parse(await readFile(receiptPath("r4.json"), "utf8"))).toMatchObject({ result: "unchanged", committed: false });
  });

  it("a clear dry run keeps the grant", async () => {
    const tenantId = await newTenant();
    await setup(tenantId, [...grantArgs, "--apply", "--backup", backupPath, "--receipt", receiptPath("keep.json")]).run();
    const plan = await setup(tenantId, ["--clear", "--by", "Dana", "--dry-run"]).run();
    expect(plan).toMatchObject({ action: "cleared", dryRun: true, after: null });
    expect(await row(tenantId)).toMatchObject({ granted_plan: "pro" });
  });

  it("refuses an unknown tenant, an end in the past and a grant of an unknown plan, and writes nothing", async () => {
    const unknown = randomUUID();
    await expect(planGrant(deps(), { tenantId: unknown, dryRun: false, request: { kind: "set", plan: "pro", until: null, note: "n", by: "d" } }))
      .rejects.toThrow(/does not exist/);
    await expect(planGrant(deps(), { tenantId: unknown, dryRun: false, request: { kind: "clear", by: "d" } })).rejects.toThrow(/does not exist/);
    const tenantId = await newTenant();
    await expect(planGrant(deps(), { tenantId, dryRun: false, request: { kind: "set", plan: "pro", until: new Date("2026-10-19T08:00:00.000Z"), note: "n", by: "d" } }))
      .rejects.toThrow(/in the future/);
    await expect(planGrant(deps(), { tenantId, dryRun: false, request: { kind: "set", plan: "enterprise" as never, until: null, note: "n", by: "d" } }))
      .rejects.toThrow(/solo, studio or pro/);
    expect(await row(tenantId)).toBeUndefined();
    expect(await readGrantFacts(database.servicePool, tenantId)).toBeNull();
  });

  it("reserves the receipt first: an existing receipt stops the run before any backup check or write", async () => {
    const tenantId = await newTenant();
    const path = receiptPath("taken.json");
    await writeFile(path, "earlier\n");
    const { calls, run } = setup(tenantId, [...grantArgs, "--apply", "--backup", backupPath, "--receipt", path]);
    await expect(run()).rejects.toThrow(/EEXIST/);
    expect(calls).toEqual([]);
    expect(await row(tenantId)).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("earlier\n");
  });

  it("a failed backup check stops before the apply and is recorded", async () => {
    const tenantId = await newTenant();
    const path = receiptPath("bad-backup.json");
    const { run } = setup(tenantId, [...grantArgs, "--apply", "--backup", backupPath, "--receipt", path], { backupFails: true });
    await expect(run()).rejects.toThrow(/taken from project/);
    expect(await row(tenantId)).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ result: "failed", failedPhase: "backup-check", committed: false });
  });

  it("a failed apply is recorded as not committed, and a read-back that disagrees fails the verify phase", async () => {
    const tenantId = await newTenant();
    const path = receiptPath("verify.json");
    const run = runPlanGrant(
      { mode: "apply", receiptPath: path },
      {
        input: { tenantId, request: { kind: "set", plan: "solo", until: null, note: "n", by: "d" } },
        target: { projectRef: FAKE_REF },
        grant: (input) => planGrant(deps(), input),
        readGrant: async () => null,
        clock,
        log: () => undefined,
        logError: () => undefined,
      },
    );
    await expect(run).rejects.toThrow(/read back does not match/);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ result: "failed", failedPhase: "verify", committed: true });
    expect(await row(tenantId)).toMatchObject({ granted_plan: "solo" });
  });

  it("keeps secrets out of the output: the fake password never appears in the receipt or the log", async () => {
    const tenantId = await newTenant();
    const path = receiptPath("secrets.json");
    const { logs, run } = setup(tenantId, [...grantArgs, "--apply", "--backup", backupPath, "--receipt", path]);
    await run();
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("fake-password");
    expect(logs.join("\n")).not.toContain("fake-password");
  });
});
