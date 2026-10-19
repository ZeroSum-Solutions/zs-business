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
  linkIntakeItemRequestSchema,
  listIntakeItemsQuerySchema,
  uuidSchema,
  moveDealStageRequestSchema,
  slotsQuerySchema,
  upsertContactRequestSchema,
  type BookingRecord,
  type ContactRecord,
  type DealRecord,
  type IntakeItemRecord,
  type PipelineSummary,
} from "@zs/contracts";
import { addDays, localIso, wallTimeInstants, weekdayOf, zonedDateKey } from "../../time";
import { newId as defaultNewId } from "../../id";
import { ApiError, contactNotFound, defaultMessage, demoError, demoValidationError } from "../errors";
import {
  byContactName,
  completeList,
  CONTACT_PAGE_SIZE,
  matchesSearch,
  toUpsertContactRequest,
  type BookingApi,
  type BookingView,
  type ContactWriteResult,
  type CrmApi,
  type IntakeApi,
  type WriteOptions,
} from "../types";
import { buildSeed, DEMO_BOOKING_PAGE, DEMO_PIPELINE, DEMO_RESOURCES, DEMO_TENANT_ID, type DemoBooking, type DemoResource } from "./seed";

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
export interface DemoControls {
  bookAsSomeoneElse(resourceId: string, startsAt: string): BookingRecord;
  editDealElsewhere(dealId: string): DealRecord;
  /**
   * The next write is saved, but its response is lost: the caller sees a network error.
   * With `goOffline` the connection stays down afterwards, until `setOffline(false)`.
   */
  loseNextResponse(options?: { goOffline?: boolean }): void;
  /** While offline every call fails with a network error before it touches the data. */
  setOffline(offline: boolean): void;
  /** Every write that reached the adapter, oldest first, with the key it carried. */
  writeLog(): DemoWrite[];
  /** From now on every call fails as a 401, like an API token that ran out. */
  expireSession(): void;
  /** The next write waits this long before it runs, to test answers that arrive late. */
  delayNextWrite(ms: number): void;
  /** While on, every read of the deal list fails with a network error; writes still work. */
  failDealReads(failing: boolean): void;
  /** Replaces the business's pipelines, such as none, one without stages, or several. */
  setPipelines(pipelines: PipelineSummary[]): void;
  /**
   * Opens every calendar on an ISO weekday (1 = Monday) between two local minutes, or closes
   * it with null, such as across the night clocks change.
   */
  setOpenHours(weekday: number, hours: [number, number] | null): void;
}

export interface DemoWrite {
  operation: string;
  idempotencyKey: string;
  /** The request body as the adapter received it, such as the instant a booking asked for. */
  payload: unknown;
  outcome: "applied" | "replayed" | "rejected";
}

type StoredBooking = DemoBooking;

const clone = <T>(value: T): T => structuredClone(value);

export function createDemoAdapter(options: DemoAdapterOptions = {}): BookingApi & CrmApi & IntakeApi & DemoControls {
  const clock = options.clock ?? { now: () => new Date() };
  const newId = options.newId ?? defaultNewId;
  const latency = options.latencyMs ?? 0;
  const seed = buildSeed(clock.now());
  const contacts = new Map(seed.contacts.map((item) => [item.id, item]));
  const deals = new Map(seed.deals.map((item) => [item.id, item]));
  const bookings = new Map<string, StoredBooking>(seed.bookings.map((item) => [item.id, item]));
  const intakeItems = new Map(seed.intakeItems.map((item) => [item.id, item]));
  const replays = new Map<string, { fingerprint: string; result: unknown }>();
  const writes: DemoWrite[] = [];
  let offline = false;
  let loseNext: { goOffline: boolean } | null = null;
  let expired = false;
  let delayNext = 0;
  let dealReadsFail = false;
  let pipelines = clone(options.pipelines ?? [DEMO_PIPELINE]);
  // A copy per adapter: setOpenHours changes this business's calendars only.
  const resources = clone(DEMO_RESOURCES);

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

  /** Like the API's bookings list: website bookings carry their customer (public-intake.md P-12). */
  function toView(booking: StoredBooking): BookingView {
    const item = booking.intakeItemId ? intakeItems.get(booking.intakeItemId) : undefined;
    const contact = item?.contactId ? contacts.get(item.contactId) : undefined;
    return {
      ...booking,
      customer: item ? { contactId: item.contactId, name: contact?.displayName ?? item.submitted.name, status: item.status } : null,
    };
  }

  /** The API refuses a reviewed item and treats an unknown one as another tenant's (403). */
  function pendingItem(id: string): IntakeItemRecord {
    parse(uuidSchema, id);
    const item = intakeItems.get(id);
    if (!item) throw demoError("Forbidden");
    if (item.status !== "possible_match") throw demoError("Conflict", { reason: "already_reviewed" });
    return item;
  }

  return {
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
      const fromMs = query.from ? Date.parse(query.from) : -Infinity;
      const toMs = query.to ? Date.parse(query.to) : Infinity;
      const rows: BookingView[] = [...bookings.values()]
        .filter((item) => (!query.resourceId || item.resourceId === query.resourceId) &&
          Date.parse(item.endsAt) > fromMs && Date.parse(item.startsAt) < toMs)
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
        const updated: DealRecord = { ...deal, stageId: move.stageId, revision: deal.revision + 1, updatedAt: nowIso() };
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

    bookAsSomeoneElse(resourceId, startsAt) {
      return toRecord(insertBooking(resourceOrThrow(resourceId), startsAt, newId(), "Booked by phone"));
    },

    editDealElsewhere(dealId) {
      const deal = deals.get(dealId);
      if (!deal) throw demoError("Forbidden");
      const updated: DealRecord = { ...deal, revision: deal.revision + 1, updatedAt: nowIso() };
      deals.set(updated.id, updated);
      return clone(updated);
    },

    loseNextResponse(options = {}) {
      loseNext = { goOffline: options.goOffline ?? false };
    },

    setOffline(value) {
      offline = value;
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

    setPipelines(next) {
      pipelines = clone(next);
    },

    setOpenHours(weekday, hours) {
      for (const resource of resources) {
        if (hours) resource.hours[weekday] = [...hours];
        else delete resource.hours[weekday];
      }
    },
  };
}
