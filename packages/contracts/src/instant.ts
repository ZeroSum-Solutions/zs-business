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
