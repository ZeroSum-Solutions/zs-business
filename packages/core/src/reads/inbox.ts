// M3c inbox reads (inbox-home.md I-1..I-3, I-8). Threads are derived from website requests,
// replies and (revision 5, member sessions only) inbound email, so there is no thread row to keep in step. They run inside ScopedDatabase.tenant, so
// RLS limits rows to the tenant; the tenant_id filters are defence in depth.
import {
  NotFound,
  THREAD_ENTRY_LIMIT,
  type IntakeChannel,
  type IntakeStatus,
  type ListThreadsQuery,
  type ReplyRecord,
  type ReplyStatus,
  type ThreadDetail,
  type ThreadEntry,
  type ThreadId,
  type ThreadKind,
  type ThreadPage,
  type ThreadSummary,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { usableEmail } from "../delivery/policy.js";
import { decodeCursor, encodeCursor, microsToTimestamp, timestampToMicros } from "./cursor.js";
import { page } from "./page.js";

const PREVIEW_LENGTH = 140;

/**
 * Who reads. Inbound email (inbound-email.md IE-24, IE-33) is shown to member sessions only: MCP and
 * automation tokens see no sender thread and no email entry before slice 4, so they leave it false.
 */
export interface InboxReadOptions {
  includeEmail?: boolean;
}

/**
 * IE-24 slice 1: an email a sender thread shows. Received over the hub's own address (never a Gmail
 * mailbox), not dropped, not a duplicate, not spam, not bound to a contact and not rejected.
 */
const VISIBLE_EMAIL = (alias: string) => `${alias}.provider = 'resend' AND ${alias}.status IN ('received','ready')
       AND ${alias}.kind <> 'spam' AND ${alias}.duplicate_of IS NULL AND ${alias}.contact_id IS NULL
       AND (${alias}.review IS NULL OR ${alias}.review IN ('possible_match','unmatched'))`;

interface ReplyRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel: "email";
  subject: string;
  body: string;
  status: ReplyStatus;
  drafted_by: string;
  drafted_by_email: string | null;
  created_at: Date;
  approved_by: string | null;
  approved_by_email: string | null;
  approved_at: Date | null;
  discarded_at: Date | null;
  settled_at: Date | null;
}

// Actor emails come from the current members; a removed member shows as an ID only.
const REPLY_SELECT = `
  SELECT r.id, r.tenant_id, r.contact_id, r.channel, r.subject, r.body, r.status, r.drafted_by, d.email AS drafted_by_email,
         r.created_at, r.approved_by, a.email AS approved_by_email, r.approved_at, r.discarded_at, r.settled_at
    FROM inbox_replies r
    LEFT JOIN tenant_members d ON d.tenant_id = r.tenant_id AND d.user_id = r.drafted_by
    LEFT JOIN tenant_members a ON a.tenant_id = r.tenant_id AND a.user_id = r.approved_by`;

function replyRecord(row: ReplyRow): ReplyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    contactId: row.contact_id,
    channel: row.channel,
    subject: row.subject,
    body: row.body,
    status: row.status,
    draftedBy: { userId: row.drafted_by, email: row.drafted_by_email },
    createdAt: row.created_at.toISOString(),
    approvedBy: row.approved_by === null ? null : { userId: row.approved_by, email: row.approved_by_email },
    approvedAt: row.approved_at?.toISOString() ?? null,
    discardedAt: row.discarded_at?.toISOString() ?? null,
    settledAt: row.settled_at?.toISOString() ?? null,
  };
}

export async function loadReply(tx: Transaction, tenantId: string, id: string): Promise<ReplyRecord | null> {
  const row = (await tx.query<ReplyRow>(`${REPLY_SELECT} WHERE r.tenant_id=$1 AND r.id=$2`, [tenantId, id])).rows[0];
  return row ? replyRecord(row) : null;
}

interface ThreadRow {
  kind: ThreadKind;
  id: string;
  last_activity_at: Date;
  needs_reply: boolean;
  needs_review: boolean;
  drafts: number;
  sort_value: string;
}

/**
 * I-1: one row per customer with a website request or a reply that is not discarded, and one
 * per website request that names no contact; with `email`, one per sender of a visible inbound
 * email (IE-24). `$1` is the tenant; `kind` and `id` name the parameters that optionally narrow
 * it to one thread. Activity is the latest request, draft, approval, settle or receive time.
 */
const threads = (kindParam: string, idParam: string, email: boolean) => `
  WITH requests AS (
    SELECT contact_id, max(created_at) AS last_in
      FROM intake_items WHERE tenant_id=$1 AND contact_id IS NOT NULL
       AND (${kindParam}::text IS NULL OR (${kindParam} = 'customer' AND contact_id = ${idParam}::uuid))
     GROUP BY contact_id
  ), replies AS (
    SELECT contact_id,
           max(greatest(created_at, approved_at, settled_at)) AS last_out,
           max(approved_at) AS last_approved,
           (count(*) FILTER (WHERE status = 'draft'))::int AS drafts
      FROM inbox_replies WHERE tenant_id=$1 AND status <> 'discarded'
       AND (${kindParam}::text IS NULL OR (${kindParam} = 'customer' AND contact_id = ${idParam}::uuid))
     GROUP BY contact_id
  ), threads AS (
    SELECT 'customer'::text AS kind, coalesce(q.contact_id, r.contact_id) AS id,
           greatest(q.last_in, r.last_out) AS last_activity_at,
           (q.last_in IS NOT NULL AND (r.last_approved IS NULL OR r.last_approved < q.last_in)) AS needs_reply,
           false AS needs_review, coalesce(r.drafts, 0) AS drafts
      FROM requests q FULL JOIN replies r ON r.contact_id = q.contact_id
    UNION ALL
    SELECT 'visitor', i.id, i.created_at, false, i.status = 'possible_match', 0
      FROM intake_items i WHERE i.tenant_id=$1 AND i.contact_id IS NULL
       AND (${kindParam}::text IS NULL OR (${kindParam} = 'visitor' AND i.id = ${idParam}::uuid))${email ? `
    UNION ALL
    SELECT 'sender', e.sender_key, max(e.received_at), false, true, 0
      FROM inbound_emails e WHERE e.tenant_id=$1 AND ${VISIBLE_EMAIL("e")}
       AND (${kindParam}::text IS NULL OR (${kindParam} = 'sender' AND e.sender_key = ${idParam}::uuid))
     GROUP BY e.sender_key` : ""}
  )
  SELECT kind, id, last_activity_at, needs_reply, needs_review, drafts,
         ${timestampToMicros("last_activity_at")} AS sort_value
    FROM threads`;

const THREAD_PREFIX: Record<ThreadKind, string> = { customer: "c", visitor: "v", sender: "e" };
const threadId = (kind: ThreadKind, id: string) => `${THREAD_PREFIX[kind]}_${id}`;
/** Cuts by code point, so an emoji is never split in half. */
const clip = (text: string | null) => {
  if (text === null) return null;
  const chars = Array.from(text);
  return chars.length <= PREVIEW_LENGTH ? text : `${chars.slice(0, PREVIEW_LENGTH - 1).join("")}…`;
};

/** Names, addresses and the latest text for a page of threads, in one query per thread kind on the page. */
async function summaries(tx: Transaction, tenantId: string, rows: readonly ThreadRow[]): Promise<ThreadSummary[]> {
  const contactIds = rows.filter((row) => row.kind === "customer").map((row) => row.id);
  const itemIds = rows.filter((row) => row.kind === "visitor").map((row) => row.id);
  const contacts = new Map((await tx.query<{
    id: string; display_name: string | null; normalized_email: string | null; e164_phone: string | null; preview: string | null;
  }>(
    `SELECT c.id, c.display_name, c.normalized_email, c.e164_phone,
            (SELECT x.text FROM (
               SELECT i.notes AS text, i.created_at AS at, 0 AS rank, i.id FROM intake_items i
                WHERE i.tenant_id = c.tenant_id AND i.contact_id = c.id AND i.notes IS NOT NULL
               UNION ALL
               SELECT r.body, r.created_at, 1, r.id FROM inbox_replies r
                WHERE r.tenant_id = c.tenant_id AND r.contact_id = c.id AND r.status <> 'discarded'
             ) x ORDER BY x.at DESC, x.rank DESC, x.id DESC LIMIT 1) AS preview
       FROM crm_contacts c WHERE c.tenant_id=$1 AND c.id = ANY($2::uuid[])`,
    [tenantId, contactIds],
  )).rows.map((row) => [row.id, row]));
  const visitors = new Map((await tx.query<{ id: string; submitted_name: string; submitted_email: string; notes: string | null }>(
    "SELECT id, submitted_name, submitted_email, notes FROM intake_items WHERE tenant_id=$1 AND id = ANY($2::uuid[])",
    [tenantId, itemIds],
  )).rows.map((row) => [row.id, row]));
  const senderKeys = rows.filter((row) => row.kind === "sender").map((row) => row.id);
  // A sender is named by their latest visible email.
  const senders = new Map(senderKeys.length === 0 ? [] : (await tx.query<{
    sender_key: string; from_address: string; from_name: string | null; subject: string | null;
  }>(
    `SELECT DISTINCT ON (e.sender_key) e.sender_key, e.from_address, e.from_name, e.subject
       FROM inbound_emails e WHERE e.tenant_id=$1 AND e.sender_key = ANY($2::uuid[]) AND ${VISIBLE_EMAIL("e")}
      ORDER BY e.sender_key, e.received_at DESC, e.id DESC`,
    [tenantId, senderKeys],
  )).rows.map((row) => [row.sender_key, row]));
  return rows.flatMap((row): ThreadSummary | ThreadSummary[] => {
    const base = {
      id: threadId(row.kind, row.id),
      kind: row.kind,
      lastActivityAt: row.last_activity_at.toISOString(),
      needsReply: row.needs_reply,
      needsReview: row.needs_review,
      drafts: row.drafts,
    };
    if (row.kind === "customer") {
      const contact = contacts.get(row.id)!;
      const email = usableEmail(contact.normalized_email);
      return {
        ...base, contactId: row.id, intakeItemId: null,
        name: contact.display_name ?? email ?? contact.e164_phone ?? "Customer",
        email, preview: clip(contact.preview),
      };
    }
    if (row.kind === "sender") {
      // The scan and this lookup are two statements: an email deleted in between (the service role deletes)
      // can leave a sender with no visible email. That thread is gone; it is left out, never a 500.
      const sender = senders.get(row.id);
      if (!sender) return [];
      return [{
        ...base, contactId: null, intakeItemId: null,
        name: sender.from_name ?? sender.from_address, email: sender.from_address, preview: clip(sender.subject),
      }];
    }
    const visitor = visitors.get(row.id)!;
    return {
      ...base, contactId: null, intakeItemId: row.id,
      name: visitor.submitted_name, email: visitor.submitted_email, preview: clip(visitor.notes),
    };
  });
}

/** I-8: latest activity first; a cursor continues right after the last thread of the page before. */
export async function listThreads(
  tx: Transaction, tenantId: string, query: ListThreadsQuery, options: InboxReadOptions = {},
): Promise<ThreadPage> {
  const cursor = decodeCursor("inbox.recent", query);
  const position = cursor
    ? `WHERE (last_activity_at < ${microsToTimestamp("$6")} OR (last_activity_at = ${microsToTimestamp("$6")} AND id > $7::uuid))`
    : "";
  const rows = (await tx.query<ThreadRow>(
    `SELECT * FROM (${threads("$4", "$5", options.includeEmail === true)}) t ${position} ORDER BY last_activity_at DESC, id LIMIT $2 OFFSET $3`,
    [tenantId, query.limit + 1, query.offset, null, null, ...(cursor ?? [])],
  )).rows;
  // "More" and the cursor come from the scanned rows, not the summaries: a sender whose last email went
  // between the two queries leaves a short page, never a lost next page.
  const scanned = page(rows, query, (index) => encodeCursor("inbox.recent", [rows[index]!.sort_value, rows[index]!.id]));
  return { ...scanned, items: await summaries(tx, tenantId, scanned.items) };
}

interface RequestRow {
  id: string;
  created_at: Date;
  channel: IntakeChannel;
  status: IntakeStatus;
  submitted_name: string;
  notes: string | null;
  booking_id: string | null;
  booking_resource_id: string | null;
  booking_starts_at: Date | null;
  booking_ends_at: Date | null;
}

/** I-2, I-3: one thread with its latest entries, oldest first. */
export async function getThread(
  tx: Transaction, tenantId: string, id: ThreadId, options: InboxReadOptions = {},
): Promise<ThreadDetail> {
  const kind: ThreadKind = id.startsWith("c_") ? "customer" : id.startsWith("e_") ? "sender" : "visitor";
  const key = id.slice(2);
  const email = options.includeEmail === true;
  // A reader without email sees no sender thread: the same 404 as an unknown ID.
  if (kind === "sender" && !email) throw new NotFound("Thread not found");
  const row = (await tx.query<ThreadRow>(threads("$2", "$3", email), [tenantId, kind, key])).rows[0];
  if (!row) throw new NotFound("Thread not found");
  if (kind === "sender") return senderThread(tx, tenantId, key, row);
  const [summary] = await summaries(tx, tenantId, [row]);
  const limit = THREAD_ENTRY_LIMIT + 1;
  const requests = (await tx.query<RequestRow>(
    `SELECT i.id, i.created_at, i.channel, i.status, i.submitted_name, i.notes,
            b.id AS booking_id, b.resource_id AS booking_resource_id, b.starts_at AS booking_starts_at, b.ends_at AS booking_ends_at
       FROM intake_items i LEFT JOIN bookings b ON b.tenant_id = i.tenant_id AND b.intake_item_id = i.id AND b.status = 'confirmed'
      WHERE i.tenant_id=$1 AND ${kind === "customer" ? "i.contact_id" : "i.id"} = $2
      ORDER BY i.created_at DESC, i.id DESC LIMIT $3`,
    [tenantId, key, limit],
  )).rows;
  const replies = kind === "visitor" ? [] : (await tx.query<ReplyRow>(
    `${REPLY_SELECT} WHERE r.tenant_id=$1 AND r.contact_id=$2 AND r.status <> 'discarded'
      ORDER BY r.created_at DESC, r.id DESC LIMIT $3`,
    [tenantId, key, limit],
  )).rows;
  const entries: ThreadEntry[] = [
    ...requests.map((request): ThreadEntry => ({
      type: "request",
      id: request.id,
      at: request.created_at.toISOString(),
      channel: request.channel,
      status: request.status,
      name: request.submitted_name,
      notes: request.notes,
      booking: request.booking_id && request.booking_resource_id && request.booking_starts_at && request.booking_ends_at
        ? {
          id: request.booking_id,
          resourceId: request.booking_resource_id,
          startsAt: request.booking_starts_at.toISOString(),
          endsAt: request.booking_ends_at.toISOString(),
        }
        : null,
    })),
    ...replies.map((reply): ThreadEntry => ({ type: "reply", at: reply.created_at.toISOString(), reply: replyRecord(reply) })),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1
    // A reply drafted in the same millisecond as a request answers it, so it is the newer one.
    : a.type !== b.type ? (a.type === "reply" ? -1 : 1)
    : entryId(a) < entryId(b) ? 1 : -1));
  const phone = kind === "customer"
    ? (await tx.query<{ e164_phone: string | null }>(
      "SELECT e164_phone FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, key])).rows[0]?.e164_phone ?? null
    : (await tx.query<{ submitted_phone: string | null }>(
      "SELECT submitted_phone FROM intake_items WHERE tenant_id=$1 AND id=$2", [tenantId, key])).rows[0]?.submitted_phone ?? null;
  return {
    ...summary!,
    phone,
    entries: entries.slice(0, THREAD_ENTRY_LIMIT).reverse(),
    olderEntries: entries.length > THREAD_ENTRY_LIMIT,
  };
}

const entryId = (entry: ThreadEntry) => (entry.type === "reply" ? entry.reply.id : entry.id);

/**
 * IE-24 slice 1: a sender thread holds that sender's visible emails as metadata only (sender,
 * subject, time); a `received` row is marked content pending. No body is read here.
 */
async function senderThread(tx: Transaction, tenantId: string, senderKey: string, row: ThreadRow): Promise<ThreadDetail> {
  const [summary] = await summaries(tx, tenantId, [row]);
  // Each query reads its own snapshot: a sender whose last email was dropped or erased in between has no thread.
  if (!summary) throw new NotFound("Thread not found");
  const emails = (await tx.query<{
    id: string; received_at: Date; from_address: string; from_name: string | null; subject: string | null; status: string;
  }>(
    `SELECT e.id, e.received_at, e.from_address, e.from_name, e.subject, e.status
       FROM inbound_emails e WHERE e.tenant_id=$1 AND e.sender_key=$2 AND ${VISIBLE_EMAIL("e")}
      ORDER BY e.received_at DESC, e.id DESC LIMIT $3`,
    [tenantId, senderKey, THREAD_ENTRY_LIMIT + 1],
  )).rows;
  const entries = emails.map((email): ThreadEntry => ({
    type: "email",
    id: email.id,
    at: email.received_at.toISOString(),
    fromAddress: email.from_address,
    fromName: email.from_name,
    subject: email.subject,
    contentPending: email.status === "received",
  }));
  if (entries.length === 0) throw new NotFound("Thread not found");
  return {
    ...summary,
    phone: null,
    entries: entries.slice(0, THREAD_ENTRY_LIMIT).reverse(),
    olderEntries: entries.length > THREAD_ENTRY_LIMIT,
  };
}
