// Connections C-4, C-5, C-10, C-13: the API-side edge. Three entry points:
//   - `createConnectionsSession`: the signed-in member's calls (connect, pending, confirm, cancel,
//     list, disconnect). Every one needs `integrations`.
//   - `createConnectionsCallback`: the anonymous OAuth callback and its status call. What it may do
//     comes from the signed attempt token alone, and it stages a grant; it never connects (G-2).
//   - `createConnectionsTools`: what a `connections:read` token's /mcp tools read and run (C-10).
// Every path is off (NotFound) when `deps.connections` is absent.
import {
  CONNECTION_CONNECT_ACTION,
  CONNECTION_DISCONNECT_ACTION,
  BindingMismatch,
  Conflict,
  IdempotencyConflict,
  NotFound,
  TenantDenied,
  confirmConnectionRequestSchema,
  connectConnectionRequestSchema,
  connectConnectionResponseSchema,
  connectionListSchema,
  connectionSchema,
  connectionToolkit,
  idempotencyKeySchema,
  pendingConnectionSchema,
  toolkitSchema,
  uuidSchema,
  type Connection,
  type ConnectionList,
  type ConnectionToolErrorCode,
  type ConnectErrorReason,
  type PendingConnection,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { derivedId } from "../edge/ids.js";
import { ConnectionsRefused } from "../edge/errors.js";
import { memberDispatch, parseInput, type EdgeDependencies, type Principal } from "../edge/session.js";
import { requireMember } from "../members/access.js";
import { catalogTool, catalogToolkit, OVERRIDE_KEYS } from "./catalog.js";
import { countTokensWithAccess, getConnection, listConnections, listLiveConnections } from "./handlers.js";
import { callbackCharges, callbackStatusCharges, connectCharges, runCharges, type ConnectionLimiter } from "./limits.js";
import { ConnectorUnavailable, type ConnectorPort } from "./port.js";
import {
  attemptBrowserMatches,
  CONNECT_ATTEMPT_LIFETIME_MS,
  CONNECT_GRANT_LIFETIME_MS,
  connectGrantId,
  connectIdempotencyKey,
  signConnectAttempt,
  signConnectGrant,
  verifyConnectAttempt,
  verifyConnectGrant,
  type ConnectGrant,
} from "./tokens.js";

/** C-5: the worker call inside the callback has 7 of the request's 10 seconds. */
export const CALLBACK_WORKER_BUDGET_MS = 7_000;

function config(deps: EdgeDependencies) {
  const connections = deps.connections;
  if (!connections) throw new NotFound();
  return connections;
}

const withDeadline = (signal: AbortSignal | undefined, ms = CALLBACK_WORKER_BUDGET_MS): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

async function charge(limiter: ConnectionLimiter, charges: Parameters<ConnectionLimiter["take"]>[0], signal?: AbortSignal): Promise<void> {
  const taken = await limiter.take(charges, signal ? { signal } : {});
  if (!taken.ok) throw new ConnectionsRefused("rate_limited", taken.retryAfterSeconds);
}

// ---- the member's calls ---------------------------------------------------------------------
export function createConnectionsSession(deps: EdgeDependencies, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  const run = memberDispatch(deps, { tenantId, actorId });
  const now = () => new Date(readClock(deps.clock));
  const read = <T>(work: (tx: Transaction) => Promise<T>) =>
    deps.db.tenant(tenantId, async (tx) => {
      await requireMember(tx, tenantId, actorId, "integrations");
      return work(tx);
    });
  /** A grant staged for this member; anything else reads as nothing staged. */
  const stagedGrant = (token: unknown): ConnectGrant & { readonly grantId: string } => {
    const grant = verifyConnectGrant(config(deps).stateSecrets, typeof token === "string" ? token : undefined, now());
    if (!grant || grant.tenantId !== tenantId.toLowerCase() || grant.actorId !== actorId.toLowerCase()) throw new NotFound("No connection waits for you");
    return { ...grant, grantId: connectGrantId(token as string) };
  };

  return {
    /** C-13: the live rows and the newest 20 disconnected ones; never a Composio or external ID. */
    async list(): Promise<ConnectionList> {
      config(deps);
      return parseInput(connectionListSchema, { items: await read((tx) => listConnections(tx, tenantId)) }, "result");
    },

    /** C-4: starts a connect. Changes no connection; records the worker's attempt and signs the token. */
    async start(toolkitParam: unknown, body: unknown, signal?: AbortSignal): Promise<{ readonly authorizeUrl: string; readonly attempt: string }> {
      const connections = config(deps);
      const toolkit = typeof toolkitParam === "string" && toolkitSchema.safeParse(toolkitParam).success ? toolkitParam : undefined;
      if (!toolkit || !catalogToolkit(toolkit)) throw new NotFound();
      const request = parseInput(connectConnectionRequestSchema, body);
      const live = await read((tx) => tx.query("SELECT 1 FROM connections WHERE tenant_id=$1 AND toolkit=$2 AND status IN ('active','reauthorize','disconnecting')", [tenantId, toolkit]));
      if (live.rowCount) throw new Conflict("This app is already connected", { reason: "already_connected" });
      await charge(connections.limiter, connectCharges(tenantId), signal);
      const attemptId = deps.generateId().toLowerCase();
      const connectionId = deps.generateId().toLowerCase();
      let linked;
      try {
        linked = await connections.connector.link({
          tenantId, toolkit, attemptId, connectionId, shopDomain: request.shopDomain, createdBy: actorId.toLowerCase(), browserHash: request.browserBinding,
        }, withDeadline(signal));
      } catch (error) {
        if (error instanceof ConnectorUnavailable) throw new ConnectionsRefused("unavailable");
        throw error;
      }
      if (linked.outcome === "refused") {
        if (linked.code === "not_found") throw new NotFound();
        throw new ConnectionsRefused(linked.code === "provider_rate_limited" ? "rate_limited" : "unavailable", linked.code === "provider_rate_limited" ? 60 : undefined);
      }
      const attempt = signConnectAttempt(connections.stateSecrets.current, {
        tenantId: tenantId.toLowerCase(), actorId: actorId.toLowerCase(), toolkit, attemptId, connectionId,
        composioAccountId: linked.composioAccountId, authConfigId: linked.authConfigId, browserHash: request.browserBinding,
        expiresAt: now().getTime() + CONNECT_ATTEMPT_LIFETIME_MS,
      });
      return { ...parseInput(connectConnectionResponseSchema, { authorizeUrl: linked.redirectUrl }, "result"), attempt };
    },

    /** C-5: the grant the callback staged for this member, with the number of tokens that will read the store. */
    async pending(grantToken: unknown): Promise<PendingConnection> {
      await read(async () => undefined);
      const grant = stagedGrant(grantToken);
      const tokensWithAccess = await read((tx) => countTokensWithAccess(tx, tenantId, now()));
      return parseInput(pendingConnectionSchema, {
        grantId: grant.grantId, toolkit: grant.toolkit, shopDomain: grant.accountDomain, accountLabel: grant.accountLabel,
        expiresAt: new Date(grant.expiresAt).toISOString(), tokensWithAccess,
      }, "result");
    },

    /**
     * C-5: connects the staged grant as the signed-in member, under `connect:<connectionId>`. A grant that
     * is not the one the owner was shown is 409 `grant_changed`; a repeat replays.
     */
    async confirm(grantToken: unknown, body: unknown): Promise<Connection> {
      await read(async () => undefined);
      const request = parseInput(confirmConnectionRequestSchema, body);
      const grant = stagedGrant(grantToken);
      if (request.grantId !== grant.grantId)
        throw new Conflict("Another store is waiting to be confirmed; check it again", { reason: "grant_changed" });
      const { connectionId } = grant;
      const settled = async (): Promise<Connection> => {
        const found = await read((tx) => getConnection(tx, tenantId, connectionId));
        if (found?.status === "active" && found.toolkit === grant.toolkit) return found;
        throw new Conflict("The connection changed since the store answered", { reason: "conflict" });
      };
      if (await read((tx) => getConnection(tx, tenantId, connectionId))) return settled();
      const idempotencyKey = connectIdempotencyKey(connectionId);
      try {
        await run({
          actionType: CONNECTION_CONNECT_ACTION,
          target: { tenantId, type: "connection", id: connectionId },
          approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
          idempotencyKey,
          payload: {
            connectionId, toolkit: grant.toolkit, composioAccountId: grant.composioAccountId, externalAccountId: grant.externalAccountId,
            accountDomain: grant.accountDomain, accountLabel: grant.accountLabel,
          },
        });
      } catch (error) {
        // Another confirmation for this connection committed first.
        if (error instanceof IdempotencyConflict || error instanceof BindingMismatch) return settled();
        throw error;
      }
      return settled();
    },

    /** C-5: asks the worker to delete the attempt's Composio account at once. */
    async cancel(attemptToken: unknown, signal?: AbortSignal): Promise<{ readonly cancelled: boolean }> {
      const connections = config(deps);
      await read(async () => undefined);
      const attempt = verifyConnectAttempt(connections.stateSecrets, typeof attemptToken === "string" ? attemptToken : undefined, now());
      if (!attempt || attempt.tenantId !== tenantId.toLowerCase() || attempt.actorId !== actorId.toLowerCase()) throw new NotFound();
      try {
        return { cancelled: (await connections.connector.cancel({ tenantId, attemptId: attempt.attemptId }, withDeadline(signal))).outcome === "cancelled" };
      } catch (error) {
        if (error instanceof ConnectorUnavailable) throw new ConnectionsRefused("unavailable");
        throw error;
      }
    },

    /**
     * C-13: `connection.disconnect` under the caller's key, then a best-effort ask of the worker to finish at
     * once; the pass finishes any it misses.
     */
    async disconnect(connectionId: unknown, key: unknown, signal?: AbortSignal): Promise<{ actionId: string; result: Connection }> {
      const connections = config(deps);
      const id = parseInput(uuidSchema, connectionId, "connection ID");
      const idempotencyKey = parseInput(idempotencyKeySchema, key, "Idempotency-Key");
      const outcome = await run({
        actionType: CONNECTION_DISCONNECT_ACTION,
        target: { tenantId, type: "connection", id },
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: { connectionId: id },
      });
      let result = parseInput(connectionSchema, outcome.result, "result");
      if (result.status === "disconnecting") {
        try {
          if ((await connections.connector.disconnect({ tenantId, connectionId: id }, withDeadline(signal))).outcome === "disconnected")
            result = (await read((tx) => getConnection(tx, tenantId, id))) ?? result;
        } catch {
          // The pass finishes it (C-9).
        }
      }
      return { actionId: outcome.actionId, result };
    },
  };
}

// ---- the anonymous callback -----------------------------------------------------------------
export interface ConnectionsCallbackInput {
  /** The attempt token the dashboard forwards from its cookie. */
  readonly attempt?: string | undefined;
  /** The browser key from the cookie of the browser that came back. */
  readonly browserKey?: string | undefined;
  /** Composio's `connected_account_id` query value. */
  readonly accountId?: string | undefined;
  /** Composio's `session_uri` query value; the status call sends none. */
  readonly sessionUri?: string | undefined;
}
export type ConnectionsCallbackOutcome =
  /** No valid attempt: nothing proves where the caller came from, so no redirect. */
  | { readonly kind: "invalid" }
  | { readonly kind: "connected" }
  | { readonly kind: "confirm"; readonly grant: string }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly reason: Exclude<ConnectErrorReason, "invalid_attempt"> };

export function createConnectionsCallback(deps: EdgeDependencies) {
  const now = () => new Date(readClock(deps.clock));
  async function handle(input: ConnectionsCallbackInput, status: boolean, signal?: AbortSignal): Promise<ConnectionsCallbackOutcome> {
    const connections = config(deps);
    const attempt = verifyConnectAttempt(connections.stateSecrets, input.attempt, now());
    if (!attempt) return { kind: "invalid" };
    const fail = (reason: Exclude<ConnectErrorReason, "invalid_attempt">): ConnectionsCallbackOutcome => ({ kind: "error", reason });
    // C-5, in this order, the first failure answers.
    if (!attemptBrowserMatches(attempt, input.browserKey)) return fail("browser_mismatch");
    if (!status && input.accountId !== attempt.composioAccountId) return fail("attempt_changed");
    try {
      await deps.db.tenant(attempt.tenantId, (tx) => requireMember(tx, attempt.tenantId, attempt.actorId, "integrations"));
    } catch (error) {
      if (error instanceof TenantDenied) return fail("forbidden");
      throw error;
    }
    const taken = await connections.limiter.take(status ? callbackStatusCharges(attempt.tenantId) : callbackCharges(attempt.tenantId), signal ? { signal } : {});
    if (!taken.ok) return fail("rate_limited");
    // A reload: `connected` only for an active row of the attempt's toolkit and account; any other row is a conflict.
    const existing = await deps.db.tenant(attempt.tenantId, async (tx) => (await tx.query<{ status: string; toolkit: string; composio_account_id: string }>(
      "SELECT status, toolkit, composio_account_id FROM connections WHERE tenant_id=$1 AND id=$2", [attempt.tenantId, attempt.connectionId])).rows[0]);
    if (existing)
      return existing.status === "active" && existing.toolkit === attempt.toolkit && existing.composio_account_id === attempt.composioAccountId
        ? { kind: "connected" } : fail("conflict");
    // Deferred verification is the pilot gate (C-17): a callback without `session_uri` connects nothing.
    if (!status && (input.sessionUri === undefined || input.sessionUri === "")) return fail("not_connected");
    let answer;
    try {
      answer = await connections.connector.complete({
        tenantId: attempt.tenantId, attemptId: attempt.attemptId, sessionUri: status ? null : input.sessionUri!,
      }, withDeadline(signal));
    } catch (error) {
      if (error instanceof ConnectorUnavailable) return fail("provider_unavailable");
      throw error;
    }
    if (answer.outcome === "pending") return { kind: "pending" };
    if (answer.outcome === "refused") return answer.reason === "invalid_attempt" ? { kind: "invalid" } : fail(answer.reason);
    // The worker's answer must be for the account the attempt names.
    if (answer.composioAccountId !== attempt.composioAccountId) return fail("not_connected");
    const grant = signConnectGrant(connections.stateSecrets.current, {
      tenantId: attempt.tenantId, actorId: attempt.actorId, toolkit: attempt.toolkit, attemptId: attempt.attemptId, connectionId: attempt.connectionId,
      composioAccountId: answer.composioAccountId, accountDomain: answer.accountDomain, externalAccountId: answer.externalAccountId,
      accountLabel: answer.accountLabel, expiresAt: now().getTime() + CONNECT_GRANT_LIFETIME_MS,
    });
    return grant === null ? fail("provider_unavailable") : { kind: "confirm", grant };
  }
  return {
    /** C-5: `GET /oauth/connections/callback`. */
    callback: (input: ConnectionsCallbackInput, signal?: AbortSignal) => handle(input, false, signal),
    /** C-5: the status call repeats the account read without the redemption. */
    status: (input: ConnectionsCallbackInput, signal?: AbortSignal) => handle(input, true, signal),
  };
}

// ---- the /mcp tools -------------------------------------------------------------------------
export type ConnectionRunResult =
  | { readonly ok: true; readonly data: unknown; readonly truncated: boolean }
  | { readonly ok: false; readonly error: { readonly code: ConnectionToolErrorCode; readonly retryAfterSeconds?: number } };

/** C-10: what a token's tenant can list and run. The caller has already checked the token and its scope. */
export function createConnectionsTools(deps: EdgeDependencies, tenantId: string) {
  const tenant = uuidSchema.parse(tenantId);
  const fail = (code: ConnectionToolErrorCode, retryAfterSeconds?: number): ConnectionRunResult =>
    ({ ok: false, error: { code, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) } });
  return {
    /** `list_connections`: the tenant's `active` and `reauthorize` connections, at most 20. */
    async list(): Promise<Connection[]> {
      config(deps);
      return deps.db.tenant(tenant, (tx) => listLiveConnections(tx, tenant, 20));
    },
    /** `list_connection_tools`: that connection's toolkit catalog; null when it is not the tenant's live connection. */
    async tools(connectionId: string): Promise<readonly { readonly name: string; readonly description: string; readonly inputSchema: unknown }[] | null> {
      config(deps);
      const found = await deps.db.tenant(tenant, async (tx) => getConnection(tx, tenant, connectionId));
      if (!found || (found.status !== "active" && found.status !== "reauthorize")) return null;
      return connectionToolkit(found.toolkit)?.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) ?? null;
    },
    /** `run_connection_tool`, in C-10's order after the token guard. */
    async run(input: { connectionId: string; tool: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<ConnectionRunResult> {
      const connections = config(deps);
      const found = await deps.db.tenant(tenant, async (tx) => getConnection(tx, tenant, input.connectionId));
      if (!found || (found.status !== "active" && found.status !== "reauthorize")) return fail("not_found");
      if (found.status === "reauthorize") return fail("connection_needs_reconnect");
      const tool = catalogTool(found.toolkit, input.tool);
      if (!tool) return fail("not_found");
      if (Object.keys(input.arguments).some((key) => OVERRIDE_KEYS.has(key)) || !tool.input.safeParse(input.arguments).success) return fail("invalid_arguments");
      const taken = await connections.limiter.take(runCharges(tenant), signal ? { signal } : {});
      if (!taken.ok) return fail("provider_rate_limited", taken.retryAfterSeconds);
      try {
        const answer = await connections.connector.run({ tenantId: tenant, connectionId: found.id, tool: tool.name, arguments: input.arguments }, withDeadline(signal));
        return answer.outcome === "ok" ? { ok: true, data: answer.data, truncated: answer.truncated } : fail(answer.code, answer.retryAfterSeconds);
      } catch (error) {
        if (error instanceof ConnectorUnavailable) return fail("provider_unavailable");
        throw error;
      }
    },
  };
}
