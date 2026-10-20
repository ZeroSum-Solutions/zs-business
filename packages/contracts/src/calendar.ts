import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";

// M5 Google Calendar busy sync (docs/requirements/google-calendar.md). Root re-exports this
// module, so shared root schemas are reached lazily, as in billing.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

export const CALENDAR_GOOGLE_CONNECT_ACTION = "calendar.google.connect";
export const CALENDAR_GOOGLE_DISCONNECT_ACTION = "calendar.google.disconnect";

/**
 * G-1: start connecting a booking resource to the owner's Google Calendar. `browserBinding` is the
 * SHA-256 (base64url) of a random key the dashboard's server keeps in an httpOnly cookie on the
 * browser that asked; the callback finishes only with that key (G-2).
 */
export const connectGoogleCalendarRequestSchema = z.strictObject({
  resourceId: idSchema,
  browserBinding: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type ConnectGoogleCalendarRequest = z.infer<typeof connectGoogleCalendarRequestSchema>;
/** G-2: the header the dashboard's callback route uses to hand the API the browser's key. */
export const CONNECT_BROWSER_KEY_HEADER = "x-zs-browser-key";
/**
 * G-2: the header carrying a staged grant: the API's callback answers with it, and the dashboard
 * sends it back (from its Strict cookie) to read and to confirm the grant.
 */
export const PENDING_GRANT_HEADER = "x-zs-pending-grant";
/** A staged grant as the API signs it: at most 3500 characters (MAX_PENDING_GRANT_LENGTH in core). */
export const PENDING_GRANT_PATTERN = /^zgg1\.[A-Za-z0-9_-]{1,3451}\.[A-Za-z0-9_-]{43}$/;

/** G-2: a grant Google gave that waits for the owner to confirm the account it names. */
export const pendingGoogleConnectSchema = z.strictObject({
  resourceId: idSchema,
  accountEmail: z.string().nullable(),
  expiresAt: instantSchema,
});
export type PendingGoogleConnect = z.infer<typeof pendingGoogleConnectSchema>;
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
