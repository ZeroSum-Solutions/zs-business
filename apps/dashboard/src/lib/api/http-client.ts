import { z } from "zod";
import {
  bookingPageSchema,
  contactPageSchema,
  createBookingOutputSchema,
  createOrFindContactOutputSchema,
  dealPageSchema,
  moveDealStageOutputSchema,
  pipelineSummarySchema,
  resourceSummarySchema,
  slotsResponseSchema,
  type CreateBookingRequest,
  type MoveDealStageRequest,
} from "@zs/contracts";
import { ApiError, contactBeyondList, contactNotFound, defaultMessage, errorFromBody } from "./errors";
import {
  byContactName,
  matchesSearch,
  toUpsertContactRequest,
  type BookingApi,
  type CrmApi,
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
}

const resourceListSchema = z.object({ items: z.array(resourceSummarySchema) });
const pipelineListSchema = z.object({ items: z.array(pipelineSummarySchema) });

/** `pageQuerySchema` caps `limit` at 100. */
const PAGE_LIMIT = 100;
/** Stop after this many pages; the pilot has well under 2,000 rows per list. */
export const MAX_PAGES = 20;

export function createHttpClient(config: HttpClientConfig): BookingApi & CrmApi {
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
      });
    } catch {
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
   * Walk `nextOffset` until the list ends or MAX_PAGES pages are read; in the second case
   * the result is marked incomplete. Filters the routes do not offer run on the result.
   */
  async function listAll<Item, T extends z.ZodType<{ items: Item[]; nextOffset: number | null }>>(
    path: string, schema: T, query: Record<string, string | undefined> = {},
  ): Promise<ListResult<z.infer<T>["items"][number]>> {
    const items: z.infer<T>["items"] = [];
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < MAX_PAGES; page += 1) {
      const result: z.infer<T> = await request({
        method: "GET", path, query: { ...query, limit: PAGE_LIMIT, offset }, schema,
      });
      items.push(...result.items);
      offset = result.nextOffset;
    }
    return { items, incomplete: offset !== null, loaded: items.length };
  }

  const write = <T extends z.ZodType>(path: string, body: unknown, schema: T, options: WriteOptions) =>
    request({ method: "POST", path, body, idempotencyKey: options?.idempotencyKey, schema });

  return {
    async listResources() {
      return (await request({ method: "GET", path: "/v1/booking/resources", schema: resourceListSchema })).items;
    },

    getSlots(query) {
      return request({
        method: "GET",
        path: "/v1/booking/slots",
        query: { resourceId: query.resourceId, from: query.from, to: query.to, zone: query.zone },
        schema: slotsResponseSchema,
      });
    },

    async listBookings(query = {}) {
      const list = await listAll("/v1/booking/bookings", bookingPageSchema, { resourceId: query.resourceId });
      const fromMs = query.from ? Date.parse(query.from) : -Infinity;
      const toMs = query.to ? Date.parse(query.to) : Infinity;
      const items = list.items
        .filter((row) => Date.parse(row.endsAt) > fromMs && Date.parse(row.startsAt) < toMs)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return { ...list, items };
    },

    async createBooking(input, options) {
      const body: CreateBookingRequest = { resourceId: input.resourceId, startsAt: input.startsAt };
      return (await write("/v1/booking/bookings", body, createBookingOutputSchema, options)).result;
    },

    async listPipelines() {
      const { items } = await request({ method: "GET", path: "/v1/crm/pipelines", schema: pipelineListSchema });
      return items.map((pipeline) => ({ ...pipeline, stages: [...pipeline.stages].sort((a, b) => a.position - b.position) }));
    },

    async listContacts(query = {}) {
      const list = await listAll("/v1/crm/contacts", contactPageSchema);
      return { ...list, items: list.items.filter((row) => matchesSearch(row, query.search)).sort(byContactName) };
    },

    async getContact(id) {
      // There is no single-contact route; the list is small and already cached per page.
      const list = await listAll("/v1/crm/contacts", contactPageSchema);
      const contact = list.items.find((item) => item.id === id);
      if (contact) return contact;
      // Past the cap the customer may exist after all: say so instead of "not found".
      throw list.incomplete ? contactBeyondList(list.loaded) : contactNotFound();
    },

    async createOrFindContact(input, options) {
      return (await write("/v1/crm/contacts", toUpsertContactRequest(input), createOrFindContactOutputSchema, options)).result;
    },

    async listDeals(query = {}) {
      const list = await listAll("/v1/crm/deals", dealPageSchema);
      const items = list.items
        .filter((row) => !query.contactId || row.contactId === query.contactId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return { ...list, items };
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
  };
}
