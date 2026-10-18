export type ApiErrorKind =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "server"
  | "network"
  | "invalid_response";

/** The one error type every API implementation (HTTP or demo) throws. */
export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status: number | null = null,
    /** Stable code from the contracts error set, when the server sent one (e.g. "Conflict"). */
    readonly code: string | null = null,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function kindForStatus(status: number): ApiErrorKind {
  if (status === 400 || status === 422) return "validation";
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

export function isApiError(error: unknown, kind?: ApiErrorKind): error is ApiError {
  return error instanceof ApiError && (kind === undefined || error.kind === kind);
}
