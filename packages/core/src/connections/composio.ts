// Connections C-2, C-3, C-8, C-10: the low-level Composio REST client (v3.1). Original code, written
// from the public API reference (no text copied). It is the only place that talks to Composio.
//   - It sends the key in `x-api-key` and nothing else a caller chose: the execute envelope is built
//     here from four values only (account, user, version, arguments), never from caller input.
//   - Every call has a timeout (6 s by default, C-10) joined with the caller's abort signal, follows
//     no redirect, and reads at most `maxBodyBytes` (1 MiB) of the answer.
//   - Account reads are parsed with an allowlist schema: the `state` block and every credential field
//     are dropped before anything else sees the answer (C-14).
//   - Provider text never leaves this file: failures become a `ComposioError` kind, and a 200 with
//     `successful: false` is classified from its structured status fields only, never its text.
//   - A 401 or 403 on our own call means Composio refused our key or project (`key_refused`), never
//     that the store's grant failed: only a provider status inside an execute envelope says that.
// The response shapes of GET account and the Shopify tools are the pilot's best reading (C-17); the
// owner-run `pnpm connections:check-catalog` confirms them against the preview project.
import { z } from "zod";
import { OVERRIDE_KEYS } from "./catalog.js";

export const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_TIMEOUT_MS = 6_000;
export const COMPOSIO_MAX_BODY_BYTES = 1024 * 1024;

export type ComposioErrorKind = "rate_limited" | "key_refused" | "not_found" | "bad_request" | "unavailable";
/**
 * Never carries provider text: only our kind and the HTTP status. `accountId` is set when a link
 * answer could not be used but named the account it made, so the caller can remove it (B-7).
 */
export class ComposioError extends Error {
  constructor(
    readonly kind: ComposioErrorKind,
    readonly status?: number,
    readonly detail?: "too_large" | "malformed" | "timeout" | "network",
    readonly accountId?: string,
  ) {
    super(`composio ${kind}${status === undefined ? "" : ` ${status}`}${detail ? ` ${detail}` : ""}`);
    this.name = "ComposioError";
  }
}

/** C-8: Composio's account statuses. Anything else is `UNKNOWN` and fails closed. */
export const COMPOSIO_STATUSES = Object.freeze(["INITIATED", "INITIALIZING", "ACTIVE", "INACTIVE", "FAILED", "EXPIRED", "REVOKED"] as const);
export type ComposioStatus = (typeof COMPOSIO_STATUSES)[number] | "UNKNOWN";
export function normalizeStatus(raw: unknown): ComposioStatus {
  const upper = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  return (COMPOSIO_STATUSES as readonly string[]).includes(upper) ? (upper as ComposioStatus) : "UNKNOWN";
}
/** C-8, `complete`: ACTIVE goes on, INITIATED and INITIALIZING wait, everything else is refused. */
export function completeDecision(status: ComposioStatus): "go" | "pending" | "refuse" {
  switch (status) {
    case "ACTIVE": return "go";
    case "INITIATED":
    case "INITIALIZING": return "pending";
    case "INACTIVE":
    case "FAILED":
    case "EXPIRED":
    case "REVOKED":
    case "UNKNOWN": return "refuse";
  }
}
/** C-8, a live row: ACTIVE keeps or restores `active`; every other value moves it to `reauthorize`. */
export function liveDecision(status: ComposioStatus): "active" | "reauthorize" {
  return status === "ACTIVE" ? "active" : "reauthorize";
}

export interface ComposioAccount {
  readonly id: string;
  readonly status: ComposioStatus;
  readonly userId: string | null;
  readonly toolkit: string | null;
  readonly authConfigId: string | null;
}
const accountSchema = z.object({
  id: z.string().min(1).max(128),
  status: z.unknown().optional(),
  user_id: z.string().max(256).nullish(),
  toolkit: z.object({ slug: z.string().max(100).nullish() }).nullish(),
  auth_config: z.object({ id: z.string().max(128).nullish() }).nullish(),
});

export interface ComposioLink {
  readonly redirectUrl: string;
  readonly connectedAccountId: string;
  readonly expiresAt: string | null;
}
const linkSchema = z.object({
  redirect_url: z.url({ protocol: /^https$/ }).max(2048),
  connected_account_id: z.string().min(1).max(128),
  expires_at: z.string().max(64).nullish(),
});
const completeSchema = z.object({
  connected_account_id: z.string().min(1).max(128),
  toolkit_slug: z.string().max(100).nullish(),
});

export interface ExecuteInput {
  readonly slug: string;
  readonly version: string;
  readonly userId: string;
  readonly connectedAccountId: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}
export type ExecuteEnvelope = {
  readonly connected_account_id: string;
  readonly user_id: string;
  readonly version: string;
  readonly arguments: Readonly<Record<string, unknown>>;
};
/**
 * C-3: the execute body, built from the derived user, the row's account, the pinned version and the
 * parsed arguments only. A missing version is an error, and a key that could override the account's
 * auth (or the envelope itself) in the arguments is refused here as a last line of defence.
 */
export function buildExecuteEnvelope(input: ExecuteInput): ExecuteEnvelope {
  if (input.version.length === 0) throw new Error("A tool call needs a pinned version");
  for (const key of Object.keys(input.arguments)) if (OVERRIDE_KEYS.has(key)) throw new Error("Arguments may not carry an override field");
  return {
    connected_account_id: input.connectedAccountId,
    user_id: input.userId,
    version: input.version,
    arguments: input.arguments,
  };
}

export type ExecuteOutcome =
  | { readonly kind: "ok"; readonly data: unknown }
  | { readonly kind: "failed"; readonly reason: "auth" | "rate_limited" | "unavailable" };
const executeSchema = z.object({ successful: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional() });
/** The numeric fields a failed envelope may carry the provider's HTTP status in. */
const STATUS_FIELDS = ["status_code", "statusCode", "http_status", "httpStatus", "status"] as const;
/**
 * A 200 with `successful: false`: only our class survives (C-10, C-14). The class comes from a
 * provider HTTP status in a structured field of `error` or `data` (401 or 403 is the store's grant,
 * 429 a provider limit); text is never read, so an order titled "Forbidden" is not an auth error.
 */
export function classifyExecuteFailure(envelope: { readonly error?: unknown; readonly data?: unknown }): "auth" | "rate_limited" | "unavailable" {
  const statuses: number[] = [];
  for (const part of [envelope.error, envelope.data]) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
    for (const field of STATUS_FIELDS) {
      const value = (part as Record<string, unknown>)[field];
      if (typeof value === "number" && Number.isInteger(value)) statuses.push(value);
    }
  }
  if (statuses.includes(429)) return "rate_limited";
  if (statuses.some((status) => status === 401 || status === 403)) return "auth";
  return "unavailable";
}

export interface ComposioClient {
  link(input: { authConfigId: string; userId: string; callbackUrl: string; connectionData: Record<string, string> }, signal?: AbortSignal): Promise<ComposioLink>;
  /** 400 or 404 surface as `bad_request` or `not_found`; the caller decides what each means. */
  completeAuth(input: { sessionUri: string; userId: string }, signal?: AbortSignal): Promise<{ connectedAccountId: string; toolkit: string | null }>;
  /** `null` for a 404. */
  getAccount(id: string, signal?: AbortSignal): Promise<ComposioAccount | null>;
  revoke(id: string, signal?: AbortSignal): Promise<void>;
  /** A 404 counts as done. */
  deleteAccount(id: string, signal?: AbortSignal): Promise<void>;
  execute(input: ExecuteInput, signal?: AbortSignal): Promise<ExecuteOutcome>;
  /** A-8, owner-run only: one tool's toolkit and versions; `null` for a 404. */
  getTool(slug: string, signal?: AbortSignal): Promise<ComposioTool | null>;
}
export interface ComposioTool { readonly slug: string; readonly toolkit: string | null; readonly versions: readonly string[] }

const toolSchema = z.object({
  slug: z.string().min(1).max(200),
  toolkit: z.object({ slug: z.string().max(200).nullish() }).nullish(),
  version: z.string().max(100).nullish(),
  available_versions: z.array(z.string().max(100)).max(1000).nullish(),
});

export interface ComposioClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

function kindOf(status: number): ComposioErrorKind {
  if (status === 429 || status === 402) return "rate_limited";
  // A-5: 401, 403 and 410 on our own call are about our key or project, never the store's grant.
  if (status === 401 || status === 403 || status === 410) return "key_refused";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "bad_request";
  return "unavailable";
}

/** Reads at most `max` bytes; more is `too_large`, never partly used. */
async function readCapped(response: Response, max: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    throw new ComposioError("unavailable", response.status, "too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ComposioError("unavailable", response.status, "too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Drops trailing "/" without a backtracking regex (CodeQL js/polynomial-redos). */
function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}

export function createComposioClient(config: ComposioClientConfig): ComposioClient {
  const base = trimTrailingSlashes(config.baseUrl ?? COMPOSIO_BASE_URL);
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? COMPOSIO_TIMEOUT_MS;
  const maxBody = config.maxBodyBytes ?? COMPOSIO_MAX_BODY_BYTES;

  async function call(method: string, path: string, body: unknown, signal: AbortSignal | undefined): Promise<{ status: number; json: unknown }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        redirect: "error",
        headers: { "x-api-key": config.apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      const timedOut = timeout.aborted || (error instanceof Error && error.name === "TimeoutError");
      throw new ComposioError("unavailable", undefined, timedOut ? "timeout" : "network");
    }
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ComposioError(kindOf(response.status), response.status);
      }
      const text = await readCapped(response, maxBody);
      if (text.length === 0) return { status: response.status, json: undefined };
      try {
        return { status: response.status, json: JSON.parse(text) as unknown };
      } catch {
        throw new ComposioError("unavailable", response.status, "malformed");
      }
    } catch (error) {
      if (error instanceof ComposioError) throw error;
      const timedOut = timeout.aborted;
      throw new ComposioError("unavailable", response.status, timedOut ? "timeout" : "network");
    }
  }
  const parse = <T>(schema: z.ZodType<T>, json: unknown): T => {
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ComposioError("unavailable", undefined, "malformed");
    return parsed.data;
  };
  const enc = encodeURIComponent;

  return {
    async link(input, signal) {
      const { json } = await call("POST", "/connected_accounts/link", {
        auth_config_id: input.authConfigId,
        user_id: input.userId,
        callback_url: input.callbackUrl,
        connection_data: input.connectionData,
      }, signal);
      const parsed = linkSchema.safeParse(json);
      if (!parsed.success) {
        // The account may exist although the answer is unusable: name it so the caller removes it.
        const named = typeof json === "object" && json !== null ? (json as Record<string, unknown>)["connected_account_id"] : undefined;
        throw new ComposioError("unavailable", undefined, "malformed", typeof named === "string" && named.length > 0 && named.length <= 128 ? named : undefined);
      }
      const out = parsed.data;
      return { redirectUrl: out.redirect_url, connectedAccountId: out.connected_account_id, expiresAt: out.expires_at ?? null };
    },
    async completeAuth(input, signal) {
      const { json } = await call("POST", "/connected_accounts/complete_auth", { session_uri: input.sessionUri, user_id: input.userId }, signal);
      const out = parse(completeSchema, json);
      return { connectedAccountId: out.connected_account_id, toolkit: out.toolkit_slug ?? null };
    },
    async getAccount(id, signal) {
      try {
        const { json } = await call("GET", `/connected_accounts/${enc(id)}`, undefined, signal);
        const out = parse(accountSchema, json);
        return {
          id: out.id,
          status: normalizeStatus(out.status),
          userId: out.user_id ?? null,
          toolkit: out.toolkit?.slug?.toLowerCase() ?? null,
          authConfigId: out.auth_config?.id ?? null,
        };
      } catch (error) {
        if (error instanceof ComposioError && error.kind === "not_found") return null;
        throw error;
      }
    },
    async revoke(id, signal) {
      await call("POST", `/connected_accounts/${enc(id)}/revoke`, {}, signal);
    },
    async deleteAccount(id, signal) {
      try {
        await call("DELETE", `/connected_accounts/${enc(id)}`, undefined, signal);
      } catch (error) {
        if (error instanceof ComposioError && error.kind === "not_found") return;
        throw error;
      }
    },
    async getTool(slug, signal) {
      try {
        const { json } = await call("GET", `/tools/${enc(slug)}`, undefined, signal);
        const out = parse(toolSchema, json);
        const versions = [...new Set([...(out.available_versions ?? []), ...(out.version ? [out.version] : [])])];
        return { slug: out.slug, toolkit: out.toolkit?.slug?.toLowerCase() ?? null, versions };
      } catch (error) {
        if (error instanceof ComposioError && error.kind === "not_found") return null;
        throw error;
      }
    },
    async execute(input, signal) {
      const { json } = await call("POST", `/tools/execute/${enc(input.slug)}`, buildExecuteEnvelope(input), signal);
      const out = parse(executeSchema, json);
      if (!out.successful) return { kind: "failed", reason: classifyExecuteFailure(out) };
      // A missing `data` is an error, never data (C-10).
      if (out.data === undefined || out.data === null) return { kind: "failed", reason: "unavailable" };
      return { kind: "ok", data: out.data };
    },
  };
}
