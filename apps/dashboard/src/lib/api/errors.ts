import { apiErrorBodySchema, type ApiErrorBody } from "@zs/contracts";

export type ApiErrorKind =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
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
  return "server";
}

const DEFAULT_MESSAGES: Record<ApiErrorKind, string> = {
  validation: "Some details need another look.",
  unauthorized: "Your session ended. Sign in again.",
  forbidden: "You do not have access to this.",
  not_found: "We could not find that.",
  conflict: "Something changed while you were working.",
  server: "Something went wrong on our side. Try again.",
  network: "You look offline. Check your connection and try again.",
  invalid_response: "We got an answer we did not expect. Try again.",
};

export function defaultMessage(kind: ApiErrorKind): string {
  return DEFAULT_MESSAGES[kind];
}

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
    ? FIELD_MESSAGES[result.field ?? ""]
    : kind === "conflict" ? CONFLICT_MESSAGES[result.reason ?? ""] : undefined;
  return friendly ? new ApiError(kind, friendly, status, result.code, result.details) : result;
}

/** Build the same error a live server would send, for the demo adapter. */
export function demoError(status: number, code: string, details: Record<string, unknown> = {}, message?: string): ApiError {
  const base = errorFromBody(status, { error: { code, message: "", details } });
  return message ? new ApiError(base.kind, message, status, base.code, base.details) : base;
}
