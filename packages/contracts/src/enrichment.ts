import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { isPostgresText } from "./json.js";

// Company enrichment with Treg (docs/requirements/enrichment.md E-1..E-18). Root re-exports this
// module, so shared root schemas are reached lazily, as in business.ts and agents.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

/** E-2: the one op of the first slice. A later op needs a revision of the contract that adds its tool. */
export const enrichmentOpSchema = z.literal("company.enrich");
export type EnrichmentOp = z.infer<typeof enrichmentOpSchema>;

/** E-17: the only error codes a tenant sees. Treg's own errors never reach one. */
export const ENRICHMENT_ERROR_CODES = Object.freeze([
  "enrichment_unavailable",
  "enrichment_no_company_domain",
  "enrichment_blocked",
  "enrichment_region_blocked",
  "enrichment_region_unknown",
  "insufficient_funds",
  "enrichment_daily_cap",
  "enrichment_result_expired",
] as const);
export type EnrichmentErrorCode = (typeof ENRICHMENT_ERROR_CODES)[number];

/** E-13: the fields kept from an answer, in the adapter's names. */
export const ENRICHMENT_FIELDS = Object.freeze([
  "name", "domain", "industry", "description", "employees", "founded", "location", "linkedin_url",
] as const);
export const enrichmentFieldSchema = z.enum(ENRICHMENT_FIELDS);
export type EnrichmentField = z.infer<typeof enrichmentFieldSchema>;

/** E-10, E-11, E-12: where a request is. `leased` is a worker holding it. */
export const ENRICHMENT_STATUSES = Object.freeze([
  "pending", "leased", "uncertain", "succeeded", "no_match", "rejected", "failed", "blocked",
  "insufficient_funds", "daily_cap", "answer_lost", "region_blocked_after_call", "dead",
] as const);
export const enrichmentStatusSchema = z.enum(ENRICHMENT_STATUSES);
export type EnrichmentStatus = z.infer<typeof enrichmentStatusSchema>;

export const ENRICHMENT_REQUEST_TARGET = "enrichment_request";

export const enrichmentRequestRecordSchema = z.strictObject({
  id: idSchema,
  contactId: idSchema,
  op: enrichmentOpSchema,
  status: enrichmentStatusSchema,
  /** The tenant-safe reason a request ended without a hit; null while it runs or after a hit. */
  reason: z.string().nullable(),
  domain: z.string(),
  priceCents: z.number().int().positive(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type EnrichmentRequestRecord = z.infer<typeof enrichmentRequestRecordSchema>;

export const enrichmentResultRecordSchema = z.strictObject({
  id: idSchema,
  requestId: idSchema,
  contactId: idSchema,
  field: enrichmentFieldSchema,
  value: z.string(),
  provider: z.string(),
  callId: z.string(),
  fetchedAt: instantSchema,
  expiresAt: instantSchema,
  /** E-14: the approval that proposes this field; null once none is left. */
  approvalId: idSchema.nullable(),
});
export type EnrichmentResultRecord = z.infer<typeof enrichmentResultRecordSchema>;

/** E-14: the contact's company profile; enrichment never writes the contact's identity columns. */
export const contactProfileRecordSchema = z.strictObject({
  contactId: idSchema,
  companyName: z.string().nullable(),
  companyDomain: z.string().nullable(),
  companyIndustry: z.string().nullable(),
  companyDescription: z.string().nullable(),
  companyEmployees: z.number().int().nullable(),
  companyFounded: z.number().int().nullable(),
  companyLocation: z.string().nullable(),
  companyLinkedinUrl: z.string().nullable(),
  country: z.string().nullable(),
  doNotEnrichAt: instantSchema.nullable(),
  doNotEnrichReason: z.string().nullable(),
  outsideEuUkAttestedAt: instantSchema.nullable(),
  revision: z.number().int().min(1),
  updatedAt: instantSchema,
});
export type ContactProfileRecord = z.infer<typeof contactProfileRecordSchema>;

/** E-17: `GET /v1/contacts/:id/enrichment`. */
export const contactEnrichmentSchema = z.strictObject({
  profile: contactProfileRecordSchema.nullable(),
  requests: z.array(enrichmentRequestRecordSchema),
  results: z.array(enrichmentResultRecordSchema),
});
export type ContactEnrichment = z.infer<typeof contactEnrichmentSchema>;

/** E-17: `POST /v1/enrichment/requests`. */
export const createEnrichmentRequestSchema = z.strictObject({
  op: enrichmentOpSchema,
  contactId: idSchema,
});
export type CreateEnrichmentRequest = z.infer<typeof createEnrichmentRequestSchema>;

/** A short reason an owner or staff member gives; valid Postgres text. */
export const enrichmentReasonSchema = z.string().trim().min(1).max(200).refine(isPostgresText, "Text is not valid in Postgres");

// E-4: the request action. The edge mints requestId from the idempotency key.
export const enrichmentRequestInputSchema = z.strictObject({
  requestId: idSchema,
  op: enrichmentOpSchema,
  contactId: idSchema,
});
export const enrichmentRequestCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("enrichment.request"),
  target: targetSchema.extend({ type: z.literal(ENRICHMENT_REQUEST_TARGET) }),
  payload: enrichmentRequestInputSchema,
}).refine((command) => command.target.id === command.payload.requestId, "Target must be the request"));
export const enrichmentRequestOutputSchema = z.lazy(() => actionResultSchema.extend({ result: enrichmentRequestRecordSchema }));
export type EnrichmentRequestOutput = z.infer<typeof enrichmentRequestOutputSchema>;

// E-6: the do-not-enrich flag, and E-7: the owner's region mark. Both target the contact.
const contactTarget = z.lazy(() => targetSchema.extend({ type: z.literal("contact") }));
export const blockEnrichmentCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("contact.enrichment.block"),
  target: contactTarget,
  payload: z.strictObject({ contactId: idSchema, reason: enrichmentReasonSchema }),
}).refine((command) => command.target.id === command.payload.contactId, "Target must be the contact"));
export const unblockEnrichmentCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("contact.enrichment.unblock"),
  target: contactTarget,
  payload: z.strictObject({ contactId: idSchema }),
}).refine((command) => command.target.id === command.payload.contactId, "Target must be the contact"));
export const attestRegionCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("contact.region.attest"),
  target: contactTarget,
  payload: z.strictObject({ contactId: idSchema }),
}).refine((command) => command.target.id === command.payload.contactId, "Target must be the contact"));
export const profileOutputSchema = z.lazy(() => actionResultSchema.extend({ result: contactProfileRecordSchema }));
export type ProfileOutput = z.infer<typeof profileOutputSchema>;

export const blockEnrichmentRequestSchema = z.strictObject({ reason: enrichmentReasonSchema });
export type BlockEnrichmentRequest = z.infer<typeof blockEnrichmentRequestSchema>;

// E-14: apply one result to the profile; it runs only after an owner approves it.
export const applyProfileCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("contact.profile.apply"),
  target: contactTarget,
  payload: z.strictObject({ contactId: idSchema, resultId: idSchema }),
}).refine((command) => command.target.id === command.payload.contactId, "Target must be the contact"));
