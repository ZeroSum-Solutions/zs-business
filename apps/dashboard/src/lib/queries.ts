"use client";

import { keepPreviousData, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { agentActorId } from "./agent-actor";
import { useApi } from "./api/react";
import { useTenantId } from "./session";
import {
  CONTACT_IDS_PER_CALL,
  type BookingListQuery,
  type CalendarConnection,
  type ContactRecord,
  type DealListQuery,
  type DealSummary,
  type FollowUpRun,
  type HomeResultsQuery,
  type IntakeStatus,
  type ListResult,
  type Page,
  type SlotQuery,
  type ThreadSummary,
} from "./api";
import type { BookingRecord, BusinessProfile, SlotsResponse } from "@zs/contracts";
import { preferNewerDeals } from "./deal-merge";
import { newerProfile } from "./business-profile";

/** Key suffixes. Queries and invalidations go through `useKeys`, which puts the tenant first. */
export const keys = {
  resources: ["booking", "resources"] as const,
  slots: (query: SlotQuery) => ["booking", "slots", query] as const,
  slotsAll: ["booking", "slots"] as const,
  bookings: (query: BookingListQuery = {}) => ["booking", "bookings", query] as const,
  bookingsAll: ["booking", "bookings"] as const,
  /** One booking with its customer revision (booking-customer.md BC-9). */
  booking: (id: string) => ["booking", "detail", id] as const,
  bookingDetailsAll: ["booking", "detail"] as const,
  bookingPages: ["booking", "pages"] as const,
  intake: (status?: IntakeStatus) => ["intake", "items", status ?? "all"] as const,
  intakeAll: ["intake", "items"] as const,
  pipelines: ["crm", "pipelines"] as const,
  /** Pages of the customer list for one search; "" is the whole list. */
  contacts: (search = "") => ["crm", "contacts", "list", search] as const,
  /** Customers by ID, sorted, such as the ones a page of deals names. */
  contactNames: (ids: readonly string[]) => ["crm", "contacts", "names", ids] as const,
  contactsAll: ["crm", "contacts"] as const,
  contact: (id: string) => ["crm", "contact", id] as const,
  deals: (query: DealListQuery = {}) => ["crm", "deals", query] as const,
  dealsAll: ["crm", "deals"] as const,
  results: (query: HomeResultsQuery) => ["home", "results", query] as const,
  resultsAll: ["home", "results"] as const,
  /** Pages of the thread list, latest activity first. */
  threads: ["inbox", "threads"] as const,
  thread: (id: string) => ["inbox", "thread", id] as const,
  inboxAll: ["inbox"] as const,
  /** The follow-up agent's status and settings (agents.md G-11). */
  followUp: ["agents", "followup", "status"] as const,
  /** Pages of the agent's runs, newest first. */
  followUpRuns: ["agents", "followup", "runs"] as const,
  followUpRun: (id: string) => ["agents", "followup", "run", id] as const,
  /** Website tasks (browser-tasks.md): status, runs and one run's steps and files. */
  browser: ["agents", "browser", "status"] as const,
  browserRuns: ["agents", "browser", "runs"] as const,
  browserRun: (id: string) => ["agents", "browser", "run", id] as const,
  /** The agent's actor ID, derived from the tenant (agents.md G-1). */
  agentActor: ["agents", "actor"] as const,
  agentsAll: ["agents"] as const,
  /** The business profile (business-profile.md BP-5). */
  business: ["business"] as const,
  /** One customer's company details and lookups (enrichment.md E-17). */
  contactEnrichment: (id: string) => ["crm", "contact", id, "enrichment"] as const,
  usage: ["ws", "usage"] as const,
  checklist: ["ws", "checklist"] as const,
  sites: ["sites", "list"] as const,
  siteReleases: (siteId: string) => ["sites", "releases", siteId] as const,
  siteRelease: (siteId: string, releaseId: string) => ["sites", "release", siteId, releaseId] as const,
  sitesAll: ["sites"] as const,
  /** Transcripts of uploaded audio and voicemails (transcription.md X-7). */
  transcriptions: ["transcriptions", "list"] as const,
  transcription: (id: string) => ["transcriptions", "detail", id] as const,
  /** Price lists read into rows for the owner to review (document-intake.md DL-12). */
  intakeJobs: ["docIntake", "jobs"] as const,
  intakeJob: (id: string) => ["docIntake", "job", id] as const,
  docIntakeAll: ["docIntake"] as const,
  /**
   * Whether the site shows the release live at one pointer version. Outside "sites", so
   * refreshing the lists does not re-sync; per version, so an answer about an older version
   * never stands for a newer one.
   */
  siteEdge: (siteId: string, pointerVersion: number) => ["siteEdge", siteId, pointerVersion] as const,
  connections: ["ws", "connections"] as const,
  /** Google Calendar connections, every resource's (google-calendar.md G-5). */
  calendarConnections: ["calendarSync", "connections"] as const,
  /** The Google grant waiting in this browser for the owner to confirm (G-2). */
  calendarPending: ["calendarSync", "pending"] as const,
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

/**
 * Takes a just-booked time out of the cached open times of the booking's own calendar, before
 * the refetch, so reopening the sheet never offers it. Other calendars' lists stay as they are:
 * the same time can still be free there. Invalidate afterwards, so the lists still refetch.
 */
export function dropBookedTime(queryClient: QueryClient, slotsKey: QueryKey, booking: BookingRecord): void {
  const [taken, takenEnd] = [Date.parse(booking.occupiedStartsAt), Date.parse(booking.occupiedEndsAt)];
  queryClient.setQueriesData<SlotsResponse>({ queryKey: slotsKey }, (current) => current?.resourceId === booking.resourceId
    ? { ...current, slots: current.slots.filter((slot) => Date.parse(slot.endsAt) <= taken || Date.parse(slot.startsAt) >= takenEnd) }
    // Undefined leaves a list untouched, its age and staleness included.
    : undefined);
}

/** The browser's own time zone. */
export function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * The zone the business's times show in: its first calendar's, else the browser's. Home results
 * count weeks in it too, so the owner's week matches the calendar's.
 */
export function useDisplayZone(): string {
  const resources = useResources();
  return resources.data?.[0]?.timeZone ?? browserZone();
}

/** One range of bookings, filtered by the API; a day or week is one short read. */
export function useBookings(query: BookingListQuery = {}) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.bookings(query), queryFn: ({ signal }) => api.listBookings(query, { signal }) });
}

/** One booking and the revision its next customer change must send. */
export function useBooking(id: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && id !== null,
    queryKey: id ? keys.booking(id) : [...keys.bookingDetailsAll, "idle"],
    queryFn: ({ signal }) => api.getBooking(id!, { signal }),
  });
}

/**
 * After a booking's customer changes, every place that names it refetches: the calendar, Home's
 * next appointment and week, a customer page's appointments (all bookings lists), the booking
 * itself, and Home's counts. Awaiting it keeps a dialog on its spinner until the lists are right.
 */
export function refreshBookingCustomer(queryClient: QueryClient, scoped: ScopedKeys): Promise<unknown> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: scoped.bookingsAll }),
    queryClient.invalidateQueries({ queryKey: scoped.bookingDetailsAll }),
    queryClient.invalidateQueries({ queryKey: scoped.resultsAll }),
  ]);
}

/** Website booking requests, newest first (public-intake.md P-12). */
export function useIntakeItems(status?: IntakeStatus) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.intake(status), queryFn: ({ signal }) => api.listIntakeItems(status ? { status } : {}, { signal }) });
}

export function useBookingPages() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.bookingPages, queryFn: () => api.listBookingPages(), staleTime: 5 * 60_000 });
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
    structuralSharing: (previous, next) => preferNewerDeals(previous as ListResult<DealSummary> | undefined, next as ListResult<DealSummary>),
  });
}

/**
 * Home results for one zone and week start (inbox-home.md H-3). Pass null for a member
 * without `reports`: nothing is fetched, so staff never see a 403 for it.
 */
export function useResults(query: HomeResultsQuery | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && query !== null,
    queryKey: query ? keys.results(query) : [...keys.resultsAll, "idle"],
    queryFn: ({ signal }) => api.getResults(query!, { signal }),
    placeholderData: keepPreviousData,
  });
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

/** The inbox list, a page at a time by keyset cursor (inbox-home.md I-8). */
export function useThreads() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useInfiniteQuery({
    enabled,
    queryKey: keys.threads,
    queryFn: ({ pageParam, signal }) => api.listThreads(pageParam ? { cursor: pageParam } : {}, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<ThreadSummary>) => last.nextCursor ?? undefined,
  });
}

/** Threads on the first page that wait for a reply or a review (inbox-home.md I-8). */
export function useInboxCount(): number {
  const threads = useThreads();
  // Signed out, the cache is empty and the count must not linger.
  if (useTenantId() === null) return 0;
  return threads.data?.pages[0]?.items.filter((thread) => thread.needsReply || thread.needsReview).length ?? 0;
}

export function useThread(id: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    queryKey: keys.thread(id ?? "none"),
    queryFn: ({ signal }) => api.getThread(id!, { signal }),
    enabled: enabled && id !== null,
  });
}

/**
 * The follow-up agent's settings, switches and whether it can draft now (agents.md G-11). Read
 * afresh on every visit and each minute while shown: someone else may stop it, and quiet hours
 * begin and end on the clock.
 */
export function useFollowUpStatus() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled, queryKey: keys.followUp, queryFn: ({ signal }) => api.getFollowUpStatus({ signal }), staleTime: 0, refetchInterval: 60_000,
  });
}

/** Website tasks: switches, caps and targets. Read afresh each visit and each minute: someone may stop it. */
export function useBrowserStatus() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled, queryKey: keys.browser, queryFn: ({ signal }) => api.getBrowserStatus({ signal }), staleTime: 0, refetchInterval: 60_000, retry: false,
  });
}

/** Recent website task runs, newest first. A run in progress is read again every few seconds. */
export function useBrowserRuns() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled, queryKey: keys.browserRuns, queryFn: ({ signal }) => api.listBrowserRuns({ signal }),
    refetchInterval: (query) => (query.state.data?.some((run) => run.status === "queued" || run.status === "running") ? 5_000 : false),
  });
}

/** One run with its steps and files; null reads nothing. */
export function useBrowserRun(id: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    queryKey: keys.browserRun(id ?? "none"),
    queryFn: ({ signal }) => api.getBrowserRun(id!, { signal }),
    enabled: enabled && id !== null,
    refetchInterval: (query) => (query.state.data && (query.state.data.run.status === "queued" || query.state.data.run.status === "running") ? 5_000 : false),
  });
}

/**
 * The business profile (business-profile.md BP-5). An API older than the profile answers 404; the
 * caller shows that as "not available yet" (BP-10), so a 404 is not retried.
 */
/**
 * One customer's company details. While a request is still running the page asks again every few
 * seconds, so the answer needs no reload.
 */
export function useContactEnrichment(contactId: string) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled,
    queryKey: keys.contactEnrichment(contactId),
    queryFn: ({ signal }) => api.getContactEnrichment(contactId, { signal }),
    refetchInterval: (query) => (query.state.data?.requests.some((r) => r.status === "pending" || r.status === "leased" || r.status === "uncertain") ? 4_000 : false),
  });
}

export function useBusinessProfile() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  const queryClient = useQueryClient();
  return useQuery({
    enabled,
    queryKey: keys.business,
    // A read that started before a save can land after it: never replace a newer cached revision with an older one.
    queryFn: async ({ signal }) => {
      const read = await api.getBusiness({ signal });
      return newerProfile(queryClient.getQueryData<BusinessProfile>(keys.business), read);
    },
    staleTime: 60_000,
  });
}

/** The agent's runs, newest first, a page at a time by keyset cursor. */
export function useFollowUpRuns() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useInfiniteQuery({
    enabled,
    queryKey: keys.followUpRuns,
    queryFn: ({ pageParam, signal }) => api.listFollowUpRuns(pageParam ? { cursor: pageParam } : {}, { signal }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: Page<FollowUpRun>) => last.nextCursor ?? undefined,
  });
}

/** One run with its decisions; null reads nothing. */
export function useFollowUpRun(id: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    queryKey: keys.followUpRun(id ?? "none"),
    queryFn: ({ signal }) => api.getFollowUpRun(id!, { signal }),
    enabled: enabled && id !== null,
  });
}

/**
 * The follow-up agent's actor ID in this business, so the Inbox can name it as a draft's
 * author. Null until known, or where the page has no Web Crypto.
 */
export function useAgentActorId(): string | null {
  const tenantId = useTenantId();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.agentActor, queryFn: () => agentActorId(tenantId!), staleTime: Infinity, gcTime: Infinity }).data ?? null;
}

export function useTranscriptions() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled,
    queryKey: keys.transcriptions,
    queryFn: ({ signal }) => api.listTranscriptions({ signal }),
    // The worker finishes jobs on its own clock: look again while any recording is still in flight.
    refetchInterval: (query) => (query.state.data?.some((job) => job.status === "queued" || job.status === "running" || job.status === "failed") ? 5000 : false),
  });
}

export function useTranscription(id: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && id !== null,
    queryKey: keys.transcription(id ?? "none"),
    queryFn: ({ signal }) => api.getTranscription(id!, { signal }),
    refetchInterval: (query) => (query.state.data && ["queued", "running", "failed"].includes(query.state.data.status) ? 5000 : false),
  });
}

export function useIntakeJobs(enabledByRole = true) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && enabledByRole,
    queryKey: keys.intakeJobs,
    queryFn: ({ signal }) => api.listIntakeJobs({ signal }),
    // The service reads a file on its own clock: look again while one is waiting or being read.
    refetchInterval: (query) => (query.state.data?.some((job) => job.status === "queued" || job.status === "claimed") ? 5000 : false),
  });
}

export function useIntakeJob(id: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && id !== null,
    queryKey: keys.intakeJob(id ?? "none"),
    queryFn: ({ signal }) => api.getIntakeJob(id!, { signal }),
  });
}

export function useSites() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.sites, queryFn: ({ signal }) => api.listSites({ signal }) });
}

export function useSiteReleases(siteId: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && siteId !== null,
    queryKey: keys.siteReleases(siteId ?? "none"),
    queryFn: ({ signal }) => api.listSiteReleases(siteId!, { signal }),
  });
}

/** A release never changes, so it is read once. */
export function useSiteRelease(siteId: string | null, releaseId: string | null) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && siteId !== null && releaseId !== null,
    queryKey: keys.siteRelease(siteId ?? "none", releaseId ?? "none"),
    queryFn: ({ signal }) => api.getSiteRelease(siteId!, releaseId!, { signal }),
    staleTime: Infinity,
  });
}

/**
 * Whether the site itself shows the release live at `pointerVersion`. Asked with a sync the
 * first time this version is shown (a sync only catches the site up), then set by every
 * publish, rollback and "Update the site now" under the version their answer names. So a
 * pending site stays pending across leaving the page, and a version another owner made live
 * is checked afresh instead of reusing what an earlier version said.
 */
export function useSiteEdge(siteId: string | null, pointerVersion: number, enabled = true) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { keys, enabled: signedIn } = useKeys();
  return useQuery({
    enabled: signedIn && enabled && siteId !== null,
    queryKey: keys.siteEdge(siteId ?? "none", pointerVersion),
    queryFn: async () => {
      const answer = await api.syncSite(siteId!);
      // The pointer may have moved since this page read the site: file the answer under its own version.
      queryClient.setQueryData(keys.siteEdge(siteId!, answer.site.pointerVersion), answer.edge);
      // Another release went live since: reload the site, whose new version then reads that answer.
      if (answer.site.pointerVersion !== pointerVersion) void queryClient.invalidateQueries({ queryKey: keys.sitesAll });
      return answer.edge;
    },
    staleTime: Infinity,
    retry: false,
  });
}

export function useConnections() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.connections, queryFn: () => api.listConnections() });
}

/** How often the connections are read again while the calendar worker has something to finish. */
export const CALENDAR_POLL_MS = 5_000;

/** Waiting on the worker: a disconnect to clean up, or a new connection's first sync. */
export function calendarWorkPending(items: readonly CalendarConnection[] | undefined): boolean {
  return items?.some((item) => item.status === "disconnecting" || (item.status === "active" && item.lastSyncedAt === null)) ?? false;
}

/**
 * Every Google Calendar connection of the business, retired ones included. Read again every
 * few seconds while the worker has something to finish, so "Disconnecting" and "Waiting for
 * the first sync" move on by themselves.
 */
export function useCalendarConnections() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled,
    queryKey: keys.calendarConnections,
    queryFn: ({ signal }) => api.listCalendarConnections({ signal }),
    refetchInterval: (query) => (calendarWorkPending(query.state.data) ? CALENDAR_POLL_MS : false),
  });
}

/**
 * The Google grant waiting in this browser for the owner to confirm, or null. Owners only (the
 * API refuses staff). Read afresh whenever the page opens and never kept after it closes, so an
 * old answer never offers a grant that is gone.
 */
export function usePendingGoogleConnect(canManage: boolean) {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({
    enabled: enabled && canManage,
    queryKey: keys.calendarPending,
    queryFn: ({ signal }) => api.getPendingGoogleConnect({ signal }),
    staleTime: 0,
    gcTime: 0,
  });
}

export function usePlan() {
  const api = useApi();
  const { keys, enabled } = useKeys();
  return useQuery({ enabled, queryKey: keys.plan, queryFn: () => api.getPlan() });
}
