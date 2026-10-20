// M5 Activepieces rows and the records the edge returns (activepieces.md W-2, W-9, W-14).
// Runs as the runtime role inside ScopedDatabase.tenant, or as the service role naming tenant_id.
import type {
  AutomationEventType,
  AutomationScope,
  AutomationToken,
  WebhookDelivery,
  WebhookDeliveryFinalReason,
  WebhookDeliveryStatus,
  WebhookEndpoint,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { derivedId } from "../edge/ids.js";

/** W-11: the actor a token's proposals carry, one per token, so an owner sees which token asked. */
export const automationActorId = (tenantId: string, tokenId: string) => derivedId(tenantId, "activepieces", tokenId, "actor");

export interface EndpointRow {
  tenant_id: string;
  id: string;
  url: string;
  description: string | null;
  events: AutomationEventType[];
  enabled: boolean;
  revision: string;
  secret_version: number;
  previous_secret_version: number | null;
  previous_valid_until: Date | null;
  scan_from: Date;
  created_at: Date;
  updated_at: Date;
}
// pg returns an enum array as its text form; cast to text[] so it arrives as an array.
export const ENDPOINT_COLUMNS = `tenant_id, id, url, description, events::text[] AS events, enabled, revision::text AS revision,
  secret_version, previous_secret_version, previous_valid_until, scan_from, created_at, updated_at`;

export async function loadEndpoint(tx: Transaction, tenantId: string, id: string, lock = false): Promise<EndpointRow | null> {
  return (await tx.query<EndpointRow>(
    `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, id])).rows[0] ?? null;
}

/** W-5: the previous secret counts only inside its grace, against the injected clock. */
export const previousVersion = (row: Pick<EndpointRow, "previous_secret_version" | "previous_valid_until">, now: Date) =>
  row.previous_secret_version !== null && row.previous_valid_until !== null && now.getTime() < row.previous_valid_until.getTime()
    ? row.previous_secret_version
    : null;

export function endpointRecord(row: EndpointRow, now: Date): WebhookEndpoint {
  const previous = previousVersion(row, now);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    url: row.url,
    events: [...row.events],
    description: row.description,
    enabled: row.enabled,
    revision: Number(row.revision),
    secretVersion: row.secret_version,
    previousSecretValidUntil: previous === null ? null : row.previous_valid_until!.toISOString(),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface DeliveryRow {
  id: string;
  endpoint_id: string;
  event_id: string;
  event_type: AutomationEventType;
  status: WebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: Date;
  last_status_code: number | null;
  last_error: string | null;
  final_reason: WebhookDeliveryFinalReason | null;
  delivered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export const DELIVERY_COLUMNS = `id, endpoint_id, event_id, event_type::text AS event_type, status, attempts, next_attempt_at,
  last_status_code, last_error, final_reason, delivered_at, created_at, updated_at`;

/** The `webhook-id` header for one event: stable across attempts and replays (W-8). */
export const webhookEventId = (eventId: string) => `evt_${eventId.replaceAll("-", "")}`;

export function deliveryRecord(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventId: webhookEventId(row.event_id),
    eventType: row.event_type,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at.toISOString(),
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    finalReason: row.final_reason,
    deliveredAt: row.delivered_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface TokenRow {
  tenant_id: string;
  id: string;
  name: string;
  scopes: AutomationScope[];
  created_by: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
}
export const TOKEN_COLUMNS = "tenant_id, id, name, scopes::text[] AS scopes, created_by, created_at, expires_at, revoked_at, revoked_by";

export async function loadToken(tx: Transaction, tenantId: string, id: string, lock?: "update" | "share"): Promise<TokenRow | null> {
  const suffix = lock ? ` FOR ${lock === "update" ? "UPDATE" : "SHARE"}` : "";
  return (await tx.query<TokenRow>(`SELECT ${TOKEN_COLUMNS} FROM automation_tokens WHERE tenant_id=$1 AND id=$2${suffix}`,
    [tenantId, id])).rows[0] ?? null;
}

/** W-9: a token works while it is not revoked and, if it has an expiry, before it. */
export const tokenActive = (row: Pick<TokenRow, "revoked_at" | "expires_at">, now: Date) =>
  row.revoked_at === null && (row.expires_at === null || now.getTime() < row.expires_at.getTime());

export function tokenRecord(row: TokenRow): AutomationToken {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    scopes: [...row.scopes],
    actorId: automationActorId(row.tenant_id, row.id),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    revokedBy: row.revoked_by,
  };
}
