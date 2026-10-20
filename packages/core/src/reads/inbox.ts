// M3c inbox reads (inbox-home.md I-1..I-3, I-8). Threads are derived from website requests and
// replies, so there is no thread row to keep in step. They run inside ScopedDatabase.tenant, so
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
import { decodeCursor, encodeCursor, microsToTimestamp, timestampToMicros } from "./cursor.js";
import { page } from "./page.js";

const PREVIEW_LENGTH = 140;
const PLACEHOLDER_EMAIL = /@placeholder\.invalid$/;
const realEmail = (email: string | null) => (email === null || PLACEHOLDER_EMAIL.test(email) ? null : email);

interface ReplyRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel: "email";
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
  SELECT r.id, r.tenant_id, r.contact_id, r.channel, r.body, r.status, r.drafted_by, d.email AS drafted_by_email,
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
 * per website request that names no contact. `$1` is the tenant; `kind` and `id` name the
 * parameters that optionally narrow it to one thread. Activity is the latest request, draft,
 * approval or settle time.
 */
const threads = (kindParam: string, idParam: string) => `
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
       AND (${kindParam}::text IS NULL OR (${kindParam} = 'visitor' AND i.id = ${idParam}::uuid))
  )
  SELECT kind, id, last_activity_at, needs_reply, needs_review, drafts,
         ${timestampToMicros("last_activity_at")} AS sort_value
    FROM threads`;

const threadId = (kind: ThreadKind, id: string) => `${kind === "customer" ? "c" : "v"}_${id}`;
const clip = (text: string | null) =>
  text === null ? null : text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`;

/** Names, addresses and the latest text for a page of threads, in two queries. */
async function summaries(tx: Transaction, tenantId: string, rows: readonly ThreadRow[]): Promise<ThreadSummary[]> {
  const contactIds = rows.filter((row) => row.kind === "customer").map((row) => row.id);
  const itemIds = rows.filter((row) => row.kind === "visitor").map((row) => row.id);
  const contacts = new Map((await tx.query<{
    id: string; display_name: string | null; normalized_email: string | null; e164_phone: string | null; preview: string | null;
  }>(
    `SELECT c.id, c.display_name, c.normalized_email, c.e164_phone,
            (SELECT x.text FROM (
               SELECT i.notes AS text, i.created_at AS at, i.id FROM intake_items i
                WHERE i.tenant_id = c.tenant_id AND i.contact_id = c.id AND i.notes IS NOT NULL
               UNION ALL
               SELECT r.body, r.created_at, r.id FROM inbox_replies r
                WHERE r.tenant_id = c.tenant_id AND r.contact_id = c.id AND r.status <> 'discarded'
             ) x ORDER BY x.at DESC, x.id DESC LIMIT 1) AS preview
       FROM crm_contacts c WHERE c.tenant_id=$1 AND c.id = ANY($2::uuid[])`,
    [tenantId, contactIds],
  )).rows.map((row) => [row.id, row]));
  const visitors = new Map((await tx.query<{ id: string; submitted_name: string; submitted_email: string; notes: string | null }>(
    "SELECT id, submitted_name, submitted_email, notes FROM intake_items WHERE tenant_id=$1 AND id = ANY($2::uuid[])",
    [tenantId, itemIds],
  )).rows.map((row) => [row.id, row]));
  return rows.map((row) => {
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
      const email = realEmail(contact.normalized_email);
      return {
        ...base, contactId: row.id, intakeItemId: null,
        name: contact.display_name ?? email ?? contact.e164_phone ?? "Customer",
        email, preview: clip(contact.preview),
      };
    }
    const visitor = visitors.get(row.id)!;
    return {
      ...base, contactId: null, intakeItemId: row.id,
      name: visitor.submitted_name, email: visitor.submitted_email, preview: clip(visitor.notes),
    };
  });
}

/** I-8: latest activity first; a cursor continues right after the last thread of the page before. */
export async function listThreads(tx: Transaction, tenantId: string, query: ListThreadsQuery): Promise<ThreadPage> {
  const cursor = decodeCursor("inbox.recent", query);
  const position = cursor
    ? `WHERE (last_activity_at < ${microsToTimestamp("$6")} OR (last_activity_at = ${microsToTimestamp("$6")} AND id > $7::uuid))`
    : "";
  const rows = (await tx.query<ThreadRow>(
    `SELECT * FROM (${threads("$4", "$5")}) t ${position} ORDER BY last_activity_at DESC, id LIMIT $2 OFFSET $3`,
    [tenantId, query.limit + 1, query.offset, null, null, ...(cursor ?? [])],
  )).rows;
  return page(await summaries(tx, tenantId, rows), query,
    (index) => encodeCursor("inbox.recent", [rows[index]!.sort_value, rows[index]!.id]));
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
export async function getThread(tx: Transaction, tenantId: string, id: ThreadId): Promise<ThreadDetail> {
  const kind: ThreadKind = id.startsWith("c_") ? "customer" : "visitor";
  const key = id.slice(2);
  const row = (await tx.query<ThreadRow>(threads("$2", "$3"), [tenantId, kind, key])).rows[0];
  if (!row) throw new NotFound("Thread not found");
  const [summary] = await summaries(tx, tenantId, [row]);
  const limit = THREAD_ENTRY_LIMIT + 1;
  const requests = (await tx.query<RequestRow>(
    `SELECT i.id, i.created_at, i.channel, i.status, i.submitted_name, i.notes,
            b.id AS booking_id, b.resource_id AS booking_resource_id, b.starts_at AS booking_starts_at, b.ends_at AS booking_ends_at
       FROM intake_items i LEFT JOIN bookings b ON b.tenant_id = i.tenant_id AND b.intake_item_id = i.id
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
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : entryId(a) < entryId(b) ? 1 : -1));
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

const entryId = (entry: ThreadEntry) => (entry.type === "request" ? entry.id : entry.reply.id);
