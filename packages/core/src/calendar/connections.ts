// M5 Google Calendar connections (docs/requirements/google-calendar.md G-1, G-4, G-5). Original
// code. Owner intent runs through the dispatcher: the connect action records a grant the callback
// sealed (G-2, G-3) and retires any older connection of the resource; disconnect hands a
// connection to the worker for cleanup (G-9). Sync state and the sealed token are the worker's.
// Connect runs only under the callback's reserved key, never through an approval (G-2).
import {
  CALENDAR_GOOGLE_CONNECT_ACTION,
  CALENDAR_GOOGLE_DISCONNECT_ACTION,
  calendarConnectionSchema,
  connectGoogleCalendarCommandSchema,
  disconnectCalendarCommandSchema,
  NotFound,
  TenantDenied,
  ValidationFailed,
  type CalendarConnection,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { currentTenant } from "../booking/create.js";
import { idInUse, parseOrFail } from "../crm/rows.js";

interface ConnectionRow {
  id: string;
  resource_id: string;
  calendar_id: string;
  account_email: string | null;
  status: CalendarConnection["status"];
  last_synced_at: Date | null;
  last_error: string | null;
  created_at: Date;
}
/** Never the sealed token, the sync token or the channel (G-5). */
const CONNECTION_COLUMNS = "id, resource_id, calendar_id, account_email, status, last_synced_at, last_error, created_at";

export const connectionFromRow = (row: ConnectionRow): CalendarConnection => calendarConnectionSchema.parse({
  id: row.id,
  provider: "google",
  resourceId: row.resource_id,
  calendarId: row.calendar_id,
  accountEmail: row.account_email,
  status: row.status,
  lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
  lastError: row.last_error,
  createdAt: row.created_at.toISOString(),
});

/** G-2: the reserved key the connect action runs under, one per connection. */
export const googleConnectIdempotencyKey = (connectionId: string) => `oauth-google:${connectionId.toLowerCase()}`;

/** Whether the booking resource is this tenant's; RLS hides every other tenant's. */
export async function resourceInTenant(tx: Transaction, tenantId: string, resourceId: string): Promise<boolean> {
  return (await tx.query("SELECT 1 FROM booking_resources WHERE tenant_id=$1 AND id=$2", [tenantId, resourceId])).rowCount === 1;
}

export async function getCalendarConnection(tx: Transaction, tenantId: string, connectionId: string): Promise<CalendarConnection | null> {
  const row = (await tx.query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM calendar_connections WHERE tenant_id=$1 AND id=$2`, [tenantId, connectionId])).rows[0];
  return row ? connectionFromRow(row) : null;
}

/** G-5: the tenant's connections, newest first. */
export async function listCalendarConnections(tx: Transaction, tenantId: string, limit = 100): Promise<CalendarConnection[]> {
  return (await tx.query<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM calendar_connections WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT $2`,
    [tenantId, limit])).rows.map(connectionFromRow);
}

async function resolveConnectionTarget(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "calendar_connection") throw new ValidationFailed("Calendar actions require a calendar_connection target");
  const tenantId = await currentTenant(tx);
  if (!tenantId || tenantId !== target.tenantId) return null;
  return { tenantId, type: "calendar_connection", id: target.id };
}

/**
 * G-2, G-4: record the grant the callback sealed. Only the callback's reserved key is accepted,
 * so an approval run (`approval:<id>`) or a hand-built command is refused. The resource must be
 * the tenant's; an older connection of the resource that still holds a grant is retired to
 * 'disconnecting' first, so the worker revokes it and removes its blocks (G-9).
 */
export const connectGoogleCalendarHandler: ActionHandler = {
  resolveTarget: resolveConnectionTarget,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(connectGoogleCalendarCommandSchema, command);
    if (command.target.id !== payload.connectionId) throw new ValidationFailed("Target must name the connection");
    if (command.idempotencyKey !== googleConnectIdempotencyKey(payload.connectionId))
      throw new ValidationFailed("Calendar connect runs only from the OAuth callback");
    if (!(await resourceInTenant(tx, binding.tenantId, payload.resourceId)))
      throw new TenantDenied("Booking resource is not owned by this tenant");
    if ((await tx.query("SELECT 1 FROM calendar_connections WHERE tenant_id=$1 AND id=$2", [binding.tenantId, payload.connectionId])).rowCount)
      throw idInUse("calendar connection");
    await tx.query(
      `UPDATE calendar_connections SET status='disconnecting', updated_at=$3
        WHERE tenant_id=$1 AND resource_id=$2 AND status IN ('active','reauthorize')`,
      [binding.tenantId, payload.resourceId, now]);
    const row = (await tx.query<ConnectionRow>(
      `INSERT INTO calendar_connections (tenant_id, id, resource_id, calendar_id, account_email, status, refresh_token_sealed, scope,
         created_by, next_sync_at, created_at, updated_at)
       VALUES ($1,$2,$3,'primary',$4,'active',$5,$6,$7,$8,$8,$8) RETURNING ${CONNECTION_COLUMNS}`,
      [binding.tenantId, payload.connectionId, payload.resourceId, payload.accountEmail, payload.refreshTokenSealed, payload.scope,
        binding.actorId, now])).rows[0]!;
    return { result: { ...connectionFromRow(row) } };
  },
};

/** G-5: an active or reauthorize connection becomes disconnecting; a retired one answers as it is. */
export const disconnectCalendarHandler: ActionHandler = {
  resolveTarget: resolveConnectionTarget,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(disconnectCalendarCommandSchema, command);
    if (command.target.id !== payload.connectionId) throw new ValidationFailed("Target must name the connection");
    const current = (await tx.query<{ status: CalendarConnection["status"] }>(
      "SELECT status FROM calendar_connections WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [binding.tenantId, payload.connectionId])).rows[0];
    if (!current) throw new NotFound();
    if (current.status === "active" || current.status === "reauthorize")
      await tx.query("UPDATE calendar_connections SET status='disconnecting', updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [binding.tenantId, payload.connectionId, now]);
    const connection = await getCalendarConnection(tx, binding.tenantId, payload.connectionId);
    return { result: { ...connection! } };
  },
};

export const calendarHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [CALENDAR_GOOGLE_CONNECT_ACTION]: connectGoogleCalendarHandler,
  [CALENDAR_GOOGLE_DISCONNECT_ACTION]: disconnectCalendarHandler,
});
