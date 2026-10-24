// M5 Activepieces webhook worker (activepieces.md W-7, W-8). Original code, built on the M3d
// delivery worker's semantics: it runs as the service role, names tenant_id in every statement,
// claims work with leases under FOR UPDATE SKIP LOCKED, checks the lease token on every later
// write, retries with backoff and ends in a dead letter. The HTTP call happens between two short
// transactions. Receivers get every event at least once under a stable `webhook-id`.
import { z } from "zod";
import { ValidationFailed, type AutomationEventType, type WebhookDeliveryFinalReason } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { approvalForAction } from "../approvals/records.js";
import { readClock } from "../booking/slots.js";
import { backoffMs } from "../delivery/policy.js";
import { derivedId } from "../edge/ids.js";
import { businessEvents, SOURCE_EVENT_TYPES, type OutboxRow } from "./events.js";
import { signingSecrets, webhookSignatureHeader, type AutomationKeySecrets } from "./keys.js";
import { ENDPOINT_COLUMNS, previousVersion, webhookEventId, type EndpointRow } from "./records.js";
import { webhookUrlProblem, type UrlPolicy, type WebhookResponse, type WebhookTransport } from "./transport.js";

const positiveMs = z.number().int().positive().max(7 * 24 * 60 * 60 * 1000);
export const webhookWorkerConfigSchema = z.strictObject({
  workerId: z.string().min(1).max(200),
  leaseMs: positiveMs.default(60_000),
  /** Longest wait for one receiver; it must end well inside the lease. */
  requestTimeoutMs: positiveMs.default(10_000),
  maxAttempts: z.number().int().min(1).max(50).default(8),
  maxStepErrors: z.number().int().min(1).max(50).default(5),
  backoffBaseMs: positiveMs.default(30_000),
  backoffMaxMs: positiveMs.default(6 * 60 * 60_000),
  /** W-7: how far behind the newest ingest a later commit may still land and be found. */
  ingestLookbackMs: positiveMs.default(60 * 60_000),
  /** Endpoints one ingest pass reads, and outbox rows per endpoint. */
  ingestEndpoints: z.number().int().min(1).max(1000).default(50),
  ingestRows: z.number().int().min(1).max(1000).default(100),
  allowLoopback: z.boolean().default(false),
}).refine((config) => config.requestTimeoutMs * 2 <= config.leaseMs,
  "requestTimeoutMs must be at most half of leaseMs, so a lease outlives its request");
export type WebhookWorkerConfig = z.input<typeof webhookWorkerConfigSchema>;
type Config = z.infer<typeof webhookWorkerConfigSchema>;

export type WebhookReport =
  | { readonly kind: "lost_lease"; readonly tenantId: string; readonly deliveryId: string }
  | { readonly kind: "step_failed"; readonly tenantId: string; readonly deliveryId: string; readonly error: string }
  | { readonly kind: "ingest_failed"; readonly tenantId: string; readonly endpointId: string; readonly error: string };

export interface WebhookWorkerDeps {
  /** A service-role transaction: `(work) => asService(servicePool, work)`. */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly transport: WebhookTransport;
  readonly keys: AutomationKeySecrets;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly config: WebhookWorkerConfig;
  readonly report?: (event: WebhookReport) => void;
}

export interface WebhookClaim {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly leaseToken: string;
}
export type WebhookStepResult =
  | { readonly outcome: "delivered"; readonly status: number }
  | { readonly outcome: "dead"; readonly reason: WebhookDeliveryFinalReason }
  | { readonly outcome: "retry"; readonly reason: string }
  | { readonly outcome: "lost_lease" }
  | { readonly outcome: "error"; readonly error: string };

interface LeasedRow {
  tenant_id: string;
  id: string;
  endpoint_id: string;
  outbox_id: string;
  occurred_at: Date;
  replayed_at: Date | null;
  event_id: string;
  body: string;
  attempts: number;
  step_errors: number;
}
type Plan =
  | { readonly kind: "done"; readonly result: WebhookStepResult }
  | { readonly kind: "send"; readonly attempt: number; readonly url: string; readonly headers: Record<string, string>; readonly body: string };

/** Transport errors that are the URL policy's refusal, not a network failure: `address_refused`, `url_…`. */
const URL_REFUSALS = /^(address_refused$|url_)/;

const errorText = (code: string) => (code.replaceAll("\u0000", "").trim() || "unknown").slice(0, 200);

/** W-3: the envelope every event shares. Its bytes are fixed at ingest (W-8). */
function eventBody(input: { eventId: string; type: AutomationEventType; tenantId: string; occurredAt: Date; data: unknown }): string {
  return JSON.stringify({
    id: webhookEventId(input.eventId),
    type: input.type,
    tenantId: input.tenantId,
    occurredAt: input.occurredAt.toISOString(),
    data: input.data,
  });
}

/**
 * approvals.md A-8, A-10: an event whose action ran under a stored approval goes out only while
 * that approval stands. A direct action (no approval record) stands; a revoked, expired or
 * rejected approval, or an outbox row with no action, does not.
 */
async function approvalStands(tx: Transaction, tenantId: string, outboxId: string, at: Date): Promise<boolean> {
  const actionId = (await tx.query<{ action_id: string | null }>(
    "SELECT action_id FROM outbox WHERE tenant_id=$1 AND id=$2", [tenantId, outboxId])).rows[0]?.action_id;
  if (!actionId) return false;
  const found = await approvalForAction(tx, tenantId, actionId, at);
  if (found === null || found.kind === "direct") return found !== null;
  // A-15: a templated send also needs its revision to be the current one.
  return found.standing === "approved" && (found.kind !== "standing" || found.current);
}

export function createWebhookWorker(deps: WebhookWorkerDeps) {
  const parsed = webhookWorkerConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new ValidationFailed(`Invalid webhook worker config: ${parsed.error.message}`);
  const config: Config = parsed.data;
  const policy: UrlPolicy = { allowLoopback: config.allowLoopback };
  const now = () => new Date(readClock(deps.clock));

  /**
   * W-7: for one endpoint, maps each outbox row of a source type since `scan_from` that it has
   * not read yet into its deliveries, and marks the row read, in one transaction. The endpoint
   * row lock keeps two workers off the same endpoint; `scan_from` moves to `lookback` before now
   * once a pass reads everything, so a transaction that commits late is still found.
   */
  async function ingestEndpoint(tenantId: string, endpointId: string): Promise<{ events: number; rows: number }> {
    return deps.service(async (tx) => {
      const at = now();
      const endpoint = (await tx.query<EndpointRow>(
        `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE tenant_id=$1 AND id=$2 AND enabled FOR UPDATE SKIP LOCKED`,
        [tenantId, endpointId])).rows[0];
      if (!endpoint) return { events: 0, rows: 0 };
      const rows = (await tx.query<OutboxRow>(
        `SELECT o.tenant_id, o.id, o.event_type, o.payload, o.created_at FROM outbox o
          WHERE o.tenant_id=$1 AND o.event_type = ANY($2::text[]) AND o.created_at >= $3
            AND NOT EXISTS (SELECT 1 FROM webhook_ingest_marks m
                             WHERE m.tenant_id=o.tenant_id AND m.endpoint_id=$4 AND m.outbox_id=o.id)
          ORDER BY o.created_at, o.id LIMIT $5`,
        [tenantId, SOURCE_EVENT_TYPES, endpoint.scan_from, endpoint.id, config.ingestRows])).rows;
      const wanted = new Set(endpoint.events);
      let events = 0;
      for (const row of rows) {
        const found = await approvalStands(tx, tenantId, row.id, at) ? await businessEvents(tx, row) : [];
        for (const event of found) {
          if (!wanted.has(event.type)) continue;
          // One event ID per outbox row and type, the same for every endpoint and replay.
          const eventId = derivedId(tenantId, row.id, event.type, "webhook-event");
          const inserted = await tx.query(
            `INSERT INTO webhook_deliveries (tenant_id, id, endpoint_id, outbox_id, event_type, event_id, body, next_attempt_at,
               created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5::automation_event_type,$6,$7::json,$8,$8,$8) ON CONFLICT DO NOTHING`,
            [tenantId, deps.generateId(), endpoint.id, row.id, event.type, eventId,
              eventBody({ eventId, type: event.type, tenantId, occurredAt: row.created_at, data: event.data }), at]);
          events += inserted.rowCount ?? 0;
        }
        await tx.query(
          "INSERT INTO webhook_ingest_marks (tenant_id, endpoint_id, outbox_id, ingested_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [tenantId, endpoint.id, row.id, at]);
      }
      const drained = rows.length < config.ingestRows;
      const next = new Date(at.getTime() - config.ingestLookbackMs);
      await tx.query(
        `UPDATE webhook_endpoints SET ingested_at=$3, scan_from = CASE WHEN $4 THEN greatest(scan_from, $5) ELSE scan_from END
          WHERE tenant_id=$1 AND id=$2`,
        [tenantId, endpoint.id, at, drained, next]);
      return { events, rows: rows.length };
    });
  }

  /** One ingest pass over the enabled endpoints; one endpoint that fails does not stop the rest. */
  async function ingest(): Promise<{ endpoints: number; events: number }> {
    const endpoints = await deps.service(async (tx) => (await tx.query<{ tenant_id: string; id: string }>(
      // W-7: least recently visited first, so a new endpoint never waits behind full ones.
      "SELECT tenant_id, id FROM webhook_endpoints WHERE enabled ORDER BY ingested_at NULLS FIRST, tenant_id, id LIMIT $1",
      [config.ingestEndpoints])).rows);
    let events = 0;
    for (const endpoint of endpoints) {
      try {
        events += (await ingestEndpoint(endpoint.tenant_id, endpoint.id)).events;
      } catch (error) {
        deps.report?.({
          kind: "ingest_failed", tenantId: endpoint.tenant_id, endpointId: endpoint.id,
          error: errorText(error instanceof Error ? error.message : "ingest_failed"),
        });
      }
    }
    return { endpoints: endpoints.length, events };
  }

  /** W-8: leases due deliveries and expired leases, skipping rows another worker holds. */
  async function claim(limit = 10): Promise<WebhookClaim[]> {
    return deps.service(async (tx) => {
      const at = now();
      const token = deps.generateId();
      const rows = (await tx.query<{ tenant_id: string; id: string }>(
        `WITH due AS (
           SELECT tenant_id, id FROM webhook_deliveries
            WHERE (status = 'pending' AND next_attempt_at <= $1) OR (status = 'leased' AND lease_expires_at <= $1)
            ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE webhook_deliveries d SET status='leased', lease_token=$3, lease_owner=$4, lease_expires_at=$5, updated_at=$1
           FROM due WHERE d.tenant_id=due.tenant_id AND d.id=due.id
         RETURNING d.tenant_id, d.id`,
        [at, limit, token, config.workerId, new Date(at.getTime() + config.leaseMs)])).rows;
      return rows.map((row) => ({ tenantId: row.tenant_id, deliveryId: row.id, leaseToken: token }));
    });
  }

  const lockLeased = async (tx: Transaction, lease: WebhookClaim): Promise<LeasedRow | undefined> =>
    (await tx.query<LeasedRow>(
      `SELECT d.tenant_id, d.id, d.endpoint_id, d.outbox_id, o.created_at AS occurred_at, d.event_id, d.body::text AS body,
         d.attempts, d.step_errors, d.replayed_at
        FROM webhook_deliveries d JOIN outbox o ON o.tenant_id = d.tenant_id AND o.id = d.outbox_id
        WHERE d.tenant_id=$1 AND d.id=$2 AND d.lease_token=$3 AND d.status='leased' FOR UPDATE OF d`,
      [lease.tenantId, lease.deliveryId, lease.leaseToken])).rows[0];

  const RELEASE = "lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL";
  async function deadLetter(tx: Transaction, row: LeasedRow, reason: WebhookDeliveryFinalReason, at: Date, error?: string) {
    await tx.query(
      `UPDATE webhook_deliveries SET status='dead', final_reason=$3, last_error=coalesce($4,last_error), ${RELEASE}, updated_at=$5
        WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, reason, error === undefined ? null : errorText(error), at]);
    return { outcome: "dead", reason } as const;
  }

  /** Opens the attempt and signs it, inside one transaction under the lease. */
  async function prepare(lease: WebhookClaim): Promise<Plan> {
    return deps.service(async (tx) => {
      const row = await lockLeased(tx, lease);
      if (!row) return { kind: "done", result: { outcome: "lost_lease" } };
      const at = now();
      await tx.query("UPDATE webhook_deliveries SET lease_expires_at=$3 WHERE tenant_id=$1 AND id=$2",
        [row.tenant_id, row.id, new Date(at.getTime() + config.leaseMs)]);
      // An attempt left open by a holder whose lease ran out may have reached the receiver.
      await tx.query(
        `UPDATE webhook_delivery_attempts SET outcome='lost', error_code='lease_lost', finished_at=$3
          WHERE tenant_id=$1 AND delivery_id=$2 AND outcome IS NULL`, [row.tenant_id, row.id, at]);
      if (row.step_errors >= config.maxStepErrors)
        return { kind: "done", result: await deadLetter(tx, row, "worker_error", at, "step_errors") };
      const endpoint = (await tx.query<EndpointRow>(
        `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, row.endpoint_id])).rows[0];
      // W-7, W-8: switched off, or switched back on after this event happened (it was queued
      // before). An owner's replay of a dead letter (W-14) is a choice to send it anyway, under
      // the activation it was made in: switched off and on again after it, the replay is dropped too.
      const since = row.replayed_at ?? row.occurred_at;
      if (!endpoint || !endpoint.enabled || since.getTime() < endpoint.activated_at.getTime())
        return { kind: "done", result: await deadLetter(tx, row, "endpoint_disabled", at) };
      const problem = webhookUrlProblem(endpoint.url, policy);
      if (problem) return { kind: "done", result: await deadLetter(tx, row, "url_refused", at, problem) };
      if (row.attempts >= config.maxAttempts) return { kind: "done", result: await deadLetter(tx, row, "max_attempts", at) };
      if (!await approvalStands(tx, row.tenant_id, row.outbox_id, at))
        return { kind: "done", result: await deadLetter(tx, row, "approval_withdrawn", at) };
      const attempt = (await tx.query<{ next: number }>(
        "SELECT coalesce(max(attempt),0)+1 AS next FROM webhook_delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2",
        [row.tenant_id, row.id])).rows[0]!.next;
      await tx.query("INSERT INTO webhook_delivery_attempts (tenant_id, delivery_id, attempt, started_at) VALUES ($1,$2,$3,$4)",
        [row.tenant_id, row.id, attempt, at]);
      await tx.query("UPDATE webhook_deliveries SET attempts=attempts+1, updated_at=$3 WHERE tenant_id=$1 AND id=$2",
        [row.tenant_id, row.id, at]);
      // W-5, W-6: signed now, with every secret the receiver may hold.
      const id = webhookEventId(row.event_id);
      const timestamp = Math.floor(at.getTime() / 1000);
      const secrets = signingSecrets(deps.keys, row.tenant_id, endpoint.id, {
        secretVersion: endpoint.secret_version, previousVersion: previousVersion(endpoint, at),
      });
      return {
        kind: "send",
        attempt,
        url: endpoint.url,
        body: row.body,
        headers: {
          "content-type": "application/json",
          "user-agent": "zs-business-webhooks/1",
          "webhook-id": id,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": webhookSignatureHeader(secrets, id, timestamp, row.body),
        },
      };
    });
  }

  /** W-8: 2xx is delivered; 410 means the receiver is gone; a refused URL stops; anything else retries with backoff. */
  async function record(lease: WebhookClaim, attempt: number, response: WebhookResponse): Promise<WebhookStepResult> {
    return deps.service(async (tx) => {
      const row = await lockLeased(tx, lease);
      if (!row) return { outcome: "lost_lease" };
      const at = now();
      const status = "status" in response && response.status >= 100 && response.status <= 599 ? response.status : null;
      const delivered = status !== null && status >= 200 && status < 300;
      const code = "error" in response ? errorText(response.error) : delivered ? null : `http_${status ?? 0}`;
      await tx.query(
        `UPDATE webhook_delivery_attempts SET outcome=$4, status_code=$5, error_code=$6, finished_at=$7
          WHERE tenant_id=$1 AND delivery_id=$2 AND attempt=$3 AND outcome IS NULL`,
        [row.tenant_id, row.id, attempt, delivered ? "delivered" : "failed", status, code, at]);
      if (delivered) {
        await tx.query(
          `UPDATE webhook_deliveries SET status='delivered', delivered_at=$3, last_status_code=$4, last_error=NULL, ${RELEASE},
             updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, row.id, at, status]);
        return { outcome: "delivered", status: status! };
      }
      await tx.query("UPDATE webhook_deliveries SET last_status_code=coalesce($3,last_status_code), last_error=$4 WHERE tenant_id=$1 AND id=$2",
        [row.tenant_id, row.id, status, code]);
      if (status === 410) return deadLetter(tx, row, "endpoint_gone", at);
      // W-8: a URL the transport refused (a name that resolves to a private address) is not retried.
      if (code !== null && URL_REFUSALS.test(code)) return deadLetter(tx, row, "url_refused", at);
      if (row.attempts >= config.maxAttempts) return deadLetter(tx, row, "max_attempts", at);
      const next = new Date(at.getTime() + backoffMs(row.attempts, config.backoffBaseMs, config.backoffMaxMs));
      await tx.query(`UPDATE webhook_deliveries SET status='pending', next_attempt_at=$3, ${RELEASE}, updated_at=$4 WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.id, next, at]);
      return { outcome: "retry", reason: code! };
    });
  }

  async function post(plan: Extract<Plan, { kind: "send" }>): Promise<WebhookResponse> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<WebhookResponse>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ error: "timeout" });
      }, config.requestTimeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => deps.transport.post({ url: plan.url, headers: plan.headers, body: plan.body, signal: controller.signal }))
          .catch((error: unknown) => ({ error: error instanceof Error ? `transport: ${error.message}` : "transport" })),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function step(lease: WebhookClaim): Promise<WebhookStepResult> {
    const plan = await prepare(lease);
    const result = plan.kind === "done" ? plan.result : await record(lease, plan.attempt, await post(plan));
    if (result.outcome === "lost_lease") deps.report?.({ kind: "lost_lease", tenantId: lease.tenantId, deliveryId: lease.deliveryId });
    return result;
  }

  /** After a step threw: count it and hand the row back with backoff while the lease is still ours. */
  async function noteStepError(lease: WebhookClaim, error: unknown): Promise<WebhookStepResult> {
    const text = errorText(error instanceof Error ? error.message : "step_failed");
    deps.report?.({ kind: "step_failed", tenantId: lease.tenantId, deliveryId: lease.deliveryId, error: text });
    try {
      await deps.service(async (tx) => {
        const at = now();
        await tx.query(
          `UPDATE webhook_deliveries SET step_errors=step_errors+1, status='pending', next_attempt_at=$4, last_error=$5, ${RELEASE},
             updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND lease_token=$6 AND status='leased'`,
          [lease.tenantId, lease.deliveryId, at, new Date(at.getTime() + config.backoffBaseMs), text, lease.leaseToken]);
      });
    } catch {
      // The lease runs out on its own; the next holder sees the same row.
    }
    return { outcome: "error", error: text };
  }

  /** One pass: ingest new events, claim due deliveries, send each in turn. */
  async function runOnce(options: { claimLimit?: number } = {}) {
    const ingested = await ingest();
    const leases = await claim(options.claimLimit ?? 10);
    const results: WebhookStepResult[] = [];
    for (const lease of leases) results.push(await step(lease).catch((error: unknown) => noteStepError(lease, error)));
    return { ingested: ingested.events, claimed: leases.length, results };
  }

  return { ingest, ingestEndpoint, claim, step, runOnce, config };
}
export type WebhookWorker = ReturnType<typeof createWebhookWorker>;
