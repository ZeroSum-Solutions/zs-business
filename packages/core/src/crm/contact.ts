import {
  Conflict,
  ValidationFailed,
  createOrFindContactCommandSchema,
  type ConsentEvidence,
  type CreateOrFindContactInput,
  type CreateOrFindContactResult,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import {
  contactColumns,
  contactRecord,
  idInUse,
  loadConsent,
  parseOrFail,
  pgCode,
  tenantVisible,
  type ConsentRow,
  type ContactRow,
} from "./rows.js";

const CHANNELS = ["email", "sms"] as const;
type Channel = (typeof CHANNELS)[number];
// Each attempt re-reads after a uniqueness race; with identity locks held one retry normally suffices.
const MAX_ATTEMPTS = 4;

const toMicros = (instant: string): bigint => BigInt(new Date(instant).getTime()) * 1000n;

/** C-10 / C-11: decide whether incoming evidence replaces the stored channel record. */
export function shouldWriteConsent(
  mode: CreateOrFindContactInput["mode"],
  existing: Pick<ConsentRow, "status" | "recorded_us"> | undefined,
  incoming: ConsentEvidence | null,
): boolean {
  if (incoming === null) return false;
  if (existing === undefined) return true;
  if (mode === "import") return false;
  const incomingAt = toMicros(incoming.recordedAt);
  const existingAt = BigInt(existing.recorded_us);
  if (incomingAt > existingAt) return true;
  if (incomingAt < existingAt) return false;
  // Equal instants: denial wins; identical status keeps the existing provenance.
  return incoming.status === "denied" && existing.status === "granted";
}

/**
 * Serialize claims on each identity key so concurrent create/find commands see one winner. Public
 * intake (booking.public_request) takes the same keys, so it serializes with this handler too.
 */
export async function lockIdentities(
  tx: Transaction,
  tenantId: string,
  input: Pick<CreateOrFindContactInput, "email" | "phone" | "contactId">,
): Promise<void> {
  const keys = [
    input.email === null ? null : `crm:contact:email:${tenantId}:${input.email}`,
    input.phone === null ? null : `crm:contact:phone:${tenantId}:${input.phone}`,
    `crm:contact:id:${tenantId}:${input.contactId}`,
  ].filter((key): key is string => key !== null).sort();
  for (const key of keys) await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
}

/**
 * Lock every row that matches the candidate ID, email or phone in one statement, in id order, so two commands
 * that match the same rows through different identities cannot take those row locks in opposite orders.
 */
async function lockMatches(tx: Transaction, tenantId: string, input: CreateOrFindContactInput): Promise<ContactRow[]> {
  return (await tx.query<ContactRow>(
    `SELECT ${contactColumns} FROM crm_contacts
      WHERE tenant_id=$1 AND (id=$2 OR normalized_email=$3 OR e164_phone=$4) ORDER BY id FOR UPDATE`,
    [tenantId, input.contactId, input.email, input.phone],
  )).rows;
}

async function attempt(
  tx: Transaction,
  tenantId: string,
  input: CreateOrFindContactInput,
  now: Date,
): Promise<CreateOrFindContactResult> {
  const locked = await lockMatches(tx, tenantId, input);
  const byEmail = input.email === null ? undefined : locked.find((row) => row.normalized_email === input.email);
  const byPhone = input.phone === null ? undefined : locked.find((row) => row.e164_phone === input.phone);
  const byId = locked.find((row) => row.id === input.contactId);
  if (byEmail && byPhone && byEmail.id !== byPhone.id)
    throw new Conflict("Email and phone belong to different contacts", { reason: "split_identity" });
  const match = byEmail ?? byPhone;
  if (match) {
    if ((input.email !== null && match.normalized_email !== null && match.normalized_email !== input.email)
      || (input.phone !== null && match.e164_phone !== null && match.e164_phone !== input.phone))
      throw new Conflict("Supplied identity differs from the matched contact", { reason: "identity_mismatch" });
  }
  if (byId && (!match || match.id !== byId.id)) throw idInUse("contact");

  let row: ContactRow;
  let created = false;
  if (!match) {
    row = (await tx.query<ContactRow>(
      `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING ${contactColumns}`,
      [tenantId, input.contactId, input.displayName, input.email, input.phone, now],
    )).rows[0]!;
    created = true;
  } else {
    row = match;
  }

  // Fill only absent values; never replace or erase a stored identity or name (C-6).
  const fill = {
    display_name: row.display_name ?? input.displayName,
    normalized_email: row.normalized_email ?? input.email,
    e164_phone: row.e164_phone ?? input.phone,
  };
  let changed = !created && (fill.display_name !== row.display_name
    || fill.normalized_email !== row.normalized_email || fill.e164_phone !== row.e164_phone);

  const existingConsent = await loadConsent(tx, tenantId, row.id);
  for (const channel of CHANNELS) {
    const incoming = input.consent[channel];
    if (!shouldWriteConsent(input.mode, existingConsent.get(channel), incoming) || incoming === null) continue;
    await writeConsent(tx, tenantId, row.id, channel, incoming);
    if (!created) changed = true;
  }

  if (changed) {
    row = (await tx.query<ContactRow>(
      `UPDATE crm_contacts SET display_name=$3, normalized_email=$4, e164_phone=$5, updated_at=$6
       WHERE tenant_id=$1 AND id=$2 RETURNING ${contactColumns}`,
      [tenantId, row.id, fill.display_name, fill.normalized_email, fill.e164_phone, now],
    )).rows[0]!;
  }
  return { contact: contactRecord(row, await loadConsent(tx, tenantId, row.id)), created };
}

async function writeConsent(tx: Transaction, tenantId: string, contactId: string, channel: Channel, evidence: ConsentEvidence) {
  await tx.query(
    `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at)
     VALUES ($1,$2,$3::crm_consent_channel,$4::crm_consent_status,$5,$6)
     ON CONFLICT (tenant_id,contact_id,channel)
     DO UPDATE SET status=EXCLUDED.status, source=EXCLUDED.source, recorded_at=EXCLUDED.recorded_at`,
    [tenantId, contactId, channel, evidence.status, evidence.source, evidence.recordedAt],
  );
}

export const createOrFindContactHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "contact" || !(await tenantVisible(tx, target.tenantId))) return null;
    // An existing owned contact or an unused candidate both resolve; handle() applies C-5/C-6.
    return { tenantId: target.tenantId, type: "contact", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    const { payload: input } = parseOrFail(createOrFindContactCommandSchema, command);
    for (const channel of CHANNELS) {
      const evidence = input.consent[channel];
      if (evidence && new Date(evidence.recordedAt).getTime() > now.getTime())
        throw new ValidationFailed(`The ${channel} consent evidence is dated after now`);
    }
    const tenantId = binding.tenantId;
    await lockIdentities(tx, tenantId, input);
    for (let tries = 1; ; tries++) {
      await tx.query("SAVEPOINT crm_contact_claim");
      try {
        const result = await attempt(tx, tenantId, input, now);
        await tx.query("RELEASE SAVEPOINT crm_contact_claim");
        return { result };
      } catch (error) {
        // A uniqueness race aborts only the savepoint; re-read in the same transaction (C-8).
        if (pgCode(error) !== "23505" || tries >= MAX_ATTEMPTS) throw error;
        await tx.query("ROLLBACK TO SAVEPOINT crm_contact_claim");
      }
    }
  },
};
