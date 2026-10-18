import { z } from "zod";
import {
  bookingInstantSchema,
  contactRecordSchema,
  dealRecordSchema,
  uuidSchema,
  type BookingRecord,
  type ConsentEvidence,
  type ContactRecord,
  type DealRecord,
  type GetAvailableSlotsOutput,
} from "@zs/contracts";
import type { WorkspaceApi } from "./workspace-types";

export type { BookingRecord, ConsentEvidence, ContactRecord, DealRecord, GetAvailableSlotsOutput };

/** Options every write accepts. Reuse the same key to retry the same write safely. */
export interface WriteOptions {
  idempotencyKey?: string;
}

// TODO(contracts): the list routes have no shared page shape yet. Proposed here.
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable().optional() });

// TODO(contracts): booking list rows. BookingRecord fields plus an optional display label.
export const bookingListItemSchema = z.object({
  id: uuidSchema,
  resourceId: uuidSchema,
  startsAt: bookingInstantSchema,
  endsAt: bookingInstantSchema,
  status: z.literal("confirmed"),
  title: z.string().nullish(),
  contactName: z.string().nullish(),
});
export type BookingListItem = z.infer<typeof bookingListItemSchema>;

export const contactPageSchema = pageSchema(contactRecordSchema);
export const dealPageSchema = pageSchema(dealRecordSchema);
export const bookingPageSchema = pageSchema(bookingListItemSchema);

// TODO(contracts): there is no resource or pipeline read route yet. These shapes come
// from config (HTTP) or the seed (demo) until one exists.
export const bookingResourceSummarySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1),
  kind: z.enum(["showroom", "repair"]),
  timeZone: z.string().min(1),
});
export type BookingResourceSummary = z.infer<typeof bookingResourceSummarySchema>;

export const pipelineSummarySchema = z.object({
  id: uuidSchema,
  stages: z.array(z.object({ id: uuidSchema, name: z.string().min(1) })).min(1),
});
export type PipelineSummary = z.infer<typeof pipelineSummarySchema>;

export interface SlotQuery {
  resourceId: string;
  from: string;
  to: string;
  zone: string;
}

export interface BookingListQuery {
  resourceId?: string;
  from?: string;
  to?: string;
}

export interface NewBooking {
  resourceId: string;
  startsAt: string;
  /** Pre-minted ID. Pass the same one with the same idempotency key on retry. */
  bookingId?: string;
}

export interface NewContact {
  displayName: string | null;
  email: string | null;
  phone: string | null;
  contactId?: string;
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
  listResources(): Promise<BookingResourceSummary[]>;
  getSlots(query: SlotQuery): Promise<GetAvailableSlotsOutput>;
  listBookings(query?: BookingListQuery): Promise<BookingListItem[]>;
  /** Throws ApiError kind "conflict" when the time was taken first. */
  createBooking(input: NewBooking, options?: WriteOptions): Promise<BookingRecord>;
}

export interface CrmApi {
  getPipeline(): Promise<PipelineSummary>;
  listContacts(query?: { search?: string }): Promise<ContactRecord[]>;
  getContact(id: string): Promise<ContactRecord>;
  /** Returns `created: false` with the existing contact when the email or phone is known. */
  createOrFindContact(input: NewContact, options?: WriteOptions): Promise<ContactWriteResult>;
  listDeals(query?: { contactId?: string }): Promise<DealRecord[]>;
  /** Throws ApiError kind "conflict" when the deal changed since `expectedRevision`. */
  moveDealStage(input: StageMove, options?: WriteOptions): Promise<DealRecord>;
}

export type ZsApi = BookingApi & CrmApi & WorkspaceApi;
