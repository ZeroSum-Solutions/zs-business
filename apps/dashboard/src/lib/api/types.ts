import type {
  BookingPageSummary,
  BookingRecord,
  BookingSummary,
  ConsentEvidence,
  ContactRecord,
  CreateBookingRequest,
  DealRecord,
  IntakeItemRecord,
  IntakeStatus,
  PipelineSummary,
  ResourceSummary,
  SlotsResponse,
  UpsertContactRequest,
} from "@zs/contracts";
import type { WorkspaceApi } from "./workspace-types";

export type {
  BookingPageSummary,
  BookingRecord,
  ConsentEvidence,
  ContactRecord,
  DealRecord,
  IntakeItemRecord,
  IntakeStatus,
  PipelineSummary,
  ResourceSummary,
  SlotsResponse,
};

/**
 * Options every write needs. The caller owns the Idempotency-Key (see `useIntentKey`):
 * reuse it to retry the same write safely. No client ever makes one up.
 */
export interface WriteOptions {
  idempotencyKey: string;
}

/**
 * A list the client reads page by page, within the filters the API applied. It stops after a
 * fixed number of pages; when the list went on past that, `incomplete` is true and `loaded`
 * is how many rows were read.
 */
export interface ListResult<T> {
  items: T[];
  incomplete: boolean;
  loaded: number;
}

/**
 * One page of a list; `nextCursor` is where the next page starts, or null after the last.
 * It names the last row shown, so rows added ahead of it never push one onto the next page.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Lets React Query cancel a read nobody waits for (a superseded search, a left page). */
export interface ReadOptions {
  signal?: AbortSignal;
}

export function completeList<T>(items: T[]): ListResult<T> {
  return { items, incomplete: false, loaded: items.length };
}

/**
 * A booking as the calendar shows it. The API returns each record with its source and, for
 * website bookings, the customer (public-intake.md P-12); the demo adapter adds display labels.
 */
export type BookingView = BookingRecord & {
  title?: string | null;
  contactName?: string | null;
  source?: BookingSummary["source"];
  intakeItemId?: string | null;
  customer?: BookingSummary["customer"];
};

/** Who a booking is for: the linked customer, the website visitor's name, or the demo label. */
export function bookingCustomerName(booking: BookingView): string | null {
  return booking.customer?.name ?? booking.contactName ?? null;
}

export interface SlotQuery {
  resourceId: string;
  from: string;
  to: string;
  /** Zone for `localStart` labels; the API defaults to the resource's own zone. */
  zone?: string;
}

/** The API filters: bookings overlapping [from, to), in start order. */
export interface BookingListQuery {
  resourceId?: string;
  from?: string;
  to?: string;
  /** Only the first `limit` bookings, in one request (at most 100). */
  limit?: number;
}

/** Customers in name order. `search` matches part of a name, email or phone. */
export interface ContactListQuery {
  search?: string;
  /** Only these customers (at most 100), such as the ones on a page of deals. */
  ids?: readonly string[];
  /** The previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface DealListQuery {
  contactId?: string;
  pipelineId?: string;
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
  listResources(options?: ReadOptions): Promise<ResourceSummary[]>;
  getSlots(query: SlotQuery, options?: ReadOptions): Promise<SlotsResponse>;
  listBookings(query?: BookingListQuery, options?: ReadOptions): Promise<ListResult<BookingView>>;
  /** Throws an ApiError where `isSlotTaken(error)` holds when the time was taken first. */
  createBooking(input: NewBooking, options: WriteOptions): Promise<BookingRecord>;
}

export interface CrmApi {
  /** Pipelines with stages sorted by position. */
  listPipelines(options?: ReadOptions): Promise<PipelineSummary[]>;
  /** One page of customers; ask for the next with `cursor: nextCursor`. */
  listContacts(query?: ContactListQuery, options?: ReadOptions): Promise<Page<ContactRecord>>;
  /** Throws `not_found` for an unknown customer, or one of another business. */
  getContact(id: string, options?: ReadOptions): Promise<ContactRecord>;
  /** Returns `created: false` with the existing contact when the email or phone is known. */
  createOrFindContact(input: NewContact, options: WriteOptions): Promise<ContactWriteResult>;
  listDeals(query?: DealListQuery, options?: ReadOptions): Promise<ListResult<DealRecord>>;
  /** Throws an ApiError where `isDealChanged(error)` holds when the deal changed since `expectedRevision`. */
  moveDealStage(input: StageMove, options: WriteOptions): Promise<DealRecord>;
}

export interface IntakeLink {
  itemId: string;
  contactId: string;
}

/** Website booking requests and the pages that take them (public-intake.md P-12). */
export interface IntakeApi {
  /** Newest first. */
  listIntakeItems(query?: { status?: IntakeStatus }, options?: ReadOptions): Promise<ListResult<IntakeItemRecord>>;
  /** Throws a conflict with reason `already_reviewed` when someone reviewed it first. */
  linkIntakeItem(input: IntakeLink, options: WriteOptions): Promise<IntakeItemRecord>;
  rejectIntakeItem(itemId: string, options: WriteOptions): Promise<IntakeItemRecord>;
  listBookingPages(): Promise<BookingPageSummary[]>;
}

/** Customers per page of the customer list. */
export const CONTACT_PAGE_SIZE = 50;
/** Most IDs one `listContacts({ ids })` call takes (`MAX_CONTACT_IDS` in the API). */
export const CONTACT_IDS_PER_CALL = 100;

export type ZsApi = BookingApi & CrmApi & IntakeApi & WorkspaceApi;

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

/** The demo adapter's search; the API's ILIKE on name, email and phone matches the same rows. */
export function matchesSearch(contact: ContactRecord, search: string | undefined): boolean {
  const needle = search?.trim().toLowerCase() ?? "";
  if (!needle) return true;
  return [contact.displayName, contact.email, contact.phone].some((field) => field?.toLowerCase().includes(needle));
}

/** The demo adapter's name order, close to the API's `sort=name`. */
export const byContactName = (a: ContactRecord, b: ContactRecord) =>
  (a.displayName ?? a.email ?? a.phone ?? "").localeCompare(b.displayName ?? b.email ?? b.phone ?? "");
