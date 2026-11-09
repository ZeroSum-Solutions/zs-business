// Row shapes and mappers for outreach reads and action results (outreach-sequencer.md OS-22). No token, cursor or lease
// column is ever selected here.
import type { Transaction } from "@zs/db";
import type { OutreachCampaignRecord, OutreachMailboxRecord, OutreachProspectRecord } from "@zs/contracts";

export const CAMPAIGN_COLUMNS =
  "id,name,status,paused_reason,window_start_min,window_end_min,daily_cap_per_mailbox,content_digest,activation_approval_id,activated_at,created_at,updated_at";
export interface CampaignRow {
  id: string;
  name: string;
  status: OutreachCampaignRecord["status"];
  paused_reason: string | null;
  window_start_min: number;
  window_end_min: number;
  daily_cap_per_mailbox: number;
  content_digest: string;
  activation_approval_id: string | null;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

export async function campaignMailboxIds(tx: Transaction, tenantId: string, campaignId: string): Promise<string[]> {
  return (await tx.query<{ mailbox_id: string }>(
    "SELECT mailbox_id FROM outreach_campaign_mailboxes WHERE tenant_id=$1 AND campaign_id=$2 ORDER BY mailbox_id", [tenantId, campaignId],
  )).rows.map((row) => row.mailbox_id);
}

export function campaignRecord(row: CampaignRow, mailboxIds: readonly string[]): OutreachCampaignRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    pausedReason: row.paused_reason,
    window: { start: clock(row.window_start_min), end: clock(row.window_end_min) },
    dailyCapPerMailbox: row.daily_cap_per_mailbox,
    contentDigest: row.content_digest,
    mailboxIds: [...mailboxIds],
    activationApprovalId: row.activation_approval_id,
    activatedAt: row.activated_at ? row.activated_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function loadCampaign(tx: Transaction, tenantId: string, id: string, lock = false): Promise<CampaignRow | null> {
  return (await tx.query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM outreach_campaigns WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, id],
  )).rows[0] ?? null;
}

export const PROSPECT_COLUMNS =
  "id,campaign_id,mailbox_id,email,first_name,last_name,company,industry,website,status,next_step,to_char(next_due_on,'YYYY-MM-DD') AS next_due_on,stopped_at,created_at,updated_at";
export interface ProspectRow {
  id: string;
  campaign_id: string;
  mailbox_id: string;
  email: string;
  first_name: string;
  last_name: string | null;
  company: string;
  industry: string | null;
  website: string | null;
  status: OutreachProspectRecord["status"];
  next_step: number | null;
  next_due_on: string | null;
  stopped_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export function prospectRecord(row: ProspectRow): OutreachProspectRecord {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    mailboxId: row.mailbox_id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    industry: row.industry,
    website: row.website,
    status: row.status,
    nextStep: row.next_step,
    nextDueOn: row.next_due_on,
    stoppedAt: row.stopped_at ? row.stopped_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
export async function loadProspect(tx: Transaction, tenantId: string, id: string, lock = false): Promise<ProspectRow | null> {
  return (await tx.query<ProspectRow>(
    `SELECT ${PROSPECT_COLUMNS} FROM outreach_prospects WHERE tenant_id=$1 AND id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, id],
  )).rows[0] ?? null;
}

/** Only the columns the runtime role may read; never the sealed token, the history cursor or the lease. */
export const MAILBOX_COLUMNS = "id,email,display_name,status,paused_until,daily_limit";
export interface MailboxRow {
  id: string;
  email: string;
  display_name: string;
  status: OutreachMailboxRecord["status"];
  paused_until: Date | null;
  daily_limit: number;
}
