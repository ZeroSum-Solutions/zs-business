// enrichment.md E-4, E-6, E-7: the checks that run when a request is made and again before every
// attempt (E-10), against the rows as they are now.
import type { EnrichmentErrorCode } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { companyDomain, emailDomain } from "./domain.js";
import { domainInRefusedRegion, regionVerdict } from "./region.js";
import { loadProfile, type ProfileRow } from "./records.js";

export type Refusal = { readonly code: EnrichmentErrorCode };
export type Verdict = Refusal | { readonly code: null; readonly domain: string };

/** E-6: the do-not-enrich flag, or a suppression on the contact's email or phone. */
export async function enrichmentBlockedNow(
  tx: Transaction,
  tenantId: string,
  contactId: string,
  profile?: ProfileRow | null,
  contactRow?: { normalized_email: string | null; e164_phone: string | null },
): Promise<boolean> {
  const loaded = profile === undefined ? await loadProfile(tx, tenantId, contactId) : profile;
  if (loaded?.do_not_enrich_at) return true;
  const contact = contactRow ?? (await tx.query<{ normalized_email: string | null; e164_phone: string | null }>(
    "SELECT normalized_email, e164_phone FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, contactId])).rows[0];
  if (!contact) return false;
  const addresses: [string, string][] = [];
  if (contact.normalized_email) addresses.push(["email", contact.normalized_email]);
  if (contact.e164_phone) addresses.push(["sms", contact.e164_phone]);
  for (const [channel, address] of addresses) {
    if ((await tx.query(
      "SELECT 1 FROM suppressions WHERE tenant_id=$1 AND channel=$2::crm_consent_channel AND address=$3",
      [tenantId, channel, address])).rowCount === 1) return true;
  }
  return false;
}

/** Serialises a block with an apply on the same contact, even when no profile row exists yet. */
export const lockContactEnrichment = (tx: Transaction, tenantId: string, contactId: string) =>
  tx.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))", [`enrichment-contact:${tenantId}:${contactId}`]);

/**
 * `sentDomain` is the domain a stored request already holds: it is then checked, not derived again,
 * so a retry never sends another domain than the first attempt did.
 */
export async function enrichmentVerdict(
  tx: Transaction,
  input: { readonly tenantId: string; readonly contactId: string; readonly sentDomain?: string },
): Promise<Verdict | "no_contact"> {
  const contact = (await tx.query<{ normalized_email: string | null; e164_phone: string | null }>(
    "SELECT normalized_email, e164_phone FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [input.tenantId, input.contactId])).rows[0];
  if (!contact) return "no_contact";
  const profile = await loadProfile(tx, input.tenantId, input.contactId);
  const current = companyDomain(profile?.company_domain ?? null, contact.normalized_email);
  const domain = input.sentDomain ?? current;
  if (!domain) return { code: "enrichment_no_company_domain" };
  // E-6, read each time: the flag, then the suppression list for both addresses (delivery.md D-9).
  if (await enrichmentBlockedNow(tx, input.tenantId, input.contactId, profile, contact)) return { code: "enrichment_blocked" };
  // E-10: a stored request keeps its sent domain, but a company domain that has since moved into the
  // refused region still stops it.
  if (current && current !== domain && domainInRefusedRegion(current)) return { code: "enrichment_region_blocked" };
  // E-7: region signals in the contract's order.
  const region = regionVerdict({
    phone: contact.e164_phone,
    country: profile?.country ?? null,
    companyDomain: domain,
    emailDomain: emailDomain(contact.normalized_email),
    attested: profile?.outside_eu_uk_attested_at != null,
  });
  if (region === "blocked") return { code: "enrichment_region_blocked" };
  if (region === "unknown") return { code: "enrichment_region_unknown" };
  return { code: null, domain };
}
