/**
 * The demo adapter's managed-tier connections (connections.md C-4, C-5, C-13). It keeps the rules the API
 * enforces: only owners (`integrations`) list, connect and disconnect; a shop domain must be a
 * `.myshopify.com` address; a toolkit has one live connection; and the owner confirms the account before anything
 * connects. There is no Shopify here: a connect stages a grant at once, as if the owner had approved the app
 * with a made-up store, and the answer sends the page straight back to the Connections page. The staged
 * grant stands in for the dashboard's grant cookie: one per adapter, as one per browser. The "worker" runs
 * on the next list once a short delay passed: it finishes a disconnect.
 */
import type { z } from "zod";
import { connectionToolkit, shopDomainSchema, toolkitSchema, type Connection, type PendingConnection } from "@zs/contracts";
import { demoError } from "../errors";
import type { ManagedConnectOutcome, ManagedConnectionsApi, WriteOptions } from "../types";
import type { DemoActor } from "./agents";

export interface DemoManagedConnectionsControls {
  /** Whether this server has connections settings; without them every call is a 404 (C-1). */
  setManagedConnectionsConfigured(configured: boolean): void;
  /** The provider stops honouring a connection: it needs the owner to reconnect (C-8). */
  loseManagedConnectionAccess(connectionId: string): void;
  /** The grant waiting for the owner's confirm runs out now, as if its ten minutes passed (C-5). */
  expireManagedPendingGrant(): void;
  /** The provider will refuse the next revoke, so a disconnect ends with `revokeFailed` (C-13). */
  setManagedRevokeFails(fails: boolean): void;
  /** How many access tokens the confirm screen says can read the store's orders (C-11). */
  setManagedTokensWithAccess(count: number): void;
}

export interface DemoManagedConnectionsContext {
  now(): Date;
  newId(): string;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>;
  actor(): DemoActor;
}

/** How long the demo worker takes to finish a disconnect. */
export const DEMO_CONNECTIONS_WORKER_MS = 1500;
/** The list keeps this many retired connections, the newest (C-13). */
export const DEMO_RETIRED_KEPT = 20;
/** How long a staged grant waits for the owner to confirm it. */
export const DEMO_MANAGED_GRANT_MS = 10 * 60_000;

interface StagedGrant {
  /** Stands in for the SHA-256 of the API's signed token: new for every staging. */
  grantId: string;
  toolkit: string;
  shopDomain: string;
  accountLabel: string;
  expiresAtMs: number;
  stagedBy: string;
}

const clone = <T>(value: T): T => structuredClone(value);

/** "halden-rowe.myshopify.com" is shown as "Halden Rowe". */
function labelOf(shopDomain: string): string {
  return shopDomain.slice(0, shopDomain.indexOf(".")).split("-").filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

/** The page's own origin, so the "provider" lands back on this dashboard. */
function pageOrigin(): string {
  const location = (globalThis as { location?: { origin?: string } }).location;
  return location?.origin && location.origin !== "null" ? location.origin : "http://127.0.0.1";
}

export function createDemoManagedConnections(ctx: DemoManagedConnectionsContext): ManagedConnectionsApi & DemoManagedConnectionsControls {
  const connections = new Map<string, Connection>();
  const changedAt = new Map<string, number>();
  let configured = true;
  let revokeFails = false;
  let tokensWithAccess = 0;
  let staged: StagedGrant | null = null;

  /** `integrations` (owners only); anything else is TenantDenied, a 403. */
  const requireOwner = () => {
    if (ctx.actor().role !== "owner") throw demoError("Forbidden");
  };
  /** Like the API without the settings: an unknown route. */
  const requireConfigured = () => {
    if (!configured) throw demoError("NotFound");
  };

  const touch = (connection: Connection, status: Connection["status"]) => {
    connection.status = status;
    changedAt.set(connection.id, ctx.now().getTime());
  };

  /** The worker's pass, run lazily: a disconnect whose delay passed finishes, and the label goes with it (C-7, C-13). */
  function runWorker() {
    const now = ctx.now().getTime();
    for (const connection of connections.values()) {
      if (connection.status !== "disconnecting" || now - (changedAt.get(connection.id) ?? now) < DEMO_CONNECTIONS_WORKER_MS) continue;
      touch(connection, "disconnected");
      connection.accountLabel = null;
      connection.revokeFailed = revokeFails;
    }
    // The list shows the newest retired rows only; older ones are history the owner no longer sees.
    const retired = [...connections.values()].filter((item) => item.status === "disconnected")
      .sort((a, b) => (changedAt.get(b.id) ?? 0) - (changedAt.get(a.id) ?? 0) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    for (const old of retired.slice(DEMO_RETIRED_KEPT)) {
      connections.delete(old.id);
      changedAt.delete(old.id);
    }
  }

  /** The toolkit's live connection, if any: one per toolkit (C-7). */
  const liveOf = (toolkit: string) => [...connections.values()].find((item) => item.toolkit === toolkit && item.status !== "disconnected");

  const stagedForActor = () => {
    if (staged && ctx.now().getTime() >= staged.expiresAtMs) staged = null;
    return staged && staged.stagedBy === ctx.actor().userId ? staged : null;
  };

  return {
    async listManagedConnections() {
      await ctx.wait();
      requireConfigured();
      requireOwner();
      runWorker();
      // The API's order: newest first, then by ID.
      return clone([...connections.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)));
    },

    async startManagedConnect(toolkit, shopDomain) {
      await ctx.wait();
      requireConfigured();
      requireOwner();
      const name = ctx.parse(toolkitSchema, toolkit);
      if (!connectionToolkit(name)) throw demoError("NotFound");
      const shop = ctx.parse(shopDomainSchema, shopDomain);
      runWorker();
      if (liveOf(name)) throw demoError("Conflict", { reason: "already_connected" });
      // What the callback does once the provider answers (C-5): it stages the grant for this browser,
      // replacing any older one, and connects nothing until the owner confirms the store.
      staged = {
        grantId: `g${ctx.newId().replaceAll("-", "")}`.padEnd(43, "0"), toolkit: name, shopDomain: shop, accountLabel: labelOf(shop),
        expiresAtMs: ctx.now().getTime() + DEMO_MANAGED_GRANT_MS, stagedBy: ctx.actor().userId,
      };
      return { authorizeUrl: `${pageOrigin()}/account/connections?connection=confirm` };
    },

    async getPendingManagedConnect() {
      await ctx.wait();
      requireConfigured();
      requireOwner();
      const grant = stagedForActor();
      if (!grant) return null;
      const pending: PendingConnection = {
        grantId: grant.grantId, toolkit: grant.toolkit, shopDomain: grant.shopDomain, accountLabel: grant.accountLabel,
        expiresAt: new Date(grant.expiresAtMs).toISOString(), tokensWithAccess,
      };
      return pending;
    },

    async confirmManagedConnect(grantId) {
      await ctx.wait();
      requireConfigured();
      const grant = stagedForActor();
      // Another grant replaced the one the owner was shown: refused, and the new one stays (C-5).
      if (grant && grant.grantId !== grantId) {
        requireOwner();
        throw demoError("Conflict", { reason: "grant_changed" });
      }
      // Like the dashboard's cookie, the grant is spent by any other answer the server gives.
      staged = null;
      requireOwner();
      if (!grant) throw demoError("NotFound");
      runWorker();
      if (liveOf(grant.toolkit)) throw demoError("Conflict", { reason: "already_connected" });
      const now = ctx.now().toISOString();
      const connection: Connection = {
        id: ctx.newId(), toolkit: grant.toolkit, accountLabel: grant.accountLabel, accountDomain: grant.shopDomain,
        status: "active", tier: "composio", reauthorizeReason: null, revokeFailed: false, readBlocked: false, lastCheckedAt: now, createdAt: now,
      };
      connections.set(connection.id, connection);
      changedAt.set(connection.id, ctx.now().getTime());
      return clone(connection);
    },

    async cancelManagedConnect() {
      await ctx.wait();
      const cancelled = staged !== null;
      staged = null;
      // Cancelling removes the provider account, which can fail to revoke like a disconnect (C-5).
      return { cancelled, revokeFailed: cancelled && revokeFails };
    },

    async checkManagedConnectStatus() {
      await ctx.wait();
      requireConfigured();
      // The demo's provider answers at once, so nothing is ever left pending.
      const outcome: ManagedConnectOutcome = stagedForActor() ? { connection: "confirm" } : { connection: "error", reason: "expired" };
      return outcome;
    },

    disconnectManagedConnection(connectionId, options) {
      return ctx.idempotent("connection.disconnect", { connectionId }, options, () => {
        requireConfigured();
        requireOwner();
        const connection = connections.get(connectionId);
        if (!connection) throw demoError("NotFound");
        // A retired connection answers as it is.
        if (connection.status === "active" || connection.status === "reauthorize") touch(connection, "disconnecting");
        return clone(connection);
      });
    },

    setManagedConnectionsConfigured(value) {
      configured = value;
    },

    loseManagedConnectionAccess(connectionId) {
      const connection = connections.get(connectionId);
      if (!connection || connection.status !== "active") return;
      touch(connection, "reauthorize");
      connection.reauthorizeReason = "auth_error";
    },

    expireManagedPendingGrant() {
      if (staged) staged.expiresAtMs = ctx.now().getTime();
    },

    setManagedRevokeFails(fails) {
      revokeFails = fails;
    },

    setManagedTokensWithAccess(count) {
      tokensWithAccess = count;
    },
  };
}
