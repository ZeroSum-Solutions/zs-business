import type {
  BookingPageSummary,
  BookingRecord,
  BookingSummary,
  ConsentEvidence,
  ContactRecord,
  CreateBookingRequest,
  DealRecord,
  DealSummary,
  DealValue,
  FollowUpDecision,
  FollowUpRun,
  FollowUpRunDetail,
  FollowUpSettings,
  FollowUpSkipReason,
  FollowUpStatus,
  FollowUpStopReason,
  HomeResults,
  KillFollowUpRequest,
  IntakeItemRecord,
  IntakeStatus,
  LeadSource,
  PipelineSummary,
  ReplyEntry,
  ReplyRecord,
  ReplyStatus,
  RequestEntry,
  ResourceSummary,
  SitePreview,
  SiteRecord,
  SiteReleaseDetail,
  SiteReleaseRecord,
  SiteReleaseResponse,
  SiteSpec,
  SiteSyncResponse,
  SlotsResponse,
  StageOutcome,
  ThreadDetail,
  ThreadEntry,
  ThreadSummary,
  UpdateFollowUpSettingsRequest,
  UpsertContactRequest,
  WeekStart,
} from "@zs/contracts";
import type { WorkspaceApi } from "./workspace-types";

export type {
  BookingPageSummary,
  BookingRecord,
  ConsentEvidence,
  ContactRecord,
  DealRecord,
  DealSummary,
  DealValue,
  FollowUpDecision,
  FollowUpRun,
  FollowUpRunDetail,
  FollowUpSettings,
  FollowUpSkipReason,
  FollowUpStatus,
  FollowUpStopReason,
  HomeResults,
  IntakeItemRecord,
  IntakeStatus,
  LeadSource,
  PipelineSummary,
  ReplyEntry,
  ReplyRecord,
  ReplyStatus,
  RequestEntry,
  ResourceSummary,
  SitePreview,
  SiteRecord,
  SiteReleaseDetail,
  SiteReleaseRecord,
  SiteReleaseResponse,
  SiteSpec,
  SiteSyncResponse,
  SlotsResponse,
  StageOutcome,
  ThreadDetail,
  ThreadEntry,
  ThreadSummary,
  UpdateFollowUpSettingsRequest,
  WeekStart,
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

/** Value and lead source for one deal (inbox-home.md H-1), with the revision the owner saw. */
export interface DealDetailsChange {
  dealId: string;
  expectedRevision: number;
  value: DealValue | null;
  leadSource: LeadSource | null;
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
  /** Each deal with its value, lead source and won date (inbox-home.md H-1). */
  listDeals(query?: DealListQuery, options?: ReadOptions): Promise<ListResult<DealSummary>>;
  /**
   * Throws an ApiError where `isDealChanged(error)` holds when the deal changed since `expectedRevision`.
   * Answers with the frozen deal record (crm.md C-14): no value, lead source or won date.
   */
  moveDealStage(input: StageMove, options: WriteOptions): Promise<DealRecord>;
  /** Same revision check as a stage move; answers with the deal as lists show it. */
  setDealDetails(input: DealDetailsChange, options: WriteOptions): Promise<DealSummary>;
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

export interface ThreadListQuery {
  /** The previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

export interface NewReply {
  contactId: string;
  /** One line; null lets the server write "Message from <business name>". */
  subject: string | null;
  body: string;
}

/**
 * The owner's Inbox (inbox-home.md I-1..I-8): one thread per customer, plus one per website
 * request not yet linked to a customer. Replies are drafted, then approved by an owner; an
 * approval queues the reply for delivery, it does not send it.
 */
export interface InboxApi {
  /** Latest activity first, one page at a time. */
  listThreads(query?: ThreadListQuery, options?: ReadOptions): Promise<Page<ThreadSummary>>;
  /** Throws `not_found` for an unknown or malformed thread ID, or one that moved (a linked visitor). */
  getThread(id: string, options?: ReadOptions): Promise<ThreadDetail>;
  draftReply(input: NewReply, options: WriteOptions): Promise<ReplyRecord>;
  /** Owners only. A conflict with reason `not_draft` or `no_email` when it cannot be approved. */
  approveReply(replyId: string, options: WriteOptions): Promise<ReplyRecord>;
  /** A conflict with reason `not_draft` once it was approved or discarded. */
  discardReply(replyId: string, options: WriteOptions): Promise<ReplyRecord>;
}

export interface HomeResultsQuery {
  /** IANA zone the weeks start in. */
  zone: string;
  weekStart: WeekStart;
}

/** Home results (inbox-home.md H-3..H-5); owners only (`reports`), staff get a 403. */
export interface HomeApi {
  getResults(query: HomeResultsQuery, options?: ReadOptions): Promise<HomeResults>;
}

export interface FollowUpRunQuery {
  /** The previous page's `nextCursor`. */
  cursor?: string;
  limit?: number;
}

/**
 * The inquiry follow-up agent (agents.md G-11). Members with `inbox.drafts` read it and may
 * stop it; owners (`agents`) change its settings, resume it and run it now. It only drafts:
 * every draft waits in the Inbox for an owner's approval.
 */
export interface AgentsApi {
  getFollowUpStatus(options?: ReadOptions): Promise<FollowUpStatus>;
  /** Replaces the settings. A conflict with reason `stale_revision` when someone saved since `expectedRevision`. */
  updateFollowUpSettings(input: UpdateFollowUpSettingsRequest, options: WriteOptions): Promise<FollowUpStatus>;
  /** Stops new drafts at once. A switch already engaged keeps its first time and note. */
  killFollowUp(input: KillFollowUpRequest, options: WriteOptions): Promise<FollowUpStatus>;
  /** Owners only. */
  resumeFollowUp(options: WriteOptions): Promise<FollowUpStatus>;
  /** Owners only. Throws `not_found` when the server has no model configured. */
  startFollowUpRun(options: WriteOptions): Promise<FollowUpRunDetail>;
  /** Newest first, one page at a time. */
  listFollowUpRuns(query?: FollowUpRunQuery, options?: ReadOptions): Promise<Page<FollowUpRun>>;
  /** Throws `not_found` for an unknown or malformed run ID. */
  getFollowUpRun(id: string, options?: ReadOptions): Promise<FollowUpRunDetail>;
}

/** Runs per page of the Agents page's run list. */
export const RUN_PAGE_SIZE = 20;

/** Threads per page of the inbox list. */
export const THREAD_PAGE_SIZE = 30;

export interface SitePublish {
  siteId: string;
  spec: SiteSpec;
  /** The release live when the edit started (null before the first); another one live now is a `stale_release` conflict. */
  expectedCurrentReleaseId: string | null;
}

export interface ReleaseActivation {
  siteId: string;
  releaseId: string;
  /** The release this page showed as live; another one live now is a `stale_release` conflict. */
  expectedCurrentReleaseId: string | null;
}

/** The business's website (M4b): immutable releases, one of them live. Owners only. */
export interface SitesApi {
  listSites(options?: ReadOptions): Promise<SiteRecord[]>;
  createSite(name: string, options: WriteOptions): Promise<SiteRecord>;
  /** Newest first. */
  listSiteReleases(siteId: string, options?: ReadOptions): Promise<SiteReleaseRecord[]>;
  /** One release with the spec it was built from. */
  getSiteRelease(siteId: string, releaseId: string, options?: ReadOptions): Promise<SiteReleaseDetail>;
  /** What publishing this spec would serve; nothing is stored. */
  previewSite(siteId: string, spec: SiteSpec): Promise<SitePreview>;
  /** Builds, stores and makes the spec live. `edge: "pending"` means the site still shows the previous version. */
  publishSite(input: SitePublish, options: WriteOptions): Promise<SiteReleaseResponse>;
  /** Rollback, or roll forward again. */
  activateSiteRelease(input: ReleaseActivation, options: WriteOptions): Promise<SiteReleaseResponse>;
  /** Pushes the live version to the site again after `edge: "pending"`. */
  syncSite(siteId: string): Promise<SiteSyncResponse>;
}

/** Customers per page of the customer list. */
export const CONTACT_PAGE_SIZE = 50;
/** Most IDs one `listContacts({ ids })` call takes (`MAX_CONTACT_IDS` in the API). */
export const CONTACT_IDS_PER_CALL = 100;

export type ZsApi = BookingApi & CrmApi & IntakeApi & InboxApi & HomeApi & AgentsApi & SitesApi & WorkspaceApi;

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
