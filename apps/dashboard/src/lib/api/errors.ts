import { apiErrorBodySchema, type ApiErrorBody, type ApiErrorCode } from "@zs/contracts";

export type ApiErrorKind =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "server"
  | "network"
  | "invalid_response";

/** The one error type every API implementation (HTTP or demo) throws. `message` is safe to show. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number | null = null,
    /** Code from `apiErrorCodeSchema` when the server sent one (e.g. "Conflict"). */
    readonly code: string | null = null,
    /** `details` from the shared error body: `reason`, `currentRevision`, `issues`. */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** `details.reason` on a 409, such as "overlap", "slot_unavailable" or "stale_revision". */
  get reason(): string | null {
    return typeof this.details.reason === "string" ? this.details.reason : null;
  }

  /** Messages of the validation issues the server sent, in order. */
  get issueMessages(): string[] {
    const issues = this.details.issues;
    if (!Array.isArray(issues)) return [];
    return issues.flatMap((issue) => {
      const message = (issue as { message?: unknown } | null)?.message;
      return typeof message === "string" ? [message] : [];
    });
  }

  /** First request field a validation error points at ("email", "phone", ...). */
  get field(): string | null {
    const issues = this.details.issues;
    if (!Array.isArray(issues)) return null;
    for (const issue of issues) {
      const path = (issue as { path?: unknown } | null)?.path;
      if (typeof path === "string" && path !== "") return path.split(".")[0]!;
    }
    return null;
  }
}

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 400 || status === 413 || status === 422) return "validation";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "rate_limited";
  return "server";
}

const DEFAULT_MESSAGES: Record<ApiErrorKind, string> = {
  validation: "Some details need another look.",
  unauthorized: "Your session ended. Sign in again.",
  forbidden: "You do not have access to this.",
  not_found: "We could not find that.",
  conflict: "Something changed while you were working.",
  rate_limited: "Too many requests. Wait a minute, then try again.",
  server: "Something went wrong on our side. Try again.",
  network: "You look offline. Check your connection and try again.",
  invalid_response: "We got an answer we did not expect. Try again.",
};

export function defaultMessage(kind: ApiErrorKind): string {
  return DEFAULT_MESSAGES[kind];
}

/** Issue messages from @zs/contracts refinements that have no field path. */
const ISSUE_MESSAGES: Record<string, string> = {
  "At least one identity is required": "Add an email or a phone number.",
};

const FIELD_MESSAGES: Record<string, string> = {
  email: "Enter an email address like name@example.com.",
  phone: "Enter a phone number with country code, like +1 212 555 0142.",
  displayName: "Names can be up to 200 characters.",
};

const CONFLICT_MESSAGES: Record<string, string> = {
  overlap: "That time was just taken.",
  slot_unavailable: "That time was just taken.",
  stale_revision: "This deal changed since you loaded it.",
  split_identity: "That email and phone belong to two different customers.",
  identity_mismatch: "That email or phone is already on another customer record.",
  idempotency_key_reused: "This request was already used for a different change.",
  concurrent_update: "Someone saved a change at the same moment. Try again.",
  last_owner: "A business needs at least one owner. Make someone else an owner first.",
  member_exists: "That email is already on the team.",
};

/** Booking conflicts: an overlapping insert (23P01) or a slot the availability check refused. */
export const SLOT_TAKEN_REASONS: ReadonlySet<string> = new Set(["overlap", "slot_unavailable"]);

export function isApiError(error: unknown, kind?: ApiErrorKind): error is ApiError {
  return error instanceof ApiError && (kind === undefined || error.kind === kind);
}

export function isSlotTaken(error: unknown): error is ApiError {
  return isApiError(error, "conflict") && error.reason !== null && SLOT_TAKEN_REASONS.has(error.reason);
}

export function isStaleRevision(error: unknown): error is ApiError {
  return isApiError(error, "conflict") && error.reason === "stale_revision";
}

/**
 * The deal moved on under this write: a stale revision, or another save in the same
 * instant (`concurrent_update`). Either way, reload the deal and let the owner try again.
 */
export const DEAL_CHANGED_REASONS: ReadonlySet<string> = new Set(["stale_revision", "concurrent_update"]);

export function isDealChanged(error: unknown): error is ApiError {
  return isApiError(error, "conflict") && error.reason !== null && DEAL_CHANGED_REASONS.has(error.reason);
}

/**
 * Slots and bookings answer 403 for a calendar this account cannot use, foreign or unknown
 * alike, so the API never reveals whether another business's calendar exists.
 */
export const CALENDAR_UNAVAILABLE = "This calendar is not available to your account.";

/**
 * Turn a non-2xx response body into an ApiError. The body must match `apiErrorBodySchema`;
 * anything else (a proxy page, an empty body) still maps by status. Server messages are for
 * developers, so the shown message comes from the status, reason and field.
 */
export function errorFromBody(status: number, body: unknown): ApiError {
  const kind = kindForStatus(status);
  const parsed = apiErrorBodySchema.safeParse(body);
  const error: ApiErrorBody["error"] | null = parsed.success ? parsed.data.error : null;
  const result = new ApiError(kind, defaultMessage(kind), status, error?.code ?? null, error?.details ?? {});
  const friendly = kind === "validation"
    ? FIELD_MESSAGES[result.field ?? ""] ?? result.issueMessages.map((message) => ISSUE_MESSAGES[message]).find(Boolean)
    : kind === "conflict" ? CONFLICT_MESSAGES[result.reason ?? ""] : undefined;
  return friendly ? new ApiError(kind, friendly, status, result.code, result.details) : result;
}

/**
 * The API's one fixed message per code (`MESSAGES` in packages/core/src/edge/errors.ts) and
 * the status each code travels with. test/error-parity.test.ts checks both against core.
 */
export const API_ERRORS: Readonly<Record<ApiErrorCode, { status: number; message: string }>> = {
  ValidationFailed: { status: 400, message: "Invalid request" },
  Unauthorized: { status: 401, message: "Invalid or missing access token" },
  Forbidden: { status: 403, message: "Forbidden" },
  NotFound: { status: 404, message: "Not found" },
  Conflict: { status: 409, message: "Request conflicts with the current state" },
  Internal: { status: 500, message: "Internal error" },
  Unavailable: { status: 503, message: "Service unavailable" },
};

/** The exact body the API sends for `code`, for the demo adapter. */
export function demoErrorBody(code: ApiErrorCode, details: Record<string, unknown> = {}): ApiErrorBody {
  return { error: { code, message: API_ERRORS[code].message, details: details as ApiErrorBody["error"]["details"] } };
}

/** The error the HTTP client would throw had the API answered with `demoErrorBody(code, details)`. */
export function demoError(code: ApiErrorCode, details: Record<string, unknown> = {}): ApiError {
  return errorFromBody(API_ERRORS[code].status, demoErrorBody(code, details));
}

/** `ValidationFailed` with issue paths and messages formatted as core's `validationError` does. */
export function demoValidationError(issues: readonly { path: readonly PropertyKey[]; message: string }[]): ApiError {
  return demoError("ValidationFailed", {
    issues: issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message })),
  });
}

/** Both clients raise this for an unknown customer, or one the signed-in business cannot see. */
export function contactNotFound(): ApiError {
  return new ApiError("not_found", "We could not find that customer.", 404, "NotFound");
}
