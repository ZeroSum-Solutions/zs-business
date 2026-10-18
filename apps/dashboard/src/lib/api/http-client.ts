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
  type UpsertContactRequest,
} from "@zs/contracts";
import { newId as defaultNewId } from "../id";
import { ApiError, defaultMessage, errorFromBody } from "./errors";
import {
  byContactName,
  matchesSearch,
  normalizePhone,
  type BookingApi,
  type CrmApi,
  type WriteOptions,
} from "./types";

export interface HttpClientConfig {
  baseUrl: string;
  /** Returns the bearer JWT, or null when signed out. */
  getToken: () => string | null;
  fetch?: typeof fetch;
  newId?: () => string;
}

type Method = "GET" | "POST";

interface RequestSpec<T extends z.ZodType> {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string | undefined;
  schema: T;
}

const resourceListSchema = z.object({ items: z.array(resourceSummarySchema) });
const pipelineListSchema = z.object({ items: z.array(pipelineSummarySchema) });

/** `pageQuerySchema` caps `limit` at 100. */
const PAGE_LIMIT = 100;
/** Stop after this many pages; the pilot has well under 2,000 rows per list. */
const MAX_PAGES = 20;

export function createHttpClient(config: HttpClientConfig): BookingApi & CrmApi {
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const newId = config.newId ?? defaultNewId;
  const base = config.baseUrl.replace(/\/+$/, "");

  async function request<T extends z.ZodType>(spec: RequestSpec<T>): Promise<z.infer<T>> {
    const url = new URL(base + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = config.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";
    if (spec.method !== "GET") headers["Idempotency-Key"] = spec.idempotencyKey ?? newId();

    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: spec.method,
        headers,
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

  /** Walk `nextOffset` until the list ends. Filters the routes do not offer run on the result. */
  async function listAll<T extends z.ZodType<{ items: unknown[]; nextOffset: number | null }>>(
    path: string, schema: T, query: Record<string, string | undefined> = {},
  ): Promise<z.infer<T>["items"]> {
    const items: z.infer<T>["items"] = [];
    let offset: number | null = 0;
    for (let page = 0; offset !== null && page < MAX_PAGES; page += 1) {
      const result: z.infer<T> = await request({
        method: "GET", path, query: { ...query, limit: PAGE_LIMIT, offset }, schema,
      });
      items.push(...result.items);
      offset = result.nextOffset;
    }
    return items;
  }

  const write = <T extends z.ZodType>(path: string, body: unknown, schema: T, options: WriteOptions) =>
    request({ method: "POST", path, body, idempotencyKey: options.idempotencyKey, schema });

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
      const rows = await listAll("/v1/booking/bookings", bookingPageSchema, { resourceId: query.resourceId });
      const fromMs = query.from ? Date.parse(query.from) : -Infinity;
      const toMs = query.to ? Date.parse(query.to) : Infinity;
      return rows
        .filter((row) => Date.parse(row.endsAt) > fromMs && Date.parse(row.startsAt) < toMs)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    },

    async createBooking(input, options = {}) {
      const body: CreateBookingRequest = { resourceId: input.resourceId, startsAt: input.startsAt };
      return (await write("/v1/booking/bookings", body, createBookingOutputSchema, options)).result;
    },

    async listPipelines() {
      const { items } = await request({ method: "GET", path: "/v1/crm/pipelines", schema: pipelineListSchema });
      return items.map((pipeline) => ({ ...pipeline, stages: [...pipeline.stages].sort((a, b) => a.position - b.position) }));
    },

    async listContacts(query = {}) {
      const rows = await listAll("/v1/crm/contacts", contactPageSchema);
      return rows.filter((row) => matchesSearch(row, query.search)).sort(byContactName);
    },

    async getContact(id) {
      // There is no single-contact route; the list is small and already cached per page.
      const contact = (await listAll("/v1/crm/contacts", contactPageSchema)).find((item) => item.id === id);
      if (!contact) throw new ApiError("not_found", "We could not find that customer.", 404, "NotFound");
      return contact;
    },

    async createOrFindContact(input, options = {}) {
      const body: UpsertContactRequest = {
        displayName: input.displayName,
        email: input.email,
        phone: input.phone === null ? null : normalizePhone(input.phone),
        mode: "interactive",
        consent: { email: null, sms: null },
      };
      return (await write("/v1/crm/contacts", body, createOrFindContactOutputSchema, options)).result;
    },

    async listDeals(query = {}) {
      const rows = await listAll("/v1/crm/deals", dealPageSchema);
      return rows
        .filter((row) => !query.contactId || row.contactId === query.contactId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async moveDealStage(input, options = {}) {
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
