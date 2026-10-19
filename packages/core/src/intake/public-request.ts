// booking.public_request (public-intake.md P-1, P-4..P-9). Original code. The handler runs
// inside the shared dispatcher transaction: contact (when new), intake item, consent,
// booking, action and outbox commit together or not at all.
import {
  Conflict,
  intakeConsentPurpose,
  NotFound,
  publicBookingRequestCommandSchema,
  ValidationFailed,
  type PublicBookingRequestInput,
  type PublicBookingRequestResult,
  type Target,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { assertBookingIdUnused, checkBookingSlot, currentTenant, insertBooking } from "../booking/create.js";
import { lockIdentities } from "../crm/contact.js";
import { idInUse, pgCode } from "../crm/rows.js";
import { loadPublishedPage, pageHasResource } from "../reads/intake.js";

export const PUBLIC_REQUEST_ACTION = "booking.public_request";
const CHANNELS = ["email", "sms"] as const;
// Identity locks serialize the CRM writers, so a uniqueness race can only come from a writer
// outside the dispatcher; one retry normally settles it.
const MAX_ATTEMPTS = 4;

interface Claim {
  outcome: "new_contact" | "possible_match";
  contactId: string | null;
  matched: string[];
}

/**
 * P-7: find contacts holding the email or phone. None: create the contact. Any: change nothing
 * and report the matches, so the owner decides. Split or mismatched identities are just matches.
 */
async function claimContact(tx: Transaction, tenantId: string, input: PublicBookingRequestInput, now: Date): Promise<Claim> {
  const rows = (await tx.query<{ id: string; normalized_email: string | null; e164_phone: string | null }>(
    `SELECT id, normalized_email, e164_phone FROM crm_contacts
      WHERE tenant_id=$1 AND (id=$2 OR normalized_email=$3 OR e164_phone=$4) ORDER BY id`,
    [tenantId, input.contactId, input.email, input.phone],
  )).rows;
  const matched = rows
    .filter((row) => row.normalized_email === input.email || (input.phone !== null && row.e164_phone === input.phone))
    .map((row) => row.id);
  if (matched.length > 0) return { outcome: "possible_match", contactId: null, matched };
  // The candidate ID derives from the stored key; an unrelated contact holding it is a real conflict.
  if (rows.some((row) => row.id === input.contactId)) throw idInUse("contact");
  await tx.query(
    `INSERT INTO crm_contacts (tenant_id,id,display_name,normalized_email,e164_phone,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [tenantId, input.contactId, input.name, input.email, input.phone, now],
  );
  return { outcome: "new_contact", contactId: input.contactId, matched: [] };
}

async function claimWithRetry(tx: Transaction, tenantId: string, input: PublicBookingRequestInput, now: Date): Promise<Claim> {
  for (let tries = 1; ; tries++) {
    await tx.query("SAVEPOINT intake_contact_claim");
    try {
      const claim = await claimContact(tx, tenantId, input, now);
      await tx.query("RELEASE SAVEPOINT intake_contact_claim");
      return claim;
    } catch (error) {
      // A uniqueness race aborts only the savepoint; the re-read then finds the winner as a match.
      if (pgCode(error) !== "23505" || tries >= MAX_ATTEMPTS) throw error;
      await tx.query("ROLLBACK TO SAVEPOINT intake_contact_claim");
    }
  }
}

export const publicRequestHandler: ActionHandler = {
  async resolveTarget(tx, target): Promise<Target | null> {
    if (target.type !== "booking") throw new ValidationFailed("booking.public_request requires a booking target");
    const tenantId = await currentTenant(tx);
    if (!tenantId || tenantId !== target.tenantId) return null;
    await assertBookingIdUnused(tx, tenantId, target.id);
    return { tenantId, type: "booking", id: target.id };
  },

  async handle({ tx, command, binding, now }) {
    const parsed = publicBookingRequestCommandSchema.safeParse(command);
    if (!parsed.success) throw new ValidationFailed(parsed.error.message);
    const input = parsed.data.payload;
    const tenantId = binding.tenantId;

    // P-4: recheck page and resource inside the write; both failures look the same.
    const page = await loadPublishedPage(tx, tenantId, input.pageId);
    if (!page || !(await pageHasResource(tx, tenantId, input.pageId, input.resourceId))) throw new NotFound();
    // P-8: consent counts only against the disclosure the visitor was shown.
    if (page.disclosure_version !== input.disclosureVersion)
      throw new Conflict("The consent disclosure changed", { reason: "disclosure_changed" });

    // The slot is checked under the resource lock before anything that depends on who the visitor
    // is, so a taken slot costs the same work for a known and an unknown person (P-6). Resource
    // lock, then identity locks: the one path that takes both, so the order cannot deadlock.
    const slot = await checkBookingSlot(tx, tenantId,
      { bookingId: input.bookingId, resourceId: input.resourceId, startsAt: input.startsAt }, now);
    await lockIdentities(tx, tenantId, input);
    const claim = await claimWithRetry(tx, tenantId, input, now);

    await tx.query(
      `INSERT INTO intake_items (tenant_id,id,kind,status,channel,page_id,submitted_name,submitted_email,
         submitted_phone,notes,matched_contact_ids,contact_id,created_at)
       VALUES ($1,$2,'booking_request',$3,$4,$5,$6,$7,$8,$9,$10::uuid[],$11,$12)`,
      [tenantId, input.intakeItemId, claim.outcome, input.channel, input.pageId, input.name, input.email,
        input.phone, input.notes, claim.matched, claim.contactId, now],
    );
    const source = `${input.channel}:${input.pageId}`;
    for (const channel of CHANNELS) {
      if (!input.consent[channel]) continue;
      await tx.query(
        `INSERT INTO intake_item_consent (tenant_id,intake_item_id,channel,status,purpose,disclosure_version,
           disclosure_text,source,recorded_at)
         VALUES ($1,$2,$3::crm_consent_channel,'granted',$4,$5,$6,$7,$8)`,
        [tenantId, input.intakeItemId, channel, intakeConsentPurpose, page.disclosure_version, page.disclosure_text,
          source, now],
      );
      // A contact created in this transaction has no recorded evidence to override.
      if (claim.outcome === "new_contact")
        await tx.query(
          `INSERT INTO crm_contact_consent (tenant_id,contact_id,channel,status,source,recorded_at)
           VALUES ($1,$2,$3::crm_consent_channel,'granted',$4,$5)`,
          [tenantId, claim.contactId, channel, `intake:${input.intakeItemId}`, now],
        );
    }

    const booking = await insertBooking(tx, slot, { source: "website", intakeItemId: input.intakeItemId });
    const result: PublicBookingRequestResult = {
      bookingId: booking.id,
      intakeItemId: input.intakeItemId,
      resourceId: booking.resourceId,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      outcome: claim.outcome,
      contactId: claim.contactId,
    };
    return { result: { ...result } };
  },
};
