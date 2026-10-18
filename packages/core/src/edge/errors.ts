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

/** Only documented detail keys leave the server; SQL codes and constraint names stay inside. */
function conflictDetails(details: Readonly<Record<string, JsonValue>>): Record<string, JsonValue> {
  const safe: Record<string, JsonValue> = {};
  if (typeof details.reason === "string") safe.reason = details.reason;
  else if (details.postgresCode === "23P01") safe.reason = "overlap";
  else safe.reason = "concurrent_update";
  if (typeof details.currentRevision === "number") safe.currentRevision = details.currentRevision;
  return safe;
}

/** Map any thrown value to one HTTP status and the shared error body. Unknown errors become 500. */
export function mapError(error: unknown): MappedError {
  if (!(error instanceof ActionError))
    return { status: 500, body: apiErrorBody("Internal", "Internal error") };
  switch (error.code) {
    case "ValidationFailed":
      return {
        status: 400,
        body: apiErrorBody("ValidationFailed", error.message,
          Array.isArray(error.details.issues) ? { issues: error.details.issues } : {}),
      };
    case "TenantDenied":
      return { status: 403, body: apiErrorBody("Forbidden", "Forbidden") };
    case "NotFound":
      return { status: 404, body: apiErrorBody("NotFound", error.message) };
    case "Conflict":
      return { status: 409, body: apiErrorBody("Conflict", error.message, conflictDetails(error.details)) };
    case "IdempotencyConflict":
      return { status: 409, body: apiErrorBody("Conflict", error.message, { reason: "idempotency_key_reused" }) };
    case "BindingMismatch":
      return { status: 409, body: apiErrorBody("Conflict", error.message, { reason: "binding_mismatch" }) };
    default:
      return { status: 500, body: apiErrorBody("Internal", "Internal error") };
  }
}
