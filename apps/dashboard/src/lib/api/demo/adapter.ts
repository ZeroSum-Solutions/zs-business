/**
 * In-memory implementation of the booking and CRM API for demos and tests. It keeps
 * the same rules the server enforces: overlap conflicts, stale-revision conflicts,
 * contact dedupe by email or phone, and idempotent replays.
 */
import {
  bookingTimeZoneSchema,
  contactEmailInputSchema,
  contactPhoneSchema,
  type BookingRecord,
  type ContactRecord,
  type DealRecord,
} from "@zs/contracts";
import { addDays, localIso, weekdayOf, zonedDateKey, zonedTimeToUtc } from "../../time";
import { newId as defaultNewId } from "../../id";
import { demoError } from "../errors";
import { byContactName, matchesSearch, normalizePhone, type BookingApi, type BookingView, type ContactWriteResult, type CrmApi, type WriteOptions } from "../types";
import { buildSeed, DEMO_PIPELINE, DEMO_RESOURCES, DEMO_TENANT_ID, type DemoResource } from "./seed";

export interface DemoClock {
  now(): Date;
}

export interface DemoAdapterOptions {
  clock?: DemoClock;
  newId?: () => string;
  /** Artificial delay per call so loading states are visible. Tests pass 0. */
  latencyMs?: number;
}

/** Hooks that act as a second person using the business, to show conflicts. */
export interface DemoControls {
  bookAsSomeoneElse(resourceId: string, startsAt: string): BookingRecord;
  editDealElsewhere(dealId: string): DealRecord;
}

type StoredBooking = BookingRecord & { title: string | null; contactName: string | null };

const MAX_RANGE_MS = 31 * 86400000;
const clone = <T>(value: T): T => structuredClone(value);

export function createDemoAdapter(options: DemoAdapterOptions = {}): BookingApi & CrmApi & DemoControls {
  const clock = options.clock ?? { now: () => new Date() };
  const newId = options.newId ?? defaultNewId;
  const latency = options.latencyMs ?? 0;
  const seed = buildSeed(clock.now());
  const contacts = new Map(seed.contacts.map((item) => [item.id, item]));
  const deals = new Map(seed.deals.map((item) => [item.id, item]));
  const bookings = new Map<string, StoredBooking>(seed.bookings.map((item) => [item.id, item]));
  const replays = new Map<string, { fingerprint: string; result: unknown }>();

  const wait = () => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const nowIso = () => clock.now().toISOString();

  async function idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T> {
    await wait();
    const key = options.idempotencyKey ?? newId();
    const fingerprint = JSON.stringify([operation, payload]);
    const previous = replays.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw demoError(409, "Conflict", { reason: "idempotency_key_reused" });
      }
      return clone(previous.result as T);
    }
    const result = run();
    replays.set(key, { fingerprint, result: clone(result) });
    return clone(result);
  }

  function resourceOrThrow(id: string): DemoResource {
    const resource = DEMO_RESOURCES.find((item) => item.id === id);
    if (!resource) throw demoError(404, "NotFound", {}, "That calendar does not exist.");
    return resource;
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

  /** Every grid start for a resource on one local day, ignoring existing bookings. */
  function gridStarts(resource: DemoResource, dateKey: string): number[] {
    const hours = resource.hours[weekdayOf(dateKey)];
    if (!hours) return [];
    const [y, m, d] = dateKey.split("-").map(Number) as [number, number, number];
    const starts: number[] = [];
    for (let minute = hours[0]; minute + resource.slotLengthMinutes <= hours[1]; minute += resource.slotStepMinutes) {
      starts.push(zonedTimeToUtc(y, m, d, minute, resource.timeZone).getTime());
    }
    return starts;
  }

  function insertBooking(resource: DemoResource, startsAt: string, id: string, title: string | null): StoredBooking {
    const slot = occupied(resource, Date.parse(startsAt));
    if (clashes(resource, slot.occStart, slot.occEnd)) {
      throw demoError(409, "Conflict", { reason: "overlap" });
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
    };
    bookings.set(record.id, record);
    return record;
  }

  const toRecord = ({ title: _title, contactName: _contactName, ...record }: StoredBooking): BookingRecord => record;

  const invalid = (path: string, message: string) => demoError(400, "ValidationFailed", { issues: [{ path, message }] });

  function normalizeContact(input: { email: string | null; phone: string | null }) {
    let email: string | null = null;
    let phone: string | null = null;
    if (input.email !== null && input.email.trim() !== "") {
      const parsed = contactEmailInputSchema.safeParse(input.email);
      if (!parsed.success) throw invalid("email", "Invalid email address");
      email = parsed.data;
    }
    if (input.phone !== null && input.phone.trim() !== "") {
      const parsed = contactPhoneSchema.safeParse(normalizePhone(input.phone));
      if (!parsed.success) throw invalid("phone", "Expected E.164 phone");
      phone = parsed.data;
    }
    if (email === null && phone === null) {
      throw demoError(400, "ValidationFailed", { issues: [{ path: "", message: "At least one identity is required" }] }, "Add an email or a phone number.");
    }
    return { email, phone };
  }

  return {
    async listResources() {
      await wait();
      return DEMO_RESOURCES.map(({ id, name, timeZone, slotLengthMinutes }) => ({ id, name, timeZone, slotLengthMinutes }));
    },

    async getSlots({ resourceId, from, to, zone }) {
      await wait();
      const resource = resourceOrThrow(resourceId);
      const fromMs = Date.parse(from);
      const toMs = Date.parse(to);
      const labelZone = zone ?? resource.timeZone;
      if (!bookingTimeZoneSchema.safeParse(labelZone).success || Number.isNaN(fromMs) || Number.isNaN(toMs) || fromMs >= toMs || toMs - fromMs > MAX_RANGE_MS) {
        throw demoError(400, "ValidationFailed", {}, "That date range is not valid.");
      }
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
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      return clone(rows);
    },

    createBooking(input, options = {}) {
      return idempotent("booking.create", input, options, () => {
        const resource = resourceOrThrow(input.resourceId);
        const startsMs = Date.parse(input.startsAt);
        const onGrid = !Number.isNaN(startsMs) && gridStarts(resource, zonedDateKey(startsMs, resource.timeZone)).includes(startsMs);
        // The API refuses a start that is off the grid or too soon as a conflict, not a 400.
        if (!onGrid || startsMs < clock.now().getTime() + resource.minimumNoticeMinutes * 60000) {
          throw demoError(409, "Conflict", { reason: "slot_unavailable" });
        }
        return toRecord(insertBooking(resource, input.startsAt, newId(), null));
      });
    },

    async listPipelines() {
      await wait();
      return [clone(DEMO_PIPELINE)];
    },

    async listContacts(query = {}) {
      await wait();
      const rows = [...contacts.values()].filter((item) => matchesSearch(item, query.search)).sort(byContactName);
      return clone(rows);
    },

    async getContact(id) {
      await wait();
      const contact = contacts.get(id);
      if (!contact) throw demoError(404, "NotFound", {}, "We could not find that customer.");
      return clone(contact);
    },

    createOrFindContact(input, options = {}) {
      return idempotent("crm.contact.create-or-find", input, options, (): ContactWriteResult => {
        const { email, phone } = normalizeContact(input);
        const all = [...contacts.values()];
        const byEmail = email ? all.find((item) => item.email === email) : undefined;
        const byPhone = phone ? all.find((item) => item.phone === phone) : undefined;
        if (byEmail && byPhone && byEmail.id !== byPhone.id) {
          throw demoError(409, "Conflict", { reason: "split_identity" });
        }
        const existing = byEmail ?? byPhone;
        if (existing) return { contact: existing, created: false };
        const name = input.displayName?.trim() || null;
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
      const rows = [...deals.values()]
        .filter((item) => !query.contactId || item.contactId === query.contactId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return clone(rows);
    },

    moveDealStage(input, options = {}) {
      return idempotent("crm.deal.move-stage", input, options, () => {
        const deal = deals.get(input.dealId);
        if (!deal) throw demoError(404, "NotFound", {}, "We could not find that deal.");
        if (input.pipelineId !== deal.pipelineId || !DEMO_PIPELINE.stages.some((stage) => stage.id === input.stageId)) {
          throw demoError(400, "ValidationFailed", {}, "That stage is not part of this pipeline.");
        }
        if (input.expectedRevision !== deal.revision) {
          throw demoError(409, "Conflict", { reason: "stale_revision", currentRevision: deal.revision });
        }
        const updated: DealRecord = { ...deal, stageId: input.stageId, revision: deal.revision + 1, updatedAt: nowIso() };
        deals.set(updated.id, updated);
        return updated;
      });
    },

    bookAsSomeoneElse(resourceId, startsAt) {
      return toRecord(insertBooking(resourceOrThrow(resourceId), startsAt, newId(), "Booked by phone"));
    },

    editDealElsewhere(dealId) {
      const deal = deals.get(dealId);
      if (!deal) throw demoError(404, "NotFound", {}, "We could not find that deal.");
      const updated: DealRecord = { ...deal, revision: deal.revision + 1, updatedAt: nowIso() };
      deals.set(updated.id, updated);
      return clone(updated);
    },
  };
}
