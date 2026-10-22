// Owner review of website intake (public-intake.md P-8, P-12): link a possible match to a
// contact, or reject it. Both run through the shared dispatcher like every owner write.
import {
  Conflict,
  linkIntakeItemCommandSchema,
  rejectIntakeItemCommandSchema,
  TenantDenied,
  ValidationFailed,
  type ActionBinding,
  type JsonValue,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { clockInstant, parseOrFail } from "../crm/rows.js";
import { loadIntakeItem } from "../reads/intake.js";

async function resolveItem(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "intake_item") throw new ValidationFailed("Intake actions require an intake_item target");
  const owned = await tx.query("SELECT 1 FROM intake_items WHERE tenant_id=$1 AND id=$2", [target.tenantId, target.id]);
  return owned.rowCount === 1 ? { tenantId: target.tenantId, type: "intake_item", id: target.id } : null;
}

/** Lock the item and require that nobody reviewed it yet. */
async function lockPending(tx: Transaction, tenantId: string, id: string): Promise<void> {
  const row = (await tx.query<{ status: string }>(
    "SELECT status FROM intake_items WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, id],
  )).rows[0];
  if (!row) throw new TenantDenied();
  if (row.status !== "possible_match")
    throw new Conflict("The intake item was already reviewed", { reason: "already_reviewed" });
}

async function itemResult(tx: Transaction, tenantId: string, id: string) {
  const item = await loadIntakeItem(tx, tenantId, id);
  if (!item) throw new TenantDenied();
  return { result: { ...item } };
}

type JsonObject = { [key: string]: JsonValue };
const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Results stored before P-8's disclosure text joined the owner view lack `disclosureText` on
 * their consent rows. Fill it from the saved intake_item_consent evidence, or, once that row
 * is gone, from the page's append-only disclosure history for the stored version, so an
 * identical retry still replays.
 */
async function addDisclosureText(tx: Transaction, result: JsonValue, binding: ActionBinding): Promise<JsonValue> {
  if (!isObject(result) || !isObject(result.consent)) return result;
  const missing = Object.entries(result.consent)
    .filter((entry): entry is [string, JsonObject] => isObject(entry[1]) && !("disclosureText" in entry[1]));
  if (missing.length === 0) return result;
  const texts = new Map((await tx.query<{ channel: string; disclosure_text: string }>(
    `SELECT channel::text AS channel, disclosure_text FROM intake_item_consent
      WHERE tenant_id=$1 AND intake_item_id=$2`, [binding.tenantId, binding.target.id],
  )).rows.map((row) => [row.channel, row.disclosure_text]));
  const history = async (version: JsonValue | undefined) => typeof result.pageId !== "string" || typeof version !== "string"
    ? undefined
    : (await tx.query<{ text: string }>(
      "SELECT text FROM booking_page_disclosures WHERE tenant_id=$1 AND page_id=$2 AND version=$3",
      [binding.tenantId, result.pageId, version],
    )).rows[0]?.text;
  const consent = { ...result.consent };
  for (const [channel, row] of missing) {
    const text = texts.get(channel) ?? await history(row.disclosureVersion);
    if (text !== undefined) consent[channel] = { ...row, disclosureText: text };
  }
  return { ...result, consent };
}

export const linkIntakeItemHandler: ActionHandler = {
  resolveTarget: resolveItem,
  upgradeStoredResult: addDisclosureText,
  async handle({ tx, command, binding, now }) {
    const at = clockInstant(now);
    const { payload } = parseOrFail(linkIntakeItemCommandSchema, command);
    const tenantId = binding.tenantId;
    await lockPending(tx, tenantId, payload.intakeItemId);
    // Lock the contact row as the CRM handler does, so consent fills cannot interleave.
    const contact = await tx.query(
      "SELECT id FROM crm_contacts WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, payload.contactId]);
    if (contact.rowCount !== 1) throw new TenantDenied("Contact is not owned by this tenant");

    // P-8: intake consent fills only channels with no recorded evidence; a denial or grant stays.
    const filled = await tx.query(
      `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at)
       SELECT c.tenant_id, $3, c.channel, c.status, 'intake:' || c.intake_item_id::text, c.recorded_at
         FROM intake_item_consent c
        WHERE c.tenant_id=$1 AND c.intake_item_id=$2
       ON CONFLICT (tenant_id,contact_id,channel) DO NOTHING`,
      [tenantId, payload.intakeItemId, payload.contactId],
    );
    if ((filled.rowCount ?? 0) > 0)
      await tx.query("UPDATE crm_contacts SET updated_at=$3 WHERE tenant_id=$1 AND id=$2", [tenantId, payload.contactId, at]);
    await tx.query(
      `UPDATE intake_items SET status='linked', contact_id=$3, reviewed_at=$4, reviewed_by=$5
        WHERE tenant_id=$1 AND id=$2`,
      [tenantId, payload.intakeItemId, payload.contactId, at, binding.actorId],
    );
    return itemResult(tx, tenantId, payload.intakeItemId);
  },
};

export const rejectIntakeItemHandler: ActionHandler = {
  resolveTarget: resolveItem,
  upgradeStoredResult: addDisclosureText,
  async handle({ tx, command, binding, now }) {
    const at = clockInstant(now);
    const { payload } = parseOrFail(rejectIntakeItemCommandSchema, command);
    const tenantId = binding.tenantId;
    await lockPending(tx, tenantId, payload.intakeItemId);
    await tx.query(
      "UPDATE intake_items SET status='rejected', reviewed_at=$3, reviewed_by=$4 WHERE tenant_id=$1 AND id=$2",
      [tenantId, payload.intakeItemId, at, binding.actorId],
    );
    return itemResult(tx, tenantId, payload.intakeItemId);
  },
};
