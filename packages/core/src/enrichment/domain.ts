// enrichment.md E-4: the one input Treg gets is a company domain. A consumer mailbox says nothing
// about a company, and a placeholder address says nothing at all.
import { usableEmail } from "../delivery/policy.js";

/** Free mailbox providers: the email domain is the person's provider, not their company. */
export const CONSUMER_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "rocketmail.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me",
  "gmx.com", "gmx.net", "mail.com", "zoho.com", "fastmail.com", "hey.com", "comcast.net", "verizon.net",
  "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "earthlink.net", "juno.com",
  "yahoo.co.uk", "hotmail.co.uk", "outlook.co.uk", "live.co.uk", "yandex.com", "mail.ru", "qq.com", "163.com",
]);

const DOMAIN = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/** A lowercase company domain, or null when the text is not a usable one. */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let domain = raw.trim().toLowerCase();
  if (domain.startsWith("www.")) domain = domain.slice(4);
  if (domain.length < 3 || domain.length > 253 || !DOMAIN.test(domain) || domain.includes("..") || !domain.includes(".")) return null;
  return domain;
}

export function emailDomain(email: string | null): string | null {
  const usable = usableEmail(email);
  const at = usable?.lastIndexOf("@") ?? -1;
  return usable && at > 0 ? normalizeDomain(usable.slice(at + 1)) : null;
}

/** E-4: the profile's company domain when set, else the stored email's domain; null if neither is a company. */
export function companyDomain(profileDomain: string | null, email: string | null): string | null {
  const candidate = normalizeDomain(profileDomain) ?? emailDomain(email);
  return candidate && !CONSUMER_MAIL_DOMAINS.has(candidate) ? candidate : null;
}
