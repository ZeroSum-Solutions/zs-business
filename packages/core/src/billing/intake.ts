// stripe.md S-3: stores one verified Stripe event for the billing worker. The runtime role may
// insert into stripe_events and nothing else; a redelivery of the same event ID changes nothing.
import { DatabaseUnavailable, type ScopedDatabase } from "@zs/db";
import type { StripeEvent } from "./stripe.js";

export async function recordStripeEvent(db: ScopedDatabase, input: {
  readonly event: StripeEvent;
  /** The event exactly as Stripe sent it. */
  readonly payload: unknown;
  readonly now: Date;
}): Promise<{ stored: boolean }> {
  if (!db.platform) throw new DatabaseUnavailable("connect");
  return db.platform(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO stripe_events (id, type, payload, received_at, next_attempt_at)
       VALUES ($1,$2,$3::jsonb,$4,$4) ON CONFLICT DO NOTHING`,
      [input.event.id, input.event.type, JSON.stringify(input.payload), input.now]);
    return { stored: inserted.rowCount === 1 };
  });
}
