/**
 * In-memory implementation of the booking and CRM API for demos and tests. It keeps
 * the same rules the server enforces: overlap conflicts, stale-revision conflicts,
 * contact dedupe by email or phone, and idempotent replays. Requests are parsed with the
 * same @zs/contracts schemas, in the same order, and every error is the body the API sends:
 * 400 before 403 (a foreign or unknown calendar, deal or stage) before 409.
 */
import type { z } from "zod";
import {
  createBookingRequestSchema,
  linkBookingContactInputSchema,
  unlinkBookingContactInputSchema,
  draftReplyRequestSchema,
  linkIntakeItemRequestSchema,
  listIntakeItemsQuerySchema,
  listThreadsQuerySchema,
  uuidSchema,
  moveDealStageRequestSchema,
  resultsQuerySchema,
  setDealDetailsRequestSchema,
  slotsQuerySchema,
  threadIdSchema,
  THREAD_ENTRY_LIMIT,
  upsertContactRequestSchema,
  type BookingContactResult,
  type BookingRecord,
  type ContactRecord,
  type DealRecord,
  type DealSummary,
  type HomeResults,
  type IntakeItemRecord,
  type PipelineSummary,
  type ReplyRecord,
  type RevenueSource,
  type ThreadDetail,
  type ThreadEntry,
  type ThreadSummary,
} from "@zs/contracts";
import { addDays, localIso, wallTimeInstants, weekdayOf, weekRanges, zonedDateKey } from "../../time";
import { newId as defaultNewId } from "../../id";
import { ApiError, contactNotFound, defaultMessage, demoError, demoValidationError, threadNotFound } from "../errors";
import { createDemoAgents, type DemoActor, type DemoAgentControls, type DemoRole } from "./agents";
import { createDemoBusiness, type DemoBusinessControls } from "./business";
import { createDemoCalendar, type DemoCalendarControls } from "./calendar";
import { createDemoTemplates, type DemoTemplateControls } from "./templates";
import {
  byContactName,
  completeList,
  CONTACT_PAGE_SIZE,
  matchesSearch,
  THREAD_PAGE_SIZE,
  toUpsertContactRequest,
  type AgentsApi,
  type BusinessApi,
  type BookingApi,
  type BookingView,
  type CalendarSyncApi,
  type ContactWriteResult,
  type CrmApi,
  type HomeApi,
  type InboxApi,
  type IntakeApi,
  type WriteOptions,
} from "../types";
import {
  buildSeed,
  DEMO_BOOKING_PAGE,
  DEMO_BUSINESS_SUBJECT,
  DEMO_OWNER,
  DEMO_PIPELINE,
  DEMO_RESOURCES,
  DEMO_STAFF,
  DEMO_TENANT_ID,
  type DemoBooking,
  type DemoResource,
} from "./seed";

export interface DemoClock {
  now(): Date;
}

export interface DemoAdapterOptions {
  clock?: DemoClock;
  newId?: () => string;
  /** Artificial delay per call so loading states are visible. Tests pass 0. */
  latencyMs?: number;
  /** The business's pipelines; the seed's one by default. */
  pipelines?: PipelineSummary[];
}

/** Hooks that act as a second person using the business, to show conflicts. */
export interface DemoControls extends DemoAgentControls, DemoTemplateControls, DemoBusinessControls, DemoCalendarControls {
  /**
   * Signs the demo in as the owner or as a staff member. The screen then offers what that role
   * may do, and the agent routes refuse an owner-only step with the API's 403.
   */
  actAs(role: DemoRole): void;
  /** Who the demo session is now. */
  currentActor(): DemoActor;
  /** Called after `actAs`; returns the unsubscribe. */
  onActorChange(listener: () => void): () => void;
  bookAsSomeoneElse(resourceId: string, startsAt: string): BookingRecord;
  /** Saves the deal as someone else: a new revision, with any details given. */
  editDealElsewhere(dealId: string, details?: Partial<Pick<DealSummary, "value" | "leadSource">>): DealRecord;
  /**
   * The next write is saved, but its response is lost: the caller sees a network error.
   * With `goOffline` the connection stays down afterwards, until `setOffline(false)`.
   */
  loseNextResponse(options?: { goOffline?: boolean }): void;
  /** While offline every call fails with a network error before it touches the data. */
  setOffline(offline: boolean): void;
  /** The next booking customer link fails with a network error before it saves; later ones work. */
  failNextBookingLink(): void;
  /** Just before the next booking customer link is checked, another member links a different customer to that booking. */
  raceNextBookingLink(): void;
  /** Every write that reached the adapter, oldest first, with the key it carried. */
  writeLog(): DemoWrite[];
  /** From now on every call fails as a 401, like an API token that ran out. */
  expireSession(): void;
  /** The next write waits this long before it runs, to test answers that arrive late. */
  delayNextWrite(ms: number): void;
  /** While on, every read of the deal list fails with a network error; writes still work. */
  failDealReads(failing: boolean): void;
  /** While on, every read of the booking list fails with a network error. */
  failBookingReads(failing: boolean): void;
  /** Replaces the business's pipelines, such as none, one without stages, or several. */
  setPipelines(pipelines: PipelineSummary[]): void;
  /**
   * Opens every calendar on an ISO weekday (1 = Monday) between two local minutes, or closes
   * it with null, such as across the night clocks change.
   */
  setOpenHours(weekday: number, hours: [number, number] | null): void;
  /** Another owner approves a draft first, so this screen's approve or discard is `not_draft`. */
  approveReplyElsewhere(replyId: string): ReplyRecord;
}

export type DemoApi = BookingApi & CrmApi & IntakeApi & InboxApi & HomeApi & AgentsApi & BusinessApi & CalendarSyncApi & DemoControls;

export interface DemoWrite {
  operation: string;
  idempotencyKey: string;
  /** The request body as the adapter received it, such as the instant a booking asked for. */
  payload: unknown;
  outcome: "applied" | "replayed" | "rejected";
}

type StoredBooking = DemoBooking;

const clone = <T>(value: T): T => structuredClone(value);

const PREVIEW_LENGTH = 140;
const clip = (text: string | null) =>
  text === null ? null : text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`;
const latest = (...values: (string | null | undefined)[]) =>
  values.reduce<string | null>((best, value) => (value && (!best || value > best) ? value : best), null);

/** The frozen deal record a stage move answers with (crm.md C-14). */
const toDealRecord = ({ value: _value, leadSource: _source, wonAt: _won, ...record }: DealSummary): DealRecord => record;

export function createDemoAdapter(options: DemoAdapterOptions = {}): DemoApi {
  const clock = options.clock ?? { now: () => new Date() };
  const newId = options.newId ?? defaultNewId;
  const latency = options.latencyMs ?? 0;
  const seed = buildSeed(clock.now());
  const contacts = new Map(seed.contacts.map((item) => [item.id, item]));
  const deals = new Map(seed.deals.map((item) => [item.id, item]));
  const bookings = new Map<string, StoredBooking>(seed.bookings.map((item) => [item.id, item]));
  const intakeItems = new Map(seed.intakeItems.map((item) => [item.id, item]));
  /** booking-customer.md BC-3: a booking has a link row from its first change on; `contactId` null once cleared. */
  const links = new Map<string, { contactId: string | null; revision: number }>();
  const replies = new Map(seed.replies.map((item) => [item.id, item]));
  const replays = new Map<string, { fingerprint: string; result: unknown }>();
  const writes: DemoWrite[] = [];
  let offline = false;
  let loseNext: { goOffline: boolean } | null = null;
  let expired = false;
  let delayNext = 0;
  let dealReadsFail = false;
  let bookingReadsFail = false;
  let nextLinkFails = false;
  let nextLinkRaced = false;
  let pipelines = clone(options.pipelines ?? [DEMO_PIPELINE]);
  // A copy per adapter: setOpenHours changes this business's calendars only.
  const resources = clone(DEMO_RESOURCES);
  let actor: DemoActor = { role: "owner", userId: DEMO_OWNER.userId };
  const actorListeners = new Set<() => void>();

  const networkError = () => new ApiError("network", defaultMessage("network"));
  const wait = async () => {
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    if (offline) throw networkError();
    if (expired) throw demoError("Unauthorized");
  };
  const nowIso = () => clock.now().toISOString();

  async function idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T> {
    // Same rule as the HTTP client: the caller owns the key, none is made up here.
    const key = options?.idempotencyKey;
    if (!key) throw new TypeError(`${operation} needs an Idempotency-Key from the caller`);
    await wait();
    if (delayNext > 0) {
      const ms = delayNext;
      delayNext = 0;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    const log = (outcome: DemoWrite["outcome"]) => writes.push({ operation, idempotencyKey: key, payload: clone(payload), outcome });
    // Like a dropped connection after the server committed: the write stands, the answer is lost.
    const answer = (result: T): T => {
      if (loseNext) {
        offline = loseNext.goOffline;
        loseNext = null;
        throw networkError();
      }
      return clone(result);
    };
    const fingerprint = JSON.stringify([operation, payload]);
    const previous = replays.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        log("rejected");
        throw demoError("Conflict", { reason: "idempotency_key_reused" });
      }
      log("replayed");
      return answer(previous.result as T);
    }
    let result: T;
    try {
      result = run();
    } catch (error) {
      log("rejected");
      throw error;
    }
    log("applied");
    replays.set(key, { fingerprint, result: clone(result) });
    return answer(result);
  }

  /** Like the API, a calendar this tenant does not own is 403 whether or not it exists. */
  function resourceOrThrow(id: string): DemoResource {
    const resource = resources.find((item) => item.id === id);
    if (!resource) throw demoError("Forbidden");
    return resource;
  }

  function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw demoValidationError(parsed.error.issues);
    return parsed.data;
  }

  function occupied(resource: DemoResource, startsMs: number) {
    const endsMs = startsMs + resource.slotLengthMinutes * 60000;
    return {
      startsMs,
      endsMs,
      occStart: startsMs - resource.bufferBeforeMinutes * 60000,
      occEnd: endsMs + resource.bufferAfterMinutes * 60000,
    };
  }

  function clashes(resource: DemoResource, occStart: number, occEnd: number): boolean {
    for (const booking of bookings.values()) {
      if (booking.resourceId !== resource.id) continue;
      if (Date.parse(booking.occupiedStartsAt) < occEnd && occStart < Date.parse(booking.occupiedEndsAt)) return true;
    }
    return false;
  }

  /**
   * Every grid start for a resource on one local day, ignoring existing bookings, in time
   * order. Like the API, a wall time the clocks pass twice gives two slots and one they skip
   * gives none.
   */
  function gridStarts(resource: DemoResource, dateKey: string): number[] {
    const hours = resource.hours[weekdayOf(dateKey)];
    if (!hours) return [];
    const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
    const starts: number[] = [];
    for (let minute = hours[0]; minute + resource.slotLengthMinutes <= hours[1]; minute += resource.slotStepMinutes) {
      starts.push(...wallTimeInstants(y, m, d, minute, resource.timeZone));
    }
    return starts.sort((a, b) => a - b);
  }

  function insertBooking(resource: DemoResource, startsAt: string, id: string, title: string | null): StoredBooking {
    const slot = occupied(resource, Date.parse(startsAt));
    if (clashes(resource, slot.occStart, slot.occEnd)) {
      throw demoError("Conflict", { reason: "overlap" });
    }
    const record: StoredBooking = {
      id,
      tenantId: DEMO_TENANT_ID,
      resourceId: resource.id,
      startsAt: new Date(slot.startsMs).toISOString(),
      endsAt: new Date(slot.endsMs).toISOString(),
      occupiedStartsAt: new Date(slot.occStart).toISOString(),
      occupiedEndsAt: new Date(slot.occEnd).toISOString(),
      bufferBeforeMinutes: resource.bufferBeforeMinutes,
      bufferAfterMinutes: resource.bufferAfterMinutes,
      status: "confirmed",
      createdAt: nowIso(),
      title,
      contactName: null,
      source: "owner",
      intakeItemId: null,
    };
    bookings.set(record.id, record);
    return record;
  }

  const toRecord = ({ title: _title, contactName: _contactName, source: _source, intakeItemId: _item, ...record }: StoredBooking): BookingRecord => record;

  /**
   * Like the API's bookings list: website bookings carry their customer (public-intake.md P-12) and
   * an owner booking the contact it was linked to (booking-customer.md BC-6). Once a booking has a
   * link row, the seed's display label no longer speaks for it.
   */
  function toView(booking: StoredBooking): BookingView {
    const item = booking.intakeItemId ? intakeItems.get(booking.intakeItemId) : undefined;
    const contact = item?.contactId ? contacts.get(item.contactId) : undefined;
    const link = links.get(booking.id);
    const linked = link?.contactId ? contacts.get(link.contactId) : undefined;
    return {
      ...booking,
      ...(link ? { contactName: null } : {}),
      customer: item
        ? { contactId: item.contactId, name: contact?.displayName ?? item.submitted.name, status: item.status }
        : link?.contactId
          ? { contactId: link.contactId, name: linked?.displayName ?? null, status: "linked" }
          : null,
    };
  }

  /** The API's `NotFound` for a booking that is not this business's. */
  function bookingOrThrow(id: string): StoredBooking {
    const booking = bookings.get(id);
    if (!booking) throw demoError("NotFound");
    return booking;
  }

  const contactResult = (bookingId: string, contactId: string | null, revision: number): BookingContactResult => ({
    bookingId,
    customer: contactId ? { contactId, name: contacts.get(contactId)?.displayName ?? null, status: "linked" } : null,
    revision,
  });

  /** The API refuses a reviewed item and treats an unknown one as another tenant's (403). */
  function pendingItem(id: string): IntakeItemRecord {
    parse(uuidSchema, id);
    const item = intakeItems.get(id);
    if (!item) throw demoError("Forbidden");
    if (item.status !== "possible_match") throw demoError("Conflict", { reason: "already_reviewed" });
    return item;
  }

  /** I-1: customer threads (a request or a reply that is not discarded) and visitor threads. */
  function allThreads(): ThreadSummary[] {
    const customerIds = new Set<string>();
    for (const item of intakeItems.values()) if (item.contactId) customerIds.add(item.contactId);
    for (const reply of replies.values()) if (reply.status !== "discarded") customerIds.add(reply.contactId);
    const threads: ThreadSummary[] = [...customerIds].map((id) => {
      const contact = contacts.get(id)!;
      const requests = [...intakeItems.values()].filter((item) => item.contactId === id);
      const sent = [...replies.values()].filter((reply) => reply.contactId === id && reply.status !== "discarded");
      const lastIn = latest(...requests.map((item) => item.createdAt));
      const lastApproved = latest(...sent.map((reply) => reply.approvedAt));
      const texts = [
        ...requests.flatMap((item) => (item.submitted.notes === null ? [] : [{ at: item.createdAt, id: item.id, text: item.submitted.notes }])),
        ...sent.map((reply) => ({ at: reply.createdAt, id: reply.id, text: reply.body })),
      ].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
      return {
        id: `c_${id}`,
        kind: "customer",
        contactId: id,
        intakeItemId: null,
        name: contact.displayName ?? contact.email ?? contact.phone ?? "Customer",
        email: contact.email,
        preview: clip(texts[0]?.text ?? null),
        lastActivityAt: latest(lastIn, ...sent.flatMap((reply) => [reply.createdAt, reply.approvedAt, reply.settledAt]))!,
        needsReply: lastIn !== null && (lastApproved === null || lastApproved < lastIn),
        needsReview: false,
        drafts: sent.filter((reply) => reply.status === "draft").length,
      };
    });
    for (const item of intakeItems.values()) {
      if (item.contactId) continue;
      threads.push({
        id: `v_${item.id}`, kind: "visitor", contactId: null, intakeItemId: item.id, name: item.submitted.name,
        email: item.submitted.email, preview: clip(item.submitted.notes), lastActivityAt: item.createdAt,
        needsReply: false, needsReview: item.status === "possible_match", drafts: 0,
      });
    }
    const key = (thread: ThreadSummary) => thread.contactId ?? thread.intakeItemId!;
    return threads.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || key(a).localeCompare(key(b)));
  }

  /** A reply this business holds; an unknown one is another tenant's (403, like TenantDenied). */
  function draftOrThrow(replyId: string): ReplyRecord {
    parse(uuidSchema, replyId);
    const reply = replies.get(replyId);
    if (!reply) throw demoError("Forbidden");
    if (reply.status !== "draft") throw demoError("Conflict", { reason: "not_draft", status: reply.status });
    return reply;
  }

  const agents = createDemoAgents({
    now: () => clock.now(),
    newId,
    wait,
    idempotent,
    parse,
    actor: () => actor,
    contacts,
    intakeItems,
    replies,
    seed: seed.followUp,
  });

  const templates = createDemoTemplates({
    now: () => clock.now(), newId, wait, idempotent, parse, actor: () => actor, globalKilled: () => agents.globalAgentKill(),
  });

  const business = createDemoBusiness({ now: () => clock.now(), wait, idempotent, parse, actor: () => actor });

  const calendar = createDemoCalendar({ now: () => clock.now(), newId, wait, idempotent, parse, actor: () => actor, resources });

  return {
    ...agents,
    ...templates,
    ...business,
    ...calendar,

    async listResources() {
      await wait();
      return resources.map(({ id, name, timeZone, slotLengthMinutes }) => ({ id, name, timeZone, slotLengthMinutes }));
    },

    async getSlots({ resourceId, from, to, zone }) {
      await wait();
      const query = parse(slotsQuerySchema, { resourceId, from, to, ...(zone ? { zone } : {}) });
      const resource = resourceOrThrow(query.resourceId);
      const fromMs = Date.parse(query.from);
      const toMs = Date.parse(query.to);
      const labelZone = query.zone ?? resource.timeZone;
      const earliest = clock.now().getTime() + resource.minimumNoticeMinutes * 60000;
      const slots: { startsAt: string; endsAt: string; localStart: string }[] = [];
      const lastDay = zonedDateKey(toMs, resource.timeZone);
      for (let day = zonedDateKey(fromMs, resource.timeZone); day <= lastDay; day = addDays(day, 1)) {
        for (const start of gridStarts(resource, day)) {
          const slot = occupied(resource, start);
          if (start < fromMs || slot.endsMs > toMs || start < earliest) continue;
          if (clashes(resource, slot.occStart, slot.occEnd)) continue;
          slots.push({ startsAt: new Date(slot.startsMs).toISOString(), endsAt: new Date(slot.endsMs).toISOString(), localStart: localIso(slot.startsMs, labelZone) });
        }
      }
      return { resourceId: resource.id, timeZone: resource.timeZone, zone: labelZone, slots };
    },

    async listBookings(query = {}) {
      await wait();
      if (bookingReadsFail) throw networkError();
      const fromMs = query.from ? Date.parse(query.from) : -Infinity;
      const toMs = query.to ? Date.parse(query.to) : Infinity;
      const rows: BookingView[] = [...bookings.values()]
        .filter((item) => (!query.resourceId || item.resourceId === query.resourceId) &&
          Date.parse(item.endsAt) > fromMs && Date.parse(item.startsAt) < toMs &&
          (!query.contactId || toView(item).customer?.contactId === query.contactId))
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
        .map(toView);
      return completeList(clone(query.limit === undefined ? rows : rows.slice(0, query.limit)));
    },

    createBooking(input, options) {
      return idempotent("booking.create", input, options, () => {
        const request = parse(createBookingRequestSchema, input);
        const resource = resourceOrThrow(request.resourceId);
        const startsMs = Date.parse(request.startsAt);
        const onGrid = !Number.isNaN(startsMs) && gridStarts(resource, zonedDateKey(startsMs, resource.timeZone)).includes(startsMs);
        // The API refuses a start that is off the grid or too soon as a conflict, not a 400.
        if (!onGrid || startsMs < clock.now().getTime() + resource.minimumNoticeMinutes * 60000) {
          throw demoError("Conflict", { reason: "slot_unavailable" });
        }
        return toRecord(insertBooking(resource, request.startsAt, newId(), null));
      });
    },

    async getBooking(id) {
      await wait();
      if (bookingReadsFail) throw networkError();
      parse(uuidSchema, id);
      return clone({ ...toView(bookingOrThrow(id)), customerRevision: links.get(id)?.revision ?? 0 });
    },

    async linkBookingContact(input, options) {
      if (nextLinkFails) {
        nextLinkFails = false;
        await wait();
        throw networkError();
      }
      return idempotent("booking.contact.link", input, options, () => {
        const request = parse(linkBookingContactInputSchema, input);
        const booking = bookingOrThrow(request.bookingId);
        // BC-2: a website booking takes its customer from the intake review only.
        if (booking.source !== "owner") throw demoError("Conflict", { reason: "intake_booking" });
        // BC-3: a customer of another business reads as missing, then the revision is compared.
        if (!contacts.has(request.contactId)) throw demoError("NotFound");
        if (nextLinkRaced) {
          nextLinkRaced = false;
          const other = [...contacts.keys()].find((id) => id !== request.contactId);
          if (other) links.set(booking.id, { contactId: other, revision: (links.get(booking.id)?.revision ?? 0) + 1 });
        }
        const link = links.get(booking.id);
        const revision = link?.revision ?? 0;
        if (revision !== request.expectedRevision) throw demoError("Conflict", { reason: "stale_revision", currentRevision: revision });
        if (link?.contactId === request.contactId) return contactResult(booking.id, request.contactId, revision);
        links.set(booking.id, { contactId: request.contactId, revision: revision + 1 });
        return contactResult(booking.id, request.contactId, revision + 1);
      });
    },

    unlinkBookingContact(input, options) {
      return idempotent("booking.contact.unlink", input, options, () => {
        const request = parse(unlinkBookingContactInputSchema, input);
        const booking = bookingOrThrow(request.bookingId);
        const link = links.get(booking.id);
        const revision = link?.revision ?? 0;
        if (revision !== request.expectedRevision) throw demoError("Conflict", { reason: "stale_revision", currentRevision: revision });
        // BC-4: the row stays so the revision only grows; clearing no customer changes nothing.
        if (!link || link.contactId === null) return contactResult(booking.id, null, revision);
        links.set(booking.id, { contactId: null, revision: revision + 1 });
        return contactResult(booking.id, null, revision + 1);
      });
    },

    async listPipelines() {
      await wait();
      return clone(pipelines);
    },

    async listContacts(query = {}) {
      await wait();
      const ids = query.ids ? new Set(query.ids) : null;
      const rows = [...contacts.values()]
        .filter((item) => matchesSearch(item, query.search) && (!ids || ids.has(item.id)))
        .sort(byContactName);
      // Like the API's cursor: the next page starts after the last customer shown.
      const start = query.cursor ? rows.findIndex((item) => item.id === query.cursor) + 1 : 0;
      const limit = query.limit ?? CONTACT_PAGE_SIZE;
      const items = rows.slice(start, start + limit);
      return { items: clone(items), nextCursor: start + limit < rows.length ? items.at(-1)!.id : null };
    },

    async getContact(id) {
      await wait();
      const contact = contacts.get(id);
      if (!contact) throw contactNotFound();
      return clone(contact);
    },

    createOrFindContact(input, options) {
      return idempotent("crm.contact.create-or-find", input, options, (): ContactWriteResult => {
        const { email, phone, displayName } = parse(upsertContactRequestSchema, toUpsertContactRequest(input));
        const all = [...contacts.values()];
        const byEmail = email ? all.find((item) => item.email === email) : undefined;
        const byPhone = phone ? all.find((item) => item.phone === phone) : undefined;
        if (byEmail && byPhone && byEmail.id !== byPhone.id) {
          throw demoError("Conflict", { reason: "split_identity" });
        }
        const existing = byEmail ?? byPhone;
        if (existing) return { contact: existing, created: false };
        const name = displayName?.trim() || null;
        const contact: ContactRecord = {
          id: newId(),
          tenantId: DEMO_TENANT_ID,
          displayName: name,
          email,
          phone,
          consent: { email: null, sms: null },
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        contacts.set(contact.id, contact);
        return { contact, created: true };
      });
    },

    async listDeals(query = {}) {
      await wait();
      if (dealReadsFail) throw networkError();
      // The frozen record plus value, lead source and won date (H-1).
      const rows = [...deals.values()]
        .filter((item) => (!query.contactId || item.contactId === query.contactId) && (!query.pipelineId || item.pipelineId === query.pipelineId))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return completeList(clone(rows));
    },

    moveDealStage(input, options) {
      return idempotent("crm.deal.move-stage", input, options, () => {
        const { dealId, ...body } = input;
        const move = parse(moveDealStageRequestSchema, body);
        const deal = deals.get(dealId);
        // An unknown deal, pipeline or stage is the API's 403, never a 404.
        const pipeline = pipelines.find((item) => item.id === move.pipelineId);
        if (!deal || deal.pipelineId !== move.pipelineId || !pipeline?.stages.some((stage) => stage.id === move.stageId)) {
          throw demoError("Forbidden");
        }
        if (move.expectedRevision !== deal.revision) {
          throw demoError("Conflict", { reason: "stale_revision", currentRevision: deal.revision });
        }
        // H-2: entering a won stage dates the win; moving between won stages keeps it; leaving clears it.
        const outcome = (stageId: string) => pipeline.stages.find((stage) => stage.id === stageId)?.outcome ?? "open";
        const updatedAt = nowIso();
        const won = outcome(move.stageId) === "won";
        const wonAt = won ? (outcome(deal.stageId) === "won" ? deal.wonAt : updatedAt) ?? updatedAt : null;
        const updated: DealSummary = { ...deal, stageId: move.stageId, revision: deal.revision + 1, updatedAt, wonAt };
        deals.set(updated.id, updated);
        return toDealRecord(updated);
      });
    },

    setDealDetails(input, options) {
      return idempotent("crm.deal.set-details", input, options, () => {
        const { dealId, ...body } = input;
        const change = parse(setDealDetailsRequestSchema, body);
        const deal = deals.get(dealId);
        if (!deal) throw demoError("Forbidden");
        if (change.expectedRevision !== deal.revision) {
          throw demoError("Conflict", { reason: "stale_revision", currentRevision: deal.revision });
        }
        const updated: DealSummary = {
          ...deal, value: change.value, leadSource: change.leadSource, revision: deal.revision + 1, updatedAt: nowIso(),
        };
        deals.set(updated.id, updated);
        return updated;
      });
    },

    async listIntakeItems(query = {}) {
      await wait();
      const { status } = parse(listIntakeItemsQuerySchema, query);
      const rows = [...intakeItems.values()]
        .filter((item) => !status || item.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
      return completeList(clone(rows));
    },

    linkIntakeItem(input, options) {
      return idempotent("intake.item.link", input, options, () => {
        const { contactId } = parse(linkIntakeItemRequestSchema, { contactId: input.contactId });
        const item = pendingItem(input.itemId);
        const contact = contacts.get(contactId);
        if (!contact) throw demoError("Forbidden");
        // Intake consent fills only channels with no recorded evidence; a denial stays.
        const fill = (channel: "email" | "sms") => {
          const given = item.consent[channel];
          return contact.consent[channel] ?? (given ? { status: given.status, source: `intake:${item.id}`, recordedAt: given.recordedAt } : null);
        };
        const consent = { email: fill("email"), sms: fill("sms") };
        if (JSON.stringify(consent) !== JSON.stringify(contact.consent))
          contacts.set(contact.id, { ...contact, consent, updatedAt: nowIso() });
        const linked: IntakeItemRecord = { ...item, status: "linked", contactId, reviewedAt: nowIso() };
        intakeItems.set(item.id, linked);
        return linked;
      });
    },

    rejectIntakeItem(itemId, options) {
      return idempotent("intake.item.reject", { itemId }, options, () => {
        const rejected: IntakeItemRecord = { ...pendingItem(itemId), status: "rejected", reviewedAt: nowIso() };
        intakeItems.set(itemId, rejected);
        return rejected;
      });
    },

    async listBookingPages() {
      await wait();
      return [clone(DEMO_BOOKING_PAGE)];
    },

    async listThreads(query = {}) {
      await wait();
      const { limit } = parse(listThreadsQuerySchema, { limit: query.limit ?? THREAD_PAGE_SIZE });
      const rows = allThreads();
      // Like the API's keyset cursor: the next page starts after the last thread shown.
      const start = query.cursor ? rows.findIndex((item) => item.id === query.cursor) + 1 : 0;
      const items = rows.slice(start, start + limit);
      return { items: clone(items), nextCursor: start + limit < rows.length ? items.at(-1)!.id : null };
    },

    async getThread(id) {
      await wait();
      const parsed = threadIdSchema.safeParse(id);
      if (!parsed.success) throw threadNotFound();
      const summary = allThreads().find((thread) => thread.id === parsed.data);
      if (!summary) throw threadNotFound();
      const requests = [...intakeItems.values()].filter((item) =>
        summary.kind === "customer" ? item.contactId === summary.contactId : item.id === summary.intakeItemId);
      const entries: ThreadEntry[] = [
        ...requests.map((item): ThreadEntry => ({
          type: "request", id: item.id, at: item.createdAt, channel: item.channel, status: item.status,
          name: item.submitted.name, notes: item.submitted.notes, booking: item.booking,
        })),
        ...(summary.kind === "customer"
          ? [...replies.values()].filter((reply) => reply.contactId === summary.contactId && reply.status !== "discarded")
            .map((reply): ThreadEntry => ({ type: "reply", at: reply.createdAt, reply }))
          : []),
      ].sort((a, b) => a.at.localeCompare(b.at));
      const phone = summary.kind === "customer" ? contacts.get(summary.contactId!)?.phone ?? null : requests[0]?.submitted.phone ?? null;
      const detail: ThreadDetail = {
        ...summary, phone, entries: entries.slice(-THREAD_ENTRY_LIMIT), olderEntries: entries.length > THREAD_ENTRY_LIMIT,
      };
      return clone(detail);
    },

    draftReply(input, options) {
      return idempotent("inbox.reply.draft", input, options, () => {
        const request = parse(draftReplyRequestSchema, input);
        // I-5: the contact must be this business's; anything else is TenantDenied (403).
        if (!contacts.has(request.contactId)) throw demoError("Forbidden");
        const reply: ReplyRecord = {
          id: newId(), tenantId: DEMO_TENANT_ID, contactId: request.contactId, channel: "email",
          subject: request.subject ?? DEMO_BUSINESS_SUBJECT, body: request.body, status: "draft",
          draftedBy: actor.role === "owner" ? DEMO_OWNER : DEMO_STAFF, createdAt: nowIso(), approvedBy: null, approvedAt: null, discardedAt: null, settledAt: null,
        };
        replies.set(reply.id, reply);
        return reply;
      });
    },

    approveReply(replyId, options) {
      return idempotent("inbox.reply.approve", { replyId }, options, () => {
        // Only owners decide a send (I-6): staff get the API's 403.
        if (actor.role !== "owner") throw demoError("Forbidden");
        const draft = draftOrThrow(replyId);
        // I-6: email is the only channel, so the customer needs an address. Nothing sends here.
        if (!contacts.get(draft.contactId)?.email) throw demoError("Conflict", { reason: "no_email" });
        const approved: ReplyRecord = { ...draft, status: "approved", approvedBy: DEMO_OWNER, approvedAt: nowIso() };
        replies.set(replyId, approved);
        return approved;
      });
    },

    discardReply(replyId, options) {
      return idempotent("inbox.reply.discard", { replyId }, options, () => {
        const discarded: ReplyRecord = { ...draftOrThrow(replyId), status: "discarded", discardedAt: nowIso() };
        replies.set(replyId, discarded);
        return discarded;
      });
    },

    async getResults(query) {
      await wait();
      const parsed = parse(resultsQuerySchema, query);
      const { thisWeek, lastWeek } = weekRanges(clock.now().getTime(), parsed.zone, parsed.weekStart);
      const weekOf = (instant: string | null): "thisWeek" | "lastWeek" | null => {
        if (!instant) return null;
        const ms = Date.parse(instant);
        if (ms >= thisWeek.from && ms < thisWeek.to) return "thisWeek";
        if (ms >= lastWeek.from && ms < lastWeek.to) return "lastWeek";
        return null;
      };
      const tally = () => ({ thisWeek: 0, lastWeek: 0 });
      const leads = { ...tally(), bySource: [{ source: "website" as const, ...tally() }, { source: "manual" as const, ...tally() }] };
      for (const contact of contacts.values()) {
        const week = weekOf(contact.createdAt);
        if (!week) continue;
        const website = [...intakeItems.values()].some((item) => item.contactId === contact.id && item.status === "new_contact");
        leads[week] += 1;
        leads.bySource[website ? 0 : 1]![week] += 1;
      }
      const taken = { ...tally(), bySource: [{ source: "website" as const, ...tally() }, { source: "owner" as const, ...tally() }] };
      for (const booking of bookings.values()) {
        const week = weekOf(booking.createdAt);
        if (!week) continue;
        taken[week] += 1;
        taken.bySource[booking.source === "website" ? 0 : 1]![week] += 1;
      }
      const wonDeals = tally();
      const revenue = new Map<string, { thisWeek: number; lastWeek: number; bySource: Map<RevenueSource, { thisWeek: number; lastWeek: number }> }>();
      for (const deal of deals.values()) {
        const week = weekOf(deal.wonAt);
        if (!week) continue;
        wonDeals[week] += 1;
        if (!deal.value) continue;
        const entry = revenue.get(deal.value.currency) ?? { ...tally(), bySource: new Map() };
        const source = entry.bySource.get(deal.leadSource ?? "unset") ?? tally();
        entry[week] += deal.value.amountMinor;
        source[week] += deal.value.amountMinor;
        entry.bySource.set(deal.leadSource ?? "unset", source);
        revenue.set(deal.value.currency, entry);
      }
      const byThisWeek = <T extends { thisWeek: number; lastWeek: number }>(key: (item: T) => string) => (a: T, b: T) =>
        b.thisWeek - a.thisWeek || b.lastWeek - a.lastWeek || key(a).localeCompare(key(b));
      const results: HomeResults = {
        zone: parsed.zone,
        weekStart: parsed.weekStart,
        thisWeek: { from: new Date(thisWeek.from).toISOString(), to: new Date(thisWeek.to).toISOString() },
        lastWeek: { from: new Date(lastWeek.from).toISOString(), to: new Date(lastWeek.to).toISOString() },
        leads,
        bookings: taken,
        wonDeals,
        revenue: [...revenue].map(([currency, entry]) => ({
          currency, thisWeek: entry.thisWeek, lastWeek: entry.lastWeek,
          bySource: [...entry.bySource].map(([source, sums]) => ({ source, ...sums })).sort(byThisWeek((item) => item.source)),
        })).sort(byThisWeek((item) => item.currency)),
      };
      return clone(results);
    },

    bookAsSomeoneElse(resourceId, startsAt) {
      return toRecord(insertBooking(resourceOrThrow(resourceId), startsAt, newId(), "Booked by phone"));
    },

    editDealElsewhere(dealId, details = {}) {
      const deal = deals.get(dealId);
      if (!deal) throw demoError("Forbidden");
      const updated: DealSummary = { ...deal, ...details, revision: deal.revision + 1, updatedAt: nowIso() };
      deals.set(updated.id, updated);
      return toDealRecord(clone(updated));
    },

    approveReplyElsewhere(replyId) {
      const draft = draftOrThrow(replyId);
      const approved: ReplyRecord = { ...draft, status: "approved", approvedBy: DEMO_OWNER, approvedAt: nowIso() };
      replies.set(replyId, approved);
      return clone(approved);
    },

    loseNextResponse(options = {}) {
      loseNext = { goOffline: options.goOffline ?? false };
    },

    setOffline(value) {
      offline = value;
    },

    failNextBookingLink() {
      nextLinkFails = true;
    },

    raceNextBookingLink() {
      nextLinkRaced = true;
    },

    writeLog() {
      return clone(writes);
    },

    expireSession() {
      expired = true;
    },

    delayNextWrite(ms) {
      delayNext = ms;
    },

    failDealReads(failing) {
      dealReadsFail = failing;
    },

    failBookingReads(failing) {
      bookingReadsFail = failing;
    },

    setPipelines(next) {
      pipelines = clone(next);
    },

    setOpenHours(weekday, hours) {
      for (const resource of resources) {
        if (hours) resource.hours[weekday] = [...hours];
        else delete resource.hours[weekday];
      }
    },

    actAs(role) {
      actor = { role, userId: (role === "owner" ? DEMO_OWNER : DEMO_STAFF).userId };
      for (const listener of actorListeners) listener();
    },

    currentActor() {
      return { ...actor };
    },

    onActorChange(listener) {
      actorListeners.add(listener);
      return () => {
        actorListeners.delete(listener);
      };
    },
  };
}
