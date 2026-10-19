"use client";

import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useApi } from "./api/react";
import { useTenantId } from "./session";
import {
  CONTACT_IDS_PER_CALL,
  type BookingListQuery,
  type ContactRecord,
  type DealListQuery,
  type DealRecord,
  type ListResult,
  type Page,
  type SlotQuery,
} from "./api";
import { preferNewerDeals } from "./deal-merge";

/** Key suffixes. Queries and invalidations go through `useKeys`, which puts the tenant first. */
export const keys = {
  resources: ["booking", "resources"] as const,
  slots: (query: SlotQuery) => ["booking", "slots", query] as const,
  slotsAll: ["booking", "slots"] as const,
  bookings: (query: BookingListQuery = {}) => ["booking", "bookings", query] as const,
  bookingsAll: ["booking", "bookings"] as const,
  pipelines: ["crm", "pipelines"] as const,
  /** Pages of the customer list for one search; "" is the whole list. */
  contacts: (search = "") => ["crm", "contacts", "list", search] as const,
  /** Customers by ID, sorted, such as the ones a page of deals names. */
  contactNames: (ids: readonly string[]) => ["crm", "contacts", "names", ids] as const,
  contactsAll: ["crm", "contacts"] as const,
  contact: (id: string) => ["crm", "contact", id] as const,
  deals: (query: DealListQuery = {}) => ["crm", "deals", query] as const,
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
  return useQuery({ enabled, queryKey: keys.resources, queryFn: ({ signal }) => api.listResources({ signal }), staleTime: Infinity });
}

export function useSlots(query: SlotQuery | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    queryKey: query ? keys.slots(query) : [...keys.slotsAll, "idle"],
    queryFn: ({ signal }) => api.getSlots(query!, { signal }),
    enabled: enabled && query !== null,
  });
}

/** One range of bookings, filtered by the API; a day or week is one short read. */
export function useBookings(query: BookingListQuery = {}) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.bookings(query), queryFn: ({ signal }) => api.listBookings(query, { signal }) });
}

/** Every pipeline with its stages, in name order. A business may have none yet. */
export function usePipelines() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.pipelines, queryFn: ({ signal }) => api.listPipelines({ signal }), staleTime: 5 * 60_000 });
}

/** Waits until typing pauses, so a search sends one request instead of one per key. */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/**
 * The customer list, a page at a time, searched by the API. While a new search loads, the
 * previous results stay on screen.
 */
export function useContacts(search = "") {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useInfiniteQuery({
    enabled,
    queryKey: keys.contacts(search),
    queryFn: ({ pageParam, signal }) => api.listContacts({ ...(search ? { search } : {}), ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<ContactRecord>) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
}

/**
 * A customer already in a cached list or name lookup, so opening it shows at once. A list a
 * write has invalidated does not count: its row may be older than what the write returned.
 */
function cachedContact(queryClient: QueryClient, listKey: QueryKey, id: string): { contact: ContactRecord; updatedAt: number } | undefined {
  for (const query of queryClient.getQueryCache().findAll({ queryKey: listKey })) {
    if (query.state.isInvalidated) continue;
    const data = query.state.data as InfiniteData<Page<ContactRecord>> | ContactRecord[] | undefined;
    const rows = Array.isArray(data) ? data : data?.pages.flatMap((page) => page.items) ?? [];
    const contact = rows.find((row) => row.id === id);
    if (contact) return { contact, updatedAt: query.state.dataUpdatedAt };
  }
  return undefined;
}

export function useContact(id: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled,
    queryKey: keys.contact(id),
    queryFn: ({ signal }) => api.getContact(id, { signal }),
    // Shown at once from the list it was opened from; refetched in the background once stale.
    initialData: () => cachedContact(queryClient, keys.contactsAll, id)?.contact,
    initialDataUpdatedAt: () => cachedContact(queryClient, keys.contactsAll, id)?.updatedAt,
  });
}

/** Names for the customers a list of deals refers to, at most 100 per request. */
export function useContactNames(ids: readonly string[]) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  const sorted = useMemo(() => [...new Set(ids)].sort(), [ids]);
  return useQuery({
    enabled: enabled && sorted.length > 0,
    queryKey: keys.contactNames(sorted),
    queryFn: async ({ signal }) => {
      const chunks: string[][] = [];
      for (let start = 0; start < sorted.length; start += CONTACT_IDS_PER_CALL) chunks.push(sorted.slice(start, start + CONTACT_IDS_PER_CALL));
      const pages = await Promise.all(chunks.map((chunk) => api.listContacts({ ids: chunk, limit: chunk.length }, { signal })));
      return pages.flatMap((page) => page.items);
    },
    placeholderData: keepPreviousData,
  });
}

export function useDeals(query: DealListQuery = {}, options: { enabled?: boolean } = {}) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && (options.enabled ?? true),
    queryKey: keys.deals(query),
    queryFn: ({ signal }) => api.listDeals(query, { signal }),
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
