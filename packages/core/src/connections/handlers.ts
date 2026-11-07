// Connections C-5, C-7, C-13, C-16: the two actions and the owner's reads. Original code, in the
// shape of calendar/connections.ts. `connection.connect` records the account the callback verified
// and the owner confirmed; it runs only under the reserved key `connect:<connectionId>`, never
// through an approval. `connection.disconnect` moves a live connection to `disconnecting` and
// commits the outbox event with it; the worker finishes the cleanup (worker.ts).
import {
  CONNECTION_CONNECT_ACTION,
  CONNECTION_CONNECTED_EVENT,
  CONNECTION_DISCONNECT_ACTION,
  CONNECTION_DISCONNECT_REQUESTED_EVENT,
  connectConnectionCommandSchema,
  connectionSchema,
  disconnectConnectionCommandSchema,
  Conflict,
  NotFound,
  TenantDenied,
  ValidationFailed,
  type Connection,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { currentTenant } from "../booking/create.js";
import { parseOrFail } from "../crm/rows.js";
import { findMembership } from "../members/access.js";
import { catalogToolkit } from "./catalog.js";
import { connectIdempotencyKey } from "./tokens.js";

interface ConnectionRow {
  id: string;
  toolkit: string;
  account_label: string | null;
  account_domain: string;
  status: Connection["status"];
  reauthorize_reason: Connection["reauthorizeReason"];
  last_error_code: string | null;
  last_checked_at: Date;
  created_at: Date;
}
/** Never a Composio or external account ID (C-13). */
const COLUMNS = "id, toolkit, account_label, account_domain, status, reauthorize_reason, last_error_code, last_checked_at, created_at";

export const managedConnectionFromRow = (row: ConnectionRow): Connection => connectionSchema.parse({
  id: row.id,
  toolkit: row.toolkit,
  accountLabel: row.account_label,
  accountDomain: row.account_domain,
  status: row.status,
  reauthorizeReason: row.reauthorize_reason,
  // C-13: the screen then tells the owner to remove the app in the store's admin.
  revokeFailed: row.last_error_code === "revoke_failed",
  lastCheckedAt: row.last_checked_at.toISOString(),
  createdAt: row.created_at.toISOString(),
});

export async function getConnection(tx: Transaction, tenantId: string, id: string): Promise<Connection | null> {
  const row = (await tx.query<ConnectionRow>(`SELECT ${COLUMNS} FROM connections WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0];
  return row ? managedConnectionFromRow(row) : null;
}

/** C-13: every live row, and only the newest 20 `disconnected` ones. */
export async function listConnections(tx: Transaction, tenantId: string, historyLimit = 20): Promise<Connection[]> {
  return (await tx.query<ConnectionRow>(
    `(SELECT ${COLUMNS} FROM connections WHERE tenant_id=$1 AND status <> 'disconnected')
     UNION ALL
     (SELECT ${COLUMNS} FROM connections WHERE tenant_id=$1 AND status = 'disconnected' ORDER BY created_at DESC, id LIMIT $2)
     ORDER BY created_at DESC, id`, [tenantId, historyLimit])).rows.map(managedConnectionFromRow);
}

/** C-10: the tenant's `active` and `reauthorize` connections, at most 20, for the agent tool. */
export async function listLiveConnections(tx: Transaction, tenantId: string, limit = 20): Promise<Connection[]> {
  return (await tx.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM connections WHERE tenant_id=$1 AND status IN ('active','reauthorize') ORDER BY created_at DESC, id LIMIT $2`,
    [tenantId, limit])).rows.map(managedConnectionFromRow);
}

/** C-5: the tenant's live tokens that hold `connections:read` (they read the store once it is confirmed). */
export async function countTokensWithAccess(tx: Transaction, tenantId: string, now: Date): Promise<number> {
  const row = (await tx.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM automation_tokens
      WHERE tenant_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2) AND 'connections:read' = ANY(scopes::text[])`,
    [tenantId, now])).rows[0];
  return Number(row?.count ?? 0);
}

async function resolveConnectionTarget(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "connection") throw new ValidationFailed("Connection actions require a connection target");
  const tenantId = await currentTenant(tx);
  if (!tenantId || tenantId !== target.tenantId) return null;
  return { tenantId, type: "connection", id: target.id };
}

/**
 * C-5: record the verified account. Only the reserved key is accepted, so an approval run or a
 * hand-built command is refused. The toolkit must be in the catalog, the connection ID unused and
 * no other live connection of the toolkit may exist (a conflict, not a replay).
 */
export const connectConnectionHandler: ActionHandler = {
  resolveTarget: resolveConnectionTarget,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(connectConnectionCommandSchema, command);
    if (command.target.id !== payload.connectionId) throw new ValidationFailed("Target must name the connection");
    if (command.idempotencyKey !== connectIdempotencyKey(payload.connectionId)) throw new ValidationFailed("A connection is added only from the confirm step");
    if (!catalogToolkit(payload.toolkit)) throw new ValidationFailed("Unknown toolkit");
    // `connected_by` is the member row; the dispatcher's actor is the user.
    const member = await findMembership(tx, binding.tenantId, binding.actorId);
    if (!member) throw new TenantDenied();
    if ((await tx.query("SELECT 1 FROM connections WHERE tenant_id=$1 AND id=$2", [binding.tenantId, payload.connectionId])).rowCount)
      throw new Conflict("The connection ID is already in use", { reason: "id_in_use" });
    if ((await tx.query("SELECT 1 FROM connections WHERE tenant_id=$1 AND toolkit=$2 AND status IN ('active','reauthorize','disconnecting')",
      [binding.tenantId, payload.toolkit])).rowCount)
      throw new Conflict("This app is already connected", { reason: "already_connected" });
    const row = (await tx.query<ConnectionRow>(
      `INSERT INTO connections (tenant_id, id, tier, toolkit, composio_account_id, external_account_id, account_domain, account_label,
         status, connected_by, last_checked_at, created_at, updated_at)
       VALUES ($1,$2,'composio',$3,$4,$5,$6,$7,'active',$8,$9,$9,$9) RETURNING ${COLUMNS}`,
      [binding.tenantId, payload.connectionId, payload.toolkit, payload.composioAccountId, payload.externalAccountId, payload.accountDomain,
        payload.accountLabel, member.memberId, now])).rows[0]!;
    const result = managedConnectionFromRow(row);
    return {
      result: { ...result },
      event: { type: CONNECTION_CONNECTED_EVENT, payload: { connectionId: result.id, toolkit: result.toolkit } },
    };
  },
};

/** C-13: `active` or `reauthorize` becomes `disconnecting` with its outbox event; a retired one answers as it is. */
export const disconnectConnectionHandler: ActionHandler = {
  resolveTarget: resolveConnectionTarget,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(disconnectConnectionCommandSchema, command);
    if (command.target.id !== payload.connectionId) throw new ValidationFailed("Target must name the connection");
    const current = (await tx.query<{ status: Connection["status"] }>(
      "SELECT status FROM connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [binding.tenantId, payload.connectionId])).rows[0];
    if (!current) throw new NotFound();
    const moves = current.status === "active" || current.status === "reauthorize";
    if (moves)
      await tx.query("UPDATE connections SET status='disconnecting', updated_at=$3 WHERE tenant_id=$1 AND id=$2", [binding.tenantId, payload.connectionId, now]);
    const connection = (await getConnection(tx, binding.tenantId, payload.connectionId))!;
    return {
      result: { ...connection },
      ...(moves ? { event: { type: CONNECTION_DISCONNECT_REQUESTED_EVENT, payload: { connectionId: connection.id, toolkit: connection.toolkit } } } : {}),
    };
  },
};

export const connectionHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [CONNECTION_CONNECT_ACTION]: connectConnectionHandler,
  [CONNECTION_DISCONNECT_ACTION]: disconnectConnectionHandler,
});
