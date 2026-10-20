/**
 * The demo adapter's Google Calendar connections (google-calendar.md G-1, G-4, G-5). It keeps the
 * rules the API enforces: anyone with `calendar` lists them, only owners (`publish`) connect and
 * disconnect, a connect key names one connection, and each resource has at most one connection
 * that is `active` or `reauthorize`. There is no Google here: a connect finishes at once, as if
 * the owner had allowed access with a made-up account, and the answer sends the page straight
 * back to the Connections page. The "worker" runs on the next list once a short delay passed: it
 * finishes cleaning up a disconnect and makes a new connection's first sync.
 */
import type { z } from "zod";
import { connectGoogleCalendarRequestSchema, uuidSchema, type CalendarConnection } from "@zs/contracts";
import { demoError } from "../errors";
import type { CalendarSyncApi, WriteOptions } from "../types";
import type { DemoActor } from "./agents";
import { DEMO_OWNER, type DemoResource } from "./seed";

export interface DemoCalendarControls {
  /** Whether this server has Google settings; without them a connect is a 404 (G-1). */
  setGoogleCalendarConfigured(configured: boolean): void;
  /** Google stops honouring a connection's grant: it needs the owner to connect again (G-9). */
  loseCalendarGrant(resourceId: string): void;
}

export interface DemoCalendarContext {
  now(): Date;
  newId(): string;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>;
  actor(): DemoActor;
  resources: readonly DemoResource[];
}

/** The Google account every demo connect "allows" (fake Halden & Rowe data). */
export const DEMO_GOOGLE_ACCOUNT = DEMO_OWNER.email!;
/** How long the demo worker takes to clean up a disconnect, or to make a first sync. */
export const DEMO_CALENDAR_WORKER_MS = 1500;

const clone = <T>(value: T): T => structuredClone(value);
/** The browser's part of the connect body; in live mode the dashboard's server adds what binds the flow to the browser. */
const browserConnectSchema = connectGoogleCalendarRequestSchema.pick({ resourceId: true });

/** The page's own origin, so the "consent screen" lands back on this dashboard. */
function pageOrigin(): string {
  const location = (globalThis as { location?: { origin?: string } }).location;
  return location?.origin && location.origin !== "null" ? location.origin : "http://127.0.0.1";
}

export function createDemoCalendar(ctx: DemoCalendarContext): CalendarSyncApi & DemoCalendarControls {
  const connections = new Map<string, CalendarConnection>();
  /** When each connection last changed status, for the worker's delay. */
  const changedAt = new Map<string, number>();
  /** A connect key names one connection (G-1). */
  const connectionByKey = new Map<string, string>();
  let configured = true;

  /** `publish` (owners only); anything else is TenantDenied, a 403. */
  const requireOwner = () => {
    if (ctx.actor().role !== "owner") throw demoError("Forbidden");
  };

  const setStatus = (connection: CalendarConnection, status: CalendarConnection["status"]) => {
    connection.status = status;
    changedAt.set(connection.id, ctx.now().getTime());
  };

  /** The worker's pass (G-6, G-9), run lazily: cleanups and first syncs that are due. */
  function runWorker() {
    const now = ctx.now().getTime();
    for (const connection of connections.values()) {
      const due = now - (changedAt.get(connection.id) ?? now) >= DEMO_CALENDAR_WORKER_MS;
      if (!due) continue;
      if (connection.status === "disconnecting") setStatus(connection, "disconnected");
      else if (connection.status === "active" && connection.lastSyncedAt === null) connection.lastSyncedAt = new Date(now).toISOString();
    }
  }

  /** The resource's one connection that is `active` or `reauthorize`, if any (G-4). */
  const current = (resourceId: string) =>
    [...connections.values()].find((item) => item.resourceId === resourceId && (item.status === "active" || item.status === "reauthorize"));

  return {
    async listCalendarConnections() {
      await ctx.wait();
      runWorker();
      return clone([...connections.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)));
    },

    async startGoogleConnect(resourceId, options) {
      const key = options?.idempotencyKey;
      if (!key) throw new TypeError("calendar.google.connect needs an Idempotency-Key from the caller");
      await ctx.wait();
      // Same order as the API: no Google settings, then the body, then the role and resource, then the key.
      if (!configured) throw demoError("NotFound");
      const request = ctx.parse(browserConnectSchema, { resourceId });
      requireOwner();
      if (!ctx.resources.some((resource) => resource.id === request.resourceId)) throw demoError("Forbidden");
      const authorizeUrl = `${pageOrigin()}/account/connections?calendar=connected`;
      const known = connectionByKey.get(key);
      if (known) {
        const found = connections.get(known)!;
        if (found.resourceId !== request.resourceId || found.status !== "active") throw demoError("Conflict", { reason: "idempotency_key_reused" });
        return { authorizeUrl };
      }
      // What the callback's connect action does once Google answers (G-2, G-4): the older
      // connection of the resource goes to the worker for cleanup, the new one starts active.
      const older = current(request.resourceId);
      if (older) setStatus(older, "disconnecting");
      const connection: CalendarConnection = {
        id: ctx.newId(), provider: "google", resourceId: request.resourceId, calendarId: "primary", accountEmail: DEMO_GOOGLE_ACCOUNT,
        status: "active", lastSyncedAt: null, lastError: null, createdAt: ctx.now().toISOString(),
      };
      connections.set(connection.id, connection);
      changedAt.set(connection.id, ctx.now().getTime());
      connectionByKey.set(key, connection.id);
      return { authorizeUrl };
    },

    disconnectCalendar(connectionId, options) {
      return ctx.idempotent("calendar.google.disconnect", { connectionId }, options, () => {
        const id = ctx.parse(uuidSchema, connectionId);
        requireOwner();
        const connection = connections.get(id);
        if (!connection) throw demoError("NotFound");
        // G-5: a retired connection answers as it is.
        if (connection.status === "active" || connection.status === "reauthorize") setStatus(connection, "disconnecting");
        return clone(connection);
      });
    },

    setGoogleCalendarConfigured(value) {
      configured = value;
    },

    loseCalendarGrant(resourceId) {
      const connection = current(resourceId);
      if (!connection) return;
      setStatus(connection, "reauthorize");
      connection.lastError = "invalid_grant";
    },
  };
}
