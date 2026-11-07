// Owner-run tenant creation (docs/requirements/industry-templates.md IT-9): the tenant row with an
// id derived from its key, the business profile's time zone when given, and the first owner
// through provisionOwner (pending until the owner's user exists and a rerun binds it). It applies
// no template: the owner does that at /setup. Every phase checks what exists first, so a rerun
// resumes and replays; a rerun whose name, owner email or zone differs refuses before any write.
// Entry points: src/scripts/tenant-create.ts (local, the auth stub) and
// src/scripts/hosted-tenant-create.ts (hosted, owner-run).
import { open, type FileHandle } from "node:fs/promises";
import type { Pool } from "pg";
import { memberEmailSchema } from "@zs/contracts";
import { derivedId, lockMembership } from "@zs/core";
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

/** The owner step: provisionOwner's report, its plan for a tenant not created yet, or a pending membership only. */
export type TenantOwnerStep =
  | { readonly kind: "provisioned"; readonly summary: ProvisionOwnerSummary }
  | { readonly kind: "would-provision"; readonly email: string; readonly userExists: boolean }
  /** The email's user belongs to another tenant: it gets a pending membership here and keeps its claim. */
  | { readonly kind: "membership-only"; readonly email: string; readonly memberId: string | null; readonly created: boolean; readonly otherTenantId: string };

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
  // The tenant trigger trims and cuts a name to 120 characters; refuse one it would change.
  if (name.length < 1 || name.length > 120 || name !== input.name) refuse("--name must be 1 to 120 characters with no outer spaces");
  const email = memberEmailSchema.safeParse(input.ownerEmail);
  if (!email.success) refuse("--owner-email is not a valid address");
  const timeZone = input.timeZone ?? null;
  if (timeZone !== null && (timeZone.length < 1 || timeZone.length > 100)) refuse("--time-zone is not a time zone name");
  return { tenantId: tenantIdForKey(input.key), key: input.key, name, email: email.data, timeZone };
}

interface Existing {
  readonly tenantName: string | null;
  readonly zone: string | null;
  readonly ownerEmails: readonly string[];
  readonly memberWithEmail: { id: string } | null;
}

async function readExisting(tx: Transaction, input: Checked): Promise<Existing> {
  if (input.timeZone !== null &&
    (await tx.query("SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name=$1", [input.timeZone])).rowCount !== 1)
    refuse(`${input.timeZone} is not a time zone PostgreSQL knows`);
  const tenant = (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [input.tenantId])).rows[0];
  const zone = (await tx.query<{ time_zone: string | null }>(
    "SELECT time_zone FROM business_profiles WHERE tenant_id=$1", [input.tenantId])).rows[0]?.time_zone ?? null;
  const owners = (await tx.query<{ email: string }>(
    "SELECT email FROM tenant_members WHERE tenant_id=$1 AND role='owner' ORDER BY email", [input.tenantId])).rows;
  const member = (await tx.query<{ id: string }>(
    "SELECT id FROM tenant_members WHERE tenant_id=$1 AND email=$2", [input.tenantId, input.email])).rows[0];
  return { tenantName: tenant?.name ?? null, zone, ownerEmails: owners.map((row) => row.email), memberWithEmail: member ?? null };
}

/** IT-9: a rerun with another name, owner email or zone refuses before anything is written. */
function refuseChanged(input: Checked, existing: Existing): void {
  if (existing.tenantName === null) return;
  if (existing.tenantName !== input.name) refuse(`tenant ${input.key} exists with another name (${existing.tenantName})`);
  if (existing.ownerEmails.length > 0 && !existing.ownerEmails.includes(input.email))
    refuse(`tenant ${input.key} already has another owner email`);
  if (input.timeZone !== null && existing.zone !== null && existing.zone !== input.timeZone)
    refuse(`tenant ${input.key} has another time zone (${existing.zone})`);
}

/**
 * Create the tenant, set its zone and provision its owner. Phase 1 (one service_role transaction,
 * under a per-key lock): check, then insert the tenant and set the zone where missing. Phase 2:
 * provisionOwner, or a pending membership when the email's user belongs to another tenant.
 */
export async function createTenant(deps: ProvisionOwnerDeps, raw: TenantCreateInput): Promise<TenantCreateSummary> {
  const input = checkTenantCreateInput(raw);
  const notes: string[] = [];
  const found = await deps.auth.findUser(input.email);
  const otherTenantId = found?.tenantId && found.tenantId !== input.tenantId ? found.tenantId : null;

  const phase1 = await asService(deps.service, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`tenant-create:${input.tenantId}`]);
    const existing = await readExisting(tx, input);
    refuseChanged(input, existing);
    const tenant: TenantCreateSummary["tenant"] = existing.tenantName !== null ? "unchanged" : raw.dryRun ? "would-create" : "created";
    const timeZoneStep: TenantCreateSummary["timeZoneStep"] = input.timeZone === null
      ? "none"
      : existing.zone === input.timeZone ? "unchanged" : raw.dryRun ? "would-set" : "set";
    if (!raw.dryRun) {
      if (tenant === "created") await tx.query("INSERT INTO tenants (tenant_id,name) VALUES ($1,$2)", [input.tenantId, input.name]);
      if (timeZoneStep === "set")
        await tx.query(
          "UPDATE business_profiles SET time_zone=$2, revision=revision+1, updated_at=$3 WHERE tenant_id=$1",
          [input.tenantId, input.timeZone, deps.clock.now().toISOString()]);
    }
    return { existing, tenant, timeZoneStep };
  });

  let owner: TenantOwnerStep;
  if (otherTenantId !== null) {
    owner = await membershipOnly(deps, input, otherTenantId, raw.dryRun || phase1.tenant === "would-create");
    notes.push("The owner's user belongs to another tenant, so it keeps that tenant's claim; this tenant holds a pending owner membership.");
  } else if (phase1.tenant === "would-create") {
    owner = { kind: "would-provision", email: input.email, userExists: found !== null };
  } else {
    owner = { kind: "provisioned", summary: await provisionOwner(deps, { tenantId: input.tenantId, email: input.email, dryRun: raw.dryRun }) };
  }
  return {
    tenantId: input.tenantId,
    key: input.key,
    name: input.name,
    ownerEmail: input.email,
    timeZone: input.timeZone ?? phase1.existing.zone,
    tenant: phase1.tenant,
    timeZoneStep: phase1.timeZoneStep,
    owner,
    dryRun: raw.dryRun,
    notes,
  };
}

/** A pending owner row on this tenant only; the user and the other tenant stay as they are. */
async function membershipOnly(deps: ProvisionOwnerDeps, input: Checked, otherTenantId: string, dryRun: boolean): Promise<TenantOwnerStep> {
  if (dryRun) {
    const member = await asService(deps.service, (tx) => tx.query<{ id: string }>(
      "SELECT id FROM tenant_members WHERE tenant_id=$1 AND email=$2", [input.tenantId, input.email]));
    return { kind: "membership-only", email: input.email, memberId: member.rows[0]?.id ?? null, created: false, otherTenantId };
  }
  return asService(deps.service, async (tx) => {
    await lockMembership(tx, input.tenantId, "exclusive");
    const existing = (await tx.query<{ id: string }>(
      "SELECT id FROM tenant_members WHERE tenant_id=$1 AND email=$2", [input.tenantId, input.email])).rows[0];
    if (existing) return { kind: "membership-only", email: input.email, memberId: existing.id, created: false, otherTenantId };
    const memberId = deps.generateId();
    const now = deps.clock.now().toISOString();
    await tx.query(
      "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,NULL,'owner',$4,$4)",
      [input.tenantId, memberId, input.email, now]);
    return { kind: "membership-only", email: input.email, memberId, created: true, otherTenantId };
  });
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
  } catch (error) {
    failure = error;
  }
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
