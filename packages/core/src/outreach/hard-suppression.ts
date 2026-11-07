// Hard suppression for cold outreach (Devin, 2026-11-07). Original code. Zero Sum never
// contacts Broken English (jewelry company Devin works with) or Rise Movement (gym Devin works
// at), their staff, or any address tied to them. Matching is by domain, company name and known
// person, and is deliberately broad: a false hit only skips a prospect, a miss is a breach.

/** Brand tokens: a domain label or company name containing one of these (separators ignored) is suppressed. */
const BRAND_TOKENS: readonly string[] = ["brokenenglish", "risemovement"];

/** Exact registrable domains named by Devin or seen in his accounts; subdomains match too. */
export const HARD_SUPPRESSED_DOMAINS: readonly string[] = Object.freeze([
  "brokenenglishjewelry.com",
  "risemovement.studio",
  "rise-movement.com",
  "risemovement.com",
]);

/** Company names, compared after normalisation (lower case, letters and digits only). */
export const HARD_SUPPRESSED_COMPANIES: readonly string[] = Object.freeze([
  "Broken English",
  "Broken English Jewelry",
  "Broken English Jewelry LLC",
  "Rise Movement",
  "Rise Movement Studio",
]);

/** Known people. Matched by full name, or by an email local part built from the name. */
export const HARD_SUPPRESSED_PEOPLE: readonly string[] = Object.freeze([
  "Jason Walsh",
  "Polina Schultz",
]);

const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

export function normaliseDomain(input: string): string {
  const raw = input.trim();
  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).hostname.toLowerCase().replace(/^www\./, "").replace(/\.+$/, "");
    } catch {
      /* fall through to the loose parse */
    }
  }
  const at = raw.lastIndexOf("@");
  const host = (at >= 0 ? raw.slice(at + 1) : raw).toLowerCase();
  return host.replace(/^https?:\/\//, "").replace(/[/?#:].*$/, "").replace(/^www\./, "").replace(/\.+$/, "");
}

export interface OutreachCandidate {
  readonly email?: string | null;
  readonly domain?: string | null;
  readonly website?: string | null;
  readonly company?: string | null;
  readonly name?: string | null;
}

export type SuppressionHit = "domain" | "company" | "person";

const domainHit = (host: string): boolean => {
  if (!host) return false;
  if (HARD_SUPPRESSED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  const flat = squash(host);
  return BRAND_TOKENS.some((t) => flat.includes(t));
};

const companyHit = (company: string): boolean => {
  const flat = squash(company);
  if (!flat) return false;
  return BRAND_TOKENS.some((t) => flat.includes(t)) || HARD_SUPPRESSED_COMPANIES.some((c) => flat === squash(c));
};

const personHit = (name: string | null | undefined, email: string | null | undefined): boolean => {
  const people = HARD_SUPPRESSED_PEOPLE.map(squash);
  if (name && people.includes(squash(name))) return true;
  const at = email ? email.lastIndexOf("@") : -1;
  const rawLocal = email && at > 0 ? email.slice(0, at) : "";
  const local = squash(rawLocal);
  // A plus tag is an alias on most providers: jason.walsh+x@ reaches jason.walsh@.
  const base = squash(rawLocal.split("+")[0] ?? "");
  return local !== "" && people.some((p) => local === p || base === p);
};

/** The first rule that matches this candidate, or null when it may be contacted. */
export function hardSuppressionHit(candidate: OutreachCandidate): SuppressionHit | null {
  const hosts = [candidate.email, candidate.domain, candidate.website]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .map(normaliseDomain);
  if (hosts.some(domainHit)) return "domain";
  if (candidate.company && companyHit(candidate.company)) return "company";
  if (personHit(candidate.name, candidate.email)) return "person";
  return null;
}

export const isHardSuppressed = (candidate: OutreachCandidate): boolean => hardSuppressionHit(candidate) !== null;

/** Splits a prospect list into those that may be contacted and those removed, with the reason. */
export function filterHardSuppressed<T extends OutreachCandidate>(
  list: readonly T[],
): { readonly kept: T[]; readonly removed: { readonly item: T; readonly reason: SuppressionHit }[] } {
  const kept: T[] = [];
  const removed: { item: T; reason: SuppressionHit }[] = [];
  for (const item of list) {
    const reason = hardSuppressionHit(item);
    if (reason) removed.push({ item, reason });
    else kept.push(item);
  }
  return { kept, removed };
}
