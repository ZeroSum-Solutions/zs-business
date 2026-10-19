import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { meResponseSchema, memberOutputSchema } from "@zs/contracts";
import { createLocalStubSessionCheck } from "@zs/core";
import { asService, migrate } from "@zs/db";
import {
  createTestDatabase,
  installAuthStub,
  startAuthSession,
  upsertAuthUser,
  withTestDatabase,
  type TestDatabase,
} from "@zs/db/testing";
import { createApp, createHs256Verifier } from "../src/app.js";
import {
  provisionOwner,
  readMemberByEmail,
  runProvisionOwner,
  type MemberState,
  type ProvisionOwnerInput,
  type ProvisionOwnerRunDeps,
  type ProvisionOwnerSummary,
} from "../src/provision-owner.js";
import { call, clock, NOW, ORIGIN, SECRET, tokenFor } from "./helpers.js";

const migrations = new URL("../../../supabase/migrations/", import.meta.url);
const MEMBERS_MIGRATION = "20261019090000";

describe("provisioning the first owner of a tenant that predates tenant_members", () => {
  it("upgrades a populated database under FORCE RLS as a non-superuser migrator, provisions the owner, and the owner can sign in and act", async () => {
    // The database as hosted held it before this branch: every migration before tenant_members.
    const partial = await mkdtemp(join(tmpdir(), "zs-migrations-pre-members-"));
    try {
      for (const name of await readdir(migrations))
        if (name.endsWith(".sql") && name < MEMBERS_MIGRATION) await copyFile(new URL(name, migrations), join(partial, name));
      await withTestDatabase(async (database) => {
        const tenantId = randomUUID();
        const contactId = randomUUID();
        await asService(database.servicePool, async (tx) => {
          await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Pilot Tenant')", [tenantId]);
          await tx.query(
            `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
               buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
             VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,30,0,0,0,20160)`,
            [tenantId, randomUUID(), JSON.stringify([{ weekday: 1, windows: [{ startMinute: 540, endMinute: 1020 }] }])],
          );
          const pipelineId = randomUUID();
          await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Sales')", [tenantId, pipelineId]);
          await tx.query("INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,'New',0)",
            [tenantId, randomUUID(), pipelineId]);
          await tx.query(
            `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
             VALUES ($1,$2,'Existing Customer','customer@example.com',NULL,$3,$3)`,
            [tenantId, contactId, NOW],
          );
        });

        // Upgrade as the NOSUPERUSER CREATEROLE migrator, which forced RLS hides every row from.
        const url = new URL(database.url);
        url.username = database.migrator!;
        const migrator = new Pool({ connectionString: url.href, max: 1 });
        try {
          await migrate(migrator);
        } finally {
          await migrator.end();
        }
        const force = await database.pool.query<{ force: boolean }>(
          "SELECT relforcerowsecurity AS force FROM pg_class WHERE oid='public.tenant_members'::regclass");
        expect(force.rows[0]!.force).toBe(true);
        const owners = await database.pool.query("SELECT 1 FROM tenant_members WHERE tenant_id=$1", [tenantId]);
        expect(owners.rowCount).toBe(0);

        // The person signs in to Supabase; the stub stands in for hosted Auth after migrating.
        await installAuthStub(database.pool);
        const email = "pilot.owner@example.com";
        const actorId = await upsertAuthUser(database.pool, { email, appMetadata: { tenant_id: tenantId } });
        const sessionId = await startAuthSession(database.pool, actorId);
        const token = await tokenFor({ tenantId, actorId, sessionId });
        const app = createApp({
          verifier: createHs256Verifier(SECRET, { clock }),
          // As apps/api/test/helpers.ts: the loopback auth stub stands in for Supabase Auth.
          sessionCheck: createLocalStubSessionCheck(database.db, clock),
          clock,
          db: database.db,
          generateId: randomUUID,
          config: { allowedOrigins: [ORIGIN] },
        });

        // Before provisioning: a valid session with no membership is refused.
        expect((await call(app, "GET", "/v1/me", { token })).status).toBe(403);

        const summary = await provisionOwner({
          service: database.servicePool,
          clock,
          generateId: randomUUID,
          findAuthUserId: async (wanted) => (await database.pool.query<{ id: string }>(
            "SELECT id FROM auth.users WHERE lower(email) = $1 AND deleted_at IS NULL", [wanted],
          )).rows[0]?.id ?? null,
        }, { tenantId, email: "  Pilot.Owner@Example.com ", dryRun: false });
        expect(summary).toMatchObject({
          tenantId, tenantName: "Pilot Tenant", email, role: "owner", userId: actorId, action: "created",
          boundUser: true, before: null, activeOwnersBefore: 0, dryRun: false,
        });

        const me = await call(app, "GET", "/v1/me", { token });
        expect(me.status).toBe(200);
        expect(meResponseSchema.parse(me.body)).toMatchObject({ tenantId, userId: actorId, memberId: summary.memberId, role: "owner" });
        const contacts = await call(app, "GET", "/v1/crm/contacts", { token });
        expect(contacts.status).toBe(200);
        expect((contacts.body as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([contactId]);
        const invited = await call(app, "POST", "/v1/members", {
          token, key: randomUUID(), body: { email: "staff@example.com", role: "staff" },
        });
        expect(invited.status).toBe(201);
        expect(memberOutputSchema.parse(invited.body).result).toMatchObject({ email: "staff@example.com", role: "staff", status: "invited" });
      }, undefined, { migrations: pathToFileURL(`${partial}/`), nonSuperuserMigrator: true, authStub: false });
    } finally {
      await rm(partial, { recursive: true, force: true });
    }
  }, 60000);
});

describe("provisionOwner", () => {
  let database: TestDatabase;
  const users = new Map<string, string>();
  const lookups: string[] = [];
  beforeAll(async () => { database = await createTestDatabase(); });
  afterAll(async () => { await database?.close(); });

  const provision = (input: Omit<ProvisionOwnerInput, "dryRun"> & { dryRun?: boolean }) => provisionOwner({
    service: database.servicePool,
    clock,
    generateId: randomUUID,
    findAuthUserId: async (email) => {
      lookups.push(email);
      return users.get(email) ?? null;
    },
  }, { dryRun: false, ...input });
  async function newTenant(): Promise<string> {
    const tenantId = randomUUID();
    await asService(database.servicePool, (tx) => tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,'Tenant')", [tenantId]));
    return tenantId;
  }
  const rows = (tenantId: string) => asService(database.servicePool, async (tx) => (await tx.query(
    "SELECT id, email, user_id, role::text AS role, updated_at FROM tenant_members WHERE tenant_id=$1 ORDER BY email", [tenantId],
  )).rows);
  const addMember = (tenantId: string, email: string, role: "owner" | "staff", userId: string | null) =>
    asService(database.servicePool, (tx) => tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id",
      [tenantId, randomUUID(), email, userId, role, NOW],
    )).then((result) => result.rows[0].id as string);
  const newEmail = () => `owner-${randomUUID().slice(0, 8)}@example.com`;

  it("creates a pending owner while no Supabase user exists, and a re-run binds the user", async () => {
    const tenantId = await newTenant();
    const email = newEmail();
    const pending = await provision({ tenantId, email });
    expect(pending).toMatchObject({ action: "created", role: "owner", userId: null, boundUser: false, before: null });
    expect(pending.notes.join(" ")).toMatch(/re-run this step to bind/);
    expect(await rows(tenantId)).toMatchObject([{ id: pending.memberId, email, user_id: null, role: "owner" }]);

    const userId = randomUUID();
    users.set(email, userId);
    const bound = await provision({ tenantId, email });
    expect(bound).toMatchObject({
      action: "bound", memberId: pending.memberId, role: "owner", userId, boundUser: true,
      before: { memberId: pending.memberId, role: "owner", userId: null }, notes: [],
    });
    expect(await rows(tenantId)).toMatchObject([{ id: pending.memberId, user_id: userId, role: "owner" }]);
  });

  it("is idempotent: a second run reports unchanged and writes nothing", async () => {
    const tenantId = await newTenant();
    const email = newEmail();
    users.set(email, randomUUID());
    const first = await provision({ tenantId, email });
    expect(first.action).toBe("created");
    const before = await rows(tenantId);
    const again = await provision({ tenantId, email });
    expect(again).toMatchObject({ action: "unchanged", memberId: first.memberId, userId: first.userId, boundUser: false });
    expect(await rows(tenantId)).toEqual(before);
  });

  it("dry run reports what would change and rolls it back", async () => {
    const tenantId = await newTenant();
    const email = newEmail();
    const plan = await provision({ tenantId, email, dryRun: true });
    expect(plan).toMatchObject({ action: "created", dryRun: true, role: "owner", userId: null });
    expect(await rows(tenantId)).toEqual([]);

    await provision({ tenantId, email });
    users.set(email, randomUUID());
    const before = await rows(tenantId);
    expect(await provision({ tenantId, email, dryRun: true })).toMatchObject({ action: "bound", dryRun: true, userId: users.get(email) });
    expect(await rows(tenantId)).toEqual(before);
  });

  it("refuses an unknown tenant, a malformed tenant id and a malformed email", async () => {
    await expect(provision({ tenantId: randomUUID(), email: newEmail() })).rejects.toThrow(/tenant .* does not exist/);
    await expect(provision({ tenantId: "pilot", email: newEmail() })).rejects.toThrow(/tenant id must be a UUID/);
    const tenantId = await newTenant();
    const before = lookups.length;
    await expect(provision({ tenantId, email: "not an email" })).rejects.toThrow(/not a valid address/);
    expect(lookups.length).toBe(before);
    expect(await rows(tenantId)).toEqual([]);
  });

  it("refuses a member bound to a different user, and a bound member whose user is gone", async () => {
    const tenantId = await newTenant();
    const email = newEmail();
    const original = randomUUID();
    await addMember(tenantId, email, "owner", original);
    users.set(email, randomUUID());
    await expect(provision({ tenantId, email })).rejects.toThrow(/bound to a different Supabase user/);
    users.delete(email);
    await expect(provision({ tenantId, email })).rejects.toThrow(/no Supabase user has this email now/);
    expect(await rows(tenantId)).toMatchObject([{ user_id: original, role: "owner" }]);
  });

  it("refuses a user already bound to another member of the tenant", async () => {
    const tenantId = await newTenant();
    const userId = randomUUID();
    await addMember(tenantId, newEmail(), "staff", userId);
    const email = newEmail();
    users.set(email, userId);
    await expect(provision({ tenantId, email })).rejects.toThrow(/already bound to member .* under another email/);
    expect(await rows(tenantId)).toHaveLength(1);
  });

  it("refuses to change a staff member's role while an active owner exists, and promotes when none does", async () => {
    const tenantId = await newTenant();
    const staffEmail = newEmail();
    const staffUser = randomUUID();
    users.set(staffEmail, staffUser);
    const staffId = await addMember(tenantId, staffEmail, "staff", staffUser);
    const ownerId = await addMember(tenantId, newEmail(), "owner", randomUUID());
    await expect(provision({ tenantId, email: staffEmail })).rejects.toThrow(/is staff and the tenant has an active owner/);
    expect((await rows(tenantId)).find((row) => row.id === staffId)).toMatchObject({ role: "staff" });

    // A pending owner invite is not an active owner.
    await asService(database.servicePool, (tx) => tx.query("UPDATE tenant_members SET user_id=NULL WHERE tenant_id=$1 AND id=$2", [tenantId, ownerId]));
    const promoted = await provision({ tenantId, email: staffEmail });
    expect(promoted).toMatchObject({
      action: "promoted", memberId: staffId, role: "owner", userId: staffUser, activeOwnersBefore: 0,
      before: { memberId: staffId, role: "staff", userId: staffUser },
    });
    expect((await rows(tenantId)).find((row) => row.id === staffId)).toMatchObject({ role: "owner", user_id: staffUser });
    expect(await provision({ tenantId, email: staffEmail })).toMatchObject({ action: "unchanged" });
  });

  it("normalizes the email like contacts and members (trimmed, lowercase) before the lookup and the write", async () => {
    const tenantId = await newTenant();
    const email = newEmail();
    const userId = randomUUID();
    users.set(email, userId);
    const summary = await provision({ tenantId, email: `  ${email.toUpperCase()}\t` });
    expect(summary).toMatchObject({ email, userId, action: "created" });
    expect(lookups.at(-1)).toBe(email);
    expect(await rows(tenantId)).toMatchObject([{ email, user_id: userId }]);
    expect(await provision({ tenantId, email: email.replace("owner", "OWNER") })).toMatchObject({ action: "unchanged" });
    expect(await readMemberByEmail(database.servicePool, tenantId, email)).toEqual({ memberId: summary.memberId, role: "owner", userId });
  });
});

describe("runProvisionOwner", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "zs-provision-receipts-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  const tenantId = randomUUID();
  const email = "owner@example.com";
  const summary = (overrides: Partial<ProvisionOwnerSummary> = {}): ProvisionOwnerSummary => ({
    tenantId, tenantName: "Pilot", memberId: "11111111-1111-4111-8111-111111111111", email, role: "owner",
    userId: "22222222-2222-4222-8222-222222222222", action: "created", boundUser: true, before: null,
    activeOwnersBefore: 0, dryRun: false, notes: [], ...overrides,
  });
  function stubDeps(options: {
    provision?: (input: ProvisionOwnerInput) => Promise<ProvisionOwnerSummary>;
    readMember?: () => Promise<MemberState | null>;
  } = {}) {
    const calls: string[] = [];
    const logs: string[] = [];
    const deps: ProvisionOwnerRunDeps = {
      input: { tenantId, email },
      target: { host: "127.0.0.1", port: "55432", database: "zs_dev" },
      provision: async (input) => {
        calls.push(input.dryRun ? "dry-run" : "apply");
        return options.provision ? options.provision(input) : summary({ dryRun: input.dryRun });
      },
      readMember: async () => {
        calls.push("read");
        return options.readMember ? options.readMember() : { memberId: summary().memberId, role: "owner", userId: summary().userId };
      },
      clock,
      log: (line) => logs.push(line),
      logError: (line) => logs.push(line),
    };
    return { deps, calls, logs };
  }
  const receiptAt = (name: string) => join(dir, name);
  const readReceipt = async (path: string) => JSON.parse(await readFile(path, "utf8"));

  it("dry-run mode runs one rolled-back provision and writes no receipt", async () => {
    const { deps, calls, logs } = stubDeps();
    await runProvisionOwner({ mode: "dry-run" }, deps);
    expect(calls).toEqual(["dry-run"]);
    expect(JSON.parse(logs[0]!)).toMatchObject({ mode: "dry-run", result: "rolled back", plan: { action: "created", dryRun: true } });
  });

  it("reserves the receipt before any database work: an existing file fails first and stays as it was", async () => {
    const path = receiptAt("existing.json");
    await writeFile(path, "earlier receipt\n");
    const { deps, calls } = stubDeps();
    await expect(runProvisionOwner({ mode: "apply", receiptPath: path }, deps)).rejects.toThrow(/EEXIST/);
    expect(calls).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("earlier receipt\n");
    const missingFolder = stubDeps();
    await expect(runProvisionOwner({ mode: "apply", receiptPath: join(dir, "no-such-dir", "r.json") }, missingFolder.deps)).rejects.toThrow(/ENOENT/);
    expect(missingFolder.calls).toEqual([]);
  });

  it("writes the receipt on success: dry run, apply, read-back, committed", async () => {
    const path = receiptAt("success.json");
    const { deps, calls } = stubDeps();
    const result = await runProvisionOwner({ mode: "apply", receiptPath: path }, deps);
    expect(result.action).toBe("created");
    expect(calls).toEqual(["dry-run", "apply", "read"]);
    expect(await readReceipt(path)).toMatchObject({
      mode: "apply", result: "committed", committed: true, tenantId,
      plan: { dryRun: true }, applied: { action: "created", dryRun: false },
      after: { memberId: summary().memberId, role: "owner" }, startedAt: NOW, finishedAt: NOW,
    });
  });

  it("records an unchanged run as unchanged with nothing committed", async () => {
    const path = receiptAt("unchanged.json");
    const unchanged = summary({ action: "unchanged", boundUser: false });
    const { deps } = stubDeps({ provision: async (input) => ({ ...unchanged, dryRun: input.dryRun }) });
    await runProvisionOwner({ mode: "apply", receiptPath: path }, deps);
    expect(await readReceipt(path)).toMatchObject({ result: "unchanged", committed: false });
  });

  it("writes the receipt on failure with the failed phase, committed false and a redacted error", async () => {
    const path = receiptAt("dry-run-failed.json");
    const { deps, calls } = stubDeps({
      provision: async () => {
        throw new Error("connect failed for postgres://postgres.abcdefghijklmnopqrst:hunter2@aws-0-us-east-1.pooler.supabase.com:5432/postgres password=hunter2");
      },
    });
    await expect(runProvisionOwner({ mode: "apply", receiptPath: path }, deps)).rejects.toThrow();
    expect(calls).toEqual(["dry-run"]);
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("pooler.supabase.com");
    expect(JSON.parse(text)).toMatchObject({
      result: "failed", failedPhase: "dry-run", committed: false,
      error: "connect failed for postgres://[redacted] password=[redacted]",
    });
  });

  it("after an apply-phase failure reads the row back to say whether the change committed", async () => {
    const lost = receiptAt("apply-lost-reply.json");
    const landed = stubDeps({
      provision: async (input) => {
        if (input.dryRun) return summary({ dryRun: true, memberId: randomUUID() });
        throw new Error("Connection terminated unexpectedly");
      },
    });
    await expect(runProvisionOwner({ mode: "apply", receiptPath: lost }, landed.deps)).rejects.toThrow(/terminated/);
    expect(landed.calls).toEqual(["dry-run", "apply", "read"]);
    expect(await readReceipt(lost)).toMatchObject({ result: "failed", failedPhase: "apply", committed: true });

    const rolledBack = receiptAt("apply-rolled-back.json");
    const none = stubDeps({
      provision: async (input) => {
        if (input.dryRun) return summary({ dryRun: true });
        throw new Error("duplicate key value violates unique constraint");
      },
      readMember: async () => null,
    });
    await expect(runProvisionOwner({ mode: "apply", receiptPath: rolledBack }, none.deps)).rejects.toThrow(/duplicate key/);
    expect(await readReceipt(rolledBack)).toMatchObject({ result: "failed", failedPhase: "apply", committed: false, after: null });
  });

  it("a read-back that disagrees fails the verify phase but still records the commit", async () => {
    const path = receiptAt("verify-failed.json");
    const { deps } = stubDeps({ readMember: async () => ({ memberId: summary().memberId, role: "staff", userId: null }) });
    await expect(runProvisionOwner({ mode: "apply", receiptPath: path }, deps)).rejects.toThrow(/does not match/);
    expect(await readReceipt(path)).toMatchObject({ result: "failed", failedPhase: "verify", committed: true });
  });
});
