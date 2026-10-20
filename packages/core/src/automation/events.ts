// M5 Activepieces business events (activepieces.md W-3, W-4). Original code. The worker reads
// committed outbox rows and turns the ones a subscriber cares about into business events. The
// data each event carries is read in the ingest transaction (service role), naming tenant_id in
// every statement, and is fixed from then on.
import { z } from "zod";
import {
  bookingRecordSchema,
  dealRecordSchema,
  publicBookingRequestResultSchema,
  type AutomationEventType,
  type JsonValue,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { PUBLIC_REQUEST_ACTION } from "../intake/public-request.js";

/** W-4: the outbox event types that can become a business event. */
export const SOURCE_EVENT_TYPES: readonly string[] = Object.freeze([
  PUBLIC_REQUEST_ACTION, "booking.create", "crm.deal.create", "crm.deal.move-stage",
]);

export interface OutboxRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly event_type: string;
  readonly payload: unknown;
  readonly created_at: Date;
}
export interface BusinessEvent {
  readonly type: AutomationEventType;
  readonly data: { readonly [key: string]: JsonValue };
}

/** The dispatcher's default event: the action's own result (actions/dispatch.ts). */
const actionEvent = <T extends z.ZodType>(result: T) => z.object({ actionId: z.uuid(), result });

/** What a subscriber may use about a website request; the visitor typed every field. */
async function websiteRequest(tx: Transaction, row: OutboxRow): Promise<BusinessEvent[]> {
  const parsed = actionEvent(publicBookingRequestResultSchema).safeParse(row.payload);
  if (!parsed.success) return [];
  const result = parsed.data.result;
  const item = (await tx.query<{
    channel: string; page_id: string; submitted_name: string; submitted_email: string; submitted_phone: string | null;
    notes: string | null; created_at: Date;
  }>(
    `SELECT channel, page_id, submitted_name, submitted_email, submitted_phone, notes, created_at
       FROM intake_items WHERE tenant_id=$1 AND id=$2`, [row.tenant_id, result.intakeItemId])).rows[0];
  if (!item) return [];
  const events: BusinessEvent[] = [
    {
      type: "lead.created",
      data: {
        intakeItemId: result.intakeItemId,
        contactId: result.contactId,
        // `possible_match`: the email or phone matches an existing customer an owner must review.
        match: result.outcome,
        name: item.submitted_name,
        email: item.submitted_email,
        phone: item.submitted_phone,
        channel: item.channel,
        pageId: item.page_id,
        bookingId: result.bookingId,
        createdAt: item.created_at.toISOString(),
      },
    },
    {
      type: "booking.created",
      data: {
        bookingId: result.bookingId,
        resourceId: result.resourceId,
        startsAt: result.startsAt,
        endsAt: result.endsAt,
        source: "website",
        intakeItemId: result.intakeItemId,
        contactId: result.contactId,
      },
    },
  ];
  if (item.notes !== null)
    events.push({
      type: "message.received",
      data: {
        intakeItemId: result.intakeItemId,
        contactId: result.contactId,
        channel: item.channel,
        body: item.notes,
        receivedAt: item.created_at.toISOString(),
      },
    });
  return events;
}

function ownerBooking(row: OutboxRow): BusinessEvent[] {
  const parsed = actionEvent(bookingRecordSchema).safeParse(row.payload);
  if (!parsed.success) return [];
  const booking = parsed.data.result;
  return [{
    type: "booking.created",
    data: {
      bookingId: booking.id,
      resourceId: booking.resourceId,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      source: "owner",
      intakeItemId: null,
      contactId: null,
    },
  }];
}

/**
 * W-4: a deal is won when a write puts it in a stage whose outcome is `won` and it was not
 * already won before that write (won_at earlier than the write means it moved between two won
 * stages). A deal that has since left the won stage still counts: the win happened.
 */
async function dealWon(tx: Transaction, row: OutboxRow): Promise<BusinessEvent[]> {
  const parsed = actionEvent(dealRecordSchema).safeParse(row.payload);
  if (!parsed.success) return [];
  const deal = parsed.data.result;
  const found = (await tx.query<{ outcome: string; won_at: Date | null; value_minor: string | null; currency: string | null }>(
    `SELECT s.outcome, d.won_at, d.value_minor::text AS value_minor, d.currency
       FROM crm_deals d JOIN crm_stages s ON s.tenant_id = d.tenant_id AND s.id = $3
      WHERE d.tenant_id=$1 AND d.id=$2`, [row.tenant_id, deal.id, deal.stageId])).rows[0];
  if (!found || found.outcome !== "won") return [];
  if (found.won_at !== null && found.won_at.getTime() < Date.parse(deal.updatedAt)) return [];
  return [{
    type: "deal.won",
    data: {
      dealId: deal.id,
      contactId: deal.contactId,
      pipelineId: deal.pipelineId,
      stageId: deal.stageId,
      title: deal.title,
      valueMinor: found.value_minor === null ? null : Number(found.value_minor),
      currency: found.currency,
      wonAt: deal.updatedAt,
    },
  }];
}

/** The business events one outbox row stands for; an unreadable row stands for none. */
export async function businessEvents(tx: Transaction, row: OutboxRow): Promise<BusinessEvent[]> {
  switch (row.event_type) {
    case PUBLIC_REQUEST_ACTION:
      return websiteRequest(tx, row);
    case "booking.create":
      return ownerBooking(row);
    case "crm.deal.create":
    case "crm.deal.move-stage":
      return dealWon(tx, row);
    default:
      return [];
  }
}
