import {
  ActionError,
  Refused,
  type ApiErrorBody,
  type ApiErrorCode,
  ENRICHMENT_ERROR_CODES,
  OUTREACH_ERROR_CODES,
  type JsonValue,
} from "@zs/contracts";
import { DatabaseUnavailable } from "@zs/db";
import { StripeRequestFailed } from "../billing/stripe.js";

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503;
export interface MappedError {
  readonly status: ApiErrorStatus;
  readonly body: ApiErrorBody;
}

/**
 * The caller could not be authenticated: a missing, forged or expired token, or a Supabase
 * session that has ended. Maps to 401 Unauthorized. Its message is always one of the fixed
 * strings written in core (never token, request or database text), so it may reach the caller.
 */
export class Unauthenticated extends Error {
  constructor(message = "Invalid or missing access token") {
    super(message);
    this.name = "Unauthenticated";
  }
}

/**
 * Supabase Auth could not answer: the session check, or the signing keys (JWKS) a token is
 * verified against, timed out, failed or came back malformed. Maps to 503 Unavailable, never
 * 401, so a caller retries and the dashboard keeps the browser's session cookies through an
 * outage. Its message is fixed text written in core.
 */
export class AuthUnavailable extends Error {
  constructor(message = "Supabase Auth did not answer the session check", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AuthUnavailable";
  }
}

/**
 * The site object store (R2) failed before anything was committed, so nothing changed and a
 * retry with the same key is safe. Maps to 503 Unavailable. Its message is fixed text.
 */
export class SiteStoreUnavailable extends Error {
  constructor(options?: { cause?: unknown }) {
    super("The site store did not answer", options);
    this.name = "SiteStoreUnavailable";
  }
}

/**
 * connections.md C-4, C-10: the managed tier is on but this request cannot go on. `rate_limited`
 * maps to 429 (with `retryAfterSeconds` for the Retry-After header), `unavailable` to 503. Fixed text.
 */
export class ConnectionsRefused extends Error {
  constructor(readonly kind: "rate_limited" | "unavailable", readonly retryAfterSeconds?: number) {
    super(`connections ${kind}`);
    this.name = "ConnectionsRefused";
  }
}

export function apiErrorBody(code: ApiErrorCode, message: string, details: Record<string, JsonValue> = {}): ApiErrorBody {
  return { error: { code, message, details } };
}

/** Parse failures at the edge carry the zod issue paths so callers can fix their input. */
export function validationError(message: string, issues: readonly { path: readonly PropertyKey[]; message: string }[]): ActionError {
  return new ActionError("ValidationFailed", message, {
    issues: issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

/** Documented conflict reasons; anything else leaves the server as the generic "conflict". */
const CONFLICT_REASONS = new Set([
  "slot_unavailable", "overlap", "stale_revision", "id_in_use", "idempotency_key_reused",
  "binding_mismatch", "concurrent_update", "split_identity", "identity_mismatch", "last_owner", "member_exists",
  "disclosure_changed", "already_reviewed", "not_draft", "no_email", "approved_by_other", "topup_closed", "wallet_currency",
  "approval_not_pending", "approval_expired", "approval_not_approved", "approval_not_revocable", "stale_source",
  "endpoint_limit", "token_limit", "proposal_limit", "not_dead_letter",
  "stale_release", "host_in_use", "grant_changed", "invalid_currency", "already_connected", "attempt_changed", "account_mismatch", "cancel_in_progress",
  // agents.md G-15, G-19, G-21 and approvals.md A-15.
  "cost_cap", "model_error", "model_invalid", "kind_not_available",
  "template_changed", "template_superseded", "template_not_approved",
  "suggestion_in_progress", "suggestion_used", "booking_link_unconfigured",
  // booking.md B-31 (booking_over; the dashboard already words it) and booking-self-service.md BS-1, BS-6, BS-8: why the
  // customer's link refuses a change.
  "booking_over", "link_expired", "too_late", "same_time", "not_changeable",
  // crm.md C-27..C-31: why a stage edit, or a deal into an archived stage, is refused.
  "name_in_use", "stage_limit", "last_stage", "stage_archived", "stage_set_changed", "stage_has_deals",
  // industry-templates.md IT-4: a tenant applies one template.
  "template_already_applied",
  // browser-tasks.md BT-9, BT-11, BT-12: why a website task cannot start or a write task is refused.
  "write_tasks_disabled", "disabled", "global_killed", "tenant_killed", "target_disabled", "daily_cap", "artifact_cap",
  "variant_expired", "variant_changed", "variant_not_staged", "variant_not_running", "image_not_approved", "upload_missing",
  // enrichment.md E-17: the only enrichment reasons a tenant sees.
  ...ENRICHMENT_ERROR_CODES,
  // outreach-sequencer.md OS-23: the only outreach reasons a tenant sees.
  ...OUTREACH_ERROR_CODES,
  "consent_required", "lease_lost", "intake_not_in_review", "intake_changed", "intake_target_changed",
  // plans.md PL-4..PL-7, PL-11, PL-14, PL-15: why a plan Checkout, the Portal or a top-up is refused.
  "plan_exists", "checkout_open", "checkout_closed", "no_customer", "founding_full", "billing_provider",
  // PL-8: an action refused by the plan, on Stripe or Shopify.
  "plan_read_only", "plan_limit", "plan_price_hold",
]);
/** PL-8: the counted resources a plan_limit conflict may name. */
const PLAN_LIMIT_RESOURCES = new Set(["seats", "bookableResources", "managedConnections", "automationTokens"]);
const count = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
/** inbox-home.md I-6, I-7: a not_draft conflict names the reply's current status. */
const REPLY_STATUSES = new Set(["draft", "approved", "sent", "failed", "discarded"]);
/** H-1 revision 4: an invalid_currency conflict names the deal's stored code (three capitals). */
const STORED_CURRENCY = /^[A-Z]{3}$/;
/** I-6: an approved_by_other conflict names the owner who finishes the send. */
/** PL-4: only an https Checkout URL Stripe answered leaves with checkout_open. */
const STRIPE_CHECKOUT_URL = /^https:\/\/[^\s]{1,2040}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One fixed message per code, so database or handler text never reaches a response. */
const MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  ValidationFailed: "Invalid request",
  Unauthorized: "Invalid or missing access token",
  Forbidden: "Forbidden",
  NotFound: "Not found",
  Conflict: "Request conflicts with the current state",
  RateLimited: "Too many requests",
  Internal: "Internal error",
  Unavailable: "Service unavailable",
};

/** Only documented detail keys leave the server; SQL codes and constraint names stay inside. */
function conflictDetails(details: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const safe: Record<string, JsonValue> = {};
  if (typeof details.reason === "string") safe.reason = CONFLICT_REASONS.has(details.reason) ? details.reason : "conflict";
  else if (details.postgresCode === "23P01") safe.reason = "overlap";
  else safe.reason = "concurrent_update";
  if (typeof details.currentRevision === "number") safe.currentRevision = details.currentRevision;
  if (safe.reason === "not_draft" && typeof details.status === "string" && REPLY_STATUSES.has(details.status))
    safe.status = details.status;
  if (safe.reason === "approved_by_other" && typeof details.approvedBy === "string" && UUID.test(details.approvedBy))
    safe.approvedBy = details.approvedBy;
  if (safe.reason === "invalid_currency" && typeof details.currency === "string" && STORED_CURRENCY.test(details.currency))
    safe.currency = details.currency;
  // C-30: a stage with deals says how many, so the owner sees what moves.
  if (safe.reason === "stage_has_deals" && count(details.dealCount)) safe.dealCount = details.dealCount;
  // PL-4: an open plan checkout answers its stored Stripe Checkout URL, so the owner goes back to it.
  if (safe.reason === "checkout_open" && typeof details.checkoutUrl === "string" && STRIPE_CHECKOUT_URL.test(details.checkoutUrl))
    safe.checkoutUrl = details.checkoutUrl;
  // PL-8: a plan_limit conflict names what ran out and the numbers, so the owner sees why.
  if (safe.reason === "plan_limit" && typeof details.resource === "string" && PLAN_LIMIT_RESOURCES.has(details.resource)
    && count(details.limit) && count(details.used)) {
    safe.resource = details.resource;
    safe.limit = details.limit;
    safe.used = details.used;
  }
  return safe;
}

const mapped = (status: ApiErrorStatus, code: ApiErrorCode, details: Record<string, JsonValue> = {}): MappedError =>
  ({ status, body: apiErrorBody(code, MESSAGES[code], details) });

/** SQLSTATEs dispatch reports as Conflict that a retry can clear: lock wait, serialization, deadlock, statement timeout. */
const TRANSIENT_CONFLICTS: ReadonlySet<string> = new Set(["55P03", "40001", "40P01", "57014"]);

/**
 * A webhook sender retries only a 5xx, so at a webhook a lock wait, serialization failure,
 * deadlock or statement timeout that dispatch reported as Conflict is DatabaseUnavailable (503):
 * the sender retries with the same idempotency key. Any other error is returned unchanged.
 */
export function retryableAsUnavailable(error: unknown): unknown {
  return error instanceof ActionError && error.code === "Conflict" && TRANSIENT_CONFLICTS.has(String(error.details.postgresCode))
    ? new DatabaseUnavailable("busy", { cause: error })
    : error;
}

/** Map any thrown value to one HTTP status and the shared error body. Unknown errors become 500. */
export function mapError(error: unknown): MappedError {
  if (error instanceof Unauthenticated) return { status: 401, body: apiErrorBody("Unauthorized", error.message) };
  // Nothing committed, or with "commit_unknown" perhaps committed: either way the caller
  // retries later, a write with its original idempotency key, which replays a commit that happened.
  if (error instanceof DatabaseUnavailable) return mapped(503, "Unavailable");
  // Supabase Auth could not say whether the token or its session is good: retry later.
  if (error instanceof AuthUnavailable) return mapped(503, "Unavailable");
  // stripe.md S-2: Stripe unreachable, busy or failing is retried with the same key; any other refusal is ours.
  if (error instanceof StripeRequestFailed) return error.retry ? mapped(503, "Unavailable") : mapped(500, "Internal");
  // The release's files could not be stored, and the publish was not recorded: retry later.
  if (error instanceof SiteStoreUnavailable) return mapped(503, "Unavailable");
  if (error instanceof ConnectionsRefused) return error.kind === "rate_limited" ? mapped(429, "RateLimited") : mapped(503, "Unavailable");
  // transcription.md X-1, X-9: 413 and 422 keep the ValidationFailed code and name the reason.
  if (error instanceof Refused) return mapped(error.status, "ValidationFailed", { reason: error.reason });
  if (!(error instanceof ActionError)) return mapped(500, "Internal");
  switch (error.code) {
    case "ValidationFailed":
      return mapped(400, "ValidationFailed", Array.isArray(error.details.issues) ? { issues: error.details.issues } : {});
    case "TenantDenied":
      return mapped(403, "Forbidden");
    case "NotFound":
      return mapped(404, "NotFound");
    case "Conflict":
      return mapped(409, "Conflict", conflictDetails(error.details));
    case "IdempotencyConflict":
      return mapped(409, "Conflict", { reason: "idempotency_key_reused" });
    case "BindingMismatch":
      return mapped(409, "Conflict", { reason: "binding_mismatch" });
    default:
      return mapped(500, "Internal");
  }
}
