import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";

// M5 Google Calendar busy sync (docs/requirements/google-calendar.md). Root re-exports this
// module, so shared root schemas are reached lazily, as in billing.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

export const CALENDAR_GOOGLE_CONNECT_ACTION = "calendar.google.connect";
export const CALENDAR_GOOGLE_DISCONNECT_ACTION = "calendar.google.disconnect";

/** G-1: start connecting a booking resource to the owner's Google Calendar. */
export const connectGoogleCalendarRequestSchema = z.strictObject({ resourceId: idSchema });
export type ConnectGoogleCalendarRequest = z.infer<typeof connectGoogleCalendarRequestSchema>;
export const connectGoogleCalendarResponseSchema = z.strictObject({
  authorizeUrl: z.url({ protocol: /^https?$/ }),
});
export type ConnectGoogleCalendarResponse = z.infer<typeof connectGoogleCalendarResponseSchema>;

/** G-2, G-3: what the callback hands the connect action; the refresh token arrives sealed. */
export const connectGoogleCalendarInputSchema = z.strictObject({
  connectionId: idSchema,
  resourceId: idSchema,
  accountEmail: z.string().min(3).max(254).nullable(),
  scope: z.string().max(2000),
  refreshTokenSealed: z.string().regex(/^zsg1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,2800}$/),
});
export const connectGoogleCalendarCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CALENDAR_GOOGLE_CONNECT_ACTION),
  target: targetSchema.extend({ type: z.literal("calendar_connection") }),
  payload: connectGoogleCalendarInputSchema,
}));

export const disconnectCalendarInputSchema = z.strictObject({ connectionId: idSchema });
export const disconnectCalendarCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CALENDAR_GOOGLE_DISCONNECT_ACTION),
  target: targetSchema.extend({ type: z.literal("calendar_connection") }),
  payload: disconnectCalendarInputSchema,
}));

export const calendarConnectionStatusSchema = z.enum(["active", "reauthorize", "disconnecting", "disconnected"]);
export type CalendarConnectionStatus = z.infer<typeof calendarConnectionStatusSchema>;

/** G-5: what an owner sees of a connection; never a token. */
export const calendarConnectionSchema = z.strictObject({
  id: idSchema,
  provider: z.literal("google"),
  resourceId: idSchema,
  calendarId: z.string(),
  accountEmail: z.string().nullable(),
  status: calendarConnectionStatusSchema,
  lastSyncedAt: instantSchema.nullable(),
  lastError: z.string().nullable(),
  createdAt: instantSchema,
});
export type CalendarConnection = z.infer<typeof calendarConnectionSchema>;
export const calendarConnectionListSchema = z.strictObject({ items: z.array(calendarConnectionSchema) });
export type CalendarConnectionList = z.infer<typeof calendarConnectionListSchema>;
