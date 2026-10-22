import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { bookingInstantSchema, bookingTimeZoneSchema } from "./booking.js";
import { crmInstantSchema, dealRecordSchema } from "./crm.js";

// M3c Home and deal details (docs/requirements/inbox-home.md H-1..H-6). The frozen F2 deal
// record (crm.md C-13..C-20) keeps its shape; lists and set-details return it with details.
const idSchema = z.lazy(() => uuidSchema);

export const leadSourceSchema = z.enum(["website", "referral", "phone", "email", "walk_in", "social", "ads", "other"]);
export type LeadSource = z.infer<typeof leadSourceSchema>;
export const stageOutcomeSchema = z.enum(["open", "won", "lost"]);
export type StageOutcome = z.infer<typeof stageOutcomeSchema>;
/**
 * H-1: the ISO 4217 codes a deal value may carry: circulating currencies, recently withdrawn ones
 * and the IMF's units, without fund, metal, test or "no currency" codes. Migration
 * 20261022520000_deal_currency_iso.sql checks the same list.
 */
export const CURRENCY_CODES: readonly string[] = Object.freeze([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BGN", "BHD", "BIF",
  "BMD", "BND", "BOB", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHF", "CLP", "CNY", "COP", "CRC",
  "CUC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL",
  "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HRK", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR",
  "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR",
  "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MYR",
  "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR",
  "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SLL", "SOS", "SRD", "SSP",
  "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD",
  "UYU", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAF", "XCD", "XCG", "XDR", "XOF", "XPF", "XSU", "YER", "ZAR",
  "ZMW", "ZWG", "ZWL",
]);
const currencyCodes: ReadonlySet<string> = new Set(CURRENCY_CODES);
export const currencyCodeSchema = z.string().refine((code) => currencyCodes.has(code), "Expected an ISO 4217 code such as USD");
/**
 * H-1 revision 4: a currency as reads show it. Deals stored under the earlier check may hold any
 * three capitals until the owner fixes them, so reads accept that shape; writes take only
 * currencyCodeSchema.
 */
export const storedCurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "Expected three capital letters");
const amountMinorSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const dealValueSchema = z.strictObject({
  /** Minor units (cents for USD). */
  amountMinor: amountMinorSchema,
  currency: currencyCodeSchema,
});
export type DealValue = z.infer<typeof dealValueSchema>;
/** A stored deal value, as lists and write results show it (H-1 revision 4). */
export const storedDealValueSchema = z.strictObject({ amountMinor: amountMinorSchema, currency: storedCurrencyCodeSchema });

export const dealDetailsSchema = z.strictObject({
  value: storedDealValueSchema.nullable(),
  leadSource: leadSourceSchema.nullable(),
  wonAt: crmInstantSchema.nullable(),
});
export type DealDetails = z.infer<typeof dealDetailsSchema>;
/** A deal as lists show it: the frozen record plus value, lead source and won date (H-1). */
export const dealSummarySchema = z.strictObject({ ...dealRecordSchema.shape, ...dealDetailsSchema.shape });
export type DealSummary = z.infer<typeof dealSummarySchema>;

export const setDealDetailsInputSchema = z.strictObject({
  dealId: idSchema,
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
  value: dealValueSchema.nullable(),
  leadSource: leadSourceSchema.nullable(),
});
export type SetDealDetailsInput = z.infer<typeof setDealDetailsInputSchema>;
export const setDealDetailsCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.deal.set-details"),
  target: targetSchema.extend({ type: z.literal("deal") }),
  payload: setDealDetailsInputSchema,
}).refine((command) => command.target.id === command.payload.dealId, "Target must equal the existing deal ID"));
export type SetDealDetailsCommand = z.infer<typeof setDealDetailsCommandSchema>;
export const setDealDetailsOutputSchema = z.lazy(() => actionResultSchema.extend({ result: dealSummarySchema }));
export type SetDealDetailsOutput = z.infer<typeof setDealDetailsOutputSchema>;
/** HTTP and MCP body for POST /v1/crm/deals/:id/details. */
export const setDealDetailsRequestSchema = z.strictObject({
  expectedRevision: setDealDetailsInputSchema.shape.expectedRevision,
  value: dealValueSchema.nullable(),
  leadSource: leadSourceSchema.nullable(),
});
export type SetDealDetailsRequest = z.infer<typeof setDealDetailsRequestSchema>;

export const weekStartSchema = z.enum(["monday", "sunday"]);
export type WeekStart = z.infer<typeof weekStartSchema>;
export const resultsQuerySchema = z.strictObject({
  zone: bookingTimeZoneSchema.default("UTC"),
  weekStart: weekStartSchema.default("monday"),
});
export type ResultsQuery = z.infer<typeof resultsQuerySchema>;

export const weekCompareSchema = z.strictObject({
  thisWeek: z.number().int().min(0),
  lastWeek: z.number().int().min(0),
});
export type WeekCompare = z.infer<typeof weekCompareSchema>;
const bySource = <Source extends z.ZodType<string>>(source: Source) =>
  z.array(z.strictObject({ source, ...weekCompareSchema.shape }));
export const leadOriginSchema = z.enum(["website", "manual"]);
export type LeadOrigin = z.infer<typeof leadOriginSchema>;
export const bookingOriginSchema = z.enum(["website", "owner"]);
export const revenueSourceSchema = z.union([leadSourceSchema, z.literal("unset")]);
export type RevenueSource = z.infer<typeof revenueSourceSchema>;
const rangeSchema = z.strictObject({ from: bookingInstantSchema, to: bookingInstantSchema });

/** H-3, H-4: this week so far against the same span of last week, in the asked zone. */
export const homeResultsSchema = z.strictObject({
  zone: bookingTimeZoneSchema,
  weekStart: weekStartSchema,
  thisWeek: rangeSchema,
  lastWeek: rangeSchema,
  leads: z.strictObject({ ...weekCompareSchema.shape, bySource: bySource(leadOriginSchema) }),
  bookings: z.strictObject({ ...weekCompareSchema.shape, bySource: bySource(bookingOriginSchema) }),
  wonDeals: weekCompareSchema,
  /** One entry per currency with won value in either week, largest this week first. */
  revenue: z.array(z.strictObject({
    currency: storedCurrencyCodeSchema,
    thisWeek: z.number().int().min(0),
    lastWeek: z.number().int().min(0),
    bySource: bySource(revenueSourceSchema),
  })),
});
export type HomeResults = z.infer<typeof homeResultsSchema>;
