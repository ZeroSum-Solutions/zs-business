import { z } from "zod";
import {
  bookingPageSchema,
  bookingPageSummarySchema,
  intakeItemOutputSchema,
  intakeItemPageSchema,
  contactPageSchema,
  contactRecordSchema,
  createBookingOutputSchema,
  createOrFindContactOutputSchema,
  dealPageSchema,
  moveDealStageOutputSchema,
  pipelineSummarySchema,
  resourceSummarySchema,
  slotsResponseSchema,
  uuidSchema,
  type CreateBookingRequest,
  type LinkIntakeItemRequest,
  type MoveDealStageRequest,
} from "@zs/contracts";
import { ApiError, contactNotFound, defaultMessage, errorFromBody, isApiError } from "./errors";
import {
  CONTACT_PAGE_SIZE,
  toUpsertContactRequest,
  type BookingApi,
  type CrmApi,
  type IntakeApi,
  type ListResult,
  type WriteOptions,
} from "./types";

export interface HttpClientConfig {
  /** Absolute API URL, or a same-origin path such as "/api" (the dashboard's proxy). */
  baseUrl: string;
  /** Returns a bearer JWT to send. The dashboard leaves it out: its proxy adds the token. */
  getToken?: () => string | null;
  fetch?: typeof fetch;
}

type Method = "GET" | "POST";

interface RequestSpec<T extends z.ZodType> {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  schema: T;
  signal?: AbortSignal | undefined;
}

const resourceListSchema = z.object({ items: z.array(resourceSummarySchema) });
const pipelineListSchema = z.object({ items: z.array(pipelineSummarySchema) });
const bookingPageListSchema = z.object({ items: z.array(bookingPageSummarySchema) });

/** `pageQuerySchema` caps `limit` at 100. */
const PAGE_LIMIT = 100;
/**
 * Stop after this many pages of one filtered list: a calendar day or week, or one customer's
 * or pipeline's deals. The API filters first, so older rows never count against the cap.
 */
export const MAX_PAGES = 20;

export function createHttpClient(config: HttpClientConfig): BookingApi & CrmApi & IntakeApi {
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
    if (spec.method !== "GET") {
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
    try {
      json = await response.json();
    } catch {
      if (!response.ok) throw errorFromBody(response.status, null);
      throw new ApiError("invalid_response", defaultMessage("invalid_response"), response.status);
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

  const write = <T extends z.ZodType>(path: string, body: unknown, schema: T, options: WriteOptions) =>
    request({ method: "POST", path, body, idempotencyKey: options?.idempotencyKey, schema });

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
      const filters = { resourceId: query.resourceId, from: query.from, to: query.to };
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
  };
}
