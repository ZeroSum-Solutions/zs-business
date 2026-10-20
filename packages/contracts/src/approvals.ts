import { z } from "zod";
import { actionCommandSchema, actionResultSchema, jsonValueSchema, targetSchema, uuidSchema } from "./index.js";
import { isPostgresText } from "./json.js";
import { pageQuerySchema, pageSchema } from "./page.js";

// M3b approval record (docs/requirements/approvals.md A-1..A-13). Root re-exports this
// module, so shared root schemas are reached lazily, as in members.ts and intake.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });
const postgresText = (min: number, max: number) =>
  z.string().min(min).max(max).refine(isPostgresText, "Text is not valid in Postgres");

/** A-2: the stored state. */
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "revoked"]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
/** A-3: the state against the injected clock; `expired` is never stored. */
export const approvalStandingSchema = z.enum(["pending", "approved", "rejected", "revoked", "expired"]);
export type ApprovalStanding = z.infer<typeof approvalStandingSchema>;

/** A-5: 1 minute to 30 days; 7 days when a request names none. */
export const APPROVAL_MAX_MINUTES = 43_200;
export const APPROVAL_DEFAULT_MINUTES = 10_080;
const expiresInMinutesSchema = z.number().int().min(1).max(APPROVAL_MAX_MINUTES);
const noteSchema = postgresText(1, 500);

/** The proposed action: the dispatcher binding without tenant, actor and approval. */
export const proposedActionSchema = z.strictObject({
  actionType: z.lazy(() => actionCommandSchema.shape.actionType),
  target: z.strictObject({ type: z.lazy(() => targetSchema.shape.type), id: idSchema }),
  payload: z.lazy(() => jsonValueSchema),
});
export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const requestApprovalInputSchema = z.strictObject({
  approvalId: idSchema,
  action: proposedActionSchema,
  summary: postgresText(1, 500),
  expiresInMinutes: expiresInMinutesSchema,
});
export const requestApprovalCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("approval.request"),
  target: targetSchema.extend({ type: z.literal("approval") }),
  payload: requestApprovalInputSchema,
}).refine((command) => command.target.id === command.payload.approvalId, "Target must equal the pre-minted approval ID"));
export type RequestApprovalCommand = z.infer<typeof requestApprovalCommandSchema>;

export const decideApprovalInputSchema = z.strictObject({ approvalId: idSchema, note: noteSchema.optional() });
const decisionCommand = <Type extends string>(actionType: Type) => z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(actionType),
  target: targetSchema.extend({ type: z.literal("approval") }),
  payload: decideApprovalInputSchema,
}).refine((command) => command.target.id === command.payload.approvalId, "Target must equal the approval ID"));
export const approveApprovalCommandSchema = decisionCommand("approval.approve");
export const rejectApprovalCommandSchema = decisionCommand("approval.reject");
export const revokeApprovalCommandSchema = decisionCommand("approval.revoke");
export type DecideApprovalCommand = z.infer<typeof approveApprovalCommandSchema>;

export const approvalRecordSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  actionType: z.string(),
  target: z.lazy(() => targetSchema),
  payload: z.lazy(() => jsonValueSchema),
  summary: z.string(),
  status: approvalStatusSchema,
  standing: approvalStandingSchema,
  requestedBy: idSchema,
  requestedAt: instantSchema,
  expiresAt: instantSchema,
  decidedBy: idSchema.nullable(),
  decidedAt: instantSchema.nullable(),
  decisionNote: z.string().nullable(),
  revokedBy: idSchema.nullable(),
  revokedAt: instantSchema.nullable(),
  revokeNote: z.string().nullable(),
  /** A-11: the action that ran under this approval, if one has. */
  executedActionId: idSchema.nullable(),
});
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export const approvalOutputSchema = z.lazy(() => actionResultSchema.extend({ result: approvalRecordSchema }));
export type ApprovalOutput = z.infer<typeof approvalOutputSchema>;

/** HTTP and MCP bodies; the edge mints approvalId from the idempotency key. */
export const requestApprovalRequestSchema = z.strictObject({
  action: proposedActionSchema,
  summary: postgresText(1, 500),
  expiresInMinutes: expiresInMinutesSchema.default(APPROVAL_DEFAULT_MINUTES),
});
export type RequestApprovalRequest = z.input<typeof requestApprovalRequestSchema>;
export const decideApprovalRequestSchema = z.strictObject({ note: noteSchema.optional() });
export type DecideApprovalRequest = z.infer<typeof decideApprovalRequestSchema>;
/** A-7: approving also runs the action; `execution` is the action's own result envelope. */
export const approveApprovalResponseSchema = z.lazy(() => z.strictObject({
  approval: approvalOutputSchema,
  execution: actionResultSchema,
}));
export type ApproveApprovalResponse = z.infer<typeof approveApprovalResponseSchema>;

export const listApprovalsQuerySchema = pageQuerySchema.extend({ status: approvalStatusSchema.optional() });
export type ListApprovalsQuery = z.infer<typeof listApprovalsQuerySchema>;
export const approvalPageSchema = pageSchema(approvalRecordSchema);
export type ApprovalPage = z.infer<typeof approvalPageSchema>;
