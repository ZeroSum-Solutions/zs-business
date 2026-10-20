// M6 candidates and per-inquiry checks (agents.md G-7, G-8, G-9). Original code. The run calls
// these before the model, and the draft action calls checkCandidate again under its locks.
import type { FollowUpPrompt, FollowUpSettings, FollowUpSkipReason } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { consentBlock, usableEmail } from "../delivery/policy.js";
import { contactDrafts } from "./controls.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface Candidate {
  readonly intakeItemId: string;
  readonly contactId: string;
  readonly createdAt: Date;
}

/**
 * G-7: inquiries nobody answered, oldest first. An inquiry is the customer's latest website
 * request, old enough to follow up and young enough to matter, with no agent draft yet and no
 * reply (other than a discarded one) drafted after it.
 */
export async function findCandidates(
  tx: Transaction, tenantId: string, settings: FollowUpSettings, now: Date, limit: number,
): Promise<Candidate[]> {
  const rows = (await tx.query<{ id: string; contact_id: string; created_at: Date }>(
    `SELECT i.id, i.contact_id, i.created_at FROM intake_items i
      WHERE i.tenant_id=$1 AND i.contact_id IS NOT NULL AND i.status IN ('new_contact','linked')
        AND i.created_at <= $2 AND i.created_at > $3
        AND NOT EXISTS (SELECT 1 FROM intake_items l WHERE l.tenant_id=i.tenant_id AND l.contact_id=i.contact_id
              AND (l.created_at, l.id) > (i.created_at, i.id))
        AND NOT EXISTS (SELECT 1 FROM agent_followups f WHERE f.tenant_id=i.tenant_id AND f.intake_item_id=i.id
              AND f.outcome='drafted')
        AND NOT EXISTS (SELECT 1 FROM inbox_replies r WHERE r.tenant_id=i.tenant_id AND r.contact_id=i.contact_id
              AND r.status<>'discarded' AND r.created_at >= i.created_at)
      ORDER BY i.created_at, i.id LIMIT $4`,
    [tenantId, new Date(now.getTime() - settings.waitHours * HOUR_MS), new Date(now.getTime() - settings.lookbackDays * DAY_MS), limit],
  )).rows;
  return rows.map((row) => ({ intakeItemId: row.id, contactId: row.contact_id, createdAt: row.created_at }));
}

/** The inquiry as stored, or null when it is not this tenant's request from this customer. */
export async function loadInquiry(tx: Transaction, tenantId: string, intakeItemId: string, contactId: string): Promise<Candidate | null> {
  const row = (await tx.query<{ created_at: Date }>(
    "SELECT created_at FROM intake_items WHERE tenant_id=$1 AND id=$2 AND contact_id=$3 AND status IN ('new_contact','linked')",
    [tenantId, intakeItemId, contactId],
  )).rows[0];
  return row ? { intakeItemId, contactId, createdAt: row.created_at } : null;
}

/**
 * G-8: the reason not to draft for this inquiry, or null. Suppression and consent are checked
 * as delivery checks them (delivery.md D-6) for a transactional email.
 */
export async function checkCandidate(
  tx: Transaction, tenantId: string, candidate: Candidate, settings: FollowUpSettings, now: Date,
): Promise<FollowUpSkipReason | null> {
  const contact = (await tx.query<{ email: string | null; suppressed: boolean; consent: "granted" | "denied" | null }>(
    `SELECT c.normalized_email AS email,
            EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id=c.tenant_id AND s.channel='email' AND s.address=c.normalized_email) AS suppressed,
            (SELECT k.status::text FROM crm_contact_consent k WHERE k.tenant_id=c.tenant_id AND k.contact_id=c.id AND k.channel='email') AS consent
       FROM crm_contacts c WHERE c.tenant_id=$1 AND c.id=$2`,
    [tenantId, candidate.contactId],
  )).rows[0];
  if (!contact || usableEmail(contact.email) === null) return "no_email";
  const blocked = consentBlock({ channel: "email", purpose: "transactional", consent: contact.consent, suppressed: contact.suppressed });
  if (blocked === "suppressed" || blocked === "consent_denied") return blocked;
  const answered = await tx.query(
    "SELECT 1 FROM inbox_replies WHERE tenant_id=$1 AND contact_id=$2 AND status<>'discarded' AND created_at >= $3 LIMIT 1",
    [tenantId, candidate.contactId, candidate.createdAt],
  );
  if (answered.rowCount) return "answered";
  if ((await contactDrafts(tx, tenantId, candidate.contactId, settings, now)) >= settings.maxDraftsPerContact) return "contact_cap";
  return null;
}

/** G-9: what the model sees about one inquiry: the business, the customer and their request. */
export async function buildPrompt(tx: Transaction, tenantId: string, candidate: Candidate): Promise<FollowUpPrompt> {
  const row = (await tx.query<{
    business: string; customer: string; notes: string | null;
    starts_at: Date | null; ends_at: Date | null; time_zone: string | null;
  }>(
    `SELECT t.name AS business, coalesce(c.display_name, i.submitted_name) AS customer, i.notes,
            b.starts_at, b.ends_at, r.time_zone
       FROM intake_items i
       JOIN tenants t ON t.tenant_id=i.tenant_id
       JOIN crm_contacts c ON c.tenant_id=i.tenant_id AND c.id=i.contact_id
       LEFT JOIN bookings b ON b.tenant_id=i.tenant_id AND b.intake_item_id=i.id
       LEFT JOIN booking_resources r ON r.tenant_id=b.tenant_id AND r.id=b.resource_id
      WHERE i.tenant_id=$1 AND i.id=$2`,
    [tenantId, candidate.intakeItemId],
  )).rows[0]!;
  return {
    businessName: row.business,
    customerName: row.customer,
    requestedAt: candidate.createdAt.toISOString(),
    notes: row.notes,
    booking: row.starts_at && row.ends_at
      ? { startsAt: row.starts_at.toISOString(), endsAt: row.ends_at.toISOString(), timeZone: row.time_zone ?? "UTC" }
      : null,
  };
}
