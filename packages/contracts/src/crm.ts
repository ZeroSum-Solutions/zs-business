import { z } from "zod";
import {
  actionCommandSchema,
  actionResultSchema,
  targetSchema,
  uuidSchema,
  type ActionCommand,
  type ActionError,
  type ActionResult,
} from "./index.js";
import { storedInstantSchema, supportedInstantSchema } from "./instant.js";
import { isPostgresText } from "./json.js";

// Root re-exports this module; defer access to the shared schema until parsing.
const idSchema = z.lazy(() => uuidSchema);

/**
 * F2 frozen boundary. Parse and normalize commands BEFORE approving their binding. This is the
 * instant on a CRM record or result; client-supplied instants use `supportedInstantSchema`.
 */
export const crmInstantSchema = storedInstantSchema;
export type CrmInstant = z.infer<typeof crmInstantSchema>;
const textSchema = z.string().min(1).max(200).refine(isPostgresText, "Invalid Postgres text");
export const contactEmailInputSchema = z.string().trim().max(254)
  .regex(/^[\x00-\x7F]+$/, "Expected ASCII email before case folding")
  .toLowerCase().pipe(z.email());
export type ContactEmailInput = z.infer<typeof contactEmailInputSchema>;
export const normalizedContactEmailSchema = z.email().max(254).refine((email) => email === email.trim().toLowerCase(),
  "Expected normalized email");
export type NormalizedContactEmail = z.infer<typeof normalizedContactEmailSchema>;
export const contactPhoneSchema = z.string().regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 phone");
export type ContactPhone = z.infer<typeof contactPhoneSchema>;
/** C-9: client evidence, dated in the supported years. */
export const consentEvidenceSchema = z.strictObject({
  status: z.enum(["granted", "denied"]),
  source: textSchema,
  recordedAt: supportedInstantSchema,
});
export type ConsentEvidence = z.infer<typeof consentEvidenceSchema>;
/** null means no evidence; it never means permission or a request to erase evidence. */
export const contactConsentSchema = z.strictObject({
  email: consentEvidenceSchema.nullable(),
  sms: consentEvidenceSchema.nullable(),
});
export type ContactConsent = z.infer<typeof contactConsentSchema>;
/** Stored evidence as a record returns it; an earlier release may have stored any instant. */
export const storedConsentEvidenceSchema = consentEvidenceSchema.extend({ recordedAt: crmInstantSchema });
export const storedContactConsentSchema = z.strictObject({
  email: storedConsentEvidenceSchema.nullable(),
  sms: storedConsentEvidenceSchema.nullable(),
});
export const createOrFindContactInputSchema = z.strictObject({
  contactId: idSchema,
  displayName: textSchema.nullable(),
  email: contactEmailInputSchema.nullable(),
  phone: contactPhoneSchema.nullable(),
  mode: z.enum(["interactive", "import"]),
  consent: contactConsentSchema,
}).refine((value) => value.email !== null || value.phone !== null, "At least one identity is required");
export type CreateOrFindContactInput = z.infer<typeof createOrFindContactInputSchema>;
export const createOrFindContactCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.contact.create-or-find"),
  target: targetSchema.extend({ type: z.literal("contact") }),
  payload: createOrFindContactInputSchema,
}).refine((command) => command.target.id === command.payload.contactId,
  "Target must equal the candidate contact ID"));
export type CreateOrFindContactCommand = z.infer<typeof createOrFindContactCommandSchema>;
export const contactRecordSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  displayName: textSchema.nullable(),
  email: normalizedContactEmailSchema.nullable(),
  phone: contactPhoneSchema.nullable(),
  consent: storedContactConsentSchema,
  createdAt: crmInstantSchema,
  updatedAt: crmInstantSchema,
}).refine((value) => value.email !== null || value.phone !== null, "At least one identity is required");
export type ContactRecord = z.infer<typeof contactRecordSchema>;
export const createOrFindContactResultSchema = z.strictObject({
  contact: contactRecordSchema,
  created: z.boolean(),
});
export type CreateOrFindContactResult = z.infer<typeof createOrFindContactResultSchema>;
export const createOrFindContactOutputSchema = z.lazy(() => actionResultSchema.extend({ result: createOrFindContactResultSchema }));
export type CreateOrFindContactOutput = z.infer<typeof createOrFindContactOutputSchema>;
export const createDealInputSchema = z.strictObject({
  dealId: idSchema,
  contactId: idSchema,
  pipelineId: idSchema,
  stageId: idSchema,
  title: textSchema,
});
export type CreateDealInput = z.infer<typeof createDealInputSchema>;
export const createDealCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.deal.create"),
  target: targetSchema.extend({ type: z.literal("deal") }),
  payload: createDealInputSchema,
}).refine((command) => command.target.id === command.payload.dealId,
  "Target must equal the pre-minted deal ID"));
export type CreateDealCommand = z.infer<typeof createDealCommandSchema>;
export const dealRecordSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  contactId: idSchema,
  pipelineId: idSchema,
  stageId: idSchema,
  title: textSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  createdAt: crmInstantSchema,
  updatedAt: crmInstantSchema,
});
export type DealRecord = z.infer<typeof dealRecordSchema>;
export const createDealOutputSchema = z.lazy(() => actionResultSchema.extend({ result: dealRecordSchema }));
export type CreateDealOutput = z.infer<typeof createDealOutputSchema>;
export const moveDealStageInputSchema = z.strictObject({
  dealId: idSchema,
  pipelineId: idSchema,
  stageId: idSchema,
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
});
export type MoveDealStageInput = z.infer<typeof moveDealStageInputSchema>;
export const moveDealStageCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("crm.deal.move-stage"),
  target: targetSchema.extend({ type: z.literal("deal") }),
  payload: moveDealStageInputSchema,
}).refine((command) => command.target.id === command.payload.dealId,
  "Target must equal the existing deal ID"));
export type MoveDealStageCommand = z.infer<typeof moveDealStageCommandSchema>;
export const moveDealStageOutputSchema = z.lazy(() => actionResultSchema.extend({ result: dealRecordSchema }));
export type MoveDealStageOutput = z.infer<typeof moveDealStageOutputSchema>;
export const crmWriteErrorCodeSchema = z.enum([
  "ValidationFailed", "TenantDenied", "BindingMismatch", "IdempotencyConflict", "Conflict", "NotImplemented",
]);
export type CrmWriteErrorCode = z.infer<typeof crmWriteErrorCodeSchema>;
export type CreateOrFindContactError = ActionError<CrmWriteErrorCode>;
export type CreateDealError = ActionError<CrmWriteErrorCode>;
export type MoveDealStageError = ActionError<CrmWriteErrorCode>;
/** Supply a shared dispatcher already bound to trusted actor/tenant/clock/db/config. */
export interface CrmWriteContext {
  readonly dispatch: (command: ActionCommand) => Promise<ActionResult>;
}
/** @throws {CreateOrFindContactError} Includes Conflict for split identities. */
export type CreateOrFindContact = (command: CreateOrFindContactCommand, ctx: CrmWriteContext) => Promise<CreateOrFindContactOutput>;
/** @throws {CreateDealError} Parent ownership is checked inside the dispatcher transaction. */
export type CreateDeal = (command: CreateDealCommand, ctx: CrmWriteContext) => Promise<CreateDealOutput>;
/** @throws {MoveDealStageError} A stale revision raises Conflict. */
export type MoveDealStage = (command: MoveDealStageCommand, ctx: CrmWriteContext) => Promise<MoveDealStageOutput>;
