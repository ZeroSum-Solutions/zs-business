"use client";

import { useQuery } from "@tanstack/react-query";
import { useApi } from "./api/react";
import { useTenantId } from "./session";
import { ApiError, type BookingListQuery, type DealRecord, type ListResult, type SlotQuery } from "./api";
import { preferNewerDeals } from "./deal-merge";

/** Key suffixes. Queries and invalidations go through `useKeys`, which puts the tenant first. */
export const keys = {
  resources: ["booking", "resources"] as const,
  slots: (query: SlotQuery) => ["booking", "slots", query] as const,
  slotsAll: ["booking", "slots"] as const,
  bookings: (query: BookingListQuery = {}) => ["booking", "bookings", query] as const,
  bookingsAll: ["booking", "bookings"] as const,
  pipeline: ["crm", "pipeline"] as const,
  contacts: (search = "") => ["crm", "contacts", search] as const,
  contactsAll: ["crm", "contacts"] as const,
  contact: (id: string) => ["crm", "contact", id] as const,
  deals: (contactId?: string) => ["crm", "deals", contactId ?? "all"] as const,
  dealsAll: ["crm", "deals"] as const,
  results: ["ws", "results"] as const,
  usage: ["ws", "usage"] as const,
  checklist: ["ws", "checklist"] as const,
  threads: ["ws", "threads"] as const,
  thread: (id: string) => ["ws", "thread", id] as const,
  sitePages: ["ws", "site"] as const,
  agents: ["ws", "agents"] as const,
  approvals: ["ws", "approvals"] as const,
  connections: ["ws", "connections"] as const,
  plan: ["ws", "plan"] as const,
};

type Keys = typeof keys;
type Scoped<K> = K extends (...args: infer A) => infer R
  ? (R extends readonly unknown[] ? (...args: A) => readonly [string, ...R] : never)
  : K extends readonly unknown[] ? readonly [string, ...K] : never;
export type ScopedKeys = { [P in keyof Keys]: Scoped<Keys[P]> };

/** Every key, prefixed with the tenant the data belongs to. */
export function scopeKeys(tenantId: string): ScopedKeys {
  return Object.fromEntries(Object.entries(keys).map(([name, key]) => [
    name,
    typeof key === "function" ? (...args: unknown[]) => [tenantId, ...(key as (...a: unknown[]) => readonly unknown[])(...args)] : [tenantId, ...key],
  ])) as unknown as ScopedKeys;
}

const SIGNED_OUT = "signed-out";

/**
 * Tenant-scoped keys for the signed-in business. Until the session is known the prefix is a
 * placeholder and `enabled` is false, so nothing is fetched or cached under it.
 */
export function useKeys(): { keys: ScopedKeys; enabled: boolean } {
  const tenantId = useTenantId();
  return { keys: scopeKeys(tenantId ?? SIGNED_OUT), enabled: tenantId !== null };
}

export function useResources() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.resources, queryFn: () => api.listResources(), staleTime: Infinity });
}

export function useSlots(query: SlotQuery | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    queryKey: query ? keys.slots(query) : [...keys.slotsAll, "idle"],
    queryFn: () => api.getSlots(query!),
    enabled: enabled && query !== null,
  });
}

export function useBookings(query: BookingListQuery = {}) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.bookings(query), queryFn: () => api.listBookings(query) });
}

export function usePipeline() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled,
    queryKey: keys.pipeline,
    // M1 has one pipeline per business; the board shows the first.
    queryFn: async () => {
      const [first] = await api.listPipelines();
      if (!first) throw new ApiError("not_found", "No pipeline is set up yet.", null, "NotFound");
      return first;
    },
    staleTime: Infinity,
  });
}

export function useContacts(search = "") {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.contacts(search), queryFn: () => api.listContacts({ search }), placeholderData: (previous) => previous });
}

export function useContact(id: string) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.contact(id), queryFn: () => api.getContact(id) });
}

export function useDeals(contactId?: string) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled,
    queryKey: keys.deals(contactId),
    queryFn: () => api.listDeals(contactId ? { contactId } : {}),
    structuralSharing: (previous, next) => preferNewerDeals(previous as ListResult<DealRecord> | undefined, next as ListResult<DealRecord>),
  });
}

export function useResults() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.results, queryFn: () => api.getResults() });
}

export function useUsage() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.usage, queryFn: () => api.getUsage() });
}

export function useChecklist() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.checklist, queryFn: () => api.getChecklist() });
}

export function useThreads() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.threads, queryFn: () => api.listThreads() });
}

export function useThread(id: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ queryKey: keys.thread(id ?? "none"), queryFn: () => api.getThread(id!), enabled: enabled && id !== null });
}

export function useSitePages() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.sitePages, queryFn: () => api.listSitePages() });
}

export function useAgents() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.agents, queryFn: () => api.listAgents() });
}

export function useApprovals() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.approvals, queryFn: () => api.listApprovals() });
}

export function useConnections() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.connections, queryFn: () => api.listConnections() });
}

export function usePlan() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.plan, queryFn: () => api.getPlan() });
}
