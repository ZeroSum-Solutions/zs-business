import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { bookingTimeZoneSchema } from "./booking.js";
import { activeCurrencyCodeSchema, currencyCodeSchema } from "./currency.js";
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
/** Postgres `char_length` counts code points, so the length rule does too (an emoji is one, not two UTF-16 units). */
const codePointsAtMost = (max: number) => (value: string) => [...value].length <= max;
const line = () => z.string().trim().min(1).refine(codePointsAtMost(120), "Expected at most 120 characters").refine(postgresText, "Text is not valid in Postgres");

/** BP-2: `display_name`, 1..120 characters after trimming. */
export const businessDisplayNameSchema = line();
/** BP-2: `legal_name`, 1..200 characters after trimming (null clears it in `changes`). */
export const businessLegalNameSchema = z.string().trim().min(1).refine(codePointsAtMost(200), "Expected at most 200 characters").refine(postgresText, "Text is not valid in Postgres");
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

/** BP-13: the description, 1..2000 characters after trimming (null clears it in `changes`). */
export const businessDescriptionSchema = z.string().trim().min(1).refine(codePointsAtMost(2000), "Expected at most 2000 characters").refine(postgresText, "Text is not valid in Postgres");

/** BP-14: at most this many services, each name at most this many characters. */
export const BUSINESS_SERVICES_MAX = 20;
export const BUSINESS_SERVICE_NAME_MAX = 80;
// A name is one line: no control character (a newline, a tab, NUL) anywhere in it.
const noControlCharacters = (value: string) => !/\p{Cc}/u.test(value);
const serviceName = z.string().trim().min(1)
  .refine(codePointsAtMost(BUSINESS_SERVICE_NAME_MAX), `Expected at most ${BUSINESS_SERVICE_NAME_MAX} characters`)
  .refine(noControlCharacters, "Expected one line of text")
  .refine(postgresText, "Text is not valid in Postgres");
/** BP-14: the services the business offers; names are unique ignoring case, and `[]` means none. */
export const businessServicesSchema = z.array(serviceName).max(BUSINESS_SERVICES_MAX, `Expected at most ${BUSINESS_SERVICES_MAX} services`)
  .refine((names) => new Set(names.map((name) => name.toLowerCase())).size === names.length, "Each service must be named once");

/** BP-16: the days of the week, in the order screens and prompts list them. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const clockTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Expected a time such as 09:00");
const closingTime = z.string().regex(/^(([01][0-9]|2[0-3]):[0-5][0-9]|24:00)$/, "Expected a time such as 17:30, or 24:00 for midnight");
/** BP-16: one open day, from `open` to `close` the same day ("HH:MM", 24-hour). */
export const openingTimesSchema = z.strictObject({ open: clockTime, close: closingTime })
  .refine((day) => day.open < day.close, { message: "Expected the closing time after the opening time", path: ["close"] });
export type OpeningTimes = z.infer<typeof openingTimesSchema>;
/** BP-16: all seven days; a day is null when the business is closed. At least one day is open. */
export const businessHoursSchema = z.strictObject({
  mon: openingTimesSchema.nullable(),
  tue: openingTimesSchema.nullable(),
  wed: openingTimesSchema.nullable(),
  thu: openingTimesSchema.nullable(),
  fri: openingTimesSchema.nullable(),
  sat: openingTimesSchema.nullable(),
  sun: openingTimesSchema.nullable(),
}).refine((hours) => WEEKDAYS.some((day) => hours[day] !== null), "Name at least one open day, or clear the hours");
export type BusinessHours = z.infer<typeof businessHoursSchema>;

/** BP-17: the tone of voice note, 1..500 characters after trimming (null clears it in `changes`). */
export const BUSINESS_TONE_MAX = 500;
export const businessToneSchema = z.string().trim().min(1).refine(codePointsAtMost(BUSINESS_TONE_MAX), `Expected at most ${BUSINESS_TONE_MAX} characters`).refine(postgresText, "Text is not valid in Postgres");

/** BP-18: at most this many policies; a title and a text at most this many characters. */
export const BUSINESS_POLICIES_MAX = 10;
export const BUSINESS_POLICY_TITLE_MAX = 60;
export const BUSINESS_POLICY_TEXT_MAX = 1000;
/** BP-18: one policy as the owner writes it: a one-line title (Cancellation) and its text. */
export const businessPolicyInputSchema = z.strictObject({
  title: z.string().trim().min(1)
    .refine(codePointsAtMost(BUSINESS_POLICY_TITLE_MAX), `Expected at most ${BUSINESS_POLICY_TITLE_MAX} characters`)
    .refine(noControlCharacters, "Expected one line of text")
    .refine(postgresText, "Text is not valid in Postgres"),
  text: z.string().trim().min(1)
    .refine(codePointsAtMost(BUSINESS_POLICY_TEXT_MAX), `Expected at most ${BUSINESS_POLICY_TEXT_MAX} characters`)
    .refine(postgresText, "Text is not valid in Postgres"),
});
export type BusinessPolicyInput = z.infer<typeof businessPolicyInputSchema>;
/** BP-18: the whole list a save sends; titles are unique ignoring case, and `[]` means none. */
export const businessPoliciesInputSchema = z.array(businessPolicyInputSchema).max(BUSINESS_POLICIES_MAX, `Expected at most ${BUSINESS_POLICIES_MAX} policies`)
  .refine((policies) => new Set(policies.map((policy) => policy.title.toLowerCase())).size === policies.length, "Each policy must have its own title");

/** BP-19: who set a fact and when: an owner's member ID, the instant, and the profile revision of that save. */
export const factMarkSchema = z.strictObject({
  setBy: idSchema,
  setAt: instantSchema,
  revision: z.number().int().min(2).max(2_147_483_647),
});
export type FactMark = z.infer<typeof factMarkSchema>;
/** BP-18: a stored policy carries its own mark. */
export const businessPolicySchema = z.strictObject({
  title: z.string(),
  text: z.string(),
  setBy: idSchema,
  setAt: instantSchema,
  revision: z.number().int().min(2).max(2_147_483_647),
});
export type BusinessPolicy = z.infer<typeof businessPolicySchema>;
/** BP-19: the facts with a single value, each with its mark; a key is absent when no mark is recorded. */
export const MARKED_FACTS = ["displayName", "description", "services", "timeZone", "hours", "tone"] as const;
export type MarkedFact = (typeof MARKED_FACTS)[number];
export const factMarksSchema = z.strictObject({
  displayName: factMarkSchema.optional(),
  description: factMarkSchema.optional(),
  services: factMarkSchema.optional(),
  timeZone: factMarkSchema.optional(),
  hours: factMarkSchema.optional(),
  tone: factMarkSchema.optional(),
});
export type FactMarks = z.infer<typeof factMarksSchema>;

/** BP-5: the profile as `GET /v1/business` and a save show it. */
export const businessProfileSchema = z.strictObject({
  displayName: businessDisplayNameSchema,
  legalName: businessLegalNameSchema.nullable(),
  phoneE164: businessPhoneSchema.nullable(),
  timeZone: businessTimeZoneSchema.nullable(),
  currency: currencyCodeSchema,
  postalAddress: postalAddressSchema.nullable(),
  description: businessDescriptionSchema.nullable(),
  services: businessServicesSchema,
  hours: businessHoursSchema.nullable(),
  tone: businessToneSchema.nullable(),
  policies: z.array(businessPolicySchema),
  factMarks: factMarksSchema,
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
  currency: activeCurrencyCodeSchema,
  postalAddress: postalAddressSchema.nullable(),
  description: businessDescriptionSchema.nullable(),
  services: businessServicesSchema,
  hours: businessHoursSchema.nullable(),
  tone: businessToneSchema.nullable(),
  policies: businessPoliciesInputSchema,
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
const postalAddressReadSchema = z.object({
  line1: z.string(),
  line2: z.string().optional(),
  city: z.string(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string(),
});
export const businessProfileReadSchema = z.object({
  displayName: z.string(),
  legalName: z.string().nullable(),
  phoneE164: z.string().nullable(),
  timeZone: z.string().nullable(),
  currency: z.string(),
  postalAddress: postalAddressReadSchema.nullable(),
  // BP-10: an older API sends neither; the reader then shows an empty description and no services.
  description: z.string().nullable().optional(),
  services: z.array(z.string()).optional(),
  // BP-21: an older API sends none of the company facts; the reader then shows them as not set.
  hours: z.record(z.string(), z.object({ open: z.string(), close: z.string() }).nullable()).nullable().optional(),
  tone: z.string().nullable().optional(),
  policies: z.array(z.object({ title: z.string(), text: z.string(), setBy: z.string(), setAt: z.string(), revision: z.number().optional() })).optional(),
  factMarks: z.record(z.string(), z.object({ setBy: z.string(), setAt: z.string(), revision: z.number().optional() })).optional(),
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
