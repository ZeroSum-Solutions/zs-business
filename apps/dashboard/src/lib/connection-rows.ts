import type { QueryStatus } from "@tanstack/react-query";
import type { CalendarConnection, ManagedConnection } from "./api";
import { currentConnection, disconnectingStatus, syncErrorMessage } from "./calendar-sync";
import { currentConnections, REAUTHORIZE_HOME_LINE } from "./managed-connections";
import { plural } from "./plural";

/**
 * Home's connections list, read from the same routes the Connections page reads: Google Calendar
 * (`GET /v1/calendar/connections`, google-calendar.md G-5) and Shopify (`GET /v1/connections`,
 * connections.md C-13), with the same rules for which connection is current. `action` needs the
 * person looking (counted on Home); `warn` is a problem that fixes itself, waits, or needs someone
 * else (an owner, for staff); `pending` is a first sync or a disconnect still running; `off` is not
 * connected and never counts as needing anyone.
 *
 * No React here: the live e2e reads the same rows to check what Home shows.
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

const LABELS: Record<ChecklistItem["id"], string> = { google_calendar: "Google Calendar", shopify: "Shopify" };

const calendars = (count: number) => plural(count, "booking calendar", "booking calendars");
/** "a, b and c" */
const listed = (names: readonly string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** The calendar each booking calendar shows on the Connections page (`currentConnection`, G-4). */
function currentCalendars(items: readonly CalendarConnection[]): CalendarConnection[] {
  const resources = [...new Set(items.map((item) => item.resourceId))];
  return resources.map((id) => currentConnection(items, id)).filter((item): item is CalendarConnection => item !== null);
}

/**
 * `canManage` is `MANAGE_CALENDARS`: staff can read the status but not reconnect or connect, so a
 * calendar that needs reconnecting is a warning that waits for an owner, not something that needs them.
 */
function calendarItem(items: readonly CalendarConnection[], canManage: boolean): ChecklistItem {
  const current = currentCalendars(items);
  const base = { id: "google_calendar", label: LABELS.google_calendar } as const;
  const reconnect = current.filter((item) => item.status === "reauthorize").length;
  if (reconnect > 0) {
    return canManage
      ? { ...base, status: "action", badge: "Needs action", actionLabel: "Reconnect", detail: `${calendars(reconnect)} stopped syncing. Reconnect to keep busy times blocked.` }
      : { ...base, status: "warn", badge: "Needs an owner", actionLabel: null, detail: `${calendars(reconnect)} stopped syncing. Ask an owner to reconnect ${reconnect === 1 ? "it" : "them"}.` };
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
  return {
    ...base, status: "off", badge: "Not connected", actionLabel: null,
    detail: canManage ? "Not connected. Connect it so busy times block bookings." : "Not connected. An owner can connect it so busy times block bookings.",
  };
}

/**
 * Shopify rows as the Connections page lists them (`currentConnections`, C-13). Every store with a
 * problem is named: one store's reconnect never hides another store's unconfirmed revoke.
 */
function shopifyItem(items: readonly ManagedConnection[]): ChecklistItem {
  const stores = currentConnections(items).filter((item) => item.toolkit === "shopify");
  const base = { id: "shopify", label: LABELS.shopify } as const;
  const active = stores.filter((item) => item.status === "active");
  const problems: { line: string; action: string }[] = [];
  if (stores.some((item) => item.status === "reauthorize")) problems.push({ line: REAUTHORIZE_HOME_LINE, action: "Reconnect" });
  // A revoke Shopify did not confirm: the app may still be installed until the owner removes it.
  const unrevoked = stores.filter((item) => item.revokeFailed).map((item) => item.accountDomain);
  if (unrevoked.length > 0) problems.push({ line: `Shopify did not confirm it removed the app from ${listed(unrevoked)}. Remove the app in your Shopify admin.`, action: "See steps" });
  const blocked = active.filter((item) => item.readBlocked).map((item) => item.accountDomain);
  if (blocked.length > 0) problems.push({ line: `The app's permissions in ${listed(blocked)} block order reads.`, action: "Check access" });
  if (problems.length > 0) {
    return { ...base, status: "action", badge: "Needs action", actionLabel: problems[0]!.action, detail: problems.map((problem) => problem.line).join(" ") };
  }
  const leaving = stores.find((item) => item.status === "disconnecting");
  if (leaving) return { ...base, status: "pending", badge: "Disconnecting", actionLabel: null, detail: `Disconnecting ${leaving.accountDomain}: removing our access and asking Shopify to remove the app's access.` };
  if (active.length > 0) return { ...base, status: "ok", badge: "Connected", actionLabel: null, detail: active.map((item) => item.accountLabel ?? item.accountDomain).join(", ") };
  return { ...base, status: "off", badge: "Not connected", actionLabel: null, detail: "Not connected. Connect a store so agents can read its orders." };
}

/** A row whose list did not answer: said so, never shown as connected or not connected. */
export function unreadItem(id: ChecklistItem["id"]): ChecklistItem {
  return { id, label: LABELS[id], status: "warn", badge: "Couldn't check", actionLabel: null, detail: `Couldn't read ${LABELS[id]}. Try again.` };
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

export interface ChecklistRead<T> {
  data: T | undefined;
  status: QueryStatus;
  fetchStatus: "fetching" | "paused" | "idle";
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => Promise<unknown>;
}

/**
 * The two reads as one: pending until both lists are in, failed when either failed. A list that
 * failed does not hide the other: once neither is loading, each row comes from its own list (or its
 * cached copy), and one with nothing to show says it could not be checked. `managed` is null when
 * Shopify is left out. Offline counts only for a read that has nothing yet: a cached list whose
 * background read is paused is still an answer.
 */
export function combineChecklist(
  calendar: ChecklistRead<readonly CalendarConnection[]>,
  managed: ChecklistRead<readonly ManagedConnection[]> | null,
  options: { canManageCalendars?: boolean } = {},
) {
  const reads: ChecklistRead<unknown>[] = managed ? [calendar, managed] : [calendar];
  const stalled = (read: ChecklistRead<unknown>) => read.isPending && read.fetchStatus === "paused";
  const failed = reads.find((read) => read.isError) ?? null;
  const loading = reads.some((read) => read.isPending);
  const isPending = !failed && loading;
  const status: QueryStatus = failed ? "error" : isPending ? "pending" : "success";
  const fetchStatus = reads.some(stalled) ? "paused" : reads.some((read) => read.fetchStatus === "fetching") ? "fetching" : "idle";
  const answered = reads.some((read) => read.data !== undefined);
  let data: ChecklistItem[] | undefined;
  if (!loading && answered) {
    const rows = connectionChecklist(calendar.data ?? [], managed ? managed.data ?? [] : null, options);
    data = rows.map((row) => {
      const read = row.id === "google_calendar" ? calendar : managed;
      return read && read.data === undefined ? unreadItem(row.id) : row;
    });
  }
  const refetch = async () => {
    await Promise.all(reads.filter((read) => read.isError || stalled(read) || read.isPending).map((read) => read.refetch()));
  };
  return { data, status, fetchStatus, isPending, isError: failed !== null, error: failed?.error ?? null, refetch } as const;
}
