import { z } from "zod";

/**
 * The supported range for a client-supplied instant: a UTC ISO string with milliseconds in
 * years 0001 through 9999. Postgres has no year 0 and the four-digit form ends at 9999, so
 * every accepted value is stored and read back exactly. Bind it to SQL as this string, never
 * as a Date: the driver writes a Date at whole-minute offset precision in the process zone.
 */
export const supportedInstantSchema = z.iso.datetime({ precision: 3 })
  .refine((instant) => !instant.startsWith("0000-"), "Instant is outside the supported years 0001 through 9999");
export type SupportedInstant = z.infer<typeof supportedInstantSchema>;

/**
 * An instant the server reads back: from a row or from a result an earlier release stored.
 * Strict on input, tolerant on output: client input uses `supportedInstantSchema`, while
 * records and replayed results accept any UTC ISO string with milliseconds. Older code could
 * store a value outside the supported years, such as 0000-12-31T23:59:02.000Z, and a replay
 * must still return it unchanged.
 */
export const storedInstantSchema = z.iso.datetime({ precision: 3 });
export type StoredInstant = z.infer<typeof storedInstantSchema>;
