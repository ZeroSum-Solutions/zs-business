"use client";

import type { QueryStatus } from "@tanstack/react-query";
import { isApiError, type CalendarConnection, type ManagedConnection } from "./api";
import { currentConnection, disconnectingStatus, MANAGE_CALENDARS, syncErrorMessage } from "./calendar-sync";
import { currentConnections, MANAGE_MANAGED_CONNECTIONS, REAUTHORIZE_HOME_LINE } from "./managed-connections";
import { useCalendarConnections, useManagedConnections } from "./queries";
import { useCan } from "./session";

/**
 * Home's connections list, read from the same routes the Connections page reads: Google Calendar
 * (`GET /v1/calendar/connections`, google-calendar.md G-5) and Shopify (`GET /v1/connections`,
 * connections.md C-13), with the same rules for which connection is current. `action` needs a
 * person (counted on Home); `warn` is a problem that fixes itself or waits; `pending` is a first
 * sync or a disconnect still running; `off` is not connected and never counts as needing anyone.
 */
export type ChecklistStatus = "ok" | "action" | "warn" | "pending" | "off";

export interface ChecklistItem {
  id: "google_calendar" | "shopify";
  label: string;
  detail: string;
  status: ChecklistStatus;
  /** The badge words: what the status means for this row. */
  badge: string;
  actionLabel: string | null;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const calendars = (count: number) => plural(count, "booking calendar", "booking calendars");

/** The calendar each booking calendar shows on the Connections page (`currentConnection`, G-4). */
function currentCalendars(items: readonly CalendarConnection[]): CalendarConnection[] {
  const resources = [...new Set(items.map((item) => item.resourceId))];
  return resources.map((id) => currentConnection(items, id)).filter((item): item is CalendarConnection => item !== null);
}

/**
 * `canManage` is `MANAGE_CALENDARS`: staff can read the status but not reconnect, so they are
 * told to ask an owner instead of being offered a button they cannot use.
 */
function calendarItem(items: readonly CalendarConnection[], canManage: boolean): ChecklistItem {
  const current = currentCalendars(items);
  const base = { id: "google_calendar", label: "Google Calendar" } as const;
  const reconnect = current.filter((item) => item.status === "reauthorize").length;
  if (reconnect > 0) {
    return canManage
      ? { ...base, status: "action", badge: "Needs action", actionLabel: "Reconnect", detail: `${calendars(reconnect)} stopped syncing. Reconnect to keep busy times blocked.` }
      : { ...base, status: "action", badge: "Needs an owner", actionLabel: null, detail: `${calendars(reconnect)} stopped syncing. Ask an owner to reconnect ${reconnect === 1 ? "it" : "them"}.` };
  }
  const stuck = current.find((item) => item.status === "disconnecting" && item.lastError !== null);
  if (stuck) return { ...base, status: "warn", badge: "Disconnect stuck", actionLabel: null, detail: disconnectingStatus(stuck.lastError).message };
  const active = current.filter((item) => item.status === "active");
  const failed = active.find((item) => item.lastError !== null);
  if (failed) return { ...base, status: "warn", badge: "Sync problem", actionLabel: null, detail: syncErrorMessage(failed.lastError!) };
  const waiting = active.filter((item) => item.lastSyncedAt === null).length;
  if (waiting > 0) return { ...base, status: "pending", badge: "Waiting", actionLabel: null, detail: `${calendars(waiting)} waiting for the first sync. Busy times block slots after it.` };
  const leaving = current.filter((item) => item.status === "disconnecting").length;
  if (leaving > 0) return { ...base, status: "pending", badge: "Disconnecting", actionLabel: null, detail: `${calendars(leaving)} disconnecting. ${disconnectingStatus(null).message}` };
  if (active.length > 0) return { ...base, status: "ok", badge: "Connected", actionLabel: null, detail: `${calendars(active.length)} syncing busy times` };
  return { ...base, status: "off", badge: "Not connected", actionLabel: null, detail: "Not connected. Connect it so busy times block bookings." };
}

/** Shopify rows as the Connections page lists them (`currentConnections`, C-13). */
function shopifyItem(items: readonly ManagedConnection[]): ChecklistItem {
  const stores = currentConnections(items).filter((item) => item.toolkit === "shopify");
  const base = { id: "shopify", label: "Shopify" } as const;
  const reconnect = stores.find((item) => item.status === "reauthorize");
  if (reconnect) return { ...base, status: "action", badge: "Needs action", actionLabel: "Reconnect", detail: REAUTHORIZE_HOME_LINE };
  // A revoke Shopify did not confirm: the app may still be installed until the owner removes it.
  const unrevoked = stores.find((item) => item.revokeFailed);
  if (unrevoked) return { ...base, status: "action", badge: "Needs action", actionLabel: "See steps", detail: `Shopify did not confirm it removed the app from ${unrevoked.accountDomain}. Remove the app in your Shopify admin.` };
  const active = stores.filter((item) => item.status === "active");
  const blocked = active.find((item) => item.readBlocked);
  if (blocked) return { ...base, status: "action", badge: "Needs action", actionLabel: "Check access", detail: `The app's permissions in ${blocked.accountDomain} block order reads.` };
  const leaving = stores.find((item) => item.status === "disconnecting");
  if (leaving) return { ...base, status: "pending", badge: "Disconnecting", actionLabel: null, detail: `Disconnecting ${leaving.accountDomain}: removing our access and asking Shopify to remove the app's access.` };
  if (active.length > 0) return { ...base, status: "ok", badge: "Connected", actionLabel: null, detail: active.map((item) => item.accountLabel ?? item.accountDomain).join(", ") };
  return { ...base, status: "off", badge: "Not connected", actionLabel: null, detail: "Not connected. Connect a store so agents can read its orders." };
}

/**
 * The rows Home shows. Shopify is left out when the member cannot manage it (`null`): staff, or a
 * server without connections settings (404).
 */
export function connectionChecklist(
  calendar: readonly CalendarConnection[],
  managed: readonly ManagedConnection[] | null,
  { canManageCalendars = true }: { canManageCalendars?: boolean } = {},
): ChecklistItem[] {
  const first = calendarItem(calendar, canManageCalendars);
  return managed === null ? [first] : [first, shopifyItem(managed)];
}

interface Read {
  status: QueryStatus;
  fetchStatus: "fetching" | "paused" | "idle";
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * The checklist as one read: pending until both lists are in, failed when either failed. Shopify's
 * list is owners only (`integrations`); a 404 means this server has no connections settings, so the
 * row is left out rather than shown as a failure.
 */
export function useConnectionChecklist() {
  const canManage = useCan(MANAGE_MANAGED_CONNECTIONS);
  const canManageCalendars = useCan(MANAGE_CALENDARS);
  const calendar = useCalendarConnections();
  const managed = useManagedConnections(canManage);
  const managedOff = !canManage || isApiError(managed.error, "not_found") || isApiError(managed.error, "forbidden");
  const reads: Read[] = managedOff ? [calendar] : [calendar, managed];
  const failed = reads.find((read) => read.isError) ?? null;
  const isPending = !failed && reads.some((read) => read.isPending);
  const status: QueryStatus = failed ? "error" : isPending ? "pending" : "success";
  const fetchStatus = reads.some((read) => read.fetchStatus === "paused") ? "paused" : reads.some((read) => read.fetchStatus === "fetching") ? "fetching" : "idle";
  const data = status === "success" && calendar.data ? connectionChecklist(calendar.data, managedOff ? null : managed.data ?? [], { canManageCalendars }) : undefined;
  const refetch = async () => {
    await Promise.all(reads.filter((read) => read.isError || read.fetchStatus === "paused" || read.isPending).map((read) => read.refetch()));
  };
  return { data, status, fetchStatus, isPending, isError: failed !== null, error: failed?.error ?? null, refetch } as const;
}
