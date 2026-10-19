// Owner-run provisioning of a tenant's first owner. Tenants that existed before the
// tenant_members migration (the hosted pilot tenant) have no member, so every request there is
// refused and nobody can invite anyone. The database holds no tenant-to-email data, so a
// migration cannot backfill it: the owner names the person here, and this binds their
// Supabase user when it exists and gives it the tenant claim (app_metadata.tenant_id) that
// every token must carry. Entry points: src/scripts/provision-owner.ts (local, the auth stub)
// and src/scripts/hosted-provision-owner.ts (hosted, the Supabase Auth admin API).
import { open, type FileHandle } from "node:fs/promises";
import type { Pool } from "pg";
import { memberEmailSchema, uuidSchema, type MemberRole } from "@zs/contracts";
import { lockMembership } from "@zs/core";
import { asService, type Transaction } from "@zs/db";
import { redactSecrets } from "./hosted.js";

export interface ProvisionOwnerDeps {
  /** A pool whose login may SET ROLE service_role (asService); never the runtime pool. */
  readonly service: Pool;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly auth: AuthAdmin;
}

/** The Supabase Auth admin calls provisioning needs; the local stub or the hosted admin API. */
export interface AuthAdmin {
  /** The live user with this exact (normalized) email and its app_metadata.tenant_id, or null when none exists yet. */
  findUser(email: string): Promise<{ id: string; tenantId: string | null } | null>;
  /** Set the user's app_metadata.tenant_id (server-owned: users cannot change app_metadata). */
  setTenantClaim(userId: string, tenantId: string): Promise<void>;
}

export interface ProvisionOwnerInput {
  readonly tenantId: string;
  readonly email: string;
  /** Do everything, then roll back and report what would change. */
  readonly dryRun: boolean;
}

export type ProvisionOwnerAction = "created" | "bound" | "promoted" | "claimed" | "unchanged";

/**
 * The bound user's tenant claim: already this tenant, set by this run, to be set (dry run), or
 * none yet because the owner is still pending.
 */
export type TenantClaimState = "present" | "set" | "would-set" | "no-user";

/** A member row's identity and role facts; no credentials. */
export interface MemberState {
  readonly memberId: string;
  readonly role: MemberRole;
  readonly userId: string | null;
}

export interface ProvisionOwnerSummary {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly memberId: string;
  readonly email: string;
  readonly role: MemberRole;
  /** The bound Supabase user, or null while the owner is a pending invite. */
  readonly userId: string | null;
  /** Precedence when several apply: created, promoted, bound, then claimed (only the tenant claim changed). */
  readonly action: ProvisionOwnerAction;
  readonly tenantClaim: TenantClaimState;
  /** True when the member row also got its user bound in this run. */
  readonly boundUser: boolean;
  /** The row before this run, or null when there was none. */
  readonly before: MemberState | null;
  /** Owners with a bound user before this run. */
  readonly activeOwnersBefore: number;
  readonly dryRun: boolean;
  readonly notes: readonly string[];
}

/** Thrown from inside the transaction so asService rolls it back; carries the dry-run report. */
class DryRunRollback extends Error {
  constructor(readonly summary: ProvisionOwnerSummary) {
    super("dry run rolled back");
  }
}

function refuse(reason: string): never {
  throw new Error(`Refusing to provision: ${reason}`);
}

const RESIGN_NOTE =
  "The user's tenant claim was just set: tokens issued before this run lack it, so they must sign in again (or refresh).";

const PENDING_NOTE =
  "No Supabase Auth user has this email yet: the owner is a pending member. Create the user " +
  "(Supabase dashboard > Authentication > Add user, or let them sign up), then re-run this step to bind it.";

interface MemberRow {
  id: string;
  user_id: string | null;
  role: MemberRole;
}

async function memberByEmail(tx: Transaction, tenantId: string, email: string): Promise<MemberRow | undefined> {
  return (await tx.query<MemberRow>(
    "SELECT id, user_id, role::text AS role FROM tenant_members WHERE tenant_id=$1 AND email=$2",
    [tenantId, email],
  )).rows[0];
}

/** Read one member's identity and role facts as service_role (the runner's verify step). */
export async function readMemberByEmail(service: Pool, tenantId: string, email: string): Promise<MemberState | null> {
  const row = await asService(service, (tx) => memberByEmail(tx, tenantId, email));
  return row ? { memberId: row.id, role: row.role, userId: row.user_id } : null;
}

/**
 * Make `email` an owner of `tenantId`, in one service_role transaction under the tenant's
 * exclusive membership lock (the one member actions take). Idempotent: a second run with the
 * same facts reports "unchanged".
 *
 * - No member with the email: insert an owner, bound to the Supabase user when it exists, else
 *   pending (user_id NULL) until a re-run binds it.
 * - A member with the email: bind its user when still pending and the user now exists. Promote
 *   staff to owner only when the tenant has no active owner at all; otherwise refuse, since
 *   owners change roles in the app.
 * - Refuses an unknown tenant, a row bound to a different user, a bound row whose user is gone,
 *   a user already bound to another member of the tenant, and a user whose tenant claim names
 *   another tenant.
 * - Gives the bound user this tenant's claim when it lacks it, inside the transaction, so a
 *   failed claim write rolls the row back and a re-run starts over.
 *
 * Runs for the same Supabase user serialize on a per-user advisory lock, taken before the
 * tenant's membership lock, which covers the claim re-read, the member row and the claim write.
 * Without it two runs for two tenants could both read "no claim" and both bind the user, and
 * the later claim write would silently take the user away from the first tenant.
 */
export async function provisionOwner(deps: ProvisionOwnerDeps, input: ProvisionOwnerInput): Promise<ProvisionOwnerSummary> {
  const tenant = uuidSchema.safeParse(input.tenantId);
  if (!tenant.success) refuse("the tenant id must be a UUID");
  const parsedEmail = memberEmailSchema.safeParse(input.email);
  if (!parsedEmail.success) refuse("the email is not a valid address");
  const tenantId = tenant.data;
  const email = parsedEmail.data;
  // A first read names the user to lock on, and refuses a claimed user without taking any lock.
  const found = await deps.auth.findUser(email);
  const userId = found === null ? null : uuidSchema.parse(found.id);
  refuseOtherTenant(found, tenantId);

  try {
    return await asService(deps.service, async (tx) => {
      let claimMissing = false;
      if (userId !== null) {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`provision-owner:user:${userId}`]);
        // Under the lock: another run may have claimed the user since the first read.
        const current = await deps.auth.findUser(email);
        if (current === null || current.id !== userId)
          refuse("the Supabase user with this email changed while provisioning; run it again");
        refuseOtherTenant(current, tenantId);
        claimMissing = current.tenantId !== tenantId;
      }
      await lockMembership(tx, tenantId, "exclusive");
      const tenantRow = (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows[0];
      if (!tenantRow) refuse(`tenant ${tenantId} does not exist`);
      const activeOwnersBefore = Number((await tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM tenant_members WHERE tenant_id=$1 AND role='owner' AND user_id IS NOT NULL", [tenantId],
      )).rows[0]!.n);
      const existing = await memberByEmail(tx, tenantId, email);
      if (userId !== null) {
        const other = (await tx.query<{ id: string }>(
          "SELECT id FROM tenant_members WHERE tenant_id=$1 AND user_id=$2 AND id IS DISTINCT FROM $3::uuid",
          [tenantId, userId, existing?.id ?? null],
        )).rows[0];
        if (other) refuse(`that Supabase user is already bound to member ${other.id} of this tenant under another email`);
      }

      const now = deps.clock.now().toISOString();
      const notes: string[] = [];
      let memberId: string;
      let role: MemberRole = "owner";
      let boundUserId = userId;
      let action: ProvisionOwnerAction;
      let boundUser = false;
      if (!existing) {
        memberId = deps.generateId();
        await tx.query(
          `INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at)
           VALUES ($1,$2,$3,$4,'owner',$5,$5)`,
          [tenantId, memberId, email, userId, now],
        );
        action = "created";
        boundUser = userId !== null;
        if (activeOwnersBefore > 0) notes.push(`The tenant already had ${activeOwnersBefore} active owner(s); this adds another.`);
      } else {
        memberId = existing.id;
        if (existing.user_id !== null && userId !== null && existing.user_id !== userId)
          refuse(`member ${existing.id} is bound to a different Supabase user than the one with this email`);
        if (existing.user_id !== null && userId === null)
          refuse(`member ${existing.id} is bound to user ${existing.user_id}, but no Supabase user has this email now`);
        boundUser = existing.user_id === null && userId !== null;
        boundUserId = existing.user_id ?? userId;
        let promote = false;
        if (existing.role !== "owner") {
          if (activeOwnersBefore > 0)
            refuse(`member ${existing.id} is ${existing.role} and the tenant has an active owner; an owner can change the role in the app`);
          promote = true;
          notes.push("The tenant had no active owner, so this member was promoted to owner.");
        }
        role = promote ? "owner" : existing.role;
        if (promote || boundUser)
          await tx.query(
            "UPDATE tenant_members SET role=$3::public.member_role, user_id=$4, updated_at=$5 WHERE tenant_id=$1 AND id=$2",
            [tenantId, memberId, role, boundUserId, now],
          );
        action = promote ? "promoted" : boundUser ? "bound" : claimMissing ? "claimed" : "unchanged";
      }
      if (boundUserId === null) notes.push(PENDING_NOTE);
      else if (claimMissing) notes.push(RESIGN_NOTE);
      const tenantClaim: TenantClaimState =
        boundUserId === null ? "no-user" : !claimMissing ? "present" : input.dryRun ? "would-set" : "set";

      const result: ProvisionOwnerSummary = {
        tenantId,
        tenantName: tenantRow.name,
        memberId,
        email,
        role,
        userId: boundUserId,
        action,
        tenantClaim,
        boundUser,
        before: existing ? { memberId: existing.id, role: existing.role, userId: existing.user_id } : null,
        activeOwnersBefore,
        dryRun: input.dryRun,
        notes,
      };
      if (input.dryRun) throw new DryRunRollback(result);
      // Still under both locks. If this fails the row rolls back; if COMMIT fails after it, the
      // claim names this tenant with no member yet, and a re-run creates the row.
      if (tenantClaim === "set") await deps.auth.setTenantClaim(boundUserId!, tenantId);
      return result;
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return error.summary;
    throw error;
  }
}

function refuseOtherTenant(found: { tenantId: string | null } | null, tenantId: string): void {
  if (found?.tenantId && found.tenantId !== tenantId)
    refuse(`that Supabase user's tenant claim already names another tenant (${found.tenantId})`);
}

/** Where an --apply run stopped; the receipt names it. */
export type ProvisionPhase = "dry-run" | "backup-check" | "apply" | "verify";

/** `backupPath`: a backup that must pass `checkBackup` before the apply (hosted always sets it). */
export type ProvisionOwnerMode = { mode: "dry-run" } | { mode: "apply"; receiptPath: string; backupPath?: string };

export interface ProvisionOwnerRunDeps {
  readonly input: { readonly tenantId: string; readonly email: string };
  /** Non-secret facts about the target (describeDatabase / describeHosted), copied into the output. */
  readonly target: Record<string, string>;
  /** provisionOwner bound to its deps. */
  readonly provision: (input: ProvisionOwnerInput) => Promise<ProvisionOwnerSummary>;
  /** readMemberByEmail bound to the service pool. */
  readonly readMember: (tenantId: string, email: string) => Promise<MemberState | null>;
  /** The user's app_metadata.tenant_id as Supabase Auth now holds it. */
  readonly readTenantClaim: (userId: string) => Promise<string | null>;
  /** Checks the backup named by the mode's backupPath and returns its facts for the receipt. */
  readonly checkBackup?: (path: string) => Promise<object>;
  readonly clock: { now(): Date };
  readonly log: (line: string) => void;
  readonly logError: (line: string) => void;
}

const describeError = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error));
const sameState = (a: MemberState | null, b: MemberState | null) =>
  a !== null && b !== null && a.memberId === b.memberId && a.role === b.role && a.userId === b.userId;
const stateOf = (summary: ProvisionOwnerSummary): MemberState =>
  ({ memberId: summary.memberId, role: summary.role, userId: summary.userId });

/**
 * The flow behind the provision-owner entry points, in the shape of hosted-migrate's
 * runHostedMigrate. --dry-run prints what would change. --apply reserves the receipt ("wx")
 * before it touches the database, runs a dry run, checks the backup when the mode names one,
 * applies, reads the row and the claim back, and always
 * writes the outcome: result, the phase that failed, the redacted error, and whether anything
 * committed (false before the apply phase; read back from the member row after it).
 */
export async function runProvisionOwner(mode: ProvisionOwnerMode, deps: ProvisionOwnerRunDeps): Promise<ProvisionOwnerSummary> {
  const startedAt = deps.clock.now().toISOString();
  if (mode.mode === "dry-run") {
    const plan = await deps.provision({ ...deps.input, dryRun: true });
    deps.log(JSON.stringify({ mode: "dry-run", startedAt, target: deps.target, plan, result: "rolled back" }, null, 2));
    return plan;
  }

  const checkBackup = deps.checkBackup;
  if (mode.backupPath !== undefined && !checkBackup) throw new Error("A backup path needs a checkBackup dependency");
  // An existing file or a missing folder fails here, before any database work.
  const receiptFile: FileHandle = await open(mode.receiptPath, "wx");
  const receipt: Record<string, unknown> = { mode: "apply", startedAt, target: deps.target, tenantId: deps.input.tenantId };
  let phase: ProvisionPhase = "dry-run";
  let failure: unknown;
  let plan: ProvisionOwnerSummary | undefined;
  let applied: ProvisionOwnerSummary | undefined;
  try {
    plan = await deps.provision({ ...deps.input, dryRun: true });
    receipt.plan = plan;

    if (mode.backupPath !== undefined) {
      phase = "backup-check";
      receipt.backup = { file: mode.backupPath, ...(await checkBackup!(mode.backupPath)) };
    }

    phase = "apply";
    applied = await deps.provision({ ...deps.input, dryRun: false });
    receipt.applied = applied;

    phase = "verify";
    const after = await deps.readMember(applied.tenantId, applied.email);
    receipt.after = after;
    if (!sameState(after, stateOf(applied))) throw new Error("The member row read back does not match what was applied");
    if (applied.userId !== null) {
      const claim = await deps.readTenantClaim(applied.userId);
      receipt.tenantClaimAfter = claim;
      if (claim !== applied.tenantId) throw new Error("The user's tenant claim read back does not name this tenant");
    }
  } catch (error) {
    failure = error;
  }

  // Nothing can commit before the apply phase. From it on the row is the evidence, also when a
  // COMMIT reply was lost: provisioning is one transaction, so the row is either before or after.
  // `committed` is about the member row; the tenant claim is read back on its own.
  let committed: boolean | "unknown" = false;
  if (phase === "apply" && plan) {
    if (plan.userId !== null) {
      try {
        receipt.tenantClaimAfter = await deps.readTenantClaim(plan.userId);
      } catch (error) {
        receipt.tenantClaimAfter = `unreadable: ${describeError(error)}`;
      }
    }
    if (plan.action === "unchanged" || plan.action === "claimed") committed = false;
    else {
      try {
        const after = await deps.readMember(plan.tenantId, plan.email);
        receipt.after = after;
        const unchanged = plan.before === null ? after === null : sameState(after, plan.before);
        // A dry run mints a fresh member id, so a created row matches on its facts only.
        const landed = after !== null && after.role === plan.role && after.userId === plan.userId &&
          (plan.action === "created" || after.memberId === plan.memberId);
        committed = unchanged ? false : landed ? true : "unknown";
      } catch (error) {
        receipt.after = `unreadable: ${describeError(error)}`;
        committed = "unknown";
      }
    }
  } else if (phase === "verify" && applied) {
    // provision() returned, so its transaction committed; a failed read-back does not undo that.
    committed = applied.action !== "unchanged" && applied.action !== "claimed";
  }
  receipt.committed = committed;
  receipt.result = failure ? "failed" : applied!.action === "unchanged" || applied!.action === "claimed" ? applied!.action : "committed";
  if (failure) {
    receipt.failedPhase = phase;
    receipt.error = describeError(failure);
  }
  receipt.finishedAt = deps.clock.now().toISOString();
  try {
    await receiptFile.writeFile(JSON.stringify(receipt, null, 2) + "\n");
  } catch (error) {
    // Print the receipt so the evidence is not lost.
    deps.logError(JSON.stringify({ receiptWriteFailed: describeError(error), receipt }, null, 2));
    failure ??= error;
  } finally {
    await receiptFile.close().catch(() => undefined);
  }
  if (failure) throw failure;
  deps.log(JSON.stringify({ result: receipt.result, ...applied!, receipt: mode.receiptPath }, null, 2));
  return applied!;
}
