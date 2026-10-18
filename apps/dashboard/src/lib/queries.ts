"use client";

import { useQuery } from "@tanstack/react-query";
import { useApi } from "./api/react";
import { ApiError, type BookingListQuery, type SlotQuery } from "./api";

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

export function useResources() {
  const api = useApi();
  return useQuery({ queryKey: keys.resources, queryFn: () => api.listResources(), staleTime: Infinity });
}

export function useSlots(query: SlotQuery | null) {
  const api = useApi();
  return useQuery({
    queryKey: query ? keys.slots(query) : ["booking", "slots", "idle"],
    queryFn: () => api.getSlots(query!),
    enabled: query !== null,
  });
}

export function useBookings(query: BookingListQuery = {}) {
  const api = useApi();
  return useQuery({ queryKey: keys.bookings(query), queryFn: () => api.listBookings(query) });
}

export function usePipeline() {
  const api = useApi();
  return useQuery({
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
  return useQuery({ queryKey: keys.contacts(search), queryFn: () => api.listContacts({ search }), placeholderData: (previous) => previous });
}

export function useContact(id: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.contact(id), queryFn: () => api.getContact(id) });
}

export function useDeals(contactId?: string) {
  const api = useApi();
  return useQuery({ queryKey: keys.deals(contactId), queryFn: () => api.listDeals(contactId ? { contactId } : {}) });
}

export function useResults() {
  const api = useApi();
  return useQuery({ queryKey: keys.results, queryFn: () => api.getResults() });
}

export function useUsage() {
  const api = useApi();
  return useQuery({ queryKey: keys.usage, queryFn: () => api.getUsage() });
}

export function useChecklist() {
  const api = useApi();
  return useQuery({ queryKey: keys.checklist, queryFn: () => api.getChecklist() });
}

export function useThreads() {
  const api = useApi();
  return useQuery({ queryKey: keys.threads, queryFn: () => api.listThreads() });
}

export function useThread(id: string | null) {
  const api = useApi();
  return useQuery({ queryKey: keys.thread(id ?? "none"), queryFn: () => api.getThread(id!), enabled: id !== null });
}

export function useSitePages() {
  const api = useApi();
  return useQuery({ queryKey: keys.sitePages, queryFn: () => api.listSitePages() });
}

export function useAgents() {
  const api = useApi();
  return useQuery({ queryKey: keys.agents, queryFn: () => api.listAgents() });
}

export function useApprovals() {
  const api = useApi();
  return useQuery({ queryKey: keys.approvals, queryFn: () => api.listApprovals() });
}

export function useConnections() {
  const api = useApi();
  return useQuery({ queryKey: keys.connections, queryFn: () => api.listConnections() });
}

export function usePlan() {
  const api = useApi();
  return useQuery({ queryKey: keys.plan, queryFn: () => api.getPlan() });
}
