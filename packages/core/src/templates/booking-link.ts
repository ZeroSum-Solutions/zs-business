// The `{booking_link}` value (agents.md G-19): the link of the tenant's oldest published booking
// page, built from the same signed key the dashboard shows. Original code. A tenant with no
// published page has no link, and the reminder kind then skips for `no_link`.
import { ValidationFailed } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { bookingPageSnippets } from "../edge/session.js";
import { signBookingKey } from "../intake/keys.js";
import type { BookingLinkProvider } from "./send.js";

/** The shortest signing secret the server's config accepts. */
const MIN_SECRET_LENGTH = 32;

export function createBookingLinkProvider(keys: { readonly secret: string; readonly publicBaseUrl: string }): BookingLinkProvider {
  // Fail closed when built: a weak secret signs guessable keys, and a link that is not http(s) must never reach a customer.
  if (typeof keys.secret !== "string" || keys.secret.length < MIN_SECRET_LENGTH)
    throw new ValidationFailed(`The booking-key secret must be at least ${MIN_SECRET_LENGTH} characters`);
  let base: URL;
  try { base = new URL(keys.publicBaseUrl); } catch { throw new ValidationFailed("The public base URL is not a URL"); }
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new ValidationFailed("The public base URL must be http or https");
  return async (tx: Transaction, tenantId: string): Promise<string | null> => {
    const page = (await tx.query<{ id: string }>(
      "SELECT id FROM booking_pages WHERE tenant_id=$1 AND published ORDER BY created_at, id LIMIT 1", [tenantId],
    )).rows[0];
    if (!page) return null;
    return bookingPageSnippets(keys.publicBaseUrl, signBookingKey(keys.secret, { tenantId, pageId: page.id })).bookingUrl;
  };
}
