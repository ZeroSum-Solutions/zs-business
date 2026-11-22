// The owner's action log (docs/direction.md rule 6, backlog B05): one redacted receipt per
// committed action. A receipt names who acted, what kind of action ran, the record it touched,
// the approval it ran under and how it ended. It never carries the action's payload or result:
// no message text, no address, no token.
import { z } from "zod";
import { agentKindSchema } from "./agents.js";
import { approvalStatusSchema } from "./approvals.js";
import { uuidSchema } from "./index.js";
import { memberRoleSchema } from "./members.js";
import { pageQuerySchema, pageSchema } from "./page.js";

// index.js imports this file before it defines uuidSchema, so read it lazily.
const idSchema = z.lazy(() => uuidSchema);

/** Service actors that are not agents: workers and inbound webhooks. */
export const SYSTEM_ACTORS = [
  "public_intake", "unsubscribe", "inbound_sms", "sms_status", "email_feedback", "voice",
  "enrichment", "outreach", "transcription", "document_intake", "images", "automation",
] as const;
export const systemActorSchema = z.enum(SYSTEM_ACTORS);
export type SystemActor = z.infer<typeof systemActorSchema>;

/**
 * Who acted. `person`: a signed-in member; `memberId` and `role` are null once that member left.
 * `agent`: one of the tenant's agents. `system`: a worker or an inbound webhook.
 */
export const actionActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("person"), memberId: idSchema.nullable(), role: memberRoleSchema.nullable() }),
  z.strictObject({ kind: z.literal("agent"), agent: agentKindSchema }),
  z.strictObject({ kind: z.literal("system"), name: systemActorSchema }),
]);
export type ActionActor = z.infer<typeof actionActorSchema>;

/** A short status word from the action's result (`sent`, `queued`), or `done` when it has none. */
export const ACTION_OUTCOME_PATTERN = /^[a-z][a-z_]{0,39}$/;
export const actionOutcomeSchema = z.string().regex(ACTION_OUTCOME_PATTERN);

export const actionLogEntrySchema = z.strictObject({
  id: idSchema,
  actionType: z.string().min(1).max(200),
  actor: actionActorSchema,
  /** The source record the action touched: its type and ID only. */
  target: z.strictObject({ type: z.string().min(1).max(100), id: idSchema }),
  /** The approval the action ran under, with that approval's current status. */
  approval: z.strictObject({ id: idSchema, status: approvalStatusSchema.nullable() }).nullable(),
  outcome: actionOutcomeSchema,
  createdAt: z.iso.datetime({ precision: 3 }),
});
export type ActionLogEntry = z.infer<typeof actionLogEntrySchema>;

/** Newest first. Page by `cursor`; an offset works too but repeats rows when new actions land. */
export const listActionsQuerySchema = pageQuerySchema;
export type ListActionsQuery = z.infer<typeof listActionsQuerySchema>;
export const actionLogPageSchema = pageSchema(actionLogEntrySchema);
export type ActionLogPage = z.infer<typeof actionLogPageSchema>;
