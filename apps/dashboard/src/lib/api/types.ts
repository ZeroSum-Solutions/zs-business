import type {
  BookingRecord,
  ConsentEvidence,
  ContactRecord,
  CreateBookingRequest,
  DealRecord,
  PipelineSummary,
  ResourceSummary,
  SlotsResponse,
  UpsertContactRequest,
} from "@zs/contracts";
import type { WorkspaceApi } from "./workspace-types";

export type { BookingRecord, ConsentEvidence, ContactRecord, DealRecord, PipelineSummary, ResourceSummary, SlotsResponse };

/**
 * Options every write needs. The caller owns the Idempotency-Key (see `useIntentKey`):
 * reuse it to retry the same write safely. No client ever makes one up.
 */
export interface WriteOptions {
  idempotencyKey: string;
}

/**
 * A list read page by page. The client stops after a fixed number of pages; when the list
 * went on past that, `incomplete` is true and `loaded` is how many rows were read.
 */
export interface ListResult<T> {
  items: T[];
  incomplete: boolean;
  loaded: number;
}

export function completeList<T>(items: T[]): ListResult<T> {
  return { items, incomplete: false, loaded: items.length };
}

/**
 * A booking as the calendar shows it. The API returns plain `BookingRecord`s; the demo
 * adapter adds display labels for its seeded appointments.
 */
export type BookingView = BookingRecord & {
  title?: string | null;
  contactName?: string | null;
};

export interface SlotQuery {
  resourceId: string;
  from: string;
  to: string;
  /** Zone for `localStart` labels; the API defaults to the resource's own zone. */
  zone?: string;
}

/** Filters run in the client: the list routes take only paging (and resource/pipeline IDs). */
export interface BookingListQuery {
  resourceId?: string;
  from?: string;
  to?: string;
}

export type NewBooking = CreateBookingRequest;

export interface NewContact {
  displayName: string | null;
  email: string | null;
  /** Spaces, dots, dashes and brackets are removed before sending (E.164 on the wire). */
  phone: string | null;
}

export interface ContactWriteResult {
  contact: ContactRecord;
  created: boolean;
}

export interface StageMove {
  dealId: string;
  pipelineId: string;
  stageId: string;
  expectedRevision: number;
}

export interface BookingApi {
  listResources(): Promise<ResourceSummary[]>;
  getSlots(query: SlotQuery): Promise<SlotsResponse>;
  listBookings(query?: BookingListQuery): Promise<ListResult<BookingView>>;
  /** Throws an ApiError where `isSlotTaken(error)` holds when the time was taken first. */
  createBooking(input: NewBooking, options: WriteOptions): Promise<BookingRecord>;
}

export interface CrmApi {
  /** Pipelines with stages sorted by position. */
  listPipelines(): Promise<PipelineSummary[]>;
  listContacts(query?: { search?: string }): Promise<ListResult<ContactRecord>>;
  /** Throws `not_found`, or `incomplete` when the list cap was hit before a match. */
  getContact(id: string): Promise<ContactRecord>;
  /** Returns `created: false` with the existing contact when the email or phone is known. */
  createOrFindContact(input: NewContact, options: WriteOptions): Promise<ContactWriteResult>;
  listDeals(query?: { contactId?: string }): Promise<ListResult<DealRecord>>;
  /** Throws an ApiError where `isDealChanged(error)` holds when the deal changed since `expectedRevision`. */
  moveDealStage(input: StageMove, options: WriteOptions): Promise<DealRecord>;
}

export type ZsApi = BookingApi & CrmApi & WorkspaceApi;

/** Strip the formatting people type into phone fields; the API wants E.164. */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s().-]/g, "");
}

/** The POST /v1/crm/contacts body; the demo adapter parses the same body the HTTP client sends. */
export function toUpsertContactRequest(input: NewContact): UpsertContactRequest {
  return {
    displayName: input.displayName,
    email: input.email,
    phone: input.phone === null ? null : normalizePhone(input.phone),
    mode: "interactive",
    consent: { email: null, sms: null },
  };
}

/** Shared by both adapters so search and sort behave the same in demo and live mode. */
export function matchesSearch(contact: ContactRecord, search: string | undefined): boolean {
  const needle = search?.trim().toLowerCase() ?? "";
  if (!needle) return true;
  return [contact.displayName, contact.email, contact.phone].some((field) => field?.toLowerCase().includes(needle));
}

export const byContactName = (a: ContactRecord, b: ContactRecord) =>
  (a.displayName ?? a.email ?? a.phone ?? "").localeCompare(b.displayName ?? b.email ?? b.phone ?? "");
