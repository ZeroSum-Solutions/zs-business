// Outreach reads (outreach-sequencer.md OS-22). They run in a tenant transaction as the runtime role, so RLS already hides
// every other tenant's rows, and they select only columns the role may read: never a token, history cursor or lease.
import {
  OUTREACH_PROSPECT_STATUSES,
  type ListOutreachProspectsQuery,
  type OutreachCampaignDetail,
  type OutreachCampaignRecord,
  type OutreachMailboxRecord,
  type OutreachProspectPage,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { decodeCursor, encodeCursor } from "../reads/cursor.js";
import {
  CAMPAIGN_COLUMNS,
  campaignMailboxIds,
  campaignRecord,
  loadCampaign,
  MAILBOX_COLUMNS,
  PROSPECT_COLUMNS,
  prospectRecord,
  type CampaignRow,
  type MailboxRow,
  type ProspectRow,
} from "./records.js";
import { localMoment } from "./schedule.js";

/** The send statuses that count against a daily cap (OS-12). */
export const COUNTED_SEND_STATUSES = Object.freeze(["sending", "sent", "uncertain", "lost"] as const);

/** The tenant's local date for `now`; UTC while the business has set no zone. */
export async function tenantToday(tx: Transaction, tenantId: string, now: Date): Promise<string> {
  const zone = (await tx.query<{ time_zone: string | null }>("SELECT time_zone FROM business_profiles WHERE tenant_id=$1", [tenantId])).rows[0]?.time_zone;
  return localMoment(zone ?? "UTC", now.getTime()).date;
}

async function sendsToday(tx: Transaction, tenantId: string, today: string, mailboxIds: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>(mailboxIds.map((id) => [id, 0]));
  if (mailboxIds.length === 0) return counts;
  for (const row of (await tx.query<{ mailbox_id: string; n: number }>(
    `SELECT mailbox_id, count(*)::int AS n FROM outreach_sends
      WHERE tenant_id=$1 AND mailbox_id = ANY($2::uuid[]) AND local_send_date=$3::date AND status = ANY($4::text[]) GROUP BY mailbox_id`,
    [tenantId, mailboxIds, today, COUNTED_SEND_STATUSES])).rows) counts.set(row.mailbox_id, row.n);
  return counts;
}

export async function listOutreachCampaigns(tx: Transaction, tenantId: string): Promise<OutreachCampaignRecord[]> {
  const rows = (await tx.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM outreach_campaigns WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT 200`, [tenantId])).rows;
  const links = new Map<string, string[]>();
  if (rows.length > 0) {
    for (const link of (await tx.query<{ campaign_id: string; mailbox_id: string }>(
      "SELECT campaign_id, mailbox_id FROM outreach_campaign_mailboxes WHERE tenant_id=$1 AND campaign_id = ANY($2::uuid[]) ORDER BY mailbox_id",
      [tenantId, rows.map((row) => row.id)])).rows) links.set(link.campaign_id, [...(links.get(link.campaign_id) ?? []), link.mailbox_id]);
  }
  return rows.map((row) => campaignRecord(row, links.get(row.id) ?? []));
}

/** One campaign with its steps, prospect counts by status and today's counted sends per mailbox; null when it is not this tenant's. */
export async function getOutreachCampaign(tx: Transaction, tenantId: string, id: string, now: Date): Promise<OutreachCampaignDetail | null> {
  const row = await loadCampaign(tx, tenantId, id);
  if (!row) return null;
  const mailboxIds = await campaignMailboxIds(tx, tenantId, id);
  const steps = (await tx.query<{ step_number: number; delay_business_days: number; subject: string | null; body: string }>(
    "SELECT step_number, delay_business_days, subject, body FROM outreach_campaign_steps WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY step_number",
    [tenantId, id])).rows;
  const counts: Record<string, number> = {};
  for (const count of (await tx.query<{ status: string; n: number }>(
    "SELECT status, count(*)::int AS n FROM outreach_prospects WHERE tenant_id=$1 AND campaign_id=$2 GROUP BY status", [tenantId, id])).rows)
    counts[count.status] = count.n;
  const today = await tenantToday(tx, tenantId, now);
  const perMailbox = await sendsToday(tx, tenantId, today, mailboxIds);
  return {
    campaign: campaignRecord(row, mailboxIds),
    steps: steps.map((step) => ({ stepNumber: step.step_number, delayBusinessDays: step.delay_business_days, subject: step.subject, body: step.body })),
    prospectCounts: counts,
    sendsToday: mailboxIds.map((mailboxId) => ({ mailboxId, count: perMailbox.get(mailboxId) ?? 0 })),
  };
}

/** A keyset page of one campaign's prospects in address order; null when the campaign is not this tenant's. */
export async function listOutreachProspects(
  tx: Transaction, tenantId: string, campaignId: string, query: ListOutreachProspectsQuery,
): Promise<OutreachProspectPage | null> {
  if ((await tx.query("SELECT 1 FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2", [tenantId, campaignId])).rowCount !== 1) return null;
  const cursor = decodeCursor("outreach.prospects", { cursor: query.cursor, offset: 0 });
  const rows = (await tx.query<ProspectRow>(
    `SELECT ${PROSPECT_COLUMNS} FROM outreach_prospects
      WHERE tenant_id=$1 AND campaign_id=$2 AND ($3::text IS NULL OR status=$3)
        ${cursor ? "AND (email > $5::text OR (email = $5::text AND id > $6::uuid))" : ""}
      ORDER BY email, id LIMIT $4`,
    [tenantId, campaignId, query.status ?? null, query.limit + 1, ...(cursor ?? [])])).rows;
  const more = rows.length > query.limit;
  const items = rows.slice(0, query.limit);
  const last = items[items.length - 1];
  return {
    items: items.map(prospectRecord),
    limit: query.limit,
    offset: 0,
    nextOffset: null,
    nextCursor: more && last ? encodeCursor("outreach.prospects", [last.email, last.id]) : null,
  };
}

/** The tenant's mailboxes: address, name, status, pause time and today's count. Never a token or the history cursor. */
export async function listOutreachMailboxes(tx: Transaction, tenantId: string, now: Date): Promise<OutreachMailboxRecord[]> {
  const rows = (await tx.query<MailboxRow>(
    `SELECT ${MAILBOX_COLUMNS} FROM outreach_mailboxes WHERE tenant_id=$1 ORDER BY email`, [tenantId])).rows;
  const counts = await sendsToday(tx, tenantId, await tenantToday(tx, tenantId, now), rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id, email: row.email, displayName: row.display_name, status: row.status,
    pausedUntil: row.paused_until ? row.paused_until.toISOString() : null, dailyLimit: row.daily_limit, sendsToday: counts.get(row.id) ?? 0,
  }));
}

/** The prospect statuses an owner may filter by. */
export const PROSPECT_FILTER_STATUSES = OUTREACH_PROSPECT_STATUSES;
