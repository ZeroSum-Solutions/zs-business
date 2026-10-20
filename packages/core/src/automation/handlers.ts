// M5 Activepieces actions (activepieces.md W-2, W-5, W-9..W-12, W-14). Original code. Each runs
// through the shared dispatcher: the endpoint, token and replay actions as an owner holding
// `integrations`, the proposal action as a token's server-built principal (W-11). A proposal only
// ever writes an M3b approval record; an owner's approval is what runs the action.
import {
  Conflict,
  PROPOSAL_ACTIONS,
  TenantDenied,
  ValidationFailed,
  createAutomationTokenCommandSchema,
  createBookingCommandSchema,
  createDealCommandSchema,
  createOrFindContactCommandSchema,
  createProposalCommandSchema,
  createWebhookEndpointCommandSchema,
  moveDealStageCommandSchema,
  replayWebhookDeliveryCommandSchema,
  revokeAutomationTokenCommandSchema,
  rotateWebhookSecretCommandSchema,
  updateWebhookEndpointCommandSchema,
  type ApprovalStatus,
  type AutomationScope,
  type ProposalAction,
  type ProposalRecord,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { loadApproval, standing } from "../approvals/records.js";
import { parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { requireMember } from "../members/access.js";
import {
  automationActorId,
  DELIVERY_COLUMNS,
  deliveryRecord,
  endpointRecord,
  loadEndpoint,
  loadToken,
  tokenActive,
  tokenRecord,
  type DeliveryRow,
  type TokenRow,
} from "./records.js";

export const CREATE_ENDPOINT_ACTION = "webhook.endpoint.create";
export const UPDATE_ENDPOINT_ACTION = "webhook.endpoint.update";
export const ROTATE_ENDPOINT_ACTION = "webhook.endpoint.rotate";
export const REPLAY_DELIVERY_ACTION = "webhook.delivery.replay";
export const CREATE_TOKEN_ACTION = "automation.token.create";
export const REVOKE_TOKEN_ACTION = "automation.token.revoke";
export const CREATE_PROPOSAL_ACTION = "automation.proposal.create";

/** W-1: the owner actions; each needs `integrations`. */
export const INTEGRATION_ACTIONS: readonly string[] = Object.freeze([
  CREATE_ENDPOINT_ACTION, UPDATE_ENDPOINT_ACTION, ROTATE_ENDPOINT_ACTION, REPLAY_DELIVERY_ACTION,
  CREATE_TOKEN_ACTION, REVOKE_TOKEN_ACTION,
]);

/** W-2, W-9, W-11: per-tenant and per-token limits, so one tenant or a leaked token stays bounded. */
export const AUTOMATION_LIMITS = Object.freeze({ endpoints: 10, activeTokens: 20, pendingProposalsPerToken: 50 });

const limitReached = (reason: "endpoint_limit" | "token_limit" | "proposal_limit") =>
  new Conflict("A limit was reached", { reason });

/** Serializes the count-then-insert of one tenant's limits; a non-UUID prefix, as members/access.ts explains. */
const lockLimits = (tx: Transaction, tenantId: string, what: string) =>
  tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [`automation-limits:${what}:${tenantId}`]);

async function newTarget(tx: Transaction, target: Target, type: string, exists: (tx: Transaction, target: Target) => Promise<boolean>) {
  if (target.type !== type) throw new ValidationFailed(`This action requires a ${type} target`);
  if (!(await tenantVisible(tx, target.tenantId))) return null;
  if (await exists(tx, target)) throw new Conflict("The ID is already in use", { reason: "id_in_use" });
  return { tenantId: target.tenantId, type, id: target.id };
}
const existingTarget = (type: string, exists: (tx: Transaction, target: Target) => Promise<boolean>) =>
  async (tx: Transaction, target: Target): Promise<Target | null> => {
    if (target.type !== type) throw new ValidationFailed(`This action requires a ${type} target`);
    return (await exists(tx, target)) ? { tenantId: target.tenantId, type, id: target.id } : null;
  };
const endpointExists = async (tx: Transaction, target: Target) => (await loadEndpoint(tx, target.tenantId, target.id)) !== null;
const tokenExists = async (tx: Transaction, target: Target) => (await loadToken(tx, target.tenantId, target.id)) !== null;

const staleRevision = (current: string) =>
  new Conflict("The endpoint changed", { reason: "stale_revision", currentRevision: Number(current) });

export const createEndpointHandler: ActionHandler = {
  resolveTarget: (tx, target) => newTarget(tx, target, "webhook_endpoint", endpointExists),
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "integrations");
    const { payload } = parseOrFail(createWebhookEndpointCommandSchema, command);
    await lockLimits(tx, binding.tenantId, "endpoints");
    const count = Number((await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM webhook_endpoints WHERE tenant_id=$1", [binding.tenantId])).rows[0]!.count);
    if (count >= AUTOMATION_LIMITS.endpoints) throw limitReached("endpoint_limit");
    await tx.query(
      `INSERT INTO webhook_endpoints (tenant_id, id, url, description, events, scan_from, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::automation_event_type[],$6,$7,$6,$6)`,
      [binding.tenantId, payload.endpointId, payload.url, payload.description, payload.events, now, binding.actorId]);
    const row = (await loadEndpoint(tx, binding.tenantId, payload.endpointId))!;
    return {
      result: endpointRecord(row, now),
      event: { type: "webhook.endpoint.created", payload: { endpointId: row.id, events: [...row.events] } },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "webhook_endpoints_pkey")
      return new Conflict("The endpoint ID is already in use", { reason: "id_in_use" });
    return undefined;
  },
};

export const updateEndpointHandler: ActionHandler = {
  resolveTarget: existingTarget("webhook_endpoint", endpointExists),
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "integrations");
    const { payload } = parseOrFail(updateWebhookEndpointCommandSchema, command);
    const row = (await loadEndpoint(tx, binding.tenantId, payload.endpointId, true))!;
    if (Number(row.revision) !== payload.expectedRevision) throw staleRevision(row.revision);
    const enabled = payload.enabled ?? row.enabled;
    // W-7: an endpoint switched back on starts from now; what happened while it was off is not sent.
    const scanFrom = enabled && !row.enabled ? now : row.scan_from;
    await tx.query(
      `UPDATE webhook_endpoints SET url=$3, events=$4::automation_event_type[], description=$5, enabled=$6, scan_from=$7,
         revision=revision+1, updated_at=$8 WHERE tenant_id=$1 AND id=$2`,
      [binding.tenantId, row.id, payload.url ?? row.url, payload.events ?? row.events,
        payload.description === undefined ? row.description : payload.description, enabled, scanFrom, now]);
    return { result: endpointRecord((await loadEndpoint(tx, binding.tenantId, row.id))!, now) };
  },
};

/** W-5: a new secret version; the old one keeps signing for the grace, or stops at once. */
export const rotateEndpointHandler: ActionHandler = {
  resolveTarget: existingTarget("webhook_endpoint", endpointExists),
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "integrations");
    const { payload } = parseOrFail(rotateWebhookSecretCommandSchema, command);
    const row = (await loadEndpoint(tx, binding.tenantId, payload.endpointId, true))!;
    const grace = payload.graceMinutes > 0;
    await tx.query(
      `UPDATE webhook_endpoints SET secret_version=secret_version+1, previous_secret_version=$3, previous_valid_until=$4,
         revision=revision+1, updated_at=$5 WHERE tenant_id=$1 AND id=$2`,
      [binding.tenantId, row.id, grace ? row.secret_version : null,
        grace ? new Date(now.getTime() + payload.graceMinutes * 60_000) : null, now]);
    const rotated = (await loadEndpoint(tx, binding.tenantId, row.id))!;
    return {
      result: endpointRecord(rotated, now),
      event: { type: "webhook.endpoint.rotated", payload: { endpointId: row.id, secretVersion: rotated.secret_version } },
    };
  },
};

const loadDelivery = async (tx: Transaction, tenantId: string, id: string, lock = false) =>
  (await tx.query<DeliveryRow>(`SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, id])).rows[0] ?? null;

/** W-14: a dead letter goes back in the queue with a fresh attempt budget, under the same event ID. */
export const replayDeliveryHandler: ActionHandler = {
  resolveTarget: existingTarget("webhook_delivery", async (tx, target) => (await loadDelivery(tx, target.tenantId, target.id)) !== null),
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "integrations");
    const { payload } = parseOrFail(replayWebhookDeliveryCommandSchema, command);
    const row = (await loadDelivery(tx, binding.tenantId, payload.deliveryId, true))!;
    if (row.status !== "dead") throw new Conflict("Only a dead letter can be replayed", { reason: "not_dead_letter" });
    await tx.query(
      `UPDATE webhook_deliveries SET status='pending', attempts=0, step_errors=0, replays=replays+1, next_attempt_at=$3,
         final_reason=NULL, last_error=NULL, updated_at=$3 WHERE tenant_id=$1 AND id=$2`,
      [binding.tenantId, row.id, now]);
    return { result: deliveryRecord((await loadDelivery(tx, binding.tenantId, row.id))!) };
  },
};

export const createTokenHandler: ActionHandler = {
  resolveTarget: (tx, target) => newTarget(tx, target, "automation_token", tokenExists),
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "integrations");
    const { payload } = parseOrFail(createAutomationTokenCommandSchema, command);
    await lockLimits(tx, binding.tenantId, "tokens");
    const active = Number((await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM automation_tokens
        WHERE tenant_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`, [binding.tenantId, now])).rows[0]!.count);
    if (active >= AUTOMATION_LIMITS.activeTokens) throw limitReached("token_limit");
    const expiresAt = payload.expiresInDays === null ? null : new Date(now.getTime() + payload.expiresInDays * 86_400_000);
    await tx.query(
      `INSERT INTO automation_tokens (tenant_id, id, name, scopes, created_by, created_at, expires_at)
       VALUES ($1,$2,$3,$4::automation_token_scope[],$5,$6,$7)`,
      [binding.tenantId, payload.tokenId, payload.name, payload.scopes, binding.actorId, now, expiresAt]);
    const row = (await loadToken(tx, binding.tenantId, payload.tokenId))!;
    return {
      result: tokenRecord(row),
      event: { type: "automation.token.created", payload: { tokenId: row.id, scopes: [...row.scopes] } },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "automation_tokens_pkey")
      return new Conflict("The token ID is already in use", { reason: "id_in_use" });
    return undefined;
  },
};

/**
 * W-9: revoking stops the token at once (the proposal action locks the token row) and withdraws
 * every proposal of it still pending. A token already revoked stays as it was.
 */
export const revokeTokenHandler: ActionHandler = {
  resolveTarget: existingTarget("automation_token", tokenExists),
  async handle({ tx, command, binding, now }) {
    await requireMember(tx, binding.tenantId, binding.actorId, "integrations");
    const { payload } = parseOrFail(revokeAutomationTokenCommandSchema, command);
    const row = (await loadToken(tx, binding.tenantId, payload.tokenId, "update"))!;
    if (row.revoked_at === null) {
      await tx.query("UPDATE automation_tokens SET revoked_at=$3, revoked_by=$4 WHERE tenant_id=$1 AND id=$2",
        [binding.tenantId, row.id, now, binding.actorId]);
      await tx.query(
        `UPDATE approvals SET status='revoked', revoked_by=$3, revoked_at=$4, revoke_note='The automation token was revoked'
          WHERE tenant_id=$1 AND requested_by=$2 AND status='pending'`,
        [binding.tenantId, automationActorId(binding.tenantId, row.id), binding.actorId, now]);
    }
    return {
      result: tokenRecord((await loadToken(tx, binding.tenantId, row.id))!),
      event: { type: "automation.token.revoked", payload: { tokenId: row.id } },
    };
  },
};

const PROPOSED_COMMANDS: Readonly<Record<string, { safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { message: string } } }>> = {
  "crm.contact.create-or-find": createOrFindContactCommandSchema,
  "crm.deal.create": createDealCommandSchema,
  "crm.deal.move-stage": moveDealStageCommandSchema,
  "booking.create": createBookingCommandSchema,
};

/** The proposal action for an action type, and the scope that allows it. */
const proposalFor = (actionType: string): { action: ProposalAction; scope: AutomationScope } => {
  const found = Object.entries(PROPOSAL_ACTIONS).find(([, entry]) => entry.actionType === actionType);
  if (!found) throw new ValidationFailed("That action cannot be proposed");
  return { action: found[0] as ProposalAction, scope: found[1].scope };
};

/** W-13: what a flow learns about its own proposal. */
export function proposalRecord(row: {
  id: string; action_type: string; target_type: string; target_id: string; status: string; requested_at: Date;
  expires_at: Date; decided_at: Date | null; executed_action_id: string | null;
}, now: Date): ProposalRecord {
  return {
    id: row.id,
    action: proposalFor(row.action_type).action,
    target: { type: row.target_type, id: row.target_id },
    standing: standing({ status: row.status as ApprovalStatus, expires_at: row.expires_at }, now),
    executed: row.executed_action_id !== null,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

/**
 * W-11, W-12: a token's principal writes one pending approval for one exact member action. The
 * token row is locked, so a revocation that commits first stops it, and the per-token count of
 * pending proposals cannot be raced past its limit.
 */
export const createProposalHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "approval") throw new ValidationFailed("A proposal requires an approval target");
    if (!(await tenantVisible(tx, target.tenantId))) return null;
    if (await loadApproval(tx, target.tenantId, target.id)) throw new Conflict("The ID is already in use", { reason: "id_in_use" });
    return { tenantId: target.tenantId, type: "approval", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(createProposalCommandSchema, command);
    const tenantId = binding.tenantId;
    if (binding.actorId !== automationActorId(tenantId, payload.tokenId)) throw new TenantDenied();
    const token: TokenRow | null = await loadToken(tx, tenantId, payload.tokenId, "update");
    if (!token || !tokenActive(token, now)) throw new TenantDenied();
    const { scope } = proposalFor(payload.action.actionType);
    if (!token.scopes.includes(scope)) throw new TenantDenied();
    // The proposed command must be one its own handler would accept (approvals.md A-7 runs it later).
    parseOrFail(PROPOSED_COMMANDS[payload.action.actionType]!, {
      actionType: payload.action.actionType,
      target: { tenantId, ...payload.action.target },
      payload: payload.action.payload,
      approvalReference: { tenantId, id: payload.proposalId },
      idempotencyKey: `approval:${payload.proposalId}`,
    });
    if (payload.action.actionType === "crm.contact.create-or-find") {
      const consent = (payload.action.payload as { consent?: { email?: unknown; sms?: unknown } }).consent;
      if (consent?.email !== null || consent?.sms !== null) throw new ValidationFailed("A proposal cannot carry consent evidence");
    }
    const pending = Number((await tx.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM approvals WHERE tenant_id=$1 AND requested_by=$2 AND status='pending' AND expires_at > $3",
      [tenantId, binding.actorId, now])).rows[0]!.count);
    if (pending >= AUTOMATION_LIMITS.pendingProposalsPerToken) throw limitReached("proposal_limit");
    const expiresAt = new Date(now.getTime() + payload.expiresInMinutes * 60_000);
    await tx.query(
      `INSERT INTO approvals (tenant_id,id,action_type,target_type,target_id,payload,summary,requested_by,requested_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tenantId, payload.proposalId, payload.action.actionType, payload.action.target.type, payload.action.target.id,
        JSON.stringify(payload.action.payload), payload.summary, binding.actorId, now, expiresAt]);
    const row = (await loadApproval(tx, tenantId, payload.proposalId))!;
    return {
      result: proposalRecord(row, now),
      event: { type: "approval.requested", payload: { approvalId: row.id, actionType: row.action_type, requestedBy: binding.actorId } },
    };
  },
  mapError(error) {
    if (pgCode(error) === "23505" && pgConstraint(error) === "approvals_pkey")
      return new Conflict("The proposal ID is already in use", { reason: "id_in_use" });
    return undefined;
  },
};

export const automationHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [CREATE_ENDPOINT_ACTION]: createEndpointHandler,
  [UPDATE_ENDPOINT_ACTION]: updateEndpointHandler,
  [ROTATE_ENDPOINT_ACTION]: rotateEndpointHandler,
  [REPLAY_DELIVERY_ACTION]: replayDeliveryHandler,
  [CREATE_TOKEN_ACTION]: createTokenHandler,
  [REVOKE_TOKEN_ACTION]: revokeTokenHandler,
  [CREATE_PROPOSAL_ACTION]: createProposalHandler,
});
