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

/** Every deal write bumps the revision and leaves one outbox row whose result is the deal. */
const DEAL_WRITE_TYPES = ["crm.deal.create", "crm.deal.move-stage", "crm.deal.set-details"];

/**
 * W-4: a deal is won when a write puts it in a stage whose outcome is `won` and the deal was
 * not already in a won stage just before that write. Both are read from the outbox history,
 * which is append-only, so a later reopen or edit cannot change the answer: the stage before
 * is the one the previous revision's write left, and the value is the last one set before this
 * write. A deal with no recorded previous write (made outside the action path) falls back to
 * its live won date.
 */
async function dealWon(tx: Transaction, row: OutboxRow): Promise<BusinessEvent[]> {
  const parsed = actionEvent(dealRecordSchema).safeParse(row.payload);
  if (!parsed.success) return [];
  const deal = parsed.data.result;
  const outcome = async (stageId: string) => (await tx.query<{ outcome: string }>(
    "SELECT outcome FROM crm_stages WHERE tenant_id=$1 AND id=$2", [row.tenant_id, stageId])).rows[0]?.outcome ?? null;
  if (await outcome(deal.stageId) !== "won") return [];
  const history = (revision: string, extra = "") => tx.query<{ stage_id: string | null; value: { amountMinor: number; currency: string } | null }>(
    `SELECT payload->'result'->>'stageId' AS stage_id, payload->'result'->'value' AS value FROM outbox
      WHERE tenant_id=$1 AND event_type = ANY($2::text[]) AND payload->'result'->>'id' = $3 ${extra}`,
    [row.tenant_id, DEAL_WRITE_TYPES, deal.id, revision]);
  if (deal.revision > 1) {
    const before = (await history(String(deal.revision - 1), "AND payload->'result'->>'revision' = $4 LIMIT 1")).rows[0];
    if (before?.stage_id) {
      if (await outcome(before.stage_id) === "won") return [];
    } else {
      const live = (await tx.query<{ won_at: Date | null }>(
        "SELECT won_at FROM crm_deals WHERE tenant_id=$1 AND id=$2", [row.tenant_id, deal.id])).rows[0];
      if (live?.won_at && live.won_at.getTime() < Date.parse(deal.updatedAt)) return [];
    }
  }
  const value = (await history(String(deal.revision),
    `AND event_type = 'crm.deal.set-details' AND (payload->'result'->>'revision')::bigint < $4::bigint
     ORDER BY (payload->'result'->>'revision')::bigint DESC LIMIT 1`)).rows[0]?.value ?? null;
  return [{
    type: "deal.won",
    data: {
      dealId: deal.id,
      contactId: deal.contactId,
      pipelineId: deal.pipelineId,
      stageId: deal.stageId,
      title: deal.title,
      valueMinor: value?.amountMinor ?? null,
      currency: value?.currency ?? null,
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
