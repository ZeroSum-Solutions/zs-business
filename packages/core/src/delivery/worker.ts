// M3d delivery worker (delivery.md D-2..D-8). Original code. It runs as the service role (the
// outbox processing entry point, @zs/db asService) and names tenant_id in every statement.
// One delivery moves through three short transactions: claim (lease), prepare (re-check,
// reserve, open an attempt) and record (settle). The provider call happens between prepare and
// record, outside any transaction; every write after the claim checks the lease token.
import { z } from "zod";
import {
  Conflict,
  MESSAGE_SEND_REQUESTED,
  messageSendRequestedSchema,
  NotFound,
  ValidationFailed,
  type DeliveryChannel,
  type DeliveryFinalReason,
  type DeliveryPurpose,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { captureReservation, heldReservation, releaseReservation, reserveFunds } from "../wallet/index.js";
import {
  backoffMs,
  consentBlock,
  deliveryContentDigest,
  deliveryPrice,
  usableEmail,
  type ConsentStatus,
} from "./policy.js";
import type {
  DeliveryApprovals,
  DeliveryProvider,
  ProviderLookupOutcome,
  ProviderSendOutcome,
  ProviderSendRequest,
} from "./provider.js";
import { signUnsubscribeToken } from "./unsubscribe.js";

const positiveMs = z.number().int().positive().max(7 * 24 * 60 * 60 * 1000);
export const deliveryWorkerConfigSchema = z.strictObject({
  /** Names this worker on its leases; for operators only. */
  workerId: z.string().min(1).max(200),
  leaseMs: positiveMs.default(60_000),
  /** Longest wait for one provider call; it must end well inside the lease. */
  providerTimeoutMs: positiveMs.default(15_000),
  maxAttempts: z.number().int().min(1).max(50).default(6),
  /** Steps that threw (a database error, a failing settlement hook) before a dead letter `worker_error`. */
  maxStepErrors: z.number().int().min(1).max(50).default(5),
  backoffBaseMs: positiveMs.default(30_000),
  backoffMaxMs: positiveMs.default(30 * 60_000),
  /** No send starts this close to the end of the provider's dedupe window (D-8). */
  dedupeMarginMs: positiveMs.default(10 * 60_000),
  pricing: z.strictObject({
    currency: z.string().regex(/^[a-z]{3}$/).default("usd"),
    email: z.number().int().positive(),
    smsSegment: z.number().int().positive(),
  }),
  unsubscribe: z.strictObject({
    secret: z.string().min(32),
    /** Absolute URL the token is appended to, e.g. https://api.example.com/public/v1/unsubscribe */
    baseUrl: z.url({ protocol: /^https?$/ }),
  }),
  smsOptOutText: z.string().min(1).max(100).default("Reply STOP to opt out."),
}).refine((config) => config.providerTimeoutMs * 2 <= config.leaseMs,
  "providerTimeoutMs must be at most half of leaseMs, so a lease outlives its provider call");
export type DeliveryWorkerConfig = z.input<typeof deliveryWorkerConfigSchema>;
type Config = z.infer<typeof deliveryWorkerConfigSchema>;

export type DeliveryReport =
  | { readonly kind: "invalid_event"; readonly tenantId: string; readonly outboxId: string; readonly error: string }
  | { readonly kind: "ingest_deferred"; readonly tenantId: string; readonly outboxId: string; readonly error: string }
  | { readonly kind: "lost_lease"; readonly tenantId: string; readonly deliveryId: string }
  | { readonly kind: "step_failed"; readonly tenantId: string; readonly deliveryId: string; readonly error: string };

export interface DeliveryWorkerDeps {
  /** A service-role transaction: `(work) => asService(servicePool, work)`. */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly providers: Readonly<Record<DeliveryChannel, DeliveryProvider>>;
  readonly approvals: DeliveryApprovals;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly config: DeliveryWorkerConfig;
  readonly report?: (event: DeliveryReport) => void;
  /**
   * Called inside the transaction that settles a delivery for good: "sent", or "failed" for a
   * block or a dead letter. An outcome-unknown dead letter calls it when an operator settles it.
   * The producer's own record (an Inbox reply) moves with the delivery, or not at all. The
   * transaction is the service role's: name tenant_id in every statement.
   */
  readonly onSettled?: (tx: Transaction, tenantId: string, messageId: string, outcome: "sent" | "failed", at: Date) => Promise<void>;
}

export interface Claim {
  readonly tenantId: string;
  readonly deliveryId: string;
  readonly leaseToken: string;
}

/** Where one processing step left the delivery. */
export type StepResult =
  | { readonly outcome: "sent"; readonly providerMessageId: string }
  | { readonly outcome: "blocked" | "dead"; readonly reason: DeliveryFinalReason }
  | { readonly outcome: "retry"; readonly status: "pending" | "uncertain"; readonly reason: string }
  | { readonly outcome: "lost_lease" }
  | { readonly outcome: "error"; readonly error: string };

interface DeliveryRow {
  tenant_id: string;
  id: string;
  message_id: string;
  channel: DeliveryChannel;
  purpose: DeliveryPurpose;
  contact_id: string;
  action_id: string;
  subject: string | null;
  body: string;
  outcome_unknown: boolean;
  attempts: number;
  first_attempt_at: Date | null;
  idempotency_key: string;
  recipient_address: string | null;
  provider: string | null;
  request: StoredRequest | null;
  step_errors: number;
}

/** What the first attempt sent; every later attempt under the same key replays it byte for byte (D-8). */
interface StoredRequest {
  subject: string | null;
  text: string;
  headers: Record<string, string>;
}

type Terminal = { readonly status: "blocked" | "dead"; readonly reason: DeliveryFinalReason };
type Plan =
  | { readonly kind: "done"; readonly result: StepResult }
  | { readonly kind: "send"; readonly attempt: number; readonly request: ProviderSendRequest }
  | { readonly kind: "lookup"; readonly onNotFound: Terminal; readonly channel: DeliveryChannel; readonly key: string; readonly startedAt: Date };

/** Provider text fits a column of `max` characters, never empty and never carrying NUL. */
const boundedText = (text: string, max: number) => (text.replaceAll("\u0000", "").trim() || "unknown").slice(0, max);
const errorText = (code: string) => boundedText(code, 200);

/**
 * D-2: a database error that will recur for this event (bad data, a constraint), so the event
 * may be marked processed. Anything else (a lock or statement timeout, a deadlock, a
 * serialization failure, a lost connection) is retried on a later pass.
 */
export function isPermanentIngestError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^(22|23)[0-9A-Z]{3}$/.test(code);
}

export function createDeliveryWorker(deps: DeliveryWorkerDeps) {
  const parsed = deliveryWorkerConfigSchema.safeParse(deps.config);
  if (!parsed.success) throw new ValidationFailed(`Invalid delivery worker config: ${parsed.error.message}`);
  const config: Config = parsed.data;
  const now = () => new Date(readClock(deps.clock));
  const provider = (channel: DeliveryChannel) => {
    const found = deps.providers[channel];
    if (!found) throw new ValidationFailed(`No delivery provider for ${channel}`);
    return found;
  };
  provider("email");
  provider("sms");

  /** Runs `work` with the provider deadline; a timeout or a throw is an uncertain outcome. */
  async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, onError: (code: string) => T): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(onError("provider_timeout"));
      }, config.providerTimeoutMs);
    });
    try {
      return await Promise.race([
        // An adapter that throws before returning a promise is uncertain too.
        Promise.resolve().then(() => work(controller.signal)).catch((error: unknown) => onError(error instanceof Error ? `provider_error: ${error.message}` : "provider_error")),
        timedOut,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** D-2: moves unprocessed send events into deliveries, one transaction per batch. */
  async function ingest(limit = 100): Promise<{ ingested: number; duplicates: number; invalid: number; deferred: number }> {
    return deps.service(async (tx) => {
      const at = now();
      const events = (await tx.query<{ tenant_id: string; id: string; action_id: string; payload: unknown }>(
        `SELECT tenant_id, id, action_id, payload FROM outbox
          WHERE event_type=$1 AND processed_at IS NULL ORDER BY seq LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [MESSAGE_SEND_REQUESTED, limit])).rows;
      const counts = { ingested: 0, duplicates: 0, invalid: 0, deferred: 0 };
      const invalid = (event: { tenant_id: string; id: string }, error: string) => {
        counts.invalid += 1;
        deps.report?.({ kind: "invalid_event", tenantId: event.tenant_id, outboxId: event.id, error });
      };
      for (const event of events) {
        const message = messageSendRequestedSchema.safeParse(event.payload);
        if (!message.success) invalid(event, message.error.message);
        else {
          // One event that the database refuses must not hold back the rest of the batch.
          await tx.query("SAVEPOINT delivery_ingest");
          try {
            const contact = await tx.query(
              "SELECT 1 FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [event.tenant_id, message.data.contactId]);
            if (contact.rowCount !== 1) invalid(event, "Unknown contact");
            else {
              const id = deps.generateId();
              const inserted = await tx.query(
                `INSERT INTO message_deliveries (tenant_id, id, outbox_id, message_id, channel, purpose, contact_id,
                   action_id, subject, body, next_attempt_at, idempotency_key, created_at, updated_at)
                 VALUES ($1,$2,$3,$4,$5::crm_consent_channel,$6,$7,$8,$9,$10,$11,$12,$11,$11)
                 ON CONFLICT DO NOTHING`,
                [event.tenant_id, id, event.id, message.data.messageId, message.data.channel, message.data.purpose,
                  message.data.contactId, event.action_id, message.data.subject, message.data.body, at, `zsd-${id}`]);
              if (inserted.rowCount === 1) counts.ingested += 1;
              else counts.duplicates += 1;
            }
            await tx.query("RELEASE SAVEPOINT delivery_ingest");
          } catch (error) {
            await tx.query("ROLLBACK TO SAVEPOINT delivery_ingest");
            const text = error instanceof Error ? error.message.slice(0, 500) : "Insert refused";
            if (!isPermanentIngestError(error)) {
              // A valid event is never dropped for a passing failure: it stays unprocessed.
              counts.deferred += 1;
              deps.report?.({ kind: "ingest_deferred", tenantId: event.tenant_id, outboxId: event.id, error: text });
              continue;
            }
            invalid(event, text);
          }
        }
        await tx.query("UPDATE outbox SET processed_at=$3 WHERE tenant_id=$1 AND id=$2", [event.tenant_id, event.id, at]);
      }
      return counts;
    });
  }

  /** D-3: leases due deliveries and expired leases, skipping rows another worker holds. */
  async function claim(limit = 10): Promise<Claim[]> {
    return deps.service(async (tx) => {
      const at = now();
      const token = deps.generateId();
      const rows = (await tx.query<{ tenant_id: string; id: string }>(
        `WITH due AS (
           SELECT tenant_id, id FROM message_deliveries
            WHERE (status IN ('pending','uncertain') AND next_attempt_at <= $1)
               OR (status = 'leased' AND lease_expires_at <= $1)
            ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED)
         UPDATE message_deliveries d SET status='leased', lease_token=$3, lease_owner=$4, lease_expires_at=$5, updated_at=$1
           FROM due WHERE d.tenant_id=due.tenant_id AND d.id=due.id
         RETURNING d.tenant_id, d.id`,
        [at, limit, token, config.workerId, new Date(at.getTime() + config.leaseMs)])).rows;
      return rows.map((row) => ({ tenantId: row.tenant_id, deliveryId: row.id, leaseToken: token }));
    });
  }

  const ROW_COLUMNS = `tenant_id, id, message_id, channel, purpose, contact_id, action_id, subject, body, outcome_unknown,
    attempts, first_attempt_at, idempotency_key, recipient_address, provider, request, step_errors`;
  const lockLeased = async (tx: Transaction, lease: Claim): Promise<DeliveryRow | undefined> =>
    (await tx.query<DeliveryRow>(
      `SELECT ${ROW_COLUMNS} FROM message_deliveries
        WHERE tenant_id=$1 AND id=$2 AND lease_token=$3 AND status='leased' FOR UPDATE`,
      [lease.tenantId, lease.deliveryId, lease.leaseToken])).rows[0];

  /** Ends the delivery without a send (or after a not-found lookup), releasing any held funds. */
  async function finish(tx: Transaction, row: DeliveryRow, terminal: Terminal, at: Date): Promise<StepResult> {
    const held = await heldReservation(tx, row.tenant_id, row.id);
    if (held) await releaseReservation(tx, { tenantId: row.tenant_id, reservationId: held.id, now: at });
    await tx.query(
      `UPDATE message_deliveries SET status=$3, final_reason=$4, outcome_unknown=false, lease_token=NULL,
         lease_owner=NULL, lease_expires_at=NULL, updated_at=$5 WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, terminal.status, terminal.reason, at]);
    await deps.onSettled?.(tx, row.tenant_id, row.message_id, "failed", at);
    return { outcome: terminal.status, reason: terminal.reason };
  }

  async function markSent(tx: Transaction, row: DeliveryRow, providerMessageId: string, at: Date): Promise<StepResult> {
    const held = await heldReservation(tx, row.tenant_id, row.id);
    if (held) await captureReservation(tx, { tenantId: row.tenant_id, reservationId: held.id, ledgerId: deps.generateId(), now: at });
    await tx.query(
      `UPDATE message_deliveries SET status='sent', provider_message_id=$3, outcome_unknown=false, final_reason=NULL,
         lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=$4
        WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, boundedText(providerMessageId, 500), at]);
    await deps.onSettled?.(tx, row.tenant_id, row.message_id, "sent", at);
    return { outcome: "sent", providerMessageId };
  }

  async function retryLater(tx: Transaction, row: DeliveryRow, status: "pending" | "uncertain", reason: string,
    attempts: number, at: Date): Promise<StepResult> {
    const next = new Date(at.getTime() + backoffMs(attempts, config.backoffBaseMs, config.backoffMaxMs));
    await tx.query(
      `UPDATE message_deliveries SET status=$3, next_attempt_at=$4, last_error=$5, lease_token=NULL, lease_owner=NULL,
         lease_expires_at=NULL, updated_at=$6 WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, status, next, errorText(reason), at]);
    return { outcome: "retry", status, reason };
  }

  /**
   * A dead letter that keeps any held reservation and the unknown outcome for an operator
   * (D-8, settleUnknown). It does not call onSettled: the producer hears when it is settled.
   */
  async function deadLetterHeld(tx: Transaction, row: DeliveryRow, reason: "outcome_unknown" | "worker_error",
    error: string, at: Date): Promise<StepResult> {
    await tx.query(
      `UPDATE message_deliveries SET status='dead', final_reason=$3, last_error=$4, lease_token=NULL,
         lease_owner=NULL, lease_expires_at=NULL, updated_at=$5 WHERE tenant_id=$1 AND id=$2`,
      [row.tenant_id, row.id, reason, errorText(error), at]);
    return { outcome: "dead", reason };
  }

  /** D-6: the first reason the send may not happen now, or null. */
  async function recheck(tx: Transaction, row: DeliveryRow): Promise<{ reason: DeliveryFinalReason | null; address: string | null }> {
    const contact = (await tx.query<{ normalized_email: string | null; e164_phone: string | null }>(
      "SELECT normalized_email, e164_phone FROM crm_contacts WHERE tenant_id=$1 AND id=$2",
      [row.tenant_id, row.contact_id])).rows[0];
    const address = row.channel === "email" ? usableEmail(contact?.normalized_email ?? null) : contact?.e164_phone ?? null;
    if (!contact || !address) return { reason: "no_address", address: null };
    // D-1: the contact's current address, except that a send whose outcome is unknown may only
    // be repeated to the recipient it went to; if that changed, the provider is asked instead.
    if (row.outcome_unknown && row.recipient_address !== null && row.recipient_address !== address)
      return { reason: "address_changed", address: null };
    const suppressed = (await tx.query(
      "SELECT 1 FROM suppressions WHERE tenant_id=$1 AND channel=$2::crm_consent_channel AND address=$3",
      [row.tenant_id, row.channel, address])).rowCount === 1;
    const consentRow = (await tx.query<{ status: ConsentStatus; source: string }>(
      "SELECT status, source FROM crm_contact_consent WHERE tenant_id=$1 AND contact_id=$2 AND channel=$3::crm_consent_channel",
      [row.tenant_id, row.contact_id, row.channel])).rows[0];
    const consent = consentRow?.status ?? null;
    const blocked = consentBlock({ channel: row.channel, purpose: row.purpose, consent, suppressed, source: consentRow?.source ?? null });
    if (blocked) return { reason: blocked, address };
    const standing = await deps.approvals.check(tx, {
      tenantId: row.tenant_id,
      actionId: row.action_id,
      messageId: row.message_id,
      contentDigest: deliveryContentDigest({
        messageId: row.message_id, contactId: row.contact_id, channel: row.channel, purpose: row.purpose,
        subject: row.subject, body: row.body,
      }),
    });
    if (standing === "revoked") return { reason: "approval_revoked", address };
    if (standing !== "approved") return { reason: "approval_missing", address };
    return { reason: null, address };
  }

  /** What the provider receives: the approved text plus the opt-out the law and D-9 require. */
  function buildContent(row: DeliveryRow): StoredRequest {
    if (row.channel === "sms") return { subject: null, text: `${row.body}\n${config.smsOptOutText}`, headers: {} };
    const token = signUnsubscribeToken(config.unsubscribe.secret, { tenantId: row.tenant_id, deliveryId: row.id });
    const url = `${config.unsubscribe.baseUrl.replace(/\/+$/, "")}/${token}`;
    return {
      subject: row.subject,
      text: `${row.body}\n\n--\nTo stop these emails, unsubscribe: ${url}`,
      headers: { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    };
  }

  /** D-5..D-8 decision, inside one transaction under the lease. */
  async function prepare(lease: Claim): Promise<Plan> {
    return deps.service(async (tx) => {
      const row = await lockLeased(tx, lease);
      if (!row) return { kind: "done", result: { outcome: "lost_lease" } };
      const at = now();
      const channelProvider = provider(row.channel);
      // Each step gets a whole lease, however long the rows before it in the batch took.
      await tx.query("UPDATE message_deliveries SET lease_expires_at=$3 WHERE tenant_id=$1 AND id=$2",
        [row.tenant_id, row.id, new Date(at.getTime() + config.leaseMs)]);
      // An attempt left open by a holder whose lease ran out may have reached the provider.
      await tx.query(
        `UPDATE message_delivery_attempts SET outcome='uncertain', error_code='lease_lost', finished_at=$3
          WHERE tenant_id=$1 AND delivery_id=$2 AND outcome IS NULL`,
        [row.tenant_id, row.id, at]);
      // A delivery that keeps failing inside the worker stops here instead of looping.
      if (row.step_errors >= config.maxStepErrors)
        return { kind: "done", result: await deadLetterHeld(tx, row, "worker_error", "step_errors", at) };
      // Another provider has never seen this key: a resend would not be deduped and a lookup
      // there proves nothing (D-8).
      if (row.outcome_unknown && row.provider !== null && row.provider !== channelProvider.name)
        return { kind: "done", result: await deadLetterHeld(tx, row, "outcome_unknown", "provider_changed", at) };
      const { reason, address } = await recheck(tx, row);
      // D-8, revision 4: a provider that drops no repeats has a window of zero, so an unknown
      // outcome is never followed by another send; only evidence through lookup settles it.
      if (row.outcome_unknown && channelProvider.dedupeWindowMs === 0) {
        const onNotFound: Terminal = reason ? { status: "blocked", reason } : { status: "dead", reason: "dedupe_window_expired" };
        return { kind: "lookup", onNotFound, channel: row.channel, key: row.idempotency_key, startedAt: at };
      }
      // The re-check took time; the window is judged from after it. Without provider dedupe a
      // send only ever follows a definite answer, so no window applies.
      const checkedAt = now();
      const windowEnd = row.first_attempt_at && channelProvider.dedupeWindowMs > 0
        ? row.first_attempt_at.getTime() + channelProvider.dedupeWindowMs - config.dedupeMarginMs
        : Number.POSITIVE_INFINITY;
      // The whole call, to its deadline, must fit inside the provider's dedupe window.
      const windowOpen = checkedAt.getTime() + config.providerTimeoutMs <= windowEnd;
      if (reason || !windowOpen || row.attempts >= config.maxAttempts) {
        const terminal: Terminal = reason
          ? { status: "blocked", reason }
          : !windowOpen ? { status: "dead", reason: "dedupe_window_expired" } : { status: "dead", reason: "max_attempts" };
        // A send may already have happened: ask the provider rather than guess (D-8).
        if (row.outcome_unknown) return { kind: "lookup", onNotFound: terminal, channel: row.channel, key: row.idempotency_key, startedAt: at };
        return { kind: "done", result: await finish(tx, row, terminal, at) };
      }
      const content = row.request ?? buildContent(row);
      const request: ProviderSendRequest = {
        idempotencyKey: row.idempotency_key, channel: row.channel, to: address!, ...content,
        tenantId: row.tenant_id, deliveryId: row.id,
      };
      if (!row.outcome_unknown && !(await heldReservation(tx, row.tenant_id, row.id))) {
        const reserved = await reserveFunds(tx, {
          tenantId: row.tenant_id, deliveryId: row.id, reservationId: deps.generateId(),
          amount: deliveryPrice(config.pricing, row.channel, request.text), currency: config.pricing.currency, now: at,
        });
        if (!reserved) {
          const attempts = row.attempts + 1;
          await tx.query("UPDATE message_deliveries SET attempts=$3 WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, attempts]);
          if (attempts >= config.maxAttempts)
            return { kind: "done", result: await finish(tx, row, { status: "dead", reason: "insufficient_funds" }, at) };
          return { kind: "done", result: await retryLater(tx, row, "pending", "insufficient_funds", attempts, at) };
        }
      }
      const attempt = (await tx.query<{ next: number }>(
        "SELECT coalesce(max(attempt),0)+1 AS next FROM message_delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2",
        [row.tenant_id, row.id])).rows[0]!.next;
      await tx.query(
        `INSERT INTO message_delivery_attempts (tenant_id, delivery_id, attempt, kind, started_at) VALUES ($1,$2,$3,'send',$4)`,
        [row.tenant_id, row.id, attempt, at]);
      // From here until a definite answer, a send may have happened.
      await tx.query(
        `UPDATE message_deliveries SET attempts=attempts+1, outcome_unknown=true, first_attempt_at=coalesce(first_attempt_at,$3),
           recipient_address=$4, provider=$5, request=coalesce(request,$6::json), updated_at=$3 WHERE tenant_id=$1 AND id=$2`,
        [row.tenant_id, row.id, at, address, channelProvider.name, JSON.stringify(content)]);
      return { kind: "send", attempt, request };
    });
  }

  async function recordSend(lease: Claim, attempt: number, outcome: ProviderSendOutcome): Promise<StepResult> {
    return deps.service(async (tx) => {
      const row = await lockLeased(tx, lease);
      // The lease moved on: the next holder resends under the same key or asks the provider.
      if (!row) return { outcome: "lost_lease" };
      const at = now();
      await tx.query(
        `UPDATE message_delivery_attempts SET outcome=$4, error_code=$5, finished_at=$6
          WHERE tenant_id=$1 AND delivery_id=$2 AND attempt=$3 AND outcome IS NULL`,
        [row.tenant_id, row.id, attempt, outcome.status, outcome.status === "accepted" ? null : errorText(outcome.code), at]);
      switch (outcome.status) {
        case "accepted":
          return markSent(tx, row, outcome.providerMessageId, at);
        case "rejected":
          return finish(tx, row, { status: "dead", reason: "provider_rejected" }, at);
        case "failed": {
          // This attempt was not accepted, but an earlier uncertain one under the same key may
          // have been: the outcome stays unknown and the money held until the provider says (D-8).
          const earlierUncertain = (await tx.query(
            `SELECT 1 FROM message_delivery_attempts
              WHERE tenant_id=$1 AND delivery_id=$2 AND attempt<$3 AND kind='send' AND outcome='uncertain' LIMIT 1`,
            [row.tenant_id, row.id, attempt])).rowCount === 1;
          if (earlierUncertain) return retryLater(tx, row, "uncertain", outcome.code, row.attempts, at);
          // Definitely never accepted: the money goes back, and the outcome is known again.
          const held = await heldReservation(tx, row.tenant_id, row.id);
          if (held) await releaseReservation(tx, { tenantId: row.tenant_id, reservationId: held.id, now: at });
          await tx.query("UPDATE message_deliveries SET outcome_unknown=false WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
          if (row.attempts >= config.maxAttempts) return finish(tx, row, { status: "dead", reason: "max_attempts" }, at);
          return retryLater(tx, row, "pending", outcome.code, row.attempts, at);
        }
        case "uncertain":
          // The reservation stays held until the outcome is known (D-7, D-8).
          return retryLater(tx, row, "uncertain", outcome.code, row.attempts, at);
      }
    });
  }

  async function recordLookup(lease: Claim, plan: Extract<Plan, { kind: "lookup" }>, outcome: ProviderLookupOutcome): Promise<StepResult> {
    return deps.service(async (tx) => {
      const row = await lockLeased(tx, lease);
      if (!row) return { outcome: "lost_lease" };
      const at = now();
      const attempt = (await tx.query<{ next: number }>(
        "SELECT coalesce(max(attempt),0)+1 AS next FROM message_delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2",
        [row.tenant_id, row.id])).rows[0]!.next;
      await tx.query(
        `INSERT INTO message_delivery_attempts (tenant_id, delivery_id, attempt, kind, started_at, outcome, error_code, finished_at)
         VALUES ($1,$2,$3,'lookup',$4,$5,$6,$7)`,
        [row.tenant_id, row.id, attempt, plan.startedAt, outcome.status, outcome.status === "unknown" ? errorText(outcome.code) : null, at]);
      if (outcome.status === "accepted") return markSent(tx, row, outcome.providerMessageId, at);
      if (outcome.status === "not_found") return finish(tx, row, plan.onNotFound, at);
      // A provider without dedupe waits for evidence (a late status callback) until its wait ends.
      const channelProvider = provider(row.channel);
      const waitEnd = row.first_attempt_at && channelProvider.dedupeWindowMs === 0
        ? row.first_attempt_at.getTime() + (channelProvider.outcomeWaitMs ?? 0) : Number.NEGATIVE_INFINITY;
      if (at.getTime() < waitEnd) {
        const lookups = (await tx.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM message_delivery_attempts WHERE tenant_id=$1 AND delivery_id=$2 AND kind='lookup'",
          [row.tenant_id, row.id])).rows[0]!.count;
        return retryLater(tx, row, "uncertain", outcome.code, lookups, at);
      }
      // No answer: dead letter, with the reservation still held for an operator (D-8).
      return deadLetterHeld(tx, row, "outcome_unknown", outcome.code, at);
    });
  }

  /** One step for one leased delivery: prepare, call the provider, record. */
  async function step(lease: Claim): Promise<StepResult> {
    const plan = await prepare(lease);
    let result: StepResult;
    if (plan.kind === "done") result = plan.result;
    else if (plan.kind === "send") {
      const channelProvider = provider(plan.request.channel);
      const outcome = await withDeadline<ProviderSendOutcome>(
        (signal) => channelProvider.send(plan.request, { signal }),
        (code) => ({ status: "uncertain", code }));
      result = await recordSend(lease, plan.attempt, outcome);
    } else {
      const channelProvider = provider(plan.channel);
      const outcome: ProviderLookupOutcome = channelProvider.lookup
        ? await withDeadline<ProviderLookupOutcome>(
          (signal) => channelProvider.lookup!(plan.key, { signal, tenantId: lease.tenantId, deliveryId: lease.deliveryId }),
          (code) => ({ status: "unknown", code }))
        : { status: "unknown", code: "lookup_unsupported" };
      result = await recordLookup(lease, plan, outcome);
    }
    if (result.outcome === "lost_lease") deps.report?.({ kind: "lost_lease", tenantId: lease.tenantId, deliveryId: lease.deliveryId });
    return result;
  }

  /**
   * After a step threw: counts the error and gives the row back with backoff while this worker
   * still holds the lease, so one bad row neither stalls the batch nor loops without end.
   */
  async function noteStepError(lease: Claim, error: unknown): Promise<StepResult> {
    const text = errorText(error instanceof Error ? error.message : "step_failed");
    deps.report?.({ kind: "step_failed", tenantId: lease.tenantId, deliveryId: lease.deliveryId, error: text });
    try {
      await deps.service(async (tx) => {
        const at = now();
        await tx.query(
          `UPDATE message_deliveries SET step_errors=step_errors+1,
             status=CASE WHEN outcome_unknown THEN 'uncertain' ELSE 'pending' END, next_attempt_at=$4, last_error=$5,
             lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL, updated_at=$3
            WHERE tenant_id=$1 AND id=$2 AND lease_token=$6 AND status='leased'`,
          [lease.tenantId, lease.deliveryId, at, new Date(at.getTime() + config.backoffBaseMs), text, lease.leaseToken]);
      });
    } catch {
      // The lease runs out on its own; the next holder sees the same row.
    }
    return { outcome: "error", error: text };
  }

  /** One pass: ingest new events, claim due deliveries, process each in turn. */
  async function runOnce(options: { ingestLimit?: number; claimLimit?: number } = {}) {
    const ingested = await ingest(options.ingestLimit ?? 100);
    const leases = await claim(options.claimLimit ?? 10);
    const results: StepResult[] = [];
    for (const lease of leases) results.push(await step(lease).catch((error: unknown) => noteStepError(lease, error)));
    return { ...ingested, claimed: leases.length, results };
  }

  /**
   * D-8: an operator settles a dead letter whose outcome stayed unknown (or that stopped on
   * worker errors), after checking the provider's own records. Exactly once: a second settlement
   * finds nothing to settle.
   */
  async function settleUnknown(input: {
    readonly tenantId: string;
    readonly deliveryId: string;
    readonly outcome: "sent" | "not_sent";
    readonly providerMessageId?: string;
  }): Promise<StepResult> {
    if (input.outcome === "sent" && !input.providerMessageId)
      throw new ValidationFailed("A sent settlement names the provider message ID");
    return deps.service(async (tx) => {
      const row = (await tx.query<DeliveryRow & { status: string; final_reason: string | null }>(
        `SELECT ${ROW_COLUMNS}, status, final_reason FROM message_deliveries WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [input.tenantId, input.deliveryId])).rows[0];
      if (!row) throw new NotFound();
      if (row.status !== "dead" || !(row.outcome_unknown || row.final_reason === "worker_error"))
        throw new Conflict("The delivery has no unknown outcome to settle", { reason: "already_settled" });
      // Without an unknown outcome no attempt can have reached the provider.
      if (input.outcome === "sent" && !row.outcome_unknown)
        throw new Conflict("No attempt of this delivery can have been sent", { reason: "never_sent" });
      const at = now();
      return input.outcome === "sent"
        ? markSent(tx, row, input.providerMessageId!, at)
        : finish(tx, row, { status: "dead", reason: "settled_not_sent" }, at);
    });
  }

  return { ingest, claim, step, runOnce, settleUnknown, config };
}
export type DeliveryWorker = ReturnType<typeof createDeliveryWorker>;
