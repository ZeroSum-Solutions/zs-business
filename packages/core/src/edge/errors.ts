import {
  ActionError,
  type ApiErrorBody,
  type ApiErrorCode,
  type JsonValue,
} from "@zs/contracts";

export type ApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 500;
export interface MappedError {
  readonly status: ApiErrorStatus;
  readonly body: ApiErrorBody;
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
  "binding_mismatch", "concurrent_update", "split_identity", "identity_mismatch",
]);

/** One fixed message per code, so database or handler text never reaches a response. */
const MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  ValidationFailed: "Invalid request",
  Unauthorized: "Invalid or missing access token",
  Forbidden: "Forbidden",
  NotFound: "Not found",
  Conflict: "Request conflicts with the current state",
  Internal: "Internal error",
};

/** Only documented detail keys leave the server; SQL codes and constraint names stay inside. */
function conflictDetails(details: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const safe: Record<string, JsonValue> = {};
  if (typeof details.reason === "string") safe.reason = CONFLICT_REASONS.has(details.reason) ? details.reason : "conflict";
  else if (details.postgresCode === "23P01") safe.reason = "overlap";
  else safe.reason = "concurrent_update";
  if (typeof details.currentRevision === "number") safe.currentRevision = details.currentRevision;
  return safe;
}

const mapped = (status: ApiErrorStatus, code: ApiErrorCode, details: Record<string, JsonValue> = {}): MappedError =>
  ({ status, body: apiErrorBody(code, MESSAGES[code], details) });

/** Map any thrown value to one HTTP status and the shared error body. Unknown errors become 500. */
export function mapError(error: unknown): MappedError {
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
