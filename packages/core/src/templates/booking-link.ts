// The `{booking_link}` value (agents.md G-19): the link of the tenant's oldest published booking
// page, built from the same signed key the dashboard shows. Original code. A tenant with no
// published page has no link, and the reminder kind then skips for `no_link`.
import type { Transaction } from "@zs/db";
import { bookingPageSnippets } from "../edge/session.js";
import { signBookingKey } from "../intake/keys.js";
import type { BookingLinkProvider } from "./send.js";

export function createBookingLinkProvider(keys: { readonly secret: string; readonly publicBaseUrl: string }): BookingLinkProvider {
  return async (tx: Transaction, tenantId: string): Promise<string | null> => {
    const page = (await tx.query<{ id: string }>(
      "SELECT id FROM booking_pages WHERE tenant_id=$1 AND published ORDER BY created_at, id LIMIT 1", [tenantId],
    )).rows[0];
    if (!page) return null;
    return bookingPageSnippets(keys.publicBaseUrl, signBookingKey(keys.secret, { tenantId, pageId: page.id })).bookingUrl;
  };
}
