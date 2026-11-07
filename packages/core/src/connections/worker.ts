// Connections C-3, C-5, C-8, C-9, C-10, C-12, C-13: the worker. It holds the only Composio client,
// runs as the service role (the `service` dependency) and names the tenant in every statement on a
// tenant table. The five operations are what the signed internal routes call; `pass` is the cron.
//
// Rules this file keeps:
//   - Every Composio call first takes one unit of the organization budget (`composio-org:<env>`,
//     the `connections_org_budget` definer). A Composio 429 or quota error opens the 60 second
//     cooldown. Over budget, a run answers `provider_rate_limited` and a pass stops (C-12).
//   - Every status change is a conditional UPDATE naming the tenant, the row and the statuses it
//     may move from (C-7). A health read never restores an `auth_error` row, never touches a
//     `disconnecting` one (C-8).
//   - The pass claims one row at a time with FOR UPDATE SKIP LOCKED, oldest first, and keeps that
//     row's transaction open through its own Composio calls (C-9). The budget call uses another
//     connection, so the claim holds no budget lock.
//   - Nothing in a log or report carries arguments, output, labels, link URLs or provider text.
import { z } from "zod";
import {
  CONNECTION_RESULT_MAX_BYTES,
  normalizeAccountLabel,
  type ConnectorCompleteResponse,
  type ConnectorLinkResponse,
  type ConnectorRunResponse,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { catalogTool, catalogToolkit, OVERRIDE_KEYS, type CatalogTool } from "./catalog.js";
import {
  completeDecision,
  ComposioError,
  liveDecision,
  type ComposioAccount,
  type ComposioClient,
} from "./composio.js";
import { CONNECT_ATTEMPT_LIFETIME_MS } from "./tokens.js";
import type { ConnectorEnv } from "./signing.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export const connectionsWorkerConfigSchema = z.strictObject({
  env: z.enum(["production", "preview"]),
  /** CONNECTIONS_CALLBACK_URL: the one dashboard URL Composio redirects to. */
  callbackUrl: z.url({ protocol: /^https?$/ }).max(2000),
  /** CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID and its kin: toolkit to Composio auth config ID. */
  authConfigIds: z.record(z.string().regex(/^[a-z0-9_-]{1,40}$/), z.string().min(1).max(128)),
  /** C-9: a pass runs at most this long and makes at most `passMaxCalls` Composio calls. */
  passMs: z.number().int().positive().max(55 * SECOND).default(40 * SECOND),
  passMaxCalls: z.number().int().positive().max(2000).default(200),
  /** C-9: an unconfirmed attempt is swept this long after it expired. */
  sweepGraceMs: z.number().int().positive().default(HOUR),
  /** C-9: a live row is re-read when its last check is older than this. */
  healthIntervalMs: z.number().int().positive().default(24 * HOUR),
  attemptLifetimeMs: z.number().int().positive().default(CONNECT_ATTEMPT_LIFETIME_MS),
});
export type ConnectionsWorkerConfig = z.input<typeof connectionsWorkerConfigSchema>;

/** Operator events: ids, our tool name, our code and timings. Never arguments, output, labels or provider text. */
export type ConnectionsWorkerReport =
  | { readonly kind: "run"; readonly tenantId: string; readonly connectionId: string; readonly tool: string; readonly code: string; readonly ms: number }
  | { readonly kind: "reauthorize"; readonly tenantId: string; readonly connectionId: string; readonly reason: "provider_status" | "auth_error" }
  | { readonly kind: "restored"; readonly tenantId: string; readonly connectionId: string }
  | { readonly kind: "disconnected"; readonly tenantId: string; readonly connectionId: string; readonly revokeFailed: boolean }
  | { readonly kind: "disconnect_retry"; readonly tenantId: string; readonly connectionId: string; readonly code: string }
  | { readonly kind: "swept"; readonly tenantId: string; readonly attemptId: string }
  | { readonly kind: "sweep_failed"; readonly tenantId: string; readonly attemptId: string; readonly code: string }
  | { readonly kind: "health_failed"; readonly tenantId: string; readonly connectionId: string; readonly code: string }
  | { readonly kind: "pass_stopped"; readonly why: "time" | "calls" | "budget" }
  | { readonly kind: "cooldown"; readonly env: string };

export interface ConnectionsWorkerDeps {
  /** The service-role transaction (`asService(pool, work)`). */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly composio: ComposioClient;
  readonly clock: { now(): Date };
  readonly config: ConnectionsWorkerConfig;
  readonly report?: (event: ConnectionsWorkerReport) => void;
}

/** What one pass did. */
export interface ConnectionsPassResult {
  readonly disconnected: number;
  readonly swept: number;
  readonly checked: number;
  readonly composioCalls: number;
  readonly stopped: "time" | "calls" | "budget" | null;
}

interface ConnectionRow {
  tenant_id: string;
  id: string;
  toolkit: string;
  composio_account_id: string;
  external_account_id: string;
  account_domain: string;
  status: "active" | "reauthorize" | "disconnecting" | "disconnected";
  reauthorize_reason: "provider_status" | "auth_error" | null;
  last_error_code: string | null;
}
const CONNECTION_COLUMNS = "tenant_id, id, toolkit, composio_account_id, external_account_id, account_domain, status, reauthorize_reason, last_error_code";
interface AttemptRow {
  tenant_id: string;
  id: string;
  connection_id: string;
  toolkit: string;
  composio_account_id: string;
  auth_config_id: string;
  account_domain: string;
  status: "started" | "verified" | "confirmed" | "cancelled" | "swept";
  expires_at: Date;
}
const ATTEMPT_COLUMNS = "tenant_id, id, connection_id, toolkit, composio_account_id, auth_config_id, account_domain, status, expires_at";

/** The organization budget refused a call (C-12). */
class BudgetRefused extends Error {
  constructor(readonly retryAfterSeconds: number) { super("composio budget"); }
}
/** A pass limit was reached. */
class PassLimit extends Error {
  constructor(readonly why: "time" | "calls" | "budget") { super(`pass limit ${why}`); }
}
interface PassContext {
  readonly deadline: number;
  calls: number;
  readonly maxCalls: number;
}

/** C-3: `zsb:<env>:<tenantId>`, built only here, from the worker's own environment. */
export const composioUserId = (env: ConnectorEnv, tenantId: string): string => `zsb:${env}:${tenantId.toLowerCase()}`;

const COOLDOWN_SECONDS = 60;

/** Drops trailing list items until the JSON fits `maxBytes`; false when even an empty list does not fit. */
export function trimToSize(value: unknown, listPath: readonly string[], maxBytes: number): { readonly data: unknown; readonly truncated: boolean } | null {
  const size = (data: unknown) => Buffer.byteLength(JSON.stringify(data), "utf8");
  if (size(value) <= maxBytes) return { data: value, truncated: false };
  const copy = structuredClone(value) as unknown;
  let list: unknown = copy;
  for (const key of listPath) list = typeof list === "object" && list !== null ? (list as Record<string, unknown>)[key] : undefined;
  if (!Array.isArray(list)) return null;
  // Halve, then step: a 250-item list needs at most ~16 size checks.
  let low = 0;
  let high = list.length;
  const original = [...list];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    list.length = 0;
    list.push(...original.slice(0, mid));
    if (size(copy) <= maxBytes) low = mid; else high = mid - 1;
  }
  list.length = 0;
  list.push(...original.slice(0, low));
  return size(copy) <= maxBytes ? { data: copy, truncated: true } : null;
}

export function createConnectionsWorker(deps: ConnectionsWorkerDeps) {
  const config = connectionsWorkerConfigSchema.parse(deps.config);
  const { service, composio } = deps;
  const now = () => deps.clock.now();
  const report = (event: ConnectionsWorkerReport) => { try { deps.report?.(event); } catch { /* a reporter never breaks the worker */ } };
  const userIdOf = (tenantId: string) => composioUserId(config.env, tenantId);

  /** C-12: one unit of `composio-org:<env>`; the number of milliseconds to wait, or 0. */
  async function budget(op: "take" | "cool"): Promise<number> {
    const row = (await service((tx) => tx.query<{ wait: string }>(
      "SELECT public.connections_org_budget($1, $2, $3)::text AS wait", [now(), config.env, op]))).rows[0];
    return Number(row?.wait ?? 0);
  }
  /** Spends the budget, then runs one Composio call; a 429 or quota error opens the cooldown. */
  async function spend<T>(pass: PassContext | undefined, work: () => Promise<T>): Promise<T> {
    if (pass) {
      if (now().getTime() >= pass.deadline) throw new PassLimit("time");
      if (pass.calls >= pass.maxCalls) throw new PassLimit("calls");
    }
    const wait = await budget("take");
    if (wait > 0) {
      if (pass) throw new PassLimit("budget");
      throw new BudgetRefused(Math.max(1, Math.ceil(wait / SECOND)));
    }
    if (pass) pass.calls += 1;
    try {
      return await work();
    } catch (error) {
      if (error instanceof ComposioError && error.kind === "rate_limited") {
        await budget("cool").catch(() => undefined);
        report({ kind: "cooldown", env: config.env });
      }
      throw error;
    }
  }

  const accountMatches = (account: ComposioAccount | null, expected: { id: string; tenantId: string; toolkit: string; authConfigId: string }): account is ComposioAccount =>
    account !== null && account.id === expected.id && account.userId === userIdOf(expected.tenantId)
      && account.toolkit === expected.toolkit && account.authConfigId === expected.authConfigId;

  const loadAttempt = (tx: Transaction, tenantId: string, attemptId: string, lock = false) =>
    tx.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM connection_attempts WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, attemptId]).then((r) => r.rows[0] ?? null);
  const loadConnection = (tx: Transaction, tenantId: string, id: string) =>
    tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE tenant_id=$1 AND id=$2`, [tenantId, id]).then((r) => r.rows[0] ?? null);

  /** What a failed Composio call means to a caller of `link` or `complete`. */
  const refusedFor = (error: unknown): "provider_rate_limited" | "provider_unavailable" =>
    (error instanceof BudgetRefused || (error instanceof ComposioError && error.kind === "rate_limited")) ? "provider_rate_limited" : "provider_unavailable";

  // ---- link --------------------------------------------------------------------------------
  async function link(input: { tenantId: string; toolkit: string; attemptId: string; connectionId: string; shopDomain: string; createdBy: string; browserHash: string }, signal?: AbortSignal): Promise<ConnectorLinkResponse> {
    const toolkit = catalogToolkit(input.toolkit);
    const authConfigId = config.authConfigIds[input.toolkit];
    if (!toolkit || !authConfigId) return { outcome: "refused", code: "not_found" };
    const started = now();
    let made;
    try {
      made = await spend(undefined, () => composio.link({
        authConfigId, userId: userIdOf(input.tenantId), callbackUrl: config.callbackUrl, connectionData: toolkit.linkData(input.shopDomain),
      }, signal));
    } catch (error) {
      return { outcome: "refused", code: refusedFor(error) };
    }
    const expiresAt = new Date(started.getTime() + config.attemptLifetimeMs);
    try {
      await service((tx) => tx.query(
        `INSERT INTO connection_attempts (tenant_id, id, connection_id, toolkit, composio_account_id, auth_config_id, account_domain, created_by,
           browser_hash, status, expires_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'started',$10,$11,$11)`,
        [input.tenantId, input.attemptId, input.connectionId, input.toolkit, made.connectedAccountId, authConfigId, input.shopDomain, input.createdBy,
          input.browserHash, expiresAt, started]));
    } catch {
      // The attempt row is the record that lets the sweep find this account; without it, remove it now.
      await spend(undefined, () => composio.deleteAccount(made.connectedAccountId)).catch(() => undefined);
      return { outcome: "refused", code: "provider_unavailable" };
    }
    return { outcome: "linked", redirectUrl: made.redirectUrl, composioAccountId: made.connectedAccountId, authConfigId, expiresAt: expiresAt.toISOString() };
  }

  // ---- complete ----------------------------------------------------------------------------
  async function complete(input: { tenantId: string; attemptId: string; sessionUri: string | null }, signal?: AbortSignal): Promise<ConnectorCompleteResponse> {
    const refused = (reason: Extract<ConnectorCompleteResponse, { outcome: "refused" }>["reason"]): ConnectorCompleteResponse => ({ outcome: "refused", reason });
    const attempt = await service((tx) => loadAttempt(tx, input.tenantId, input.attemptId));
    if (!attempt || attempt.status === "cancelled" || attempt.status === "swept") return refused("invalid_attempt");
    if (attempt.status === "confirmed") return refused("conflict");
    if (attempt.expires_at.getTime() <= now().getTime()) return refused("expired");
    const toolkit = catalogToolkit(attempt.toolkit);
    if (!toolkit) return refused("not_connected");
    const userId = userIdOf(input.tenantId);
    try {
      if (input.sessionUri !== null) {
        const sessionUri = input.sessionUri;
        try {
          const redeemed = await spend(undefined, () => composio.completeAuth({ sessionUri, userId }, signal));
          // Another account than the attempt's never connects (C-5).
          if (redeemed.connectedAccountId !== attempt.composio_account_id) return refused("not_connected");
        } catch (error) {
          // 404: the session was used or has expired. Only this browser held it, so an account that is
          // ACTIVE for this user by the read below was redeemed by our earlier, lost call (C-5).
          // 400: Composio checked `user_id` and it is not the session's.
          if (error instanceof ComposioError && error.kind === "bad_request") return refused("not_connected");
          if (!(error instanceof ComposioError && error.kind === "not_found")) throw error;
        }
      }
      const account = await spend(undefined, () => composio.getAccount(attempt.composio_account_id, signal));
      if (!accountMatches(account, { id: attempt.composio_account_id, tenantId: input.tenantId, toolkit: attempt.toolkit, authConfigId: attempt.auth_config_id }))
        return refused("not_connected");
      const decision = completeDecision(account.status);
      if (decision === "pending") return { outcome: "pending" };
      if (decision === "refuse") return refused("not_connected");
      const identity = await spend(undefined, () => composio.execute({
        slug: toolkit.identity.slug, version: toolkit.identity.version, userId, connectedAccountId: attempt.composio_account_id, arguments: {},
      }, signal));
      if (identity.kind !== "ok") return refused(identity.reason === "rate_limited" ? "rate_limited" : identity.reason === "auth" ? "not_connected" : "provider_unavailable");
      const shop = toolkit.identity.project(identity.data);
      if (!shop) return refused("provider_unavailable");
      // The store that consented must be the one the member named (C-14).
      if (shop.domain !== attempt.account_domain) return refused("not_connected");
      const label = normalizeAccountLabel(shop.name) ?? attempt.account_domain;
      const moved = await service((tx) => tx.query(
        `UPDATE connection_attempts SET status='verified', updated_at=$3
          WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified')`, [input.tenantId, input.attemptId, now()]));
      if (moved.rowCount !== 1) return refused("invalid_attempt");
      return { outcome: "verified", composioAccountId: attempt.composio_account_id, externalAccountId: shop.externalAccountId, accountDomain: shop.domain, accountLabel: label };
    } catch (error) {
      if (error instanceof BudgetRefused || error instanceof ComposioError) return refused(refusedFor(error) === "provider_rate_limited" ? "rate_limited" : "provider_unavailable");
      throw error;
    }
  }

  // ---- cancel ------------------------------------------------------------------------------
  async function cancel(input: { tenantId: string; attemptId: string }, signal?: AbortSignal): Promise<{ outcome: "cancelled" | "not_found" }> {
    const attempt = await service((tx) => loadAttempt(tx, input.tenantId, input.attemptId));
    if (!attempt) return { outcome: "not_found" };
    if (attempt.status === "cancelled" || attempt.status === "swept") return { outcome: "cancelled" };
    if (attempt.status === "confirmed") return { outcome: "not_found" };
    // A connection built from this attempt owns the account now: never delete it from here.
    const connection = await service((tx) => loadConnection(tx, input.tenantId, attempt.connection_id));
    if (connection) {
      await service((tx) => tx.query(
        "UPDATE connection_attempts SET status='confirmed', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified')", [input.tenantId, input.attemptId, now()]));
      return { outcome: "not_found" };
    }
    const done = await removeAttemptAccount(attempt, undefined, signal);
    if (done !== "removed") throw new ComposioError("unavailable");
    await service((tx) => tx.query(
      "UPDATE connection_attempts SET status='cancelled', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified')", [input.tenantId, input.attemptId, now()]));
    return { outcome: "cancelled" };
  }

  /**
   * Revokes (best effort) and deletes an attempt's Composio account, after checking it belongs to the
   * attempt's tenant: `removed` (a 404 counts), `foreign` (another user's: left alone), or `failed`.
   */
  async function removeAttemptAccount(attempt: AttemptRow, pass: PassContext | undefined, signal?: AbortSignal): Promise<"removed" | "foreign" | "failed"> {
    try {
      const account = await spend(pass, () => composio.getAccount(attempt.composio_account_id, signal));
      if (account === null) return "removed";
      if (account.userId !== userIdOf(attempt.tenant_id)) return "foreign";
      await spend(pass, () => composio.revoke(attempt.composio_account_id, signal)).catch((error) => { if (error instanceof PassLimit) throw error; });
      await spend(pass, () => composio.deleteAccount(attempt.composio_account_id, signal));
      return "removed";
    } catch (error) {
      if (error instanceof PassLimit) throw error;
      return "failed";
    }
  }

  // ---- run ---------------------------------------------------------------------------------
  async function run(input: { tenantId: string; connectionId: string; tool: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<ConnectorRunResponse> {
    const started = now().getTime();
    const fail = (code: Extract<ConnectorRunResponse, { outcome: "error" }>["code"], retryAfterSeconds?: number): ConnectorRunResponse => {
      report({ kind: "run", tenantId: input.tenantId, connectionId: input.connectionId, tool: input.tool, code, ms: now().getTime() - started });
      return { outcome: "error", code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) };
    };
    const row = await service((tx) => loadConnection(tx, input.tenantId, input.connectionId));
    if (!row) return fail("not_found");
    if (row.status === "reauthorize") return fail("connection_needs_reconnect");
    if (row.status !== "active") return fail("not_found");
    const tool: CatalogTool | undefined = catalogTool(row.toolkit, input.tool);
    if (!tool) return fail("not_found");
    // The override fields are refused before any schema sees them, then the strict schema runs again.
    if (Object.keys(input.arguments).some((key) => OVERRIDE_KEYS.has(key))) return fail("invalid_arguments");
    const args = tool.input.safeParse(input.arguments);
    if (!args.success) return fail("invalid_arguments");
    const authConfigId = config.authConfigIds[row.toolkit];
    if (!authConfigId) return fail("provider_unavailable");
    const userId = userIdOf(input.tenantId);
    try {
      const account = await spend(undefined, () => composio.getAccount(row.composio_account_id, signal));
      if (!accountMatches(account, { id: row.composio_account_id, tenantId: input.tenantId, toolkit: row.toolkit, authConfigId }) || liveDecision(account.status) !== "active") {
        await markReauthorize(input.tenantId, row.id, "provider_status");
        return fail("connection_needs_reconnect");
      }
      const outcome = await spend(undefined, () => composio.execute({
        slug: tool.slug, version: tool.version, userId, connectedAccountId: row.composio_account_id, arguments: tool.toArguments(args.data, now()),
      }, signal));
      if (outcome.kind === "failed") {
        if (outcome.reason === "auth") {
          await markReauthorize(input.tenantId, row.id, "auth_error");
          return fail("connection_needs_reconnect");
        }
        if (outcome.reason === "rate_limited") {
          await budget("cool").catch(() => undefined);
          return fail("provider_rate_limited", COOLDOWN_SECONDS);
        }
        return fail("provider_unavailable");
      }
      const projected = tool.project(outcome.data);
      if (projected === undefined) return fail("provider_unavailable");
      const trimmed = trimToSize(projected, tool.listPath, CONNECTION_RESULT_MAX_BYTES);
      if (!trimmed) return fail("provider_unavailable");
      report({ kind: "run", tenantId: input.tenantId, connectionId: input.connectionId, tool: input.tool, code: "ok", ms: now().getTime() - started });
      return { outcome: "ok", data: trimmed.data, truncated: trimmed.truncated };
    } catch (error) {
      if (error instanceof BudgetRefused) return fail("provider_rate_limited", error.retryAfterSeconds);
      if (error instanceof ComposioError) {
        if (error.kind === "rate_limited") return fail("provider_rate_limited", COOLDOWN_SECONDS);
        if (error.kind === "auth") {
          await markReauthorize(input.tenantId, row.id, "auth_error");
          return fail("connection_needs_reconnect");
        }
        return fail("provider_unavailable");
      }
      throw error;
    }
  }

  /** C-8: only an `active` row moves; a row already reauthorizing or ending keeps its reason or state. */
  async function markReauthorize(tenantId: string, id: string, reason: "provider_status" | "auth_error"): Promise<void> {
    const moved = await service((tx) => tx.query(
      `UPDATE connections SET status='reauthorize', reauthorize_reason=$3, last_checked_at=$4, updated_at=$4
        WHERE tenant_id=$1 AND id=$2 AND status='active'`, [tenantId, id, reason, now()]));
    if (moved.rowCount === 1) report({ kind: "reauthorize", tenantId, connectionId: id, reason });
  }

  // ---- disconnect --------------------------------------------------------------------------
  /**
   * C-13: revoke (a failure is recorded, the delete still runs), delete (a 404 counts), then
   * `disconnected` with the label cleared. A failed delete leaves the row `disconnecting` for the pass.
   */
  async function finishDisconnect(tx: Transaction, row: ConnectionRow, pass: PassContext | undefined, signal?: AbortSignal): Promise<"disconnected" | "pending"> {
    let revokeFailed = false;
    try {
      await spend(pass, () => composio.revoke(row.composio_account_id, signal));
    } catch (error) {
      if (error instanceof PassLimit || error instanceof BudgetRefused) throw error;
      // An account that is already gone has nothing left to revoke.
      if (!(error instanceof ComposioError && error.kind === "not_found")) revokeFailed = true;
    }
    try {
      await spend(pass, () => composio.deleteAccount(row.composio_account_id, signal));
    } catch (error) {
      if (error instanceof PassLimit || error instanceof BudgetRefused) throw error;
      const code = revokeFailed ? "revoke_failed" : "delete_failed";
      await tx.query("UPDATE connections SET last_error_code=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='disconnecting'",
        [row.tenant_id, row.id, code, now()]);
      report({ kind: "disconnect_retry", tenantId: row.tenant_id, connectionId: row.id, code });
      return "pending";
    }
    await tx.query(
      `UPDATE connections SET status='disconnected', account_label=NULL, last_error_code=$3, last_checked_at=$4, updated_at=$4
        WHERE tenant_id=$1 AND id=$2 AND status='disconnecting'`, [row.tenant_id, row.id, revokeFailed ? "revoke_failed" : null, now()]);
    report({ kind: "disconnected", tenantId: row.tenant_id, connectionId: row.id, revokeFailed });
    return "disconnected";
  }

  async function disconnect(input: { tenantId: string; connectionId: string }, signal?: AbortSignal): Promise<{ outcome: "disconnected" | "pending" | "not_found" }> {
    const row = await service((tx) => loadConnection(tx, input.tenantId, input.connectionId));
    if (!row) return { outcome: "not_found" };
    if (row.status === "disconnected") return { outcome: "disconnected" };
    if (row.status !== "disconnecting") return { outcome: "not_found" };
    try {
      // A row the pass holds is being finished: this call answers `pending` and leaves it alone.
      const outcome = await service(async (tx) => {
        const claimed = (await tx.query<ConnectionRow>(
          `SELECT ${CONNECTION_COLUMNS} FROM connections WHERE tenant_id=$1 AND id=$2 AND status='disconnecting' FOR UPDATE SKIP LOCKED`,
          [input.tenantId, input.connectionId])).rows[0];
        return claimed ? finishDisconnect(tx, claimed, undefined, signal) : "pending" as const;
      });
      return { outcome };
    } catch (error) {
      if (error instanceof BudgetRefused) return { outcome: "pending" };
      throw error;
    }
  }

  // ---- nonces ------------------------------------------------------------------------------
  /** C-3: records a request ID; false when it was already there. */
  const takeNonce = async (jti: string, expiresAt: Date): Promise<boolean> =>
    (await service((tx) => tx.query("INSERT INTO connector_request_nonces (jti, expires_at) VALUES ($1,$2) ON CONFLICT (jti) DO NOTHING", [jti, expiresAt]))).rowCount === 1;

  // ---- the pass ----------------------------------------------------------------------------
  /** Claims the oldest row `select` finds that is not in `skip`, runs `work` while holding it. */
  async function claimOne<Row extends { id: string }>(
    select: string, params: readonly unknown[], skip: Set<string>, work: (tx: Transaction, row: Row) => Promise<void>,
  ): Promise<boolean> {
    return service(async (tx) => {
      const row = (await tx.query<Row>(select, [...params, [...skip]])).rows[0];
      if (!row) return false;
      skip.add(row.id);
      await work(tx, row);
      return true;
    });
  }

  async function pass(signal?: AbortSignal): Promise<ConnectionsPassResult> {
    const start = now().getTime();
    const ctx: PassContext = { deadline: start + config.passMs, calls: 0, maxCalls: config.passMaxCalls };
    const result = { disconnected: 0, swept: 0, checked: 0 };
    let stopped: ConnectionsPassResult["stopped"] = null;
    try {
      // 1. disconnecting rows: finish them.
      const doneConnections = new Set<string>();
      while (await claimOne<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM connections WHERE status='disconnecting' AND id <> ALL($1::uuid[]) ORDER BY updated_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [], doneConnections, async (tx, row) => { if ((await finishDisconnect(tx, row, ctx, signal)) === "disconnected") result.disconnected += 1; },
      )) { /* next */ }

      // 2. attempts past expiry plus the grace: confirm or sweep.
      const doneAttempts = new Set<string>();
      while (await claimOne<AttemptRow>(
        `SELECT ${ATTEMPT_COLUMNS} FROM connection_attempts
          WHERE status IN ('started','verified') AND expires_at + ($1::bigint * interval '1 millisecond') <= $2 AND id <> ALL($3::uuid[])
          ORDER BY expires_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [config.sweepGraceMs, now()], doneAttempts, async (tx, attempt) => {
          const connection = await loadConnection(tx, attempt.tenant_id, attempt.connection_id);
          if (connection) {
            await tx.query("UPDATE connection_attempts SET status='confirmed', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified')",
              [attempt.tenant_id, attempt.id, now()]);
            return;
          }
          const removed = await removeAttemptAccount(attempt, ctx, signal);
          if (removed === "failed") {
            report({ kind: "sweep_failed", tenantId: attempt.tenant_id, attemptId: attempt.id, code: "delete_failed" });
            return;
          }
          await tx.query("UPDATE connection_attempts SET status='swept', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified')",
            [attempt.tenant_id, attempt.id, now()]);
          result.swept += 1;
          report({ kind: "swept", tenantId: attempt.tenant_id, attemptId: attempt.id });
        },
      )) { /* next */ }

      // 3. live rows not checked for a day.
      const doneChecks = new Set<string>();
      while (await claimOne<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM connections
          WHERE status IN ('active','reauthorize') AND last_checked_at <= $1 AND id <> ALL($2::uuid[])
          ORDER BY last_checked_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [new Date(now().getTime() - config.healthIntervalMs)], doneChecks, async (tx, row) => {
          await healthCheck(tx, row, ctx, signal);
          result.checked += 1;
        },
      )) { /* next */ }
    } catch (error) {
      if (!(error instanceof PassLimit)) throw error;
      stopped = error.why;
      report({ kind: "pass_stopped", why: error.why });
    }
    // 4. nonces past their expiry: no Composio call, so it runs even after a limit.
    await service((tx) => tx.query("DELETE FROM connector_request_nonces WHERE expires_at < $1", [now()]));
    return { ...result, composioCalls: ctx.calls, stopped };
  }

  /** C-8: reads the account of one live row and moves it only as the map allows. */
  async function healthCheck(tx: Transaction, row: ConnectionRow, ctx: PassContext, signal?: AbortSignal): Promise<void> {
    const authConfigId = config.authConfigIds[row.toolkit];
    if (!authConfigId) return;
    let account: ComposioAccount | null;
    try {
      account = await spend(ctx, () => composio.getAccount(row.composio_account_id, signal));
    } catch (error) {
      if (error instanceof PassLimit) throw error;
      // Unknown to us: leave the row as it is and try again next pass.
      const code = error instanceof ComposioError && error.kind === "rate_limited" ? "provider_rate_limited" : "provider_unavailable";
      await tx.query("UPDATE connections SET last_error_code=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status IN ('active','reauthorize')",
        [row.tenant_id, row.id, code, now()]);
      report({ kind: "health_failed", tenantId: row.tenant_id, connectionId: row.id, code });
      return;
    }
    const healthy = accountMatches(account, { id: row.composio_account_id, tenantId: row.tenant_id, toolkit: row.toolkit, authConfigId })
      && liveDecision(account.status) === "active";
    const at = now();
    if (!healthy) {
      // Only an `active` row moves; a `reauthorize` row keeps its reason.
      const moved = await tx.query(
        `UPDATE connections SET status='reauthorize', reauthorize_reason='provider_status', last_checked_at=$3, updated_at=$3
          WHERE tenant_id=$1 AND id=$2 AND status='active'`, [row.tenant_id, row.id, at]);
      if (moved.rowCount === 1) report({ kind: "reauthorize", tenantId: row.tenant_id, connectionId: row.id, reason: "provider_status" });
      else await tx.query("UPDATE connections SET last_checked_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('active','reauthorize')", [row.tenant_id, row.id, at]);
      return;
    }
    // Healthy: restore `active` only from `reauthorize` with `provider_status`, and only while this is the
    // tenant's one live row for the toolkit. An `auth_error` row returns only through Reconnect.
    const restored = await tx.query(
      `UPDATE connections SET status='active', reauthorize_reason=NULL, last_error_code=NULL, last_checked_at=$3, updated_at=$3
        WHERE tenant_id=$1 AND id=$2 AND status='reauthorize' AND reauthorize_reason='provider_status'
          AND NOT EXISTS (SELECT 1 FROM connections o WHERE o.tenant_id=$1 AND o.toolkit=$4 AND o.id<>$2 AND o.status IN ('active','reauthorize','disconnecting'))`,
      [row.tenant_id, row.id, at, row.toolkit]);
    if (restored.rowCount === 1) {
      report({ kind: "restored", tenantId: row.tenant_id, connectionId: row.id });
      return;
    }
    await tx.query(
      `UPDATE connections SET last_checked_at=$3, last_error_code=NULL, updated_at=$3
        WHERE tenant_id=$1 AND id=$2 AND status IN ('active','reauthorize')`, [row.tenant_id, row.id, at]);
  }

  return { link, complete, cancel, run, disconnect, pass, takeNonce, config };
}
export type ConnectionsWorker = ReturnType<typeof createConnectionsWorker>;
