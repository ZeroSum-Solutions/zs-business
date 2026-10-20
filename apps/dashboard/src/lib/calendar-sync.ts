import type { Permission } from "@zs/contracts";
import { isApiError, type CalendarConnection } from "./api";
import { isDefinitive } from "./intent-key";

/**
 * Connecting and disconnecting a calendar decides what the public pages offer, so the API
 * asks for the owner-only `publish` (google-calendar.md G-1, G-5). Reading needs `calendar`.
 */
export const MANAGE_CALENDARS: Permission = "publish";

/**
 * The connection to show for one resource. History keeps every grant, but at most one is
 * `active` or `reauthorize` (G-4); without one, the newest that is still being cleaned up.
 * Null means not connected: a `disconnected` row is history.
 */
export function currentConnection(items: readonly CalendarConnection[], resourceId: string): CalendarConnection | null {
  const mine = items.filter((item) => item.resourceId === resourceId);
  const live = mine.find((item) => item.status === "active" || item.status === "reauthorize");
  if (live) return live;
  const newest = mine.filter((item) => item.status === "disconnecting")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  return newest ?? null;
}

export interface ReturnNotice {
  tone: "success" | "info" | "error";
  message: string;
}

/** Why the callback sent the owner back without a connection (G-2), in plain words. */
export const RETURN_REASONS: Readonly<Record<string, string>> = {
  denied: "Google access was not allowed. Nothing changed.",
  exchange_failed: "Google did not finish connecting. Nothing changed. Try again from this page.",
  no_refresh_token: "Google did not grant lasting access. Remove Zero Sum from your Google account's third-party access, then connect again.",
  scope_missing: "Allow access to calendar events on Google's screen, then connect again.",
  forbidden: "Only an owner can connect calendars. Nothing changed.",
  conflict: "This calendar changed while you were on Google's screen. Check its status below, then connect again if you need to.",
  browser_mismatch: "Finish connecting in the same browser you started in. Try again from this page.",
  invalid_state: "That connect link expired or is not valid. Try again from this page.",
  unavailable: "We could not reach the server to finish connecting. Try again in a minute.",
};

export const CONNECTED_MESSAGE = "Google Calendar connected. Busy times start blocking slots after the first sync.";
const UNKNOWN_RETURN = "Google Calendar could not be connected. Try again from this page.";
export const CONFIRM_EXPIRED_MESSAGE = "That connection request expired. Connect again.";
export const CANCELLED_MESSAGE = "Nothing was connected.";

/**
 * What `?calendar=connected` or `?calendar=error&reason=…` on the return URL means; null for
 * neither. `?calendar=confirm` says nothing by itself: the waiting grant, read from the server,
 * is what the page asks the owner to confirm.
 */
export function returnNotice(outcome: string | null, reason: string | null): ReturnNotice | null {
  if (outcome === "connected") return { tone: "success", message: CONNECTED_MESSAGE };
  // Own keys only: the reason comes from the address bar.
  if (outcome === "error") return { tone: "error", message: reason !== null && Object.hasOwn(RETURN_REASONS, reason) ? RETURN_REASONS[reason]! : UNKNOWN_RETURN };
  return null;
}

/**
 * What a confirm the server answered for good says (G-2): nothing waits any more (404), the
 * connection or its calendar changed (409), or not an owner (403). Null for a lost answer, which
 * leaves the grant waiting, so the owner can try again.
 */
export function confirmErrorNotice(error: unknown): ReturnNotice | null {
  if (!isDefinitive(error)) return null;
  const message = isApiError(error, "not_found") ? CONFIRM_EXPIRED_MESSAGE
    : isApiError(error, "conflict") ? RETURN_REASONS.conflict!
    : isApiError(error, "forbidden") ? RETURN_REASONS.forbidden!
    : isApiError(error) ? error.message : UNKNOWN_RETURN;
  return { tone: "error", message };
}

/**
 * Whether busy times may block other slots now: a sync finished, or a connection moved to another
 * status or left the list. A new connection blocks nothing until its first sync.
 */
export function busyTimesChanged(before: readonly CalendarConnection[], after: readonly CalendarConnection[]): boolean {
  const now = new Map(after.map((item) => [item.id, item]));
  return before.some((item) => {
    const next = now.get(item.id);
    return !next || next.status !== item.status || next.lastSyncedAt !== item.lastSyncedAt;
  });
}

/** A connect the server refused before Google: no Google settings (404), or not an owner (403). */
export function connectErrorMessage(error: unknown): string {
  if (isApiError(error, "not_found")) return "Google Calendar is not set up on this server yet.";
  if (isApiError(error, "forbidden")) return "Only an owner can connect calendars.";
  return isApiError(error) ? error.message : "Something went wrong. Try again.";
}

/** The worker's `last_error` codes on a connection that still syncs (G-6, G-10). */
const SYNC_ERRORS: Readonly<Record<string, string>> = {
  too_many_events: "This Google Calendar has more events than one sync reads. Busy times for the next 30 days are up to date.",
  too_many_changes: "Too many changes arrived at once. The next sync reads the whole calendar again.",
  run_deadline: "The last sync took too long. It tries again by itself.",
};

export function syncErrorMessage(code: string): string {
  return Object.hasOwn(SYNC_ERRORS, code) ? SYNC_ERRORS[code]! : "The last sync did not finish. It tries again by itself; busy times from before still apply.";
}
