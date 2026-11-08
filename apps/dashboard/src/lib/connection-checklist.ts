"use client";

import type { QueryStatus } from "@tanstack/react-query";
import { isApiError, type CalendarConnection, type ManagedConnection } from "./api";
import { MANAGE_MANAGED_CONNECTIONS } from "./managed-connections";
import { useCalendarConnections, useManagedConnections } from "./queries";
import { useCan } from "./session";

/**
 * Home's connections list, read from the same routes the Connections page reads: Google Calendar
 * (`GET /v1/calendar/connections`, google-calendar.md G-5) and Shopify (`GET /v1/connections`,
 * connections.md C-13). `action` needs the owner; `off` is not connected and never counts as needing them.
 */
export type ChecklistStatus = "ok" | "action" | "off";

export interface ChecklistItem {
  id: "google_calendar" | "shopify";
  label: string;
  detail: string;
  status: ChecklistStatus;
  actionLabel: string | null;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function calendarItem(items: readonly CalendarConnection[]): ChecklistItem {
  const reconnect = items.filter((item) => item.status === "reauthorize").length;
  const active = items.filter((item) => item.status === "active").length;
  const base = { id: "google_calendar", label: "Google Calendar" } as const;
  if (reconnect > 0) {
    return { ...base, status: "action", actionLabel: "Reconnect", detail: `${plural(reconnect, "booking calendar", "booking calendars")} stopped syncing. Reconnect to keep busy times blocked.` };
  }
  if (active > 0) return { ...base, status: "ok", actionLabel: null, detail: `${plural(active, "booking calendar", "booking calendars")} syncing busy times` };
  return { ...base, status: "off", actionLabel: null, detail: "Not connected. Connect it so busy times block bookings." };
}

function shopifyItem(items: readonly ManagedConnection[]): ChecklistItem {
  const stores = items.filter((item) => item.toolkit === "shopify");
  const reconnect = stores.find((item) => item.status === "reauthorize");
  const active = stores.filter((item) => item.status === "active");
  const base = { id: "shopify", label: "Shopify" } as const;
  if (reconnect) return { ...base, status: "action", actionLabel: "Reconnect", detail: "A connected store needs you to reconnect it. Agents cannot read its orders until you do." };
  const blocked = active.find((item) => item.readBlocked);
  if (blocked) return { ...base, status: "action", actionLabel: "Check access", detail: `The app's permissions in ${blocked.accountDomain} block order reads.` };
  if (active.length > 0) return { ...base, status: "ok", actionLabel: null, detail: active.map((item) => item.accountLabel ?? item.accountDomain).join(", ") };
  return { ...base, status: "off", actionLabel: null, detail: "Not connected. Connect a store so agents can read its orders." };
}

/**
 * The rows Home shows. Shopify is left out when the member cannot manage it (`null`): staff, or a
 * server without connections settings (404).
 */
export function connectionChecklist(calendar: readonly CalendarConnection[], managed: readonly ManagedConnection[] | null): ChecklistItem[] {
  return managed === null ? [calendarItem(calendar)] : [calendarItem(calendar), shopifyItem(managed)];
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
  const calendar = useCalendarConnections();
  const managed = useManagedConnections(canManage);
  const managedOff = !canManage || isApiError(managed.error, "not_found") || isApiError(managed.error, "forbidden");
  const reads: Read[] = managedOff ? [calendar] : [calendar, managed];
  const failed = reads.find((read) => read.isError) ?? null;
  const isPending = !failed && reads.some((read) => read.isPending);
  const status: QueryStatus = failed ? "error" : isPending ? "pending" : "success";
  const fetchStatus = reads.some((read) => read.fetchStatus === "paused") ? "paused" : reads.some((read) => read.fetchStatus === "fetching") ? "fetching" : "idle";
  const data = status === "success" && calendar.data ? connectionChecklist(calendar.data, managedOff ? null : managed.data ?? []) : undefined;
  const refetch = async () => {
    await Promise.all(reads.filter((read) => read.isError || read.fetchStatus === "paused" || read.isPending).map((read) => read.refetch()));
  };
  return { data, status, fetchStatus, isPending, isError: failed !== null, error: failed?.error ?? null, refetch } as const;
}
