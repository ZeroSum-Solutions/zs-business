import type {
  BusinessProfile,
  ContactEnrichment,
  EnrichmentProposal,
  EnrichmentRequestRecord,
  BookingContactResult,
  BookingPageSummary,
  BookingRecord,
  BookingSummary,
  CalendarConnection,
  CalendarConnectionStatus,
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
  IntakeApplyRequest,
  IntakeJob,
  IntakeJobDetail,
  IntakeItemRecord,
  IntakeStatus,
  LeadSource,
  PendingGoogleConnect,
  PipelineSummary,
  ReplyEntry,
  ReplyRecord,
  ReplyStatus,
  TranscriptionDetail,
  TranscriptionSummary,
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
  UpdateBusinessProfileRequest,
  UpdateFollowUpSettingsRequest,
  UpsertContactRequest,
  WeekStart,
} from "@zs/contracts";
import type { WorkspaceApi } from "./workspace-types";

export type {
  BusinessProfile,
  ContactEnrichment,
  EnrichmentProposal,
  EnrichmentRequestRecord,
  BookingContactResult,
  BookingPageSummary,
  BookingRecord,
  CalendarConnection,
  CalendarConnectionStatus,
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
  IntakeApplyRequest,
  IntakeItemRecord,
  IntakeJob,
  IntakeJobDetail,
  IntakeStatus,
  LeadSource,
  PendingGoogleConnect,
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

/** One booking as the detail read shows it: the revision to send with the next customer change (BC-3). */
export type BookingDetailView = BookingView & { customerRevision: number };

/** Link or change a booking's customer; `expectedRevision` is the `customerRevision` last read. */
export interface BookingContactLink {
  bookingId: string;
  contactId: string;
  expectedRevision: number;
}

/** Clear a booking's customer. */
export interface BookingContactUnlink {
  bookingId: string;
  expectedRevision: number;
}

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
  /** Only this customer's bookings: the ones linked to them and their website requests. */
  contactId?: string;
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
  /** One booking with its customer revision. Throws `not_found` for another business's booking. */
  getBooking(id: string, options?: ReadOptions): Promise<BookingDetailView>;
  /**
   * Link or change who a booking is for (booking-customer.md BC-3). Throws a conflict where
   * `isStaleRevision(error)` holds when the customer changed since it was read, and one with
   * reason `intake_booking` for a website booking.
   */
  linkBookingContact(input: BookingContactLink, options: WriteOptions): Promise<BookingContactResult>;
  /** Clear who a booking is for (BC-4). Same conflicts as `linkBookingContact`. */
  unlinkBookingContact(input: BookingContactUnlink, options: WriteOptions): Promise<BookingContactResult>;
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

/**
 * The business profile (business-profile.md BP-5..BP-7): who the business is. Any member reads it;
 * owners (`business`) change it.
 */
export interface BusinessApi {
  /** Throws `not_found` on an API older than the profile (BP-10). */
  getBusiness(options?: ReadOptions): Promise<BusinessProfile>;
  /** Only the fields in `changes`. A conflict with reason `stale_revision` when someone saved since `expectedRevision`. */
  updateBusiness(input: UpdateBusinessProfileRequest, options: WriteOptions): Promise<BusinessProfile>;
}

/**
 * Company details for one customer (enrichment.md E-4, E-14, E-17). Anyone with `customers` reads;
 * only an owner (`enrich`) asks. Found details arrive as approvals, never as edits to the customer.
 */
export interface EnrichmentApi {
  /** Throws `not_found` for an unknown customer, or one of another business. */
  getContactEnrichment(contactId: string, options?: ReadOptions): Promise<ContactEnrichment>;
  /**
   * Asks for the customer's company details. A conflict whose reason is one of `ENRICHMENT_ERROR_CODES`
   * says why not (no company domain, a customer who opted out, low funds, ...).
   */
  requestEnrichment(contactId: string, options: WriteOptions): Promise<EnrichmentRequestRecord>;
  /**
   * The business's undecided company-detail proposals, oldest first: each field with its current
   * value, the value found and its source (`GET /v1/enrichment/proposals`).
   */
  listEnrichmentProposals(options?: ReadOptions): Promise<EnrichmentProposal[]>;
  /**
   * An owner approves (the field is written to the customer's company details) or rejects one
   * proposal (`POST /v1/approvals/:id/approve` or `/reject`). Throws `not_found` for an unknown or
   * foreign proposal, and a conflict for one already decided or expired.
   */
  decideEnrichmentProposal(approvalId: string, decision: EnrichmentDecision, options: WriteOptions): Promise<void>;
}

export type EnrichmentDecision = "approve" | "reject";

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

/**
 * Google Calendar busy sync (google-calendar.md G-1, G-2, G-5). Members with `calendar` read the
 * connections; owners (`publish`) connect and disconnect. A connect changes nothing on the
 * server: it answers the Google consent URL. When Google sends the owner back, the grant waits
 * in this browser until the owner confirms the Google account it names on the Connections page.
 */
export interface CalendarSyncApi {
  /** Every connection of the business, retired ones included, never a token. */
  listCalendarConnections(options?: ReadOptions): Promise<CalendarConnection[]>;
  /**
   * The URL that starts connecting this booking resource. Throws `not_found` when the server
   * has no Google settings. It writes nothing, so each attempt takes a fresh key.
   */
  startGoogleConnect(resourceId: string, options: WriteOptions): Promise<{ authorizeUrl: string }>;
  /** The grant Google gave this browser that waits for the owner, or null when there is none. */
  getPendingGoogleConnect(options?: ReadOptions): Promise<PendingGoogleConnect | null>;
  /**
   * Connects the waiting grant the owner was shown, named by its `grantId`. Throws `not_found`
   * when it is gone or expired, `conflict` with reason `grant_changed` when another grant has
   * replaced it (nothing connects; read the pending grant again), and `conflict` when its
   * connection was retired or its calendar changed. Safe to repeat: the server keys it by the
   * grant, so it takes no key from the caller.
   */
  confirmGoogleConnect(grantId: string): Promise<CalendarConnection>;
  /** Drops the waiting grant; nothing is connected. */
  discardGoogleConnect(): Promise<void>;
  /** Hands the connection to the worker to clean up; a retired one answers as it is. */
  disconnectCalendar(connectionId: string, options: WriteOptions): Promise<CalendarConnection>;
}

/** Customers per page of the customer list. */
export const CONTACT_PAGE_SIZE = 50;
/** Most IDs one `listContacts({ ids })` call takes (`MAX_CONTACT_IDS` in the API). */
export const CONTACT_IDS_PER_CALL = 100;

/** Transcripts of uploaded audio and voicemails (transcription.md X-7). Members with `inbox.drafts` read them. */
export interface TranscriptionApi {
  /** Newest first. */
  listTranscriptions(options?: ReadOptions): Promise<TranscriptionSummary[]>;
  /** One job with its speaker-labelled segments, once a transcript exists. */
  getTranscription(id: string, options?: ReadOptions): Promise<TranscriptionDetail>;
}

/**
 * Document intake (document-intake.md DL-12..DL-14): price lists the owner uploaded, read into rows
 * and shown as one diff. Only owners (`publish`) read and decide them. Nothing reaches the catalog
 * until an approval is decided: `proposeIntakeApply` asks, `approveIntakeApply` decides.
 */
export interface DocumentIntakeApi {
  /** Newest first. */
  listIntakeJobs(options?: ReadOptions): Promise<IntakeJob[]>;
  /** One job with every row, its page and its snippet. Throws `not_found` for an unknown job. */
  getIntakeJob(id: string, options?: ReadOptions): Promise<IntakeJobDetail>;
  /** Asks to apply the chosen rows. A conflict with reason `intake_not_in_review` or `intake_changed`. */
  proposeIntakeApply(id: string, input: IntakeApplyRequest, options: WriteOptions): Promise<{ approvalId: string }>;
  /** Decides the approval. A conflict with reason `intake_target_changed` when an item moved since the review. */
  approveIntakeApply(approvalId: string, options: WriteOptions): Promise<void>;
  /** Drops a job that waits for review. */
  discardIntakeJob(id: string, options: WriteOptions): Promise<void>;
}

export type ZsApi = BookingApi & CrmApi & IntakeApi & InboxApi & HomeApi & AgentsApi & BusinessApi & EnrichmentApi & SitesApi & CalendarSyncApi & WorkspaceApi & TranscriptionApi & DocumentIntakeApi;


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
