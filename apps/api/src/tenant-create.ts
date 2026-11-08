// Owner-run tenant creation (docs/requirements/industry-templates.md IT-9): the tenant row with an
// id derived from its key, the business profile's time zone when given, and the first owner
// through provisionOwner (pending until the owner's user exists and a rerun binds it). It applies
// no template: the owner does that at /setup. Every phase checks what exists first, so a rerun
// resumes and replays; a rerun whose name, owner email or zone differs refuses before any write,
// and so does an owner email whose user (or membership) already belongs to another tenant: the
// platform allows one tenant claim per user.
//
// Concurrency (IT-9, D3): a run holds two session advisory locks, one on the key and one on the
// normalized owner email, on ONE dedicated connection for the whole run (both phases), and
// releases them in `finally`. Everything that decides a refusal (the claim, the memberships, the
// stored name, zone and intended owner email) is read again under those locks. Phase 1 stores the
// intended owner email on the tenant row, so a run resumed after a crash with another email refuses.
// Entry points: src/scripts/tenant-create.ts (local, the auth stub) and
// src/scripts/hosted-tenant-create.ts (hosted, owner-run, session pooler).
import { open, type FileHandle } from "node:fs/promises";
import type { Pool } from "pg";
import { bookingTimeZoneSchema, memberEmailSchema } from "@zs/contracts";
import { derivedId } from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import { redactSecrets } from "./hosted.js";
import { provisionOwner, type ProvisionOwnerDeps, type ProvisionOwnerSummary } from "./provision-owner.js";

/** IT-9: the slug the tenant id derives from. */
export const TENANT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/;
/** The same key always names the same tenant, on every database. */
export const tenantIdForKey = (key: string): string => derivedId("tenant", key);

export interface TenantCreateInput {
  readonly key: string;
  readonly name: string;
  readonly ownerEmail: string;
  readonly timeZone?: string | undefined;
  /** Check and plan only; nothing is written. */
  readonly dryRun: boolean;
}

/** The owner step: provisionOwner's report, or its plan for a tenant not created yet. */
export type TenantOwnerStep =
  | { readonly kind: "provisioned"; readonly summary: ProvisionOwnerSummary }
  | { readonly kind: "would-provision"; readonly email: string; readonly userExists: boolean };

export interface TenantCreateSummary {
  readonly tenantId: string;
  readonly key: string;
  readonly name: string;
  readonly ownerEmail: string;
  readonly timeZone: string | null;
  readonly tenant: "created" | "unchanged" | "would-create";
  readonly timeZoneStep: "set" | "unchanged" | "would-set" | "none";
  readonly owner: TenantOwnerStep;
  readonly dryRun: boolean;
  readonly notes: readonly string[];
}

function refuse(reason: string): never {
  throw new Error(`Refusing to create the tenant: ${reason}`);
}

interface Checked {
  readonly tenantId: string;
  readonly key: string;
  readonly name: string;
  readonly email: string;
  readonly timeZone: string | null;
}

/** Arguments only, before anything connects. */
export function checkTenantCreateInput(input: TenantCreateInput): Checked {
  if (!TENANT_KEY_PATTERN.test(input.key)) refuse("--key must match ^[a-z0-9][a-z0-9-]{2,39}$");
  const name = input.name.trim();
  // The tenant trigger trims and cuts a name to 120 characters (code points, as Postgres counts them, not UTF-16
  // units: a name of emoji is 120 characters at 240 units); refuse one it would change.
  if (name.length < 1 || [...name].length > 120 || name !== input.name) refuse("--name must be 1 to 120 characters with no outer spaces");
  const email = memberEmailSchema.safeParse(input.ownerEmail);
  if (!email.success) refuse("--owner-email is not a valid address");
  // An explicit empty zone is a bad zone, not an omitted one.
  const timeZone = input.timeZone ?? null;
  if (timeZone !== null && !bookingTimeZoneSchema.safeParse(timeZone).success) refuse("--time-zone is not an IANA time zone name");
  return { tenantId: tenantIdForKey(input.key), key: input.key, name, email: email.data, timeZone };
}

interface Existing {
  readonly tenantName: string | null;
  /** The owner email phase 1 stored when it created the tenant; null before that or for an older tenant. */
  readonly intendedOwner: string | null;
  readonly zone: string | null;
  readonly ownerEmails: readonly string[];
  /** Memberships of this email, of any role, on other tenants. */
  readonly elsewhere: readonly { tenantId: string; role: string }[];
}

async function readExisting(tx: Transaction, input: Checked): Promise<Existing> {
  if (input.timeZone !== null &&
    (await tx.query("SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=$1", [input.timeZone])).rowCount !== 1)
    refuse(`${input.timeZone} is not a time zone PostgreSQL knows`);
  const tenant = (await tx.query<{ name: string; owner: string | null }>(
    "SELECT name, provisioning_owner_email AS owner FROM tenants WHERE tenant_id=$1", [input.tenantId])).rows[0];
  const zone = (await tx.query<{ time_zone: string | null }>(
    "SELECT time_zone FROM business_profiles WHERE tenant_id=$1", [input.tenantId])).rows[0]?.time_zone ?? null;
  const owners = (await tx.query<{ email: string }>(
    "SELECT email FROM tenant_members WHERE tenant_id=$1 AND role='owner' ORDER BY email", [input.tenantId])).rows;
  const elsewhere = (await tx.query<{ tenant_id: string; role: string }>(
    "SELECT tenant_id, role::text AS role FROM tenant_members WHERE email=$1 AND tenant_id<>$2 ORDER BY tenant_id",
    [input.email, input.tenantId])).rows;
  return {
    tenantName: tenant?.name ?? null,
    intendedOwner: tenant?.owner ?? null,
    zone,
    ownerEmails: owners.map((row) => row.email),
    elsewhere: elsewhere.map((row) => ({ tenantId: row.tenant_id, role: row.role })),
  };
}

/**
 * IT-9: refuse before any write. A rerun with another name, owner email or zone; and an owner email
 * whose user holds another tenant's claim or whose email is a member of another tenant (one tenant
 * claim per user is a platform limit, so the owner needs an address of their own).
 */
function refuseUnsafe(input: Checked, existing: Existing, found: { tenantId: string | null } | null): void {
  if (found?.tenantId && found.tenantId !== input.tenantId)
    refuse(`the owner's user already holds the tenant claim of tenant ${found.tenantId}; one tenant claim per user, so use another owner email`);
  const other = existing.elsewhere[0];
  if (other)
    refuse(`${input.email} is already a ${other.role} of tenant ${other.tenantId}; one tenant claim per user, so use another owner email`);
  if (existing.tenantName === null) return;
  if (existing.tenantName !== input.name) refuse(`tenant ${input.key} exists with another name (${existing.tenantName})`);
  if (existing.intendedOwner !== null && existing.intendedOwner !== input.email)
    refuse(`tenant ${input.key} was started for another owner email`);
  if (existing.ownerEmails.length > 0 && !existing.ownerEmails.includes(input.email))
    refuse(`tenant ${input.key} already has another owner email`);
  if (input.timeZone !== null && existing.zone !== null && existing.zone !== input.timeZone)
    refuse(`tenant ${input.key} has another time zone (${existing.zone})`);
}

const LOCK_WAIT = "30s";

/**
 * Run `work` while this process holds a session advisory lock for each name, in order, on one
 * dedicated connection. The locks go in `finally`; if they cannot be released cleanly the
 * connection is destroyed, which drops them, so a lock never stays on a pooled client.
 */
export async function withSessionLocks<T>(pool: Pool, names: readonly string[], work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let clean = false;
  try {
    await client.query("SELECT set_config('lock_timeout', $1, false)", [LOCK_WAIT]);
    for (const name of names) {
      try {
        await client.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [name]);
      } catch (error) {
        if ((error as { code?: string }).code === "55P03") refuse("another tenant:create for this key or owner email is still running; try again in a minute");
        throw error;
      }
    }
    return await work();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock_all()");
      await client.query("RESET lock_timeout");
      clean = true;
    } catch {
      // The connection is in an unknown state: destroy it so its locks are gone.
    }
    client.release(!clean);
  }
}

/** Two runs for one key, or for one owner email, take the same locks in the same order. */
const lockNames = (input: Checked) => [`tenant-create:email:${input.email}`, `tenant-create:key:${input.tenantId}`];

/**
 * Create the tenant, set its zone and provision its owner. A dry run reads and plans. An apply
 * holds the email and key locks for both phases. Phase 1 (one service_role transaction): check,
 * then insert the tenant (with the intended owner email) and set the zone where missing. Phase 2:
 * provisionOwner.
 */
export async function createTenant(deps: ProvisionOwnerDeps, raw: TenantCreateInput, hooks: TenantCreateHooks = {}): Promise<TenantCreateSummary> {
  const input = checkTenantCreateInput(raw);
  if (raw.dryRun) return execute(deps, input, true);
  return withSessionLocks(deps.service, lockNames(input), () => execute(deps, input, false, hooks));
}

export interface TenantCreateHooks {
  /**
   * Makes the owner's Auth user. It runs under the run's locks, after every refusal that does not depend on the user
   * has been checked, and only when the user does not exist yet: a rerun that would refuse (another owner email stored,
   * another name, another tenant's member) creates no Auth user.
   */
  readonly createOwnerUser?: () => Promise<void>;
}

async function execute(deps: ProvisionOwnerDeps, input: Checked, dryRun: boolean, hooks: TenantCreateHooks = {}): Promise<TenantCreateSummary> {
  // Read under the locks (an apply): another run may have claimed the user since any earlier look.
  let found = await deps.auth.findUser(input.email);
  if (!dryRun && hooks.createOwnerUser) {
    await asService(deps.service, async (tx) => refuseUnsafe(input, await readExisting(tx, input), found));
    if (found === null) {
      await hooks.createOwnerUser();
      found = await deps.auth.findUser(input.email);
    }
  }

  const phase1 = await asService(deps.service, async (tx) => {
    const existing = await readExisting(tx, input);
    refuseUnsafe(input, existing, found);
    const tenant: TenantCreateSummary["tenant"] = existing.tenantName !== null ? "unchanged" : dryRun ? "would-create" : "created";
    const timeZoneStep: TenantCreateSummary["timeZoneStep"] = input.timeZone === null
      ? "none"
      : existing.zone === input.timeZone ? "unchanged" : dryRun ? "would-set" : "set";
    if (!dryRun) {
      if (tenant === "created")
        await tx.query("INSERT INTO tenants (tenant_id,name,provisioning_owner_email) VALUES ($1,$2,$3)", [input.tenantId, input.name, input.email]);
      else if (existing.intendedOwner === null)
        await tx.query("UPDATE tenants SET provisioning_owner_email=$2 WHERE tenant_id=$1 AND provisioning_owner_email IS NULL", [input.tenantId, input.email]);
      if (timeZoneStep === "set") {
        const updated = await tx.query(
          "UPDATE business_profiles SET time_zone=$2, revision=revision+1, updated_at=$3 WHERE tenant_id=$1",
          [input.tenantId, input.timeZone, deps.clock.now().toISOString()]);
        if (updated.rowCount !== 1) refuse(`tenant ${input.key} has no business profile to set the time zone on`);
      }
    }
    return { existing, tenant, timeZoneStep };
  });

  const owner: TenantOwnerStep = phase1.tenant === "would-create"
    ? { kind: "would-provision", email: input.email, userExists: found !== null }
    : { kind: "provisioned", summary: await provisionOwner(deps, { tenantId: input.tenantId, email: input.email, dryRun }) };
  return {
    tenantId: input.tenantId,
    key: input.key,
    name: input.name,
    ownerEmail: input.email,
    timeZone: input.timeZone ?? phase1.existing.zone,
    tenant: phase1.tenant,
    timeZoneStep: phase1.timeZoneStep,
    owner,
    dryRun,
    notes: [],
  };
}

/** What a verify step reads back as service_role. */
export async function readTenantState(service: Pool, tenantId: string, email: string) {
  return asService(service, async (tx) => ({
    name: (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows[0]?.name ?? null,
    timeZone: (await tx.query<{ time_zone: string | null }>(
      "SELECT time_zone FROM business_profiles WHERE tenant_id=$1", [tenantId])).rows[0]?.time_zone ?? null,
    owner: (await tx.query<{ id: string; role: string; user_id: string | null }>(
      "SELECT id, role::text AS role, user_id FROM tenant_members WHERE tenant_id=$1 AND email=$2", [tenantId, email])).rows[0] ?? null,
  }));
}

export type TenantCreateMode =
  | { mode: "dry-run" }
  /** Local runs need no receipt; hosted runs always name one and a backup. */
  | { mode: "apply"; receiptPath?: string; backupPath?: string };

export interface TenantCreateRunDeps {
  readonly input: Omit<TenantCreateInput, "dryRun">;
  /** Non-secret facts about the target, copied into the output. */
  readonly target: Record<string, string>;
  readonly create: (input: TenantCreateInput) => Promise<TenantCreateSummary>;
  readonly readState: (tenantId: string, email: string) => Promise<Awaited<ReturnType<typeof readTenantState>>>;
  /** The user's app_metadata.tenant_id as Supabase Auth now holds it (provision-owner's verify step). */
  readonly readTenantClaim: (userId: string) => Promise<string | null>;
  readonly checkBackup?: (path: string) => Promise<object>;
  readonly clock: { now(): Date };
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

const describeError = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error));

/**
 * The flow behind both entry points. --dry-run prints the plan. An apply reserves the receipt
 * ("wx") first when one is named, plans, checks the backup when one is named, applies, reads
 * the tenant, zone and owner back, and records the outcome in the receipt either way.
 */
export async function runTenantCreate(mode: TenantCreateMode, deps: TenantCreateRunDeps): Promise<TenantCreateSummary> {
  const startedAt = deps.clock.now().toISOString();
  if (mode.mode === "dry-run") {
    const plan = await deps.create({ ...deps.input, dryRun: true });
    deps.log(JSON.stringify({ mode: "dry-run", startedAt, target: deps.target, plan, result: "nothing written" }, null, 2));
    return plan;
  }
  if (mode.backupPath !== undefined && !deps.checkBackup) throw new Error("A backup path needs a checkBackup dependency");
  const receiptFile: FileHandle | null = mode.receiptPath === undefined ? null : await open(mode.receiptPath, "wx");
  const receipt: Record<string, unknown> = { mode: "apply", startedAt, target: deps.target, key: deps.input.key };
  let phase: "dry-run" | "backup-check" | "apply" | "verify" = "dry-run";
  let failure: unknown;
  let applied: TenantCreateSummary | undefined;
  try {
    receipt.plan = await deps.create({ ...deps.input, dryRun: true });
    if (mode.backupPath !== undefined) {
      phase = "backup-check";
      receipt.backup = { file: mode.backupPath, ...(await deps.checkBackup!(mode.backupPath)) };
    }
    phase = "apply";
    applied = await deps.create({ ...deps.input, dryRun: false });
    receipt.applied = applied;
    phase = "verify";
    const after = await deps.readState(applied.tenantId, applied.ownerEmail);
    receipt.after = after;
    if (after.name !== applied.name || after.owner === null || after.owner.role !== "owner" ||
      (applied.timeZone !== null && after.timeZone !== applied.timeZone))
      throw new Error("The tenant read back does not match what was applied");
    // A bound owner must carry this tenant's claim, or every token it gets is refused.
    const userId = applied.owner.kind === "provisioned" ? applied.owner.summary.userId : null;
    if (userId !== null) {
      const claim = await deps.readTenantClaim(userId);
      receipt.tenantClaimAfter = claim;
      if (claim !== applied.tenantId) throw new Error("The owner's tenant claim read back does not name this tenant");
    }
  } catch (error) {
    failure = error;
  }
  // Nothing commits before the apply phase. From it on the tenant row is the evidence, also when a
  // reply was lost: phase 1 is one transaction, so the row is either there or not.
  let committed: boolean | "unknown" = false;
  if (phase === "apply" || phase === "verify") {
    try {
      committed = (await deps.readState(deps.input.key ? tenantIdForKey(deps.input.key) : "", deps.input.ownerEmail)).name !== null;
    } catch {
      committed = "unknown";
    }
  }
  receipt.committed = committed;
  receipt.result = failure ? "failed" : "done";
  if (failure) {
    receipt.failedPhase = phase;
    receipt.error = describeError(failure);
  }
  receipt.finishedAt = deps.clock.now().toISOString();
  if (receiptFile) {
    try {
      await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + "\n");
    } catch (error) {
      deps.logError(JSON.stringify({ receiptWriteFailed: describeError(error), receipt }, null, 2));
      failure ??= error;
    } finally {
      await receiptFile.close().catch(() => undefined);
    }
  }
  if (failure) throw failure;
  deps.log(JSON.stringify({ result: "done", ...applied!, ...(mode.receiptPath ? { receipt: mode.receiptPath } : {}) }, null, 2));
  return applied!;
}
