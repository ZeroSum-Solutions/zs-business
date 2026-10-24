import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { bookingTimeZoneSchema } from "./booking.js";
import { currencyCodeSchema } from "./currency.js";
import { isPostgresText } from "./json.js";

// The business profile (docs/requirements/business-profile.md BP-1..BP-12). Root re-exports this
// module, so shared root schemas are reached lazily, as in agents.ts and inbox.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

/** BP-2: ISO 3166-1 alpha-2 country codes a postal address may carry. */
export const COUNTRY_CODES: readonly string[] = Object.freeze([
  "AD", "AE", "AF", "AG", "AI", "AL", "AM", "AO", "AQ", "AR", "AS", "AT", "AU", "AW", "AX", "AZ", "BA", "BB", "BD",
  "BE", "BF", "BG", "BH", "BI", "BJ", "BL", "BM", "BN", "BO", "BQ", "BR", "BS", "BT", "BV", "BW", "BY", "BZ", "CA",
  "CC", "CD", "CF", "CG", "CH", "CI", "CK", "CL", "CM", "CN", "CO", "CR", "CU", "CV", "CW", "CX", "CY", "CZ", "DE",
  "DJ", "DK", "DM", "DO", "DZ", "EC", "EE", "EG", "EH", "ER", "ES", "ET", "FI", "FJ", "FK", "FM", "FO", "FR", "GA",
  "GB", "GD", "GE", "GF", "GG", "GH", "GI", "GL", "GM", "GN", "GP", "GQ", "GR", "GS", "GT", "GU", "GW", "GY", "HK",
  "HM", "HN", "HR", "HT", "HU", "ID", "IE", "IL", "IM", "IN", "IO", "IQ", "IR", "IS", "IT", "JE", "JM", "JO", "JP",
  "KE", "KG", "KH", "KI", "KM", "KN", "KP", "KR", "KW", "KY", "KZ", "LA", "LB", "LC", "LI", "LK", "LR", "LS", "LT",
  "LU", "LV", "LY", "MA", "MC", "MD", "ME", "MF", "MG", "MH", "MK", "ML", "MM", "MN", "MO", "MP", "MQ", "MR", "MS",
  "MT", "MU", "MV", "MW", "MX", "MY", "MZ", "NA", "NC", "NE", "NF", "NG", "NI", "NL", "NO", "NP", "NR", "NU", "NZ",
  "OM", "PA", "PE", "PF", "PG", "PH", "PK", "PL", "PM", "PN", "PR", "PS", "PT", "PW", "PY", "QA", "RE", "RO", "RS",
  "RU", "RW", "SA", "SB", "SC", "SD", "SE", "SG", "SH", "SI", "SJ", "SK", "SL", "SM", "SN", "SO", "SR", "SS", "ST",
  "SV", "SX", "SY", "SZ", "TC", "TD", "TF", "TG", "TH", "TJ", "TK", "TL", "TM", "TN", "TO", "TR", "TT", "TV", "TW",
  "TZ", "UA", "UG", "UM", "US", "UY", "UZ", "VA", "VC", "VE", "VG", "VI", "VN", "VU", "WF", "WS", "YE", "YT", "ZA",
  "ZM", "ZW",
]);
const countryCodes: ReadonlySet<string> = new Set(COUNTRY_CODES);
export const countryCodeSchema = z.string().refine((code) => countryCodes.has(code), "Expected an ISO 3166-1 alpha-2 country code such as US");

const postgresText = (value: string) => isPostgresText(value);
const line = () => z.string().trim().min(1).max(120).refine(postgresText, "Text is not valid in Postgres");

/** BP-2: `display_name`, 1..120 characters after trimming. */
export const businessDisplayNameSchema = line();
/** BP-2: `legal_name`, 1..200 characters after trimming (null clears it in `changes`). */
export const businessLegalNameSchema = z.string().trim().min(1).max(200).refine(postgresText, "Text is not valid in Postgres");
/** BP-2: an E.164 number, `+` and 8..15 digits. */
export const businessPhoneSchema = z.string().regex(/^\+[0-9]{8,15}$/, "Expected an international number such as +14155550123");
/** BP-3: `UTC` or an IANA name; the database trigger checks it against `pg_timezone_names`. */
export const businessTimeZoneSchema = bookingTimeZoneSchema;
/** BP-2: `{ line1, line2?, city, region?, postalCode?, country }`; optional lines are left out, not null. */
export const postalAddressSchema = z.strictObject({
  line1: line(),
  line2: line().optional(),
  city: line(),
  region: line().optional(),
  postalCode: line().optional(),
  country: countryCodeSchema,
});
export type PostalAddress = z.infer<typeof postalAddressSchema>;

/** BP-5: the profile as `GET /v1/business` and a save show it. */
export const businessProfileSchema = z.strictObject({
  displayName: businessDisplayNameSchema,
  legalName: businessLegalNameSchema.nullable(),
  phoneE164: businessPhoneSchema.nullable(),
  timeZone: businessTimeZoneSchema.nullable(),
  currency: currencyCodeSchema,
  postalAddress: postalAddressSchema.nullable(),
  revision: z.number().int().min(1).max(2_147_483_647),
  updatedAt: instantSchema,
});
export type BusinessProfile = z.infer<typeof businessProfileSchema>;

/** The editable fields (BP-6): `displayName` and `currency` cannot be cleared. */
export const businessProfileChangesSchema = z.strictObject({
  displayName: businessDisplayNameSchema,
  legalName: businessLegalNameSchema.nullable(),
  phoneE164: businessPhoneSchema.nullable(),
  timeZone: businessTimeZoneSchema.nullable(),
  currency: currencyCodeSchema,
  postalAddress: postalAddressSchema.nullable(),
}).partial().refine((changes) => Object.keys(changes).length > 0, "Name at least one field to change");
export type BusinessProfileChanges = z.infer<typeof businessProfileChangesSchema>;

/** PUT /v1/business: only the fields being set, compare-and-set on `expectedRevision` (BP-6, BP-7). */
export const updateBusinessProfileRequestSchema = z.strictObject({
  expectedRevision: z.number().int().min(1).max(2_147_483_647),
  changes: businessProfileChangesSchema,
});
export type UpdateBusinessProfileRequest = z.infer<typeof updateBusinessProfileRequestSchema>;

/**
 * How a client reads the profile: a newer API may add keys, which are dropped here, so neither order
 * of a rolling deploy breaks the Settings form (BP-10).
 */
export const businessProfileReadSchema = z.object({
  displayName: z.string(),
  legalName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  timeZone: z.string().nullable(),
  currency: z.string(),
  postalAddress: postalAddressSchema.nullable(),
  revision: z.number().int(),
  updatedAt: z.string(),
});

// The action command. The edge mints the action ID from the idempotency key.
export const BUSINESS_PROFILE_TARGET = "business_profile";
export const updateBusinessProfileCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("business.profile.update"),
  target: targetSchema.extend({ type: z.literal(BUSINESS_PROFILE_TARGET) }),
  payload: updateBusinessProfileRequestSchema,
}).refine((command) => command.target.id === command.target.tenantId, "Target must be the tenant's business profile"));
export const businessProfileOutputSchema = z.lazy(() => actionResultSchema.extend({ result: businessProfileSchema }));
export type BusinessProfileOutput = z.infer<typeof businessProfileOutputSchema>;
