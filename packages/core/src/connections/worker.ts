// Connections C-3, C-5, C-8, C-9, C-10, C-12, C-13: the worker. It holds the only Composio client,
// runs as the service role (the `service` dependency) and names the tenant in every statement on a
// tenant table. The five operations are what the signed internal routes call; `pass` is the cron.
//
// Rules this file keeps:
//   - Every Composio call first takes one unit of the organization budget (`composio-org:<env>`,
//     the `connections_org_budget` definer). A Composio 429, a provider 429 inside an execute
//     envelope, or a quota error opens the 60 second cooldown and reports it. Over budget, a run
//     answers `provider_rate_limited` and a pass stops (C-12).
//   - Every status change is a conditional UPDATE naming the tenant, the row and the statuses it
//     may move from (C-7). A health read never restores an `auth_error` row, never touches a
//     `disconnecting` one (C-8).
//   - No transaction is held across a Composio call. The pass and the disconnect call take a lease
//     (`claimed_until`, one short UPDATE … FOR UPDATE SKIP LOCKED) on the row they work on, and each
//     write after a call is its own short conditional statement (C-9). So no work ever holds one pool
//     client while it waits for another: the worker runs on a pool of one.
//   - An account is uninstalled at the provider or deleted only after a fresh read shows it is this
//     tenant's (its `user_id`, toolkit and auth config), whatever path asks (C-3, C-9, C-13). The
//     uninstall is the worker's one write to the provider: the catalog's fixed request (C-13).
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
/** A lease outlives one pass and one function run (30 s), so a lost worker frees its row within a minute. */
const LEASE_MS = MINUTE;
/** An attempt whose account read shows no user is retried this long past the sweep, then given up (C-9). */
const UNVERIFIED_GIVE_UP_MS = 24 * HOUR;
/**
 * A callback that redeems a session leases its attempt this long (the edge gives the worker 7 s) and frees it
 * when the redemption returns. While the lease holds, no other callback or status call for the attempt may
 * take the lost-answer path: it could only be reading an account that call, or a call from another browser,
 * is activating.
 */
const REDEMPTION_LEASE_MS = 8 * SECOND;

export const connectionsWorkerConfigSchema = z.strictObject({
  env: z.enum(["production", "preview"]),
  /** CONNECTIONS_CALLBACK_URL: the one dashboard URL Composio redirects to. */
  callbackUrl: z.url({ protocol: /^https?$/ }).max(2000),
  /** CONNECTIONS_SHOPIFY_AUTH_CONFIG_ID and its kin: toolkit to Composio auth config ID. */
  authConfigIds: z.record(z.string().regex(/^[a-z0-9_-]{1,40}$/), z.string().min(1).max(128)),
  /** C-9: a pass runs at most this long (inside the function's 30 s) and makes at most `passMaxCalls` Composio calls. */
  passMs: z.number().int().positive().max(25 * SECOND).default(20 * SECOND),
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
  | { readonly kind: "account_mismatch"; readonly tenantId: string; readonly connectionId?: string; readonly attemptId?: string }
  | { readonly kind: "swept"; readonly tenantId: string; readonly attemptId: string }
  | { readonly kind: "sweep_failed"; readonly tenantId: string; readonly attemptId: string; readonly code: string }
  /** No row records the account: its ID is how an operator finds and removes it. */
  | { readonly kind: "link_orphan"; readonly tenantId: string; readonly attemptId: string; readonly composioAccountId: string }
  | { readonly kind: "health_failed"; readonly tenantId: string; readonly connectionId: string; readonly code: string }
  | { readonly kind: "pass_stopped"; readonly why: "time" | "calls" | "budget" }
  | { readonly kind: "cooldown"; readonly env: string }
  | { readonly kind: "key_refused"; readonly env: string; readonly status: number }
  /** A database call the worker cannot recover from; the SQLSTATE only (`unknown` when the error has none), never the message. */
  | { readonly kind: "database_error"; readonly op: "budget"; readonly code: string };

/** Attempt codes that mean the account was left alone, not removed. */
const UNREMOVED_CODES: ReadonlySet<string> = new Set(["account_mismatch", "account_unverified"]);

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

/** What the cancel operation answers (C-5). */
export type ConnectorCancelOutcome =
  | { readonly outcome: "cancelled"; readonly revokeFailed: boolean }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "refused"; readonly code: "account_mismatch" | "provider_rate_limited" | "in_progress"; readonly retryAfterSeconds?: number };

type RevokeOutcome = "revoked" | "failed" | null;
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
  revoke_outcome: RevokeOutcome;
  claimed_until: Date | null;
}
const CONNECTION_FIELDS = ["tenant_id", "id", "toolkit", "composio_account_id", "external_account_id", "account_domain", "status", "reauthorize_reason",
  "last_error_code", "revoke_outcome", "claimed_until"] as const;
interface AttemptRow {
  tenant_id: string;
  id: string;
  connection_id: string;
  toolkit: string;
  composio_account_id: string;
  auth_config_id: string;
  account_domain: string;
  status: "started" | "verified" | "confirmed" | "cancelling" | "cancelled" | "swept";
  session_presented_at: Date | null;
  external_account_id: string | null;
  last_error_code: string | null;
  revoke_outcome: RevokeOutcome;
  claimed_until: Date | null;
  expires_at: Date;
}
const ATTEMPT_FIELDS = ["tenant_id", "id", "connection_id", "toolkit", "composio_account_id", "auth_config_id", "account_domain", "status",
  "session_presented_at", "external_account_id", "last_error_code", "revoke_outcome", "claimed_until", "expires_at"] as const;
const columns = (fields: readonly string[], alias?: string) => fields.map((field) => (alias ? `${alias}.${field}` : field)).join(", ");
const CONNECTION_COLUMNS = columns(CONNECTION_FIELDS);
const ATTEMPT_COLUMNS = columns(ATTEMPT_FIELDS);
type LeaseTable = "connections" | "connection_attempts";

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
/** What removing one account came to: a 404 counts as removed (C-9, C-13). */
type Removal =
  | { readonly outcome: "removed"; readonly revokeFailed: boolean }
  | { readonly outcome: "foreign" }
  | { readonly outcome: "unverified" }
  | { readonly outcome: "failed"; readonly rateLimited: boolean };

/** C-3: `zsb:<env>:<tenantId>`, built only here, from the worker's own environment. */
export const composioUserId = (env: ConnectorEnv, tenantId: string): string => `zsb:${env}:${tenantId.toLowerCase()}`;

const COOLDOWN_SECONDS = 60;
/** Codes a later successful read clears; a recorded revoke or mismatch stays (C-8). */
const TRANSIENT_CODES = ["provider_unavailable", "provider_rate_limited", "not_configured"] as const;

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
    let row;
    try {
      row = (await service((tx) => tx.query<{ wait: string }>(
        "SELECT public.connections_org_budget($1, $2, $3)::text AS wait", [now(), config.env, op]))).rows[0];
    } catch (error) {
      // A refused login or a missing function would otherwise look like a provider outage and leave no trace.
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      report({ kind: "database_error", op: "budget", code: typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "unknown" });
      throw error;
    }
    return Number(row?.wait ?? 0);
  }
  /** C-12: a provider or Composio rate limit opens the organization cooldown, and an operator hears of it. */
  async function cooldown(): Promise<void> {
    await budget("cool").catch(() => undefined);
    report({ kind: "cooldown", env: config.env });
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
      if (error instanceof ComposioError && error.kind === "rate_limited") await cooldown();
      // A-5: our own key or project was refused. Nothing about the store; an operator must look.
      if (error instanceof ComposioError && error.kind === "key_refused") report({ kind: "key_refused", env: config.env, status: error.status ?? 0 });
      throw error;
    }
  }
  const isRateLimit = (error: unknown) => error instanceof BudgetRefused || (error instanceof ComposioError && error.kind === "rate_limited");
  const retryAfterOf = (error: unknown) => (error instanceof BudgetRefused ? error.retryAfterSeconds : COOLDOWN_SECONDS);

  const accountMatches = (account: ComposioAccount | null, expected: { id: string; tenantId: string; toolkit: string; authConfigId: string }): account is ComposioAccount =>
    account !== null && account.id === expected.id && account.userId === userIdOf(expected.tenantId)
      && account.toolkit === expected.toolkit && account.authConfigId === expected.authConfigId;

  const loadAttempt = (tx: Transaction, tenantId: string, attemptId: string, lock = false) =>
    tx.query<AttemptRow>(`SELECT ${ATTEMPT_COLUMNS} FROM connection_attempts WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, attemptId]).then((r) => r.rows[0] ?? null);
  const loadConnection = (tx: Transaction, tenantId: string, id: string) =>
    tx.query<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM connections WHERE tenant_id=$1 AND id=$2`, [tenantId, id]).then((r) => r.rows[0] ?? null);

  /**
   * An attempt whose account a connection row owns ends without touching the account: `confirmed` when it
   * was verified, else `swept` (a `confirmed` attempt always names the store it verified, C-7).
   */
  const OWNED_END = "status = (CASE WHEN external_account_id IS NULL THEN 'swept' ELSE 'confirmed' END)::connection_attempt_status";
  const ownedByConnection = async (tx: Transaction, attempt: AttemptRow) => ((await tx.query(
    "SELECT 1 FROM connections WHERE (tenant_id=$1 AND id=$2) OR composio_account_id=$3 LIMIT 1",
    [attempt.tenant_id, attempt.connection_id, attempt.composio_account_id])).rowCount ?? 0) > 0;

  // ---- leases ------------------------------------------------------------------------------
  /**
   * C-9: takes the oldest free row `where` finds (not in `skip`) and leases it for LEASE_MS in one short
   * statement. Parameters: $1 the lease end, $2 now, $3 the skip list, then `params` from $4.
   */
  async function lease<Row extends { id: string }>(table: LeaseTable, fields: readonly string[], where: string, order: string, params: readonly unknown[], skip: readonly string[] = []): Promise<Row | null> {
    const until = new Date(now().getTime() + LEASE_MS);
    const row = (await service((tx) => tx.query<Row>(
      `UPDATE ${table} t SET claimed_until=$1
        FROM (SELECT tenant_id, id FROM ${table}
               WHERE (${where}) AND (claimed_until IS NULL OR claimed_until <= $2) AND id <> ALL($3::uuid[])
               ORDER BY ${order} LIMIT 1 FOR UPDATE SKIP LOCKED) c
       WHERE t.tenant_id=c.tenant_id AND t.id=c.id
       RETURNING ${columns(fields, "t")}`,
      [until, now(), [...skip], ...params]))).rows[0];
    return row ?? null;
  }
  /** Gives a lease back, unless it already lapsed and another worker holds a new one. */
  const release = (table: LeaseTable, row: { tenant_id: string; id: string; claimed_until: Date | null }) => row.claimed_until === null ? Promise.resolve() :
    service((tx) => tx.query(`UPDATE ${table} SET claimed_until=NULL WHERE tenant_id=$1 AND id=$2 AND claimed_until=$3`, [row.tenant_id, row.id, row.claimed_until])).then(() => undefined);

  // ---- removing an account -----------------------------------------------------------------
  /**
   * C-3, C-9, C-13: reads the account and, only when it is this tenant's (user, toolkit and auth config,
   * all required: A-2 fails closed), uninstalls the app on the provider's side once (the catalog's fixed request
   * through Composio's proxy; `recordRevoke` stores the outcome at once, so a retry never repeats a success or
   * loses a failure) and deletes the account. A 404 at any step counts as done. Only a clean provider answer is
   * `revoked`: anything else, a toolkit with no uninstall request included, is `failed`, and the delete still runs.
   * Budget and pass limits propagate; nothing else does.
   */
  async function removeAccount(
    target: { accountId: string; tenantId: string; toolkit: string; authConfigId: string; revoke: RevokeOutcome },
    recordRevoke: (outcome: "revoked" | "failed") => Promise<void>,
    pass: PassContext | undefined,
    signal?: AbortSignal,
  ): Promise<Removal> {
    let revoke = target.revoke;
    try {
      const account = await spend(pass, () => composio.getAccount(target.accountId, signal));
      if (account === null) return { outcome: "removed", revokeFailed: revoke === "failed" };
      if (account.userId === null) return { outcome: "unverified" };
      if (account.id !== target.accountId || account.userId !== userIdOf(target.tenantId) || account.toolkit !== target.toolkit
        || account.authConfigId !== target.authConfigId) return { outcome: "foreign" };
      if (revoke === null) {
        try {
          const uninstall = catalogToolkit(target.toolkit)?.uninstall;
          if (uninstall === undefined) revoke = "failed";
          else {
            const answer = await spend(pass, () => composio.proxy({ connectedAccountId: target.accountId, userId: userIdOf(target.tenantId), request: uninstall.request }, signal));
            revoke = uninstall.confirms(answer) ? "revoked" : "failed";
          }
        } catch (error) {
          if (!(error instanceof ComposioError)) throw error;
          // An account already gone has nothing left to revoke.
          revoke = error.kind === "not_found" ? "revoked" : "failed";
        }
        await recordRevoke(revoke);
      }
      await spend(pass, () => composio.deleteAccount(target.accountId, signal));
      return { outcome: "removed", revokeFailed: revoke === "failed" };
    } catch (error) {
      if (error instanceof ComposioError) return { outcome: "failed", rateLimited: error.kind === "rate_limited" };
      throw error;
    }
  }
  const recordAttemptRevoke = (attempt: AttemptRow) => async (outcome: "revoked" | "failed") => {
    await service((tx) => tx.query("UPDATE connection_attempts SET revoke_outcome=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND revoke_outcome IS NULL",
      [attempt.tenant_id, attempt.id, outcome, now()]));
  };
  const removeAttemptAccount = (attempt: AttemptRow, pass: PassContext | undefined, signal?: AbortSignal) => removeAccount(
    { accountId: attempt.composio_account_id, tenantId: attempt.tenant_id, toolkit: attempt.toolkit, authConfigId: attempt.auth_config_id, revoke: attempt.revoke_outcome },
    recordAttemptRevoke(attempt), pass, signal);

  // ---- link --------------------------------------------------------------------------------
  async function link(input: { tenantId: string; toolkit: string; attemptId: string; connectionId: string; shopDomain: string; createdBy: string; browserHash: string }, signal?: AbortSignal): Promise<ConnectorLinkResponse> {
    const toolkit = catalogToolkit(input.toolkit);
    const authConfigId = config.authConfigIds[input.toolkit];
    if (!toolkit || !authConfigId) return { outcome: "refused", code: "not_found" };
    const started = now();
    const expiresAt = new Date(started.getTime() + config.attemptLifetimeMs);
    const row = (accountId: string, status: "started" | "cancelling") => service((tx) => tx.query(
      `INSERT INTO connection_attempts (tenant_id, id, connection_id, toolkit, composio_account_id, auth_config_id, account_domain, created_by,
         browser_hash, status, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12)`,
      [input.tenantId, input.attemptId, input.connectionId, input.toolkit, accountId, authConfigId, input.shopDomain, input.createdBy,
        input.browserHash, status, expiresAt, started]));
    /**
     * B-7: an account no attempt row records is one the sweep can never find, so it is removed now. If
     * that fails, a `cancelling` attempt row records it for the sweep; if even that fails, an operator
     * hears of it.
     */
    const compensate = async (accountId: string) => {
      const named = await service((tx) => tx.query(
        "SELECT 1 FROM connection_attempts WHERE composio_account_id=$1 UNION ALL SELECT 1 FROM connections WHERE composio_account_id=$1 LIMIT 1", [accountId]));
      if (named.rowCount) return; // another attempt or connection owns it: never ours to remove
      const removal = await removeAccount({ accountId, tenantId: input.tenantId, toolkit: input.toolkit, authConfigId, revoke: null }, async () => undefined, undefined, signal)
        .catch(() => ({ outcome: "failed" as const }));
      if (removal.outcome === "removed") return;
      try {
        await row(accountId, "cancelling");
      } catch {
        report({ kind: "link_orphan", tenantId: input.tenantId, attemptId: input.attemptId, composioAccountId: accountId });
      }
    };
    let made;
    try {
      made = await spend(undefined, () => composio.link({
        authConfigId, userId: userIdOf(input.tenantId), callbackUrl: config.callbackUrl,
      }, signal));
    } catch (error) {
      if (error instanceof ComposioError && error.accountId !== undefined) await compensate(error.accountId);
      return isRateLimit(error)
        ? { outcome: "refused", code: "provider_rate_limited", retryAfterSeconds: retryAfterOf(error) }
        : { outcome: "refused", code: "provider_unavailable" };
    }
    try {
      await row(made.connectedAccountId, "started");
    } catch {
      await compensate(made.connectedAccountId);
      return { outcome: "refused", code: "provider_unavailable" };
    }
    return { outcome: "linked", redirectUrl: made.redirectUrl, composioAccountId: made.connectedAccountId, authConfigId, expiresAt: expiresAt.toISOString() };
  }

  // ---- complete ----------------------------------------------------------------------------
  async function complete(input: { tenantId: string; attemptId: string; sessionUri: string | null }, signal?: AbortSignal): Promise<ConnectorCompleteResponse> {
    type Refused = Extract<ConnectorCompleteResponse, { outcome: "refused" }>;
    const refused = (reason: Refused["reason"]): Refused => ({ outcome: "refused", reason });
    // A-3, A-4: the attempt is locked while it is checked, and a callback that carries a session marks
    // the attempt before the redemption. A status call (no session) for an attempt no callback reached
    // is refused: a consent in another browser can never be picked up by polling.
    // Whether an earlier callback had presented a session: only then can a "used" answer be our own lost call.
    let presentedBefore = false;
    let lease: Date | null = null;
    const gate = await service(async (tx): Promise<AttemptRow | Refused> => {
      const attempt = await loadAttempt(tx, input.tenantId, input.attemptId, true);
      if (!attempt || attempt.status === "cancelling" || attempt.status === "cancelled" || attempt.status === "swept") return refused("invalid_attempt");
      if (attempt.status === "confirmed") return refused("conflict");
      if (attempt.expires_at.getTime() <= now().getTime()) return refused("expired");
      if (attempt.status === "started") {
        presentedBefore = attempt.session_presented_at !== null;
        if (attempt.claimed_until !== null && attempt.claimed_until.getTime() > now().getTime()) return refused("rate_limited");
        if (input.sessionUri !== null) {
          lease = new Date(now().getTime() + REDEMPTION_LEASE_MS);
          await tx.query("UPDATE connection_attempts SET session_presented_at=coalesce(session_presented_at, $3), claimed_until=$4, updated_at=$3 WHERE tenant_id=$1 AND id=$2",
            [input.tenantId, input.attemptId, now(), lease]);
        } else if (attempt.session_presented_at === null) {
          return refused("not_connected");
        }
      }
      return attempt;
    });
    if ("outcome" in gate) return gate;
    const attempt = gate;
    const toolkit = catalogToolkit(attempt.toolkit);
    if (!toolkit) return refused("not_connected");
    const userId = userIdOf(input.tenantId);
    /**
     * A-4: a redemption that failed for good ends what the session marker allowed: the marker goes, so no
     * status call can pick up an account this browser never redeemed. Only a `started` attempt holds one.
     */
    const clearMarker = () => service((tx) => tx.query(
      "UPDATE connection_attempts SET session_presented_at=NULL, updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='started'",
      [input.tenantId, input.attemptId, now()]));
    const definitive = async (reason: Refused["reason"] = "not_connected"): Promise<Refused> => {
      await clearMarker();
      return refused(reason);
    };
    try {
      // Only a `started` attempt redeems; a `verified` one (a reload) goes to the account check.
      if (input.sessionUri !== null && attempt.status === "started") {
        const sessionUri = input.sessionUri;
        try {
          try {
            const redeemed = await spend(undefined, () => composio.completeAuth({ sessionUri, userId }, signal));
            // Another account than the attempt's never connects (C-5).
            // The callback names no account, so this answer is what ties the session to the attempt: its account and
            // toolkit must be the attempt's (the account read below checks the user and auth config).
            if (redeemed.connectedAccountId !== attempt.composio_account_id) {
              // A session of the tenant's other, newer or older attempt (two tabs): that attempt's browser keeps its
              // cookie and this link ends as `attempt_changed` (C-4). Any other account is not ours to name.
              const sibling = await service((tx) => tx.query(
                "SELECT 1 FROM connection_attempts WHERE tenant_id=$1 AND composio_account_id=$2 AND id<>$3", [input.tenantId, redeemed.connectedAccountId, input.attemptId]));
              return await definitive(sibling.rowCount === 1 ? "attempt_changed" : "not_connected");
            }
            if (redeemed.toolkit !== null && redeemed.toolkit.toLowerCase() !== attempt.toolkit) return await definitive();
          } catch (error) {
            // 400: Composio checked `user_id` and it is not the session's.
            if (error instanceof ComposioError && error.kind === "bad_request") return await definitive();
            // 404: the session is unknown or used. It can be our own earlier call, whose answer was lost, only
            // when an earlier callback presented a session; then the account read below decides (C-5). On the
            // first presentation it is a session nobody redeemed for us: final.
            if (error instanceof ComposioError && error.kind === "not_found") {
              if (!presentedBefore) return await definitive();
            } else {
              // Our budget, or an HTTP answer that redeemed nothing (429, or our key refused): no call of ours can be
              // "lost", so the marker goes. Only a call with no answer (network, timeout, 5xx) may have redeemed.
              if (error instanceof BudgetRefused || (error instanceof ComposioError && (error.kind === "rate_limited" || error.kind === "key_refused"))) await clearMarker();
              throw error;
            }
          }
        } finally {
          // The redemption has an outcome (or failed): the lease ends, whatever the outcome was.
          if (lease !== null) await service((tx) => tx.query(
            "UPDATE connection_attempts SET claimed_until=NULL WHERE tenant_id=$1 AND id=$2 AND claimed_until=$3", [input.tenantId, input.attemptId, lease]));
        }
      }
      const account = await spend(undefined, () => composio.getAccount(attempt.composio_account_id, signal));
      if (!accountMatches(account, { id: attempt.composio_account_id, tenantId: input.tenantId, toolkit: attempt.toolkit, authConfigId: attempt.auth_config_id }))
        return refused("not_connected");
      const decision = completeDecision(account.status);
      if (decision === "pending") return { outcome: "pending" };
      if (decision === "refuse") return refused("not_connected");
      const identity = await spend(undefined, () => composio.execute({
        slug: toolkit.identity.slug, version: toolkit.identity.version, userId, connectedAccountId: attempt.composio_account_id, arguments: { ...toolkit.identity.arguments },
      }, signal));
      if (identity.kind !== "ok") {
        if (identity.reason === "rate_limited") {
          await cooldown();
          return refused("rate_limited");
        }
        return refused(identity.reason === "auth" || identity.reason === "forbidden" ? "not_connected" : "provider_unavailable");
      }
      const shop = toolkit.identity.project(identity.data);
      if (!shop) return refused("provider_unavailable");
      // The store that consented must be the one the member named (C-14).
      if (shop.domain !== attempt.account_domain) return refused("not_connected");
      const label = normalizeAccountLabel(shop.name) ?? attempt.account_domain;
      // A cancel that took the lock meanwhile wins: nothing moves, and the answer says so.
      const moved = await service((tx) => tx.query(
        `UPDATE connection_attempts SET status='verified', external_account_id=$4, updated_at=$3
          WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified') AND (external_account_id IS NULL OR external_account_id=$4)`,
        [input.tenantId, input.attemptId, now(), shop.externalAccountId]));
      if (moved.rowCount !== 1) return refused("invalid_attempt");
      return { outcome: "verified", composioAccountId: attempt.composio_account_id, externalAccountId: shop.externalAccountId, accountDomain: shop.domain, accountLabel: label };
    } catch (error) {
      if (error instanceof BudgetRefused || error instanceof ComposioError) return refused(isRateLimit(error) ? "rate_limited" : "provider_unavailable");
      throw error;
    }
  }

  // ---- cancel ------------------------------------------------------------------------------
  /**
   * C-5: under the attempt's lock, a cancel first makes the attempt `cancelling` (so no confirm can take
   * it from then on) and leases it; then it removes the account. A confirm that took the lock first wins.
   */
  async function cancel(input: { tenantId: string; attemptId: string }, signal?: AbortSignal): Promise<ConnectorCancelOutcome> {
    type Gate = { kind: "answer"; answer: ConnectorCancelOutcome } | { kind: "work"; attempt: AttemptRow };
    const gate = await service(async (tx): Promise<Gate> => {
      const attempt = await loadAttempt(tx, input.tenantId, input.attemptId, true);
      if (!attempt || attempt.status === "confirmed") return { kind: "answer", answer: { outcome: "not_found" } };
      // A connection row that has the attempt's connection ID or account owns the account: never removed.
      if (attempt.status !== "cancelled" && attempt.status !== "swept" && (await ownedByConnection(tx, attempt))) {
        await tx.query(`UPDATE connection_attempts SET ${OWNED_END}, updated_at=$3 WHERE tenant_id=$1 AND id=$2`, [attempt.tenant_id, attempt.id, now()]);
        return { kind: "answer", answer: { outcome: "not_found" } };
      }
      // An attempt that ended without removing its account (foreign, or never verified) may leave the app
      // installed, so a repeat never reads as a clean success.
      const revokeFailed = attempt.revoke_outcome === "failed" || UNREMOVED_CODES.has(attempt.last_error_code ?? "");
      if (attempt.status === "cancelled" || attempt.status === "swept") return { kind: "answer", answer: { outcome: "cancelled", revokeFailed } };
      const leased = attempt.claimed_until !== null && attempt.claimed_until.getTime() > now().getTime();
      const until = new Date(now().getTime() + LEASE_MS);
      await tx.query(
        `UPDATE connection_attempts SET status='cancelling', updated_at=$3${leased ? "" : ", claimed_until=$4"}
          WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified','cancelling')`,
        [input.tenantId, input.attemptId, now(), ...(leased ? [] : [until])]);
      // B-10: another cancel or the sweep is removing the account. The attempt can no longer connect, but
      // the removal's outcome is not known yet: the caller asks again once that lease has run out at most.
      if (leased) {
        const retryAfterSeconds = Math.max(1, Math.ceil((attempt.claimed_until!.getTime() - now().getTime()) / 1000));
        return { kind: "answer", answer: { outcome: "refused", code: "in_progress", retryAfterSeconds } };
      }
      return { kind: "work", attempt: { ...attempt, status: "cancelling", claimed_until: until } };
    });
    if (gate.kind === "answer") return gate.answer;
    const attempt = gate.attempt;
    try {
      let removal: Removal;
      try {
        removal = await removeAttemptAccount(attempt, undefined, signal);
      } catch (error) {
        if (isRateLimit(error)) return { outcome: "refused", code: "provider_rate_limited", retryAfterSeconds: retryAfterOf(error) };
        throw error;
      }
      const finish = (code: string | null) => service((tx) => tx.query(
        `UPDATE connection_attempts SET status='cancelled', last_error_code=coalesce($4, last_error_code), claimed_until=NULL, updated_at=$3
          WHERE tenant_id=$1 AND id=$2 AND status='cancelling'`, [attempt.tenant_id, attempt.id, now(), code]));
      switch (removal.outcome) {
        case "removed":
          await finish(null);
          return { outcome: "cancelled", revokeFailed: removal.revokeFailed };
        case "foreign":
          // Never ours to remove: the attempt ends, an operator hears of it, and the owner is told.
          await finish("account_mismatch");
          report({ kind: "account_mismatch", tenantId: attempt.tenant_id, attemptId: attempt.id });
          return { outcome: "refused", code: "account_mismatch" };
        case "unverified":
          // The read named no user: nothing was removed, so the owner is told to check Shopify admin; the
          // attempt stays cancelling (it can no longer connect) and the sweep retries it (C-9).
          return { outcome: "cancelled", revokeFailed: true };
        case "failed":
          // A rate-limited read or delete is a 429 the member may retry; the attempt stays cancelling, so it can no
          // longer connect and the sweep finishes it if nobody does.
          if (removal.rateLimited) return { outcome: "refused", code: "provider_rate_limited", retryAfterSeconds: COOLDOWN_SECONDS };
          await service((tx) => tx.query("UPDATE connection_attempts SET last_error_code='delete_failed', updated_at=$3 WHERE tenant_id=$1 AND id=$2",
            [attempt.tenant_id, attempt.id, now()]));
          throw new ComposioError("unavailable");
      }
    } finally {
      await release("connection_attempts", attempt);
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
        // C-8, C-10: the credential works but the store's app permissions block this read (Shopify's protected
        // customer data gate). The row stays `active`: reconnecting cannot fix it. The owner sees why (`readBlocked`).
        if (outcome.reason === "forbidden") {
          await service((tx) => tx.query(
            `UPDATE connections SET last_error_code='provider_permission_denied', updated_at=$3
              WHERE tenant_id=$1 AND id=$2 AND status='active' AND composio_account_id=$4`, [input.tenantId, row.id, now(), row.composio_account_id]));
          return fail("provider_permission_denied");
        }
        if (outcome.reason === "rate_limited") {
          await cooldown();
          return fail("provider_rate_limited", COOLDOWN_SECONDS);
        }
        return fail("provider_unavailable");
      }
      // B-9: a disconnect (or a reconnect onto a new account) during the call wins: its data is dropped.
      const after = await service((tx) => loadConnection(tx, input.tenantId, input.connectionId));
      if (!after || after.composio_account_id !== row.composio_account_id || after.status === "disconnecting" || after.status === "disconnected") return fail("not_found");
      if (after.status !== "active") return fail("connection_needs_reconnect");
      // A read that works again ends the owner's "permissions block this" notice.
      if (after.last_error_code === "provider_permission_denied") await service((tx) => tx.query(
        `UPDATE connections SET last_error_code=NULL, updated_at=$3
          WHERE tenant_id=$1 AND id=$2 AND status='active' AND last_error_code='provider_permission_denied'`, [input.tenantId, row.id, now()]));
      const projected = tool.project(outcome.data);
      if (projected === undefined) return fail("provider_unavailable");
      const trimmed = trimToSize(projected, tool.listPath, CONNECTION_RESULT_MAX_BYTES);
      if (!trimmed) return fail("provider_unavailable");
      report({ kind: "run", tenantId: input.tenantId, connectionId: input.connectionId, tool: input.tool, code: "ok", ms: now().getTime() - started });
      return { outcome: "ok", data: trimmed.data, truncated: trimmed.truncated };
    } catch (error) {
      if (isRateLimit(error)) return fail("provider_rate_limited", retryAfterOf(error));
      if (error instanceof ComposioError) return fail("provider_unavailable");
      throw error;
    }
  }

  /**
   * C-8: an `active` row moves; an auth failure also upgrades a `reauthorize`/`provider_status` row, since
   * a credential that failed outranks a status read. A row ending keeps its state.
   */
  async function markReauthorize(tenantId: string, id: string, reason: "provider_status" | "auth_error"): Promise<void> {
    const moved = await service((tx) => tx.query(
      `UPDATE connections SET status='reauthorize', reauthorize_reason=$3::connection_reauthorize_reason, last_checked_at=$4, updated_at=$4
        WHERE tenant_id=$1 AND id=$2
          AND (status='active' OR ($3::text='auth_error' AND status='reauthorize' AND reauthorize_reason='provider_status'))`, [tenantId, id, reason, now()]));
    if (moved.rowCount === 1) report({ kind: "reauthorize", tenantId, connectionId: id, reason });
  }

  // ---- disconnect --------------------------------------------------------------------------
  /**
   * C-13, on a leased `disconnecting` row: the shared removal (ownership check, one recorded revoke, the
   * delete), then `disconnected` with the label cleared. A failed delete leaves the row `disconnecting`
   * for the pass; an account that is not this tenant's is never touched: the row ends with
   * `account_mismatch` and an operator hears of it.
   */
  async function finishDisconnect(row: ConnectionRow, pass: PassContext | undefined, signal?: AbortSignal): Promise<"disconnected" | "pending"> {
    const authConfigId = config.authConfigIds[row.toolkit];
    if (!authConfigId) {
      // A-2: without the auth config the account cannot be proved ours, so nothing is revoked or deleted;
      // the row stays disconnecting until the config is back, and an operator hears of it.
      const code = "not_configured";
      await service((tx) => tx.query("UPDATE connections SET last_error_code=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='disconnecting'",
        [row.tenant_id, row.id, code, now()]));
      report({ kind: "disconnect_retry", tenantId: row.tenant_id, connectionId: row.id, code });
      return "pending";
    }
    const removal = await removeAccount(
      { accountId: row.composio_account_id, tenantId: row.tenant_id, toolkit: row.toolkit, authConfigId, revoke: row.revoke_outcome },
      (outcome) => service((tx) => tx.query(
        "UPDATE connections SET revoke_outcome=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='disconnecting' AND revoke_outcome IS NULL",
        [row.tenant_id, row.id, outcome, now()])).then(() => undefined),
      pass, signal);
    if (removal.outcome === "failed") {
      const code = "delete_failed";
      await service((tx) => tx.query("UPDATE connections SET last_error_code=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='disconnecting'",
        [row.tenant_id, row.id, code, now()]));
      report({ kind: "disconnect_retry", tenantId: row.tenant_id, connectionId: row.id, code });
      return "pending";
    }
    const mismatch = removal.outcome !== "removed";
    const revokeFailed = removal.outcome === "removed" && removal.revokeFailed;
    if (mismatch) report({ kind: "account_mismatch", tenantId: row.tenant_id, connectionId: row.id });
    await service((tx) => tx.query(
      `UPDATE connections SET status='disconnected', account_label=NULL, last_error_code=$3, last_checked_at=$4, claimed_until=NULL, updated_at=$4
        WHERE tenant_id=$1 AND id=$2 AND status='disconnecting'`,
      [row.tenant_id, row.id, mismatch ? "account_mismatch" : revokeFailed ? "revoke_failed" : null, now()]));
    report({ kind: "disconnected", tenantId: row.tenant_id, connectionId: row.id, revokeFailed: revokeFailed || mismatch });
    return "disconnected";
  }

  async function disconnect(input: { tenantId: string; connectionId: string }, signal?: AbortSignal): Promise<{ outcome: "disconnected" | "pending" | "not_found" }> {
    const row = await service((tx) => loadConnection(tx, input.tenantId, input.connectionId));
    if (!row) return { outcome: "not_found" };
    if (row.status === "disconnected") return { outcome: "disconnected" };
    if (row.status !== "disconnecting") return { outcome: "not_found" };
    // A row another worker holds is being finished: this call answers `pending` and leaves it alone.
    const claimed = await lease<ConnectionRow>("connections", CONNECTION_FIELDS, "tenant_id=$4 AND id=$5 AND status='disconnecting'", "id",
      [input.tenantId, input.connectionId]);
    if (!claimed) return { outcome: "pending" };
    try {
      return { outcome: await finishDisconnect(claimed, undefined, signal) };
    } catch (error) {
      if (error instanceof BudgetRefused) return { outcome: "pending" };
      throw error;
    } finally {
      await release("connections", claimed);
    }
  }

  // ---- nonces ------------------------------------------------------------------------------
  /** C-3: records a request ID; false when it was already there. */
  const takeNonce = async (jti: string, expiresAt: Date): Promise<boolean> =>
    (await service((tx) => tx.query("INSERT INTO connector_request_nonces (jti, expires_at) VALUES ($1,$2) ON CONFLICT (jti) DO NOTHING", [jti, expiresAt]))).rowCount === 1;

  // ---- the pass ----------------------------------------------------------------------------
  /** Leases the next row (deadline first, B-4), runs `work` on it, gives the lease back. */
  async function each<Row extends { tenant_id: string; id: string; claimed_until: Date | null }>(
    ctx: PassContext, table: LeaseTable, fields: readonly string[], where: string, order: string, params: readonly unknown[], work: (row: Row) => Promise<void>,
  ): Promise<void> {
    const skip: string[] = [];
    for (;;) {
      if (now().getTime() >= ctx.deadline) throw new PassLimit("time");
      const row = await lease<Row>(table, fields, where, order, params, skip);
      if (!row) return;
      skip.push(row.id);
      try {
        await work(row);
      } finally {
        await release(table, row);
      }
    }
  }

  async function pass(signal?: AbortSignal): Promise<ConnectionsPassResult> {
    const start = now().getTime();
    const ctx: PassContext = { deadline: start + config.passMs, calls: 0, maxCalls: config.passMaxCalls };
    const result = { disconnected: 0, swept: 0, checked: 0 };
    let stopped: ConnectionsPassResult["stopped"] = null;
    try {
      // 1. disconnecting rows: finish them.
      await each<ConnectionRow>(ctx, "connections", CONNECTION_FIELDS, "status='disconnecting'", "updated_at, id", [], async (row) => {
        if ((await finishDisconnect(row, ctx, signal)) === "disconnected") result.disconnected += 1;
      });
      // 2. attempts past expiry plus the grace, and attempts left cancelling: remove their accounts.
      await each<AttemptRow>(ctx, "connection_attempts", ATTEMPT_FIELDS,
        "status='cancelling' OR (status IN ('started','verified') AND expires_at + ($4::bigint * interval '1 millisecond') <= $2)", "expires_at, id",
        [config.sweepGraceMs], async (attempt) => { if (await sweepAttempt(attempt, ctx, signal)) result.swept += 1; });
      // 3. live rows not checked for a day.
      await each<ConnectionRow>(ctx, "connections", CONNECTION_FIELDS, "status IN ('active','reauthorize') AND last_checked_at <= $4", "last_checked_at, id",
        [new Date(now().getTime() - config.healthIntervalMs)], async (row) => {
          await healthCheck(row, ctx, signal);
          result.checked += 1;
        });
    } catch (error) {
      if (!(error instanceof PassLimit)) throw error;
      stopped = error.why;
      report({ kind: "pass_stopped", why: error.why });
    }
    // 4. nonces past their expiry: one statement and no Composio call, so it runs even after a limit.
    await service((tx) => tx.query("DELETE FROM connector_request_nonces WHERE expires_at < $1", [now()]));
    return { ...result, composioCalls: ctx.calls, stopped };
  }

  /**
   * C-9: one attempt the sweep holds. The account is removed only when no connection row has the
   * attempt's connection ID and a fresh read shows it is the tenant's. A foreign account is left alone
   * and the attempt ends; one whose read names no user is retried for a day, then given up. True when
   * the attempt is done.
   */
  async function sweepAttempt(attempt: AttemptRow, ctx: PassContext, signal?: AbortSignal): Promise<boolean> {
    const end = (status: "swept" | "cancelled", code: string | null) => service((tx) => tx.query(
      `UPDATE connection_attempts SET status=$3, last_error_code=coalesce($5, last_error_code), claimed_until=NULL, updated_at=$4
        WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified','cancelling')`, [attempt.tenant_id, attempt.id, status, now(), code]));
    if (await service((tx) => ownedByConnection(tx, attempt))) {
      await service((tx) => tx.query(`UPDATE connection_attempts SET ${OWNED_END}, claimed_until=NULL, updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('started','verified','cancelling')`,
        [attempt.tenant_id, attempt.id, now()]));
      return false;
    }
    const done = attempt.status === "cancelling" ? "cancelled" : "swept";
    const removal = await removeAttemptAccount(attempt, ctx, signal);
    switch (removal.outcome) {
      case "removed":
        await end(done, null);
        report({ kind: "swept", tenantId: attempt.tenant_id, attemptId: attempt.id });
        return true;
      case "foreign":
        await end(done, "account_mismatch");
        report({ kind: "account_mismatch", tenantId: attempt.tenant_id, attemptId: attempt.id });
        return true;
      case "unverified": {
        const giveUp = attempt.expires_at.getTime() + config.sweepGraceMs + UNVERIFIED_GIVE_UP_MS;
        report({ kind: "sweep_failed", tenantId: attempt.tenant_id, attemptId: attempt.id, code: "account_unverified" });
        if (now().getTime() < giveUp) return false;
        await end(done, "account_unverified");
        return true;
      }
      case "failed":
        await service((tx) => tx.query("UPDATE connection_attempts SET last_error_code='delete_failed', updated_at=$3 WHERE tenant_id=$1 AND id=$2",
          [attempt.tenant_id, attempt.id, now()]));
        report({ kind: "sweep_failed", tenantId: attempt.tenant_id, attemptId: attempt.id, code: "delete_failed" });
        return false;
    }
  }

  /** C-8: reads the account of one leased live row and moves it only as the map allows. */
  async function healthCheck(row: ConnectionRow, ctx: PassContext, signal?: AbortSignal): Promise<void> {
    const at = () => now();
    const authConfigId = config.authConfigIds[row.toolkit];
    if (!authConfigId) {
      // B-2: a toolkit this worker has no auth config for is checked off, so it never starves the rest.
      await service((tx) => tx.query(
        "UPDATE connections SET last_checked_at=$3, last_error_code='not_configured', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('active','reauthorize')",
        [row.tenant_id, row.id, at()]));
      report({ kind: "health_failed", tenantId: row.tenant_id, connectionId: row.id, code: "not_configured" });
      return;
    }
    let account: ComposioAccount | null;
    try {
      account = await spend(ctx, () => composio.getAccount(row.composio_account_id, signal));
    } catch (error) {
      if (error instanceof PassLimit || !(error instanceof ComposioError)) throw error;
      // Unknown to us: leave the state as it is and try again next pass.
      const code = error.kind === "rate_limited" ? "provider_rate_limited" : "provider_unavailable";
      await service((tx) => tx.query("UPDATE connections SET last_error_code=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status IN ('active','reauthorize')",
        [row.tenant_id, row.id, code, at()]));
      report({ kind: "health_failed", tenantId: row.tenant_id, connectionId: row.id, code });
      return;
    }
    const healthy = accountMatches(account, { id: row.composio_account_id, tenantId: row.tenant_id, toolkit: row.toolkit, authConfigId })
      && liveDecision(account.status) === "active";
    // Every write below is conditional on the state it moves from, so a run's mark or a disconnect that
    // landed during the read is never undone.
    if (!healthy) {
      const moved = await service((tx) => tx.query(
        `UPDATE connections SET status='reauthorize', reauthorize_reason='provider_status', last_checked_at=$3, updated_at=$3
          WHERE tenant_id=$1 AND id=$2 AND status='active'`, [row.tenant_id, row.id, at()]));
      if (moved.rowCount === 1) report({ kind: "reauthorize", tenantId: row.tenant_id, connectionId: row.id, reason: "provider_status" });
      else await service((tx) => tx.query("UPDATE connections SET last_checked_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='reauthorize'",
        [row.tenant_id, row.id, at()]));
      return;
    }
    // Healthy: restore `active` only from `reauthorize` with `provider_status`, and only while this is the
    // tenant's one live row for the toolkit. An `auth_error` row returns only through Reconnect.
    const restored = await service((tx) => tx.query(
      `UPDATE connections SET status='active', reauthorize_reason=NULL, last_error_code=NULL, last_checked_at=$3, updated_at=$3
        WHERE tenant_id=$1 AND id=$2 AND status='reauthorize' AND reauthorize_reason='provider_status'
          AND NOT EXISTS (SELECT 1 FROM connections o WHERE o.tenant_id=$1 AND o.toolkit=$4 AND o.id<>$2 AND o.status IN ('active','reauthorize','disconnecting'))`,
      [row.tenant_id, row.id, at(), row.toolkit]));
    if (restored.rowCount === 1) {
      report({ kind: "restored", tenantId: row.tenant_id, connectionId: row.id });
      return;
    }
    // B-2: a read that succeeded clears only a transient code, and only on an active row; a row still
    // reauthorizing has not recovered, so it keeps its last code until it does.
    await service((tx) => tx.query(
      `UPDATE connections SET last_checked_at=$3, updated_at=$3,
          last_error_code = CASE WHEN status='active' AND last_error_code = ANY($4::text[]) THEN NULL ELSE last_error_code END
        WHERE tenant_id=$1 AND id=$2 AND status IN ('active','reauthorize')`, [row.tenant_id, row.id, at(), [...TRANSIENT_CODES]]));
  }

  return { link, complete, cancel, run, disconnect, pass, takeNonce, config };
}
export type ConnectionsWorker = ReturnType<typeof createConnectionsWorker>;
