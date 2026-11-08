"use client";

import { isApiError } from "./api";
import { MANAGE_CALENDARS } from "./calendar-sync";
import { combineChecklist } from "./connection-rows";
import { MANAGE_MANAGED_CONNECTIONS } from "./managed-connections";
import { useCalendarConnections, useManagedConnections } from "./queries";
import { useCan } from "./session";

export { combineChecklist, connectionChecklist, unreadItem, type ChecklistItem, type ChecklistStatus } from "./connection-rows";

/**
 * Home's connections as one read (see `combineChecklist`). Shopify's list is owners only
 * (`integrations`), so staff never ask for it. A 404 means this server has no connections
 * settings, so the row is left out rather than shown as a failure. An owner's 403 is not left
 * out: the owner can read it, so a refusal is a real failure and Home says it could not check.
 */
export function useConnectionChecklist() {
  const canManage = useCan(MANAGE_MANAGED_CONNECTIONS);
  const canManageCalendars = useCan(MANAGE_CALENDARS);
  const calendar = useCalendarConnections();
  const managed = useManagedConnections(canManage);
  const managedOff = !canManage || isApiError(managed.error, "not_found");
  return combineChecklist(calendar, managedOff ? null : managed, { canManageCalendars });
}
