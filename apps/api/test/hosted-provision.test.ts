import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService } from "@zs/db";
import { createTestDatabase, type TestDatabase } from "@zs/db/testing";
import { redactSecrets } from "../src/hosted.js";
import { parseHostedProvisionArgs, runHostedProvisionOwner, type HostedProvisionConfig } from "../src/hosted-provision.js";
import { assertServiceKey, createSupabaseAuthAdmin } from "../src/supabase-auth-admin.js";
import { FAKE_REF, FAKE_SERVICE_KEY, fakeGoTrue } from "./fake-gotrue.js";
import { clock } from "./helpers.js";

const SERVICE_URL = `postgres://postgres.${FAKE_REF}:fake-password@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
const ENV = { ZS_TARGET_REF: FAKE_REF, SERVICE_DATABASE_URL: SERVICE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SERVICE_KEY };
/** An unsigned JWT with these claims: assertServiceKey reads `ref` and `role`, the server checks the signature. */
const jwtWith = (claims: Record<string, unknown>) =>
  ["eyJhbGciOiJIUzI1NiJ9", Buffer.from(JSON.stringify(claims)).toString("base64url"), "c2lnbmF0dXJl"].join(".");

describe("assertServiceKey", () => {
  it("accepts a service_role JWT for the target project and an sb_secret_ key", () => {
    const key = jwtWith({ role: "service_role", ref: FAKE_REF });
    expect(assertServiceKey(key, FAKE_REF)).toBe(key);
    expect(assertServiceKey(FAKE_SERVICE_KEY, FAKE_REF)).toBe(FAKE_SERVICE_KEY);
  });

  it("refuses a missing key, another project's key, the anon key and anything else, without echoing it", () => {
    const cases: [string | undefined, RegExp][] = [
      [undefined, /is required/],
      [jwtWith({ role: "service_role", ref: "zyxwvutsrqponmlkjihg" }), /not the service_role key of project/],
      [jwtWith({ role: "anon", ref: FAKE_REF }), /not the service_role key of project/],
      ["sb_publishable_abcdefghijklmnopqrstuvwxyz", /not a Supabase service_role JWT/],
      ["hunter2-not-a-key", /not a Supabase service_role JWT/],
    ];
    for (const [key, pattern] of cases) {
      let message = "";
      try {
        assertServiceKey(key, FAKE_REF);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(pattern);
      if (key) expect(message).not.toContain(key);
    }
  });
});

describe("createSupabaseAuthAdmin", () => {
  it("finds a user by exact email across pages, through the filter, with the service key on every call", async () => {
    const gotrue = fakeGoTrue();
    for (const email of ["aowner@example.com", "owner@example.com.test", "x-owner@example.com"]) gotrue.addUser(email);
    const id = gotrue.addUser("owner@example.com", { tenant_id: "t-1" });
    gotrue.addUser("gone-owner@example.com");
    const admin = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY, fetch: gotrue.fetch, perPage: 2 });
    expect(await admin.findUser("  Owner@Example.com ")).toEqual({ id, tenantId: "t-1" });
    expect(await admin.findUser("nobody@example.com")).toBeNull();
    // Five users contain "owner@example.com" as a substring; two per page means three pages.
    const lists = gotrue.requests.filter((request) => request.method === "GET" && request.url.includes("filter=owner%40example.com"));
    expect(lists.map((request) => new URL(request.url).searchParams.get("page"))).toEqual(["1", "2", "3"]);
    for (const request of gotrue.requests) {
      expect(new URL(request.url).origin).toBe(`https://${FAKE_REF}.supabase.co`);
      expect(request.headers).toMatchObject({ apikey: FAKE_SERVICE_KEY, authorization: `Bearer ${FAKE_SERVICE_KEY}` });
    }
  });

  it("refuses two users with one email, a non-string claim, and a list longer than maxPages", async () => {
    const gotrue = fakeGoTrue();
    gotrue.addUser("twin@example.com");
    gotrue.addUser("TWIN@example.com".toLowerCase());
    const odd = gotrue.addUser("odd@example.com", { tenant_id: 42 });
    const admin = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY, fetch: gotrue.fetch });
    await expect(admin.findUser("twin@example.com")).rejects.toThrow(/more than one user has this email/);
    await expect(admin.findUser("odd@example.com")).rejects.toThrow(/tenant_id is not a string/);
    await expect(admin.readTenantClaim(odd)).rejects.toThrow(/tenant_id is not a string/);
    const paged = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY, fetch: gotrue.fetch, perPage: 1, maxPages: 2 });
    await expect(paged.findUser("example.com")).rejects.toThrow(/more than 2 pages/);
  });

  it("sets the tenant claim keeping other app_metadata keys, reads it back, and creates and deletes users", async () => {
    const gotrue = fakeGoTrue();
    const admin = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY, fetch: gotrue.fetch });
    const id = gotrue.addUser("claim@example.com");
    expect(await admin.readTenantClaim(id)).toBeNull();
    await admin.setTenantClaim(id, "tenant-a");
    expect(gotrue.users.get(id)!.app_metadata).toEqual({ provider: "email", providers: ["email"], tenant_id: "tenant-a" });
    expect(gotrue.requests.at(-1)).toMatchObject({ method: "PUT", body: { app_metadata: { tenant_id: "tenant-a" } } });
    expect(await admin.readTenantClaim(id)).toBe("tenant-a");
    expect(await admin.readTenantClaim(randomUUID())).toBeNull();

    const created = await admin.createUser({ email: "temp@example.com", password: "p".repeat(40), appMetadata: { tenant_id: "tenant-b" } });
    expect(gotrue.requests.at(-1)!.body).toMatchObject({ email: "temp@example.com", email_confirm: true, app_metadata: { tenant_id: "tenant-b" } });
    expect(await admin.readTenantClaim(created)).toBe("tenant-b");
    await admin.deleteUser(created);
    expect(gotrue.users.has(created)).toBe(false);
    await expect(admin.deleteUser(created)).rejects.toThrow(/delete user failed: HTTP 404 \(user_not_found\)/);
  });

  it("reports failures by status and code only, never the reply text or the key", async () => {
    const gotrue = fakeGoTrue();
    const id = gotrue.addUser("fail@example.com");
    gotrue.failAll(500);
    const admin = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY, fetch: gotrue.fetch });
    for (const call of [() => admin.findUser("fail@example.com"), () => admin.setTenantClaim(id, "t"), () => admin.readTenantClaim(id)]) {
      const error = await call().then(() => null, (thrown: Error) => thrown);
      expect(error?.message).toMatch(/failed: HTTP 500 \(unexpected_failure\)$/);
      expect(error?.message).not.toContain(FAKE_SERVICE_KEY);
    }
    const down = createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: FAKE_SERVICE_KEY,
      fetch: (async () => { throw new Error(`socket closed ${FAKE_SERVICE_KEY}`); }) as typeof fetch });
    await expect(down.findUser("fail@example.com")).rejects.toThrow(/^Supabase Auth admin find user failed: no answer from Supabase Auth$/);
  });

  it("redactSecrets hides JWTs and sb_ keys as well as connection strings", () => {
    const jwt = jwtWith({ role: "service_role", ref: FAKE_REF });
    expect(redactSecrets(`key ${jwt} and ${FAKE_SERVICE_KEY} at ${SERVICE_URL}`))
      .toBe("key [redacted-jwt] and sb_secret_[redacted] at postgres://[redacted]");
  });
});

describe("parseHostedProvisionArgs", () => {
  const tenant = randomUUID();
  const base = ["--tenant", tenant, "--email", "owner@example.com"];

  it("reads a dry run and an apply with backup and receipt", () => {
    expect(parseHostedProvisionArgs([...base, "--dry-run"], ENV)).toMatchObject({
      tenantId: tenant, email: "owner@example.com", mode: { mode: "dry-run" },
      target: { projectRef: FAKE_REF, role: "postgres" }, serviceKey: FAKE_SERVICE_KEY,
    });
    expect(parseHostedProvisionArgs([...base, "--apply", "--backup", "/tmp/b.dump", "--receipt", "/tmp/r.json"], ENV).mode)
      .toEqual({ mode: "apply", backupPath: "/tmp/b.dump", receiptPath: "/tmp/r.json" });
  });

  it.each([
    [[...base], /exactly one of --dry-run or --apply/],
    [[...base, "--dry-run", "--apply"], /exactly one of --dry-run or --apply/],
    [[...base, "--apply", "--receipt", "/tmp/r.json"], /--apply needs --backup <file> and --receipt <file>/],
    [[...base, "--apply", "--backup", "/tmp/b.dump"], /--apply needs --backup <file> and --receipt <file>/],
    [[...base, "--dry-run", "--receipt", "/tmp/r.json"], /go with --apply only/],
    [["--email", "owner@example.com", "--dry-run"], /Pass --tenant/],
  ])("refuses %j", (argv, pattern) => {
    expect(() => parseHostedProvisionArgs(argv, ENV)).toThrow(pattern);
  });

  it("refuses a local or another project's database URL and a key for another project, before connecting", () => {
    const dry = [...base, "--dry-run"];
    expect(() => parseHostedProvisionArgs(dry, { ...ENV, SERVICE_DATABASE_URL: "postgres://postgres@127.0.0.1:55432/zs_dev" }))
      .toThrow(/Supabase pooler host/);
    expect(() => parseHostedProvisionArgs(dry, { ...ENV, SERVICE_DATABASE_URL: SERVICE_URL.replace(FAKE_REF, "zyxwvutsrqponmlkjihg") }))
      .toThrow(/must log in as postgres on project/);
    expect(() => parseHostedProvisionArgs(dry, { ...ENV, SERVICE_DATABASE_URL: `${SERVICE_URL}?sslmode=disable` })).toThrow(/query parameters/);
    expect(() => parseHostedProvisionArgs(dry, { ...ENV, ZS_TARGET_REF: "" })).toThrow(/ZS_TARGET_REF/);
    expect(() => parseHostedProvisionArgs(dry, { ...ENV, SUPABASE_SERVICE_ROLE_KEY: jwtWith({ role: "service_role", ref: "zyxwvutsrqponmlkjihg" }) }))
      .toThrow(/not the service_role key of project/);
  });
});

describe("runHostedProvisionOwner on local Postgres with a fake Auth admin API", () => {
  let database: TestDatabase;
  let dir: string;
  beforeAll(async () => {
    database = await createTestDatabase();
    dir = await mkdtemp(join(tmpdir(), "zs-hosted-provision-"));
  });
  afterAll(async () => {
    await database?.close();
    await rm(dir, { recursive: true, force: true });
  });

  async function newTenant(): Promise<string> {
    const tenantId = randomUUID();
    await asService(database.servicePool, (tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Pilot Tenant')", [tenantId]));
    return tenantId;
  }
  const members = (tenantId: string) => asService(database.servicePool, async (tx) => (await tx.query(
    "SELECT email, user_id, role::text AS role FROM tenant_members WHERE tenant_id=$1", [tenantId])).rows);

  function setup(tenantId: string, mode: HostedProvisionConfig["mode"], options: { backupFails?: boolean } = {}) {
    const gotrue = fakeGoTrue();
    const calls: string[] = [];
    const logs: string[] = [];
    const config = parseHostedProvisionArgs(
      ["--tenant", tenantId, "--email", "Owner@Example.com",
        ...(mode.mode === "dry-run" ? ["--dry-run"] : ["--apply", "--backup", mode.backupPath, "--receipt", mode.receiptPath])], ENV);
    const run = () => runHostedProvisionOwner(config, {
      service: database.servicePool,
      auth: createSupabaseAuthAdmin({ projectRef: FAKE_REF, serviceKey: config.serviceKey, fetch: gotrue.fetch }),
      checkBackup: async (path) => {
        calls.push(`backup ${path}`);
        if (options.backupFails) throw new Error("Refusing to apply: the backup was taken from project zyxwvutsrqponmlkjihg, not ZS_TARGET_REF");
        return { sha256: "0".repeat(64), manifest: { projectRef: FAKE_REF } };
      },
      clock,
      generateId: randomUUID,
      log: (line) => logs.push(line),
      logError: (line) => logs.push(line),
    });
    return { gotrue, calls, logs, run };
  }
  const receiptPath = (name: string) => join(dir, name);
  const backupPath = join(tmpdir(), "zs-fake-backup.dump");

  it("dry run: reports the plan, writes no row and sets no claim", async () => {
    const tenantId = await newTenant();
    const { gotrue, calls, logs, run } = setup(tenantId, { mode: "dry-run" });
    const userId = gotrue.addUser("owner@example.com");
    const plan = await run();
    expect(plan).toMatchObject({ action: "created", userId, tenantClaim: "would-set", dryRun: true, email: "owner@example.com" });
    expect(JSON.parse(logs[0]!)).toMatchObject({ mode: "dry-run", result: "rolled back", target: { projectRef: FAKE_REF, role: "postgres" } });
    expect(await members(tenantId)).toEqual([]);
    expect(gotrue.claimOf(userId)).toBeUndefined();
    expect(gotrue.requests.every((request) => request.method === "GET")).toBe(true);
    expect(calls).toEqual([]);
  });

  it("apply: dry run, backup check, row bound to the Supabase user, claim set and read back, receipt without secrets", async () => {
    const tenantId = await newTenant();
    const path = receiptPath("applied.json");
    const { gotrue, calls, logs, run } = setup(tenantId, { mode: "apply", receiptPath: path, backupPath });
    const userId = gotrue.addUser("owner@example.com");
    const applied = await run();
    expect(applied).toMatchObject({ action: "created", userId, tenantClaim: "set", role: "owner" });
    expect(calls).toEqual([`backup ${backupPath}`]);
    expect(await members(tenantId)).toEqual([{ email: "owner@example.com", user_id: userId, role: "owner" }]);
    expect(gotrue.claimOf(userId)).toBe(tenantId);
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      result: "committed", committed: true, tenantClaimAfter: tenantId, after: { userId, role: "owner" },
      backup: { file: backupPath, sha256: "0".repeat(64) }, target: { projectRef: FAKE_REF },
    });
    for (const secret of [FAKE_SERVICE_KEY, "fake-password"]) {
      expect(text).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    // A second run changes nothing.
    const again = setup(tenantId, { mode: "apply", receiptPath: receiptPath("again.json"), backupPath });
    again.gotrue.users.set(userId, gotrue.users.get(userId)!);
    expect(await again.run()).toMatchObject({ action: "unchanged", tenantClaim: "present" });
    expect(JSON.parse(await readFile(receiptPath("again.json"), "utf8"))).toMatchObject({ result: "unchanged", committed: false });
  });

  it("reserves the receipt first: an existing receipt stops the run before any Auth call, backup check or write", async () => {
    const tenantId = await newTenant();
    const path = receiptPath("taken.json");
    await writeFile(path, "earlier\n");
    const { gotrue, calls, run } = setup(tenantId, { mode: "apply", receiptPath: path, backupPath });
    gotrue.addUser("owner@example.com");
    await expect(run()).rejects.toThrow(/EEXIST/);
    expect(gotrue.requests).toEqual([]);
    expect(calls).toEqual([]);
    expect(await members(tenantId)).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("earlier\n");
  });

  it("a failed backup check stops before the apply and is recorded", async () => {
    const tenantId = await newTenant();
    const path = receiptPath("bad-backup.json");
    const { gotrue, run } = setup(tenantId, { mode: "apply", receiptPath: path, backupPath }, { backupFails: true });
    const userId = gotrue.addUser("owner@example.com");
    await expect(run()).rejects.toThrow(/taken from project/);
    expect(await members(tenantId)).toEqual([]);
    expect(gotrue.claimOf(userId)).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ result: "failed", failedPhase: "backup-check", committed: false });
  });

  it("refuses a user whose claim names another tenant (the c104ff0 rule), with nothing written", async () => {
    const tenantId = await newTenant();
    const other = randomUUID();
    const path = receiptPath("conflict.json");
    const { gotrue, run } = setup(tenantId, { mode: "apply", receiptPath: path, backupPath });
    const userId = gotrue.addUser("owner@example.com", { tenant_id: other });
    await expect(run()).rejects.toThrow(/tenant claim already names another tenant/);
    expect(await members(tenantId)).toEqual([]);
    expect(gotrue.claimOf(userId)).toBe(other);
    expect(gotrue.requests.some((request) => request.method === "PUT")).toBe(false);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ result: "failed", failedPhase: "dry-run", committed: false });
  });

  it("without a Supabase user the owner is pending, and a later run binds it and sets the claim", async () => {
    const tenantId = await newTenant();
    const first = setup(tenantId, { mode: "apply", receiptPath: receiptPath("pending.json"), backupPath });
    expect(await first.run()).toMatchObject({ action: "created", userId: null, tenantClaim: "no-user" });
    expect(await members(tenantId)).toEqual([{ email: "owner@example.com", user_id: null, role: "owner" }]);

    const second = setup(tenantId, { mode: "apply", receiptPath: receiptPath("bind.json"), backupPath });
    const userId = second.gotrue.addUser("owner@example.com");
    expect(await second.run()).toMatchObject({ action: "bound", userId, tenantClaim: "set" });
    expect(second.gotrue.claimOf(userId)).toBe(tenantId);
  });
});
