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
/** An error body is read up to this many bytes; a longer one is dropped whole (class `unknown`), never partly used. */
export const COMPOSIO_MAX_ERROR_BODY_BYTES = 16 * 1024;

export type ComposioErrorKind = "rate_limited" | "key_refused" | "not_found" | "bad_request" | "unavailable";
/**
 * What kind of answer this was, for code that must decide whether to retry or give something back. It is a
 * description of the answer, not a promise about side effects.
 *   - `provider_refused`: Composio answered with its documented refusal envelope (a 400, 404 or 422, see
 *     `classifyHttpError`) and the body names no account.
 *   - `transient`: 429, 402, 408, 5xx, a timeout or a network failure (also while reading the error body).
 *   - `unknown`: everything else (401, 403, 410, 409, an unreadable, oversized or foreign 4xx body, a malformed 2xx).
 * A caller that needs proof that nothing was created must get it elsewhere; the other two classes are never proof.
 */
export type ComposioErrorClass = "provider_refused" | "transient" | "unknown";
export interface ComposioErrorInfo {
  readonly errorClass: ComposioErrorClass;
  /** The parsed non-2xx body (JSON), or `undefined` when it was empty, over the size limit or not JSON. */
  readonly body?: unknown;
  /** Composio's `error.request_id`, a safe identifier for support and logs. */
  readonly requestId?: string;
  /** An account id the error body named (it may exist although the call failed). Distinct from `accountId`, which only `link` sets. */
  readonly namedAccountId?: string;
}
/**
 * Never carries provider text in its message: only our kind and the HTTP status. `accountId` is set when a link
 * answer could not be used but named the account it made, so the caller can remove it (B-7). The provider's
 * non-2xx body rides along as `body` (a non-enumerable property, so JSON.stringify, spreads and loggers skip it):
 * it is for code to classify, never for a message, a log line or a response.
 */
export class ComposioError extends Error {
  readonly errorClass: ComposioErrorClass;
  readonly requestId?: string;
  readonly namedAccountId?: string;
  declare readonly body: unknown;
  constructor(
    readonly kind: ComposioErrorKind,
    readonly status?: number,
    readonly detail?: "too_large" | "malformed" | "timeout" | "network",
    readonly accountId?: string,
    info?: ComposioErrorInfo,
  ) {
    super(`composio ${kind}${status === undefined ? "" : ` ${status}`}${detail ? ` ${detail}` : ""}`);
    this.name = "ComposioError";
    this.errorClass = info?.errorClass ?? (detail === "timeout" || detail === "network" ? "transient" : status !== undefined ? classifyHttpError(status, undefined).errorClass : "unknown");
    if (info?.requestId !== undefined) this.requestId = info.requestId;
    if (info?.namedAccountId !== undefined) this.namedAccountId = info.namedAccountId;
    Object.defineProperty(this, "body", { value: info?.body, enumerable: false, writable: false });
  }
}

const REFUSABLE_STATUSES: readonly number[] = [400, 404, 422];
const TRANSIENT_STATUSES: readonly number[] = [402, 408, 429];
const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const safeId = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value) ? value : undefined;
/** A request id we expose in errors and reports: short, and only characters that cannot carry a token or a sentence. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const ENVELOPE_KEYS: readonly string[] = ["message", "status", "request_id", "suggested_fix"];
const ACCOUNT_KEYS: readonly string[] = ["connected_account_id", "connectedAccountId", "id"];

/**
 * The documented envelope and nothing else: the root holds only `error`; `error` holds only `message` (a
 * non-empty string), `status` (an integer), `request_id` (a string) and, optionally, `suggested_fix` (a string).
 * Any other key, and any nested value, fails it: an extra field is a shape nobody documented, and it may be
 * where an account id or other state hides.
 */
function strictEnvelope(body: unknown): { status: number; requestId: string | undefined } | undefined {
  const root = asRecord(body);
  if (root === undefined || Object.keys(root).length !== 1) return undefined;
  const error = asRecord(root["error"]);
  if (error === undefined || !Object.keys(error).every((key) => ENVELOPE_KEYS.includes(key))) return undefined;
  const { message, status, request_id: requestId, suggested_fix: fix } = error;
  if (typeof message !== "string" || message.length === 0 || typeof status !== "number" || !Number.isInteger(status)) return undefined;
  if (fix !== undefined && typeof fix !== "string") return undefined;
  if (typeof requestId !== "string") return undefined;
  return { status, requestId: REQUEST_ID.test(requestId) ? requestId : undefined };
}
/** A bounded scan (depth 6, 200 nodes) for an account id anywhere in the body, so the information is kept. */
function scanForAccountId(body: unknown): string | undefined {
  let budget = 200;
  const walk = (value: unknown, depth: number): string | undefined => {
    if (depth > 6 || budget-- <= 0) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) { const found = walk(item, depth + 1); if (found) return found; }
      return undefined;
    }
    const record = asRecord(value);
    if (record === undefined) return undefined;
    for (const key of ACCOUNT_KEYS) { const id = safeId(record[key], 128); if (id) return id; }
    for (const child of Object.values(record)) { const found = walk(child, depth + 1); if (found) return found; }
    return undefined;
  };
  return walk(body, 0);
}
/**
 * Classifies a non-2xx answer from its status and parsed body, never from message text. Evidence: Composio's
 * public error reference (https://docs.composio.dev/reference/errors, read 2026-11-08) documents one envelope,
 * `{"error": {"message", "status", "request_id", "suggested_fix"?}}` with `status` the HTTP code. It documents no
 * machine-readable error code and no guarantee about side effects, and this function claims none:
 * `provider_refused` means only "Composio answered with its documented refusal envelope".
 *   - 5xx, 402, 408, 429: `transient`.
 *   - 400, 404, 422 whose body is exactly that envelope (see `strictEnvelope`), with `status` equal to the HTTP
 *     status, a request id of safe characters, and no account id anywhere in the body: `provider_refused`.
 *   - 409, 401, 403, 410, other 4xx and any body that is missing, oversized, not JSON or another shape: `unknown`.
 * `requestId` is taken only from a validated envelope. `namedAccountId` comes from a bounded scan of the whole body.
 */
export function classifyHttpError(status: number, body: unknown): ComposioErrorInfo {
  const envelope = strictEnvelope(body);
  const matched = envelope !== undefined && envelope.status === status;
  const requestId = matched ? envelope.requestId : undefined;
  const named = scanForAccountId(body);
  const base: { body?: unknown; requestId?: string; namedAccountId?: string } = {
    ...(body === undefined ? {} : { body }), ...(requestId === undefined ? {} : { requestId }), ...(named === undefined ? {} : { namedAccountId: named }),
  };
  if (status >= 500 || TRANSIENT_STATUSES.includes(status)) return { errorClass: "transient", ...base };
  const refused = REFUSABLE_STATUSES.includes(status) && matched && requestId !== undefined && named === undefined;
  return { errorClass: refused ? "provider_refused" : "unknown", ...base };
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

export type ExecuteFailure = "auth" | "forbidden" | "rate_limited" | "unavailable";
export type ExecuteOutcome =
  | { readonly kind: "ok"; readonly data: unknown }
  | { readonly kind: "failed"; readonly reason: ExecuteFailure };
const executeSchema = z.object({ successful: z.boolean(), data: z.unknown().optional(), error: z.unknown().optional() });
/** The numeric fields a failed envelope may carry the provider's HTTP status in. */
const STATUS_FIELDS = ["status_code", "statusCode", "http_status", "httpStatus", "status"] as const;
/**
 * A 200 with `successful: false`: only our class survives (C-10, C-14). The class comes from a
 * provider HTTP status in a structured field of `error` or `data`; text is never read, so an order titled
 * "Forbidden" is not an auth error. 429 is a provider limit. 401 is the store's grant (the credential is
 * refused: reconnect). A 403 alone is `forbidden`: the credential works but the app may not read this
 * resource (Shopify's protected customer data gate, observed on preview 2026-11-07, C-17), which
 * reconnecting cannot fix. A 401 beside a 403 stays `auth`: a refused credential outranks.
 */
export function classifyExecuteFailure(envelope: { readonly error?: unknown; readonly data?: unknown }): ExecuteFailure {
  const statuses: number[] = [];
  for (const part of [envelope.error, envelope.data]) {
    if (typeof part !== "object" || part === null || Array.isArray(part)) continue;
    for (const field of STATUS_FIELDS) {
      const value = (part as Record<string, unknown>)[field];
      if (typeof value === "number" && Number.isInteger(value)) statuses.push(value);
    }
  }
  if (statuses.includes(429)) return "rate_limited";
  if (statuses.includes(401)) return "auth";
  if (statuses.includes(403)) return "forbidden";
  return "unavailable";
}

/** A fixed provider request the code builds (C-13): a path relative to the toolkit's base URL, never an absolute URL. */
export interface ProxyRequest {
  readonly method: "GET" | "POST" | "DELETE";
  readonly endpoint: string;
  readonly body?: unknown;
}
/** The provider's own HTTP status and body, as Composio relays them. Callers read it; it is never logged or returned. */
export interface ProxyAnswer {
  readonly status: number;
  readonly data: unknown;
}
const proxySchema = z.object({ status: z.number().int().min(100).max(599), data: z.unknown().optional() });

export interface ComposioClient {
  link(input: { authConfigId: string; userId: string; callbackUrl: string }, signal?: AbortSignal): Promise<ComposioLink>;
  /** 400 or 404 surface as `bad_request` or `not_found`; the caller decides what each means. */
  completeAuth(input: { sessionUri: string; userId: string }, signal?: AbortSignal): Promise<{ connectedAccountId: string; toolkit: string | null }>;
  /** `null` for a 404. */
  getAccount(id: string, signal?: AbortSignal): Promise<ComposioAccount | null>;
  /**
   * C-13: one proxy call through the account's own credential. The request is the catalog's fixed one, never a
   * caller's. Composio's own `revoke` is not used: it answers 400 for a toolkit without a revoke configuration,
   * which Shopify is.
   */
  proxy(input: { connectedAccountId: string; userId: string; request: ProxyRequest }, signal?: AbortSignal): Promise<ProxyAnswer>;
  /**
   * C-4: the connected accounts for one Composio user and auth config (GET /connected_accounts with `user_ids` and
   * `auth_config_ids`, newest first, one page of at most 50). Used only to check that a refused link created nothing.
   * `hasMore` is true when Composio says another page exists.
   */
  listConnectedAccounts(input: { userId: string; authConfigId: string }, signal?: AbortSignal): Promise<ComposioAccountList>;
  /** A 404 counts as done. */
  deleteAccount(id: string, signal?: AbortSignal): Promise<void>;
  execute(input: ExecuteInput, signal?: AbortSignal): Promise<ExecuteOutcome>;
  /**
   * A-8, owner-run only: one tool's toolkit and versions; `null` for a 404. With `version`, the tool at that
   * one version (`toolkit_versions`), and `null` when the tool has no such version.
   */
  getTool(slug: string, signal?: AbortSignal, version?: string): Promise<ComposioTool | null>;
}
export interface ComposioAccountList {
  readonly items: readonly { readonly id: string; readonly createdAt: string | null }[];
  readonly hasMore: boolean;
}
const accountListSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1).max(128), created_at: z.string().max(64).nullish() })).max(200),
  next_cursor: z.string().max(2048).nullish(),
});
export interface ComposioTool {
  readonly slug: string;
  readonly toolkit: string | null;
  /** The version this answer describes (the latest, unless one was asked for). */
  readonly version: string | null;
  /** The registry's recent versions plus `version`; the registry caps this list, so it is not every version. */
  readonly versions: readonly string[];
  readonly deprecated: boolean;
}

const toolSchema = z.object({
  slug: z.string().min(1).max(200),
  toolkit: z.object({ slug: z.string().max(200).nullish() }).nullish(),
  version: z.string().max(100).nullish(),
  available_versions: z.array(z.string().max(100)).max(1000).nullish(),
  // Required: an answer that does not say whether the tool is deprecated is not one the check can trust.
  is_deprecated: z.boolean(),
});

export interface ComposioClientConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly maxErrorBodyBytes?: number;
}

function kindOf(status: number): ComposioErrorKind {
  if (status === 429 || status === 402) return "rate_limited";
  // A-5: 401, 403 and 410 on our own call are about our key or project, never the store's grant.
  if (status === 401 || status === 403 || status === 410) return "key_refused";
  if (status === 404) return "not_found";
  if (status >= 400 && status < 500) return "bad_request";
  return "unavailable";
}

/** Reads at most `max` bytes; more is `too_large`, never partly used. Checked after each read, so one runtime chunk can arrive first; the reader is cancelled as soon as the total passes `max`. */
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

/**
 * Reads a non-2xx body up to `max` bytes. An empty, oversized, unreadable-as-JSON body is `undefined` (class
 * `unknown`, never used). A transport failure or timeout while reading is different: the answer is incomplete, so it
 * is thrown as a `transient` error with the `timeout` or `network` detail. The size is checked after each read, so
 * one runtime chunk can arrive before the check; the reader is cancelled the moment the total passes `max`.
 */
async function readErrorBody(response: Response, max: number, timeout: AbortSignal): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    throw new ComposioError(kindOf(response.status), response.status, timeout.aborted ? "timeout" : "network", undefined, { errorClass: "transient" });
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
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
  const maxErrorBody = config.maxErrorBodyBytes ?? COMPOSIO_MAX_ERROR_BODY_BYTES;

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
        const errorBody = await readErrorBody(response, maxErrorBody, timeout);
        throw new ComposioError(kindOf(response.status), response.status, undefined, undefined, classifyHttpError(response.status, errorBody));
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
    async proxy(input, signal) {
      const { endpoint, method, body } = input.request;
      if (!/^\/[A-Za-z0-9._/-]*$/.test(endpoint) || endpoint.startsWith("//") || endpoint.includes("..")) throw new Error("A proxy request needs a path relative to the base URL");
      const { json } = await call("POST", "/tools/execute/proxy", {
        connected_account_id: input.connectedAccountId,
        user_id: input.userId,
        endpoint,
        method,
        ...(body === undefined ? {} : { body }),
      }, signal);
      const out = parse(proxySchema, json);
      return { status: out.status, data: out.data };
    },
    async listConnectedAccounts(input, signal) {
      const query = `user_ids=${enc(input.userId)}&auth_config_ids=${enc(input.authConfigId)}&order_by=created_at&order_direction=desc&limit=50`;
      const { json } = await call("GET", `/connected_accounts?${query}`, undefined, signal);
      const out = parse(accountListSchema, json);
      return { items: out.items.map((item) => ({ id: item.id, createdAt: item.created_at ?? null })), hasMore: out.next_cursor !== undefined && out.next_cursor !== null && out.next_cursor !== "" };
    },
    async deleteAccount(id, signal) {
      try {
        await call("DELETE", `/connected_accounts/${enc(id)}`, undefined, signal);
      } catch (error) {
        if (error instanceof ComposioError && error.kind === "not_found") return;
        throw error;
      }
    },
    async getTool(slug, signal, version) {
      try {
        const query = version === undefined ? "" : `?toolkit_versions=${enc(version)}`;
        const { json } = await call("GET", `/tools/${enc(slug)}${query}`, undefined, signal);
        const out = parse(toolSchema, json);
        const versions = [...new Set([...(out.available_versions ?? []), ...(out.version ? [out.version] : [])])];
        return { slug: out.slug, toolkit: out.toolkit?.slug?.toLowerCase() ?? null, version: out.version ?? null, versions, deprecated: out.is_deprecated };
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
