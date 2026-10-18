import type { z } from "zod";
import {
  createBookingOutputSchema,
  createOrFindContactOutputSchema,
  getAvailableSlotsOutputSchema,
  moveDealStageOutputSchema,
  type CreateBookingInput,
  type CreateOrFindContactInput,
  type MoveDealStageInput,
} from "@zs/contracts";
import { newId as defaultNewId } from "../id";
import { ApiError, defaultMessage, kindForStatus } from "./errors";
import {
  bookingPageSchema,
  contactPageSchema,
  dealPageSchema,
  type BookingApi,
  type BookingResourceSummary,
  type CrmApi,
  type PipelineSummary,
  type WriteOptions,
} from "./types";

export interface HttpClientConfig {
  baseUrl: string;
  /** Returns the bearer JWT, or null when signed out. */
  getToken: () => string | null;
  fetch?: typeof fetch;
  newId?: () => string;
  // TODO(contracts): replace with GET routes once the API exposes resources and pipelines.
  resources: BookingResourceSummary[];
  pipeline: PipelineSummary | null;
}

type Method = "GET" | "POST";

interface RequestSpec<T extends z.ZodType> {
  method: Method;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  idempotencyKey?: string;
  schema: T;
}

/** Read the shared error body leniently: `{ error: { code, message, details } }` or flat. */
async function readError(response: Response): Promise<ApiError> {
  const kind = kindForStatus(response.status);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const inner = (typeof record.error === "object" && record.error !== null ? record.error : record) as Record<string, unknown>;
  const code = typeof inner.code === "string" ? inner.code : null;
  const message = typeof inner.message === "string" && inner.message.length > 0 ? inner.message : defaultMessage(kind);
  const details = typeof inner.details === "object" && inner.details !== null ? inner.details as Record<string, unknown> : {};
  return new ApiError(kind, message, response.status, code, details);
}

export function createHttpClient(config: HttpClientConfig): BookingApi & CrmApi {
  const doFetch = config.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const newId = config.newId ?? defaultNewId;
  const base = config.baseUrl.replace(/\/+$/, "");

  async function request<T extends z.ZodType>(spec: RequestSpec<T>): Promise<z.infer<T>> {
    const url = new URL(base + spec.path);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
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
    if (!response.ok) throw await readError(response);

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError("invalid_response", defaultMessage("invalid_response"), response.status);
    }
    const parsed = spec.schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError("invalid_response", defaultMessage("invalid_response"), response.status, null, {
        issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      });
    }
    return parsed.data;
  }

  // TODO(contracts): paging. One page of up to 200 rows covers the pilot.
  const LIST_LIMIT = "200";

  return {
    async listResources() {
      return config.resources;
    },

    getSlots(query) {
      return request({
        method: "GET",
        path: "/v1/booking/slots",
        query: { resourceId: query.resourceId, from: query.from, to: query.to, zone: query.zone },
        schema: getAvailableSlotsOutputSchema,
      });
    },

    async listBookings(query = {}) {
      const page = await request({
        method: "GET",
        path: "/v1/booking/bookings",
        query: { resourceId: query.resourceId, from: query.from, to: query.to, limit: LIST_LIMIT },
        schema: bookingPageSchema,
      });
      return page.items;
    },

    async createBooking(input, options: WriteOptions = {}) {
      const body: CreateBookingInput = {
        bookingId: input.bookingId ?? newId(),
        resourceId: input.resourceId,
        startsAt: input.startsAt,
      };
      const output = await request({
        method: "POST",
        path: "/v1/booking/bookings",
        body,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        schema: createBookingOutputSchema,
      });
      return output.result;
    },

    async getPipeline() {
      if (!config.pipeline) {
        throw new ApiError("not_found", "No pipeline is set up yet.", null);
      }
      return config.pipeline;
    },

    async listContacts(query = {}) {
      const page = await request({
        method: "GET",
        path: "/v1/crm/contacts",
        // TODO(contracts): `q` search parameter is proposed, not yet agreed.
        query: { q: query.search?.trim(), limit: LIST_LIMIT },
        schema: contactPageSchema,
      });
      return page.items;
    },

    async getContact(id) {
      // TODO(contracts): no single-contact route; read the list and pick one.
      const page = await request({ method: "GET", path: "/v1/crm/contacts", query: { limit: LIST_LIMIT }, schema: contactPageSchema });
      const contact = page.items.find((item) => item.id === id);
      if (!contact) throw new ApiError("not_found", "We could not find that customer.", 404);
      return contact;
    },

    async createOrFindContact(input, options: WriteOptions = {}) {
      const body: CreateOrFindContactInput = {
        contactId: input.contactId ?? newId(),
        displayName: input.displayName,
        email: input.email,
        phone: input.phone,
        mode: "interactive",
        consent: { email: null, sms: null },
      };
      const output = await request({
        method: "POST",
        path: "/v1/crm/contacts",
        body,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        schema: createOrFindContactOutputSchema,
      });
      return output.result;
    },

    async listDeals(query = {}) {
      const page = await request({
        method: "GET",
        path: "/v1/crm/deals",
        query: { contactId: query.contactId, limit: LIST_LIMIT },
        schema: dealPageSchema,
      });
      return page.items;
    },

    async moveDealStage(input, options: WriteOptions = {}) {
      const body: MoveDealStageInput = {
        dealId: input.dealId,
        pipelineId: input.pipelineId,
        stageId: input.stageId,
        expectedRevision: input.expectedRevision,
      };
      const output = await request({
        method: "POST",
        path: `/v1/crm/deals/${encodeURIComponent(input.dealId)}/stage`,
        body,
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        schema: moveDealStageOutputSchema,
      });
      return output.result;
    },
  };
}
