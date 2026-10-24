import { z } from "zod";
import {
  bookingContactOutputSchema,
  bookingDetailSchema,
  bookingPageSchema,
  bookingPageSummarySchema,
  businessProfileReadSchema,
  calendarConnectionListSchema,
  calendarConnectionSchema,
  connectGoogleCalendarResponseSchema,
  pendingGoogleConnectSchema,
  intakeItemOutputSchema,
  intakeItemPageSchema,
  contactPageSchema,
  contactRecordSchema,
  createBookingOutputSchema,
  createOrFindContactOutputSchema,
  dealPageSchema,
  followUpRunDetailSchema,
  followUpRunPageSchema,
  followUpStatusOutputSchema,
  followUpStatusSchema,
  homeResultsSchema,
  moveDealStageOutputSchema,
  pipelineSummarySchema,
  replyOutputSchema,
  resourceSummarySchema,
  setDealDetailsOutputSchema,
  siteListSchema,
  siteOutputSchema,
  sitePreviewSchema,
  siteReleaseDetailSchema,
  siteReleaseListSchema,
  siteReleaseResponseSchema,
  siteSyncResponseSchema,
  slotsResponseSchema,
  transcriptionDetailSchema,
  transcriptionListSchema,
  threadDetailSchema,
  threadIdSchema,
  threadPageSchema,
  uuidSchema,
  type CreateBookingRequest,
  type DraftReplyRequest,
  type KillFollowUpRequest,
  type LinkIntakeItemRequest,
  type MoveDealStageRequest,
  type SetDealDetailsRequest,
  type UpdateFollowUpSettingsRequest,
} from "@zs/contracts";
import { ApiError, contactNotFound, defaultMessage, errorFromBody, isApiError, runNotFound, threadNotFound } from "./errors";
import {
  CONTACT_PAGE_SIZE,
  RUN_PAGE_SIZE,
  THREAD_PAGE_SIZE,
  toUpsertContactRequest,
  type AgentsApi,
  type BusinessApi,
  type BookingApi,
  type CalendarSyncApi,
  type CrmApi,
  type HomeApi,
  type InboxApi,
  type IntakeApi,
  type ListResult,
  type SitesApi,
  type TranscriptionApi,
  type WriteOptions,
} from "./types";

export interface HttpClientConfig {
  /** Absolute API URL, or a same-origin path such as "/api" (the dashboard's proxy). */
  baseUrl: string;
  /** Returns a bearer JWT to send. The dashboard leaves it out: its proxy adds the token. */
  getToken?: () => string | null;
  fetch?: typeof fetch;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface RequestSpec<T extends z.ZodType> {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  /**
   * Why a request other than a GET takes no Idempotency-Key; every other write needs one from
   * the caller. `read_only`: it changes nothing (a preview). `server_keyed`: the server runs it
   * under a key it derives itself (confirming a staged Google grant uses the grant's). `repeatable`:
   * repeating it leaves the same state (dropping a cookie).
   */
  keyless?: "read_only" | "server_keyed" | "repeatable";
  schema: T;
  signal?: AbortSignal | undefined;
}

const resourceListSchema = z.object({ items: z.array(resourceSummarySchema) });
const pipelineListSchema = z.object({ items: z.array(pipelineSummarySchema) });
const bookingPageListSchema = z.object({ items: z.array(bookingPageSummarySchema) });
/** POST /v1/calendar/connections/:id/disconnect answers the action and the connection as it is now. */
const disconnectCalendarOutputSchema = z.object({ actionId: uuidSchema, result: calendarConnectionSchema });
/** PUT /v1/business answers the action and the profile as it is now; a newer API's extra keys are dropped (BP-10). */
const businessOutputSchema = z.object({ actionId: uuidSchema, result: businessProfileReadSchema });

/** `pageQuerySchema` caps `limit` at 100. */
const PAGE_LIMIT = 100;
/**
 * Stop after this many pages of one filtered list: a calendar day or week, or one customer's
 * or pipeline's deals. The API filters first, so older rows never count against the cap.
 */
export const MAX_PAGES = 20;

export type HttpApi = BookingApi & CrmApi & IntakeApi & InboxApi & HomeApi & AgentsApi & BusinessApi & SitesApi & CalendarSyncApi & TranscriptionApi;

export function createHttpClient(config: HttpClientConfig): HttpApi {
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const base = config.baseUrl.replace(/\/+$/, "");

  async function request<T extends z.ZodType>(spec: RequestSpec<T>): Promise<z.infer<T>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined && value !== "") search.set(key, String(value));
    }
    const url = search.size > 0 ? `${base}${spec.path}?${search}` : `${base}${spec.path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = config.getToken?.() ?? null;
    if (token) headers.Authorization = `Bearer ${token}`;
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    if (spec.method !== "GET" && !spec.keyless) {
      // The caller owns the key, so a retry can reuse it. A made-up key would turn a retry
      // after a lost answer into a second write.
      if (!spec.idempotencyKey) throw new TypeError(`${spec.method} ${spec.path} needs an Idempotency-Key from the caller`);
      headers["Idempotency-Key"] = spec.idempotencyKey;
    }

    let response: Response;
    try {
      response = await doFetch(url, {
        method: spec.method,
        headers,
        // Business data never goes to the HTTP cache, in the browser or in Next's fetch cache.
        cache: "no-store",
        ...(spec.body !== undefined ? { body: JSON.stringify(spec.body) } : {}),
        ...(spec.signal ? { signal: spec.signal } : {}),
      });
    } catch (error) {
      // A read the caller gave up on is not an outage; React Query drops it.
      if (spec.signal?.aborted) throw error;
      throw new ApiError("network", defaultMessage("network"));
    }

    let json: unknown;
    // 204 has no body; the schema says whether that is the expected answer.
    if (response.status !== 204) {
      try {
        json = await response.json();
      } catch {
        if (!response.ok) throw errorFromBody(response.status, null);
        throw new ApiError("invalid_response", defaultMessage("invalid_response"), response.status);
      }
    }
    if (!response.ok) throw errorFromBody(response.status, json);

    const parsed = spec.schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError("invalid_response", defaultMessage("invalid_response"), response.status, null, {
        issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      });
    }
    return parsed.data;
  }

  /**
   * Walk `nextCursor` through a list the API already filtered, until it ends or MAX_PAGES
   * pages are read; in the second case the result is marked incomplete. A cursor, unlike an
   * offset, does not repeat or skip a row when another is added or moved between pages.
   */
  async function listAll<Item, T extends z.ZodType<{ items: Item[]; nextCursor: string | null }>>(
    path: string, schema: T, query: Record<string, string | undefined>, signal: AbortSignal | undefined,
  ): Promise<ListResult<z.infer<T>["items"][number]>> {
    const items: z.infer<T>["items"] = [];
    let cursor: string | null | undefined;
    for (let page = 0; cursor !== null && page < MAX_PAGES; page += 1) {
      const result: z.infer<T> = await request({
        method: "GET", path, query: { ...query, limit: PAGE_LIMIT, cursor: cursor ?? undefined }, schema, signal,
      });
      items.push(...result.items);
      cursor = result.nextCursor;
    }
    return { items, incomplete: cursor !== null, loaded: items.length };
  }

  const write = <T extends z.ZodType>(path: string, body: unknown, schema: T, options: WriteOptions, method: Method = "POST") =>
    request({ method, path, body, idempotencyKey: options?.idempotencyKey, schema });

  const FOLLOW_UP = "/v1/agents/followup";

  return {
    async listResources(options = {}) {
      return (await request({ method: "GET", path: "/v1/booking/resources", schema: resourceListSchema, signal: options.signal })).items;
    },

    getSlots(query, options = {}) {
      return request({
        method: "GET",
        path: "/v1/booking/slots",
        query: { resourceId: query.resourceId, from: query.from, to: query.to, zone: query.zone },
        schema: slotsResponseSchema,
        signal: options.signal,
      });
    },

    async listBookings(query = {}, options = {}) {
      const filters = { resourceId: query.resourceId, from: query.from, to: query.to, contactId: query.contactId };
      if (query.limit === undefined) return listAll("/v1/booking/bookings", bookingPageSchema, filters, options.signal);
      const page = await request({
        method: "GET", path: "/v1/booking/bookings", query: { ...filters, limit: query.limit },
        schema: bookingPageSchema, signal: options.signal,
      });
      return { items: page.items, incomplete: false, loaded: page.items.length };
    },

    async createBooking(input, options) {
      const body: CreateBookingRequest = { resourceId: input.resourceId, startsAt: input.startsAt };
      return (await write("/v1/booking/bookings", body, createBookingOutputSchema, options)).result;
    },

    getBooking(id, options = {}) {
      return request({ method: "GET", path: `/v1/booking/bookings/${encodeURIComponent(id)}`, schema: bookingDetailSchema, signal: options.signal });
    },

    async linkBookingContact(input, options) {
      const body = { contactId: input.contactId, expectedRevision: input.expectedRevision };
      return (await write(`/v1/booking/bookings/${encodeURIComponent(input.bookingId)}/contact/link`, body, bookingContactOutputSchema, options)).result;
    },

    async unlinkBookingContact(input, options) {
      const body = { expectedRevision: input.expectedRevision };
      return (await write(`/v1/booking/bookings/${encodeURIComponent(input.bookingId)}/contact/unlink`, body, bookingContactOutputSchema, options)).result;
    },

    async listPipelines(options = {}) {
      const { items } = await request({ method: "GET", path: "/v1/crm/pipelines", schema: pipelineListSchema, signal: options.signal });
      return items.map((pipeline) => ({ ...pipeline, stages: [...pipeline.stages].sort((a, b) => a.position - b.position) }));
    },

    async listContacts(query = {}, options = {}) {
      const page = await request({
        method: "GET",
        path: "/v1/crm/contacts",
        query: {
          sort: "name",
          search: query.search?.trim(),
          ids: query.ids?.join(","),
          limit: query.limit ?? CONTACT_PAGE_SIZE,
          cursor: query.cursor,
        },
        schema: contactPageSchema,
        signal: options.signal,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    },

    async getContact(id, options = {}) {
      // A malformed ID in the address bar is an unknown customer, not a bad request.
      if (!uuidSchema.safeParse(id).success) throw contactNotFound();
      try {
        return await request({ method: "GET", path: `/v1/crm/contacts/${encodeURIComponent(id)}`, schema: contactRecordSchema, signal: options.signal });
      } catch (error) {
        throw isApiError(error) && error.kind === "not_found" ? contactNotFound() : error;
      }
    },

    async createOrFindContact(input, options) {
      return (await write("/v1/crm/contacts", toUpsertContactRequest(input), createOrFindContactOutputSchema, options)).result;
    },

    listDeals(query = {}, options = {}) {
      return listAll("/v1/crm/deals", dealPageSchema, { contactId: query.contactId, pipelineId: query.pipelineId }, options.signal);
    },

    async moveDealStage(input, options) {
      const body: MoveDealStageRequest = {
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        expectedRevision: input.expectedRevision,
      };
      const path = `/v1/crm/deals/${encodeURIComponent(input.dealId)}/stage`;
      return (await write(path, body, moveDealStageOutputSchema, options)).result;
    },

    async setDealDetails(input, options) {
      const body: SetDealDetailsRequest = { expectedRevision: input.expectedRevision, value: input.value, leadSource: input.leadSource };
      const path = `/v1/crm/deals/${encodeURIComponent(input.dealId)}/details`;
      return (await write(path, body, setDealDetailsOutputSchema, options)).result;
    },

    listIntakeItems(query = {}, options = {}) {
      return listAll("/v1/intake/items", intakeItemPageSchema, { status: query.status }, options.signal);
    },

    async linkIntakeItem(input, options) {
      const body: LinkIntakeItemRequest = { contactId: input.contactId };
      const path = `/v1/intake/items/${encodeURIComponent(input.itemId)}/link`;
      return (await write(path, body, intakeItemOutputSchema, options)).result;
    },

    async rejectIntakeItem(itemId, options) {
      const path = `/v1/intake/items/${encodeURIComponent(itemId)}/reject`;
      return (await write(path, {}, intakeItemOutputSchema, options)).result;
    },

    async listBookingPages() {
      return (await request({ method: "GET", path: "/v1/booking/pages", schema: bookingPageListSchema })).items;
    },

    async listThreads(query = {}, options = {}) {
      const page = await request({
        method: "GET",
        path: "/v1/inbox/threads",
        query: { limit: query.limit ?? THREAD_PAGE_SIZE, cursor: query.cursor },
        schema: threadPageSchema,
        signal: options.signal,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    },

    async getThread(id, options = {}) {
      // A malformed ID in the address bar is an unknown conversation, not a bad request.
      if (!threadIdSchema.safeParse(id).success) throw threadNotFound();
      try {
        return await request({ method: "GET", path: `/v1/inbox/threads/${encodeURIComponent(id)}`, schema: threadDetailSchema, signal: options.signal });
      } catch (error) {
        throw isApiError(error) && error.kind === "not_found" ? threadNotFound() : error;
      }
    },

    async draftReply(input, options) {
      const body: DraftReplyRequest = { contactId: input.contactId, subject: input.subject, body: input.body };
      return (await write("/v1/inbox/replies", body, replyOutputSchema, options)).result;
    },

    async approveReply(replyId, options) {
      return (await write(`/v1/inbox/replies/${encodeURIComponent(replyId)}/approve`, {}, replyOutputSchema, options)).result;
    },

    async discardReply(replyId, options) {
      return (await write(`/v1/inbox/replies/${encodeURIComponent(replyId)}/discard`, {}, replyOutputSchema, options)).result;
    },

    getResults(query, options = {}) {
      return request({
        method: "GET",
        path: "/v1/home/results",
        query: { zone: query.zone, weekStart: query.weekStart },
        schema: homeResultsSchema,
        signal: options.signal,
      });
    },

    async listTranscriptions(options = {}) {
      return (await request({ method: "GET", path: "/v1/transcriptions", schema: transcriptionListSchema, signal: options.signal })).items;
    },

    getTranscription(id, options = {}) {
      return request({ method: "GET", path: `/v1/transcriptions/${encodeURIComponent(id)}`, schema: transcriptionDetailSchema, signal: options.signal });
    },

    async listSites(options = {}) {
      return (await request({ method: "GET", path: "/v1/sites", schema: siteListSchema, signal: options.signal })).items;
    },

    async createSite(name, options) {
      return (await write("/v1/sites", { name }, siteOutputSchema, options)).result;
    },

    async listSiteReleases(siteId, options = {}) {
      const path = `/v1/sites/${encodeURIComponent(siteId)}/releases`;
      return (await request({ method: "GET", path, schema: siteReleaseListSchema, signal: options.signal })).items;
    },

    getSiteRelease(siteId, releaseId, options = {}) {
      const path = `/v1/sites/${encodeURIComponent(siteId)}/releases/${encodeURIComponent(releaseId)}`;
      return request({ method: "GET", path, schema: siteReleaseDetailSchema, signal: options.signal });
    },

    previewSite(siteId, spec) {
      const path = `/v1/sites/${encodeURIComponent(siteId)}/preview`;
      return request({ method: "POST", path, body: { spec }, keyless: "read_only", schema: sitePreviewSchema });
    },

    publishSite(input, options) {
      const body = { spec: input.spec, expectedCurrentReleaseId: input.expectedCurrentReleaseId };
      return write(`/v1/sites/${encodeURIComponent(input.siteId)}/releases`, body, siteReleaseResponseSchema, options);
    },

    activateSiteRelease(input, options) {
      const path = `/v1/sites/${encodeURIComponent(input.siteId)}/releases/${encodeURIComponent(input.releaseId)}/activate`;
      return write(path, { expectedCurrentReleaseId: input.expectedCurrentReleaseId }, siteReleaseResponseSchema, options);
    },

    syncSite(siteId) {
      return request({ method: "POST", path: `/v1/sites/${encodeURIComponent(siteId)}/sync`, body: {}, keyless: "read_only", schema: siteSyncResponseSchema });
    },

    async listCalendarConnections(options = {}) {
      return (await request({ method: "GET", path: "/v1/calendar/connections", schema: calendarConnectionListSchema, signal: options.signal })).items;
    },

    startGoogleConnect(resourceId, options) {
      // Only the resource: the dashboard's server proxy adds what binds the flow to this browser.
      return write("/v1/calendar/google/connect", { resourceId }, connectGoogleCalendarResponseSchema, options);
    },

    async getPendingGoogleConnect(options = {}) {
      try {
        return await request({ method: "GET", path: "/v1/calendar/google/pending", schema: pendingGoogleConnectSchema, signal: options.signal });
      } catch (error) {
        // None waits in this browser: no cookie, expired, or another member's.
        if (isApiError(error, "not_found")) return null;
        throw error;
      }
    },

    confirmGoogleConnect(grantId) {
      // The server keys the connect by the staged grant, so a retry after a lost answer replays
      // it; a key from here could not name the grant any better. The grant ID names the grant the
      // owner was shown, so one that replaced it is refused rather than connected.
      return request({ method: "POST", path: "/v1/calendar/google/confirm", body: { grantId }, keyless: "server_keyed", schema: calendarConnectionSchema });
    },

    async discardGoogleConnect() {
      // The dashboard's own route (not the API's): it clears the cookie that holds the grant.
      await request({ method: "DELETE", path: "/calendar/google/pending", keyless: "repeatable", schema: z.undefined() });
    },

    async disconnectCalendar(connectionId, options) {
      const path = `/v1/calendar/connections/${encodeURIComponent(connectionId)}/disconnect`;
      return (await write(path, {}, disconnectCalendarOutputSchema, options)).result;
    },

    getBusiness(options = {}) {
      return request({ method: "GET", path: "/v1/business", schema: businessProfileReadSchema, signal: options.signal });
    },

    async updateBusiness(input, options) {
      return (await write("/v1/business", input, businessOutputSchema, options, "PUT")).result;
    },

    getFollowUpStatus(options = {}) {
      return request({ method: "GET", path: FOLLOW_UP, schema: followUpStatusSchema, signal: options.signal });
    },

    async updateFollowUpSettings(input, options) {
      const body: UpdateFollowUpSettingsRequest = {
        enabled: input.enabled,
        maxDraftsPerDay: input.maxDraftsPerDay,
        maxDraftsPerContact: input.maxDraftsPerContact,
        contactWindowHours: input.contactWindowHours,
        waitHours: input.waitHours,
        lookbackDays: input.lookbackDays,
        quietStartMinute: input.quietStartMinute,
        quietEndMinute: input.quietEndMinute,
        timeZone: input.timeZone,
        expectedRevision: input.expectedRevision,
      };
      return (await write(`${FOLLOW_UP}/settings`, body, followUpStatusOutputSchema, options, "PUT")).result;
    },

    async killFollowUp(input, options) {
      const body: KillFollowUpRequest = input.note === undefined ? {} : { note: input.note };
      return (await write(`${FOLLOW_UP}/kill`, body, followUpStatusOutputSchema, options)).result;
    },

    async resumeFollowUp(options) {
      return (await write(`${FOLLOW_UP}/resume`, {}, followUpStatusOutputSchema, options)).result;
    },

    startFollowUpRun(options) {
      return write(`${FOLLOW_UP}/runs`, {}, followUpRunDetailSchema, options);
    },

    async listFollowUpRuns(query = {}, options = {}) {
      const page = await request({
        method: "GET",
        path: `${FOLLOW_UP}/runs`,
        query: { limit: query.limit ?? RUN_PAGE_SIZE, cursor: query.cursor },
        schema: followUpRunPageSchema,
        signal: options.signal,
      });
      return { items: page.items, nextCursor: page.nextCursor };
    },

    async getFollowUpRun(id, options = {}) {
      if (!uuidSchema.safeParse(id).success) throw runNotFound();
      try {
        return await request({ method: "GET", path: `${FOLLOW_UP}/runs/${encodeURIComponent(id)}`, schema: followUpRunDetailSchema, signal: options.signal });
      } catch (error) {
        throw isApiError(error) && error.kind === "not_found" ? runNotFound() : error;
      }
    },
  };
}
