// G-8: stores one Google push notification for the calendar worker. Original code. The caller has
// already checked the channel token; the runtime role may only insert into this platform table,
// and a redelivery of the same channel and message number changes nothing.
import { DatabaseUnavailable, type ScopedDatabase } from "@zs/db";

export interface CalendarPushNotification {
  readonly channelId: string;
  /** X-Goog-Message-Number. */
  readonly messageNumber: string;
  /** X-Goog-Resource-State: `sync` first, then `exists`. */
  readonly resourceState: string;
  readonly now: Date;
}

export async function recordCalendarPush(db: ScopedDatabase, input: CalendarPushNotification): Promise<{ stored: boolean }> {
  if (!db.platform) throw new DatabaseUnavailable("connect");
  return db.platform(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO calendar_push_notifications (channel_id, message_number, resource_state, received_at)
       VALUES ($1,$2::bigint,$3,$4) ON CONFLICT DO NOTHING`,
      [input.channelId, input.messageNumber, input.resourceState, input.now]);
    return { stored: inserted.rowCount === 1 };
  });
}
