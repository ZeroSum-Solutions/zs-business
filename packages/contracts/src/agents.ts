import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { bookingTimeZoneSchema } from "./booking.js";
import { replyBodySchema, replySubjectSchema } from "./inbox.js";
import { isPostgresText } from "./json.js";
import { pageQuerySchema, pageSchema } from "./page.js";

// M6 inquiry follow-up agent (docs/requirements/agents.md G-1..G-12). Root re-exports this
// module, so shared root schemas are reached lazily, as in inbox.ts and approvals.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

/** G-8: why the agent did not draft for one inquiry. */
export const followUpSkipReasonSchema = z.enum([
  "no_email", "suppressed", "consent_denied", "contact_cap", "answered", "model_error", "model_invalid",
  "global_killed", "disabled", "tenant_killed", "quiet_hours", "daily_cap",
]);
export type FollowUpSkipReason = z.infer<typeof followUpSkipReasonSchema>;
/** G-3, G-4, G-5, G-8: reasons that apply to the whole tenant and end a run. */
export const followUpStopReasonSchema = z.enum(["global_killed", "disabled", "tenant_killed", "quiet_hours", "daily_cap"]);
export type FollowUpStopReason = z.infer<typeof followUpStopReasonSchema>;
export const isStopReason = (reason: FollowUpSkipReason): reason is FollowUpStopReason =>
  (followUpStopReasonSchema.options as readonly string[]).includes(reason);

const minuteOfDay = z.number().int().min(0).max(1439);
/** G-2, G-4, G-5: what an owner sets. */
export const followUpSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  maxDraftsPerDay: z.number().int().min(1).max(200),
  maxDraftsPerContact: z.number().int().min(1).max(10),
  contactWindowHours: z.number().int().min(1).max(2160),
  waitHours: z.number().int().min(1).max(720),
  lookbackDays: z.number().int().min(1).max(90),
  quietStartMinute: minuteOfDay,
  quietEndMinute: minuteOfDay,
  timeZone: bookingTimeZoneSchema.refine((zone) => zone.length <= 100, "Time zone is too long"),
});
export type FollowUpSettings = z.infer<typeof followUpSettingsSchema>;
/** G-2: a tenant without a settings row reads as these, with revision 0. */
export const DEFAULT_FOLLOW_UP_SETTINGS: FollowUpSettings = Object.freeze({
  enabled: false,
  maxDraftsPerDay: 10,
  maxDraftsPerContact: 1,
  contactWindowHours: 168,
  waitHours: 24,
  lookbackDays: 14,
  quietStartMinute: 21 * 60,
  quietEndMinute: 8 * 60,
  timeZone: "UTC",
});

const noteSchema = z.string().min(1).max(500).refine(isPostgresText, "Text is not valid in Postgres");

/** PUT /v1/agents/followup/settings: the whole settings, compare-and-set on `expectedRevision`. */
export const updateFollowUpSettingsRequestSchema = followUpSettingsSchema.extend({
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
});
export type UpdateFollowUpSettingsRequest = z.infer<typeof updateFollowUpSettingsRequestSchema>;
/** POST /v1/agents/followup/kill; resume takes an empty object. */
export const killFollowUpRequestSchema = z.strictObject({ note: noteSchema.optional() });
export type KillFollowUpRequest = z.infer<typeof killFollowUpRequestSchema>;
export const resumeFollowUpRequestSchema = z.strictObject({});
/** POST /v1/agents/followup/runs: no options yet. */
export const startFollowUpRunRequestSchema = z.strictObject({});

/** G-11: the agent's state for one tenant. */
export const followUpStatusSchema = z.strictObject({
  settings: followUpSettingsSchema,
  /** 0 until the settings row exists (an owner saves settings or anyone kills the agent). */
  revision: z.number().int().min(0),
  updatedAt: instantSchema.nullable(),
  killed: z.strictObject({ at: instantSchema, by: idSchema, note: z.string().nullable() }).nullable(),
  globalKilled: z.boolean(),
  /** Whether a draft could commit now; `blockedBy` names the first reason it could not. */
  canDraft: z.boolean(),
  blockedBy: followUpStopReasonSchema.nullable(),
});
export type FollowUpStatus = z.infer<typeof followUpStatusSchema>;

export const followUpRunStatusSchema = z.enum(["running", "completed", "stopped"]);
export type FollowUpRunStatus = z.infer<typeof followUpRunStatusSchema>;
export const followUpRunSchema = z.strictObject({
  id: idSchema,
  agent: z.literal("inquiry_followup"),
  /** The owner who started it; null for a scheduled run. */
  requestedBy: idSchema.nullable(),
  startedAt: instantSchema,
  finishedAt: instantSchema.nullable(),
  status: followUpRunStatusSchema,
  stopReason: followUpStopReasonSchema.nullable(),
  considered: z.number().int().min(0),
  drafted: z.number().int().min(0),
  skipped: z.number().int().min(0),
});
export type FollowUpRun = z.infer<typeof followUpRunSchema>;
export const followUpDecisionSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  intakeItemId: idSchema,
  contactId: idSchema,
  outcome: z.enum(["drafted", "skipped"]),
  reason: followUpSkipReasonSchema.nullable(),
  replyId: idSchema.nullable(),
  approvalId: idSchema.nullable(),
  createdAt: instantSchema,
});
export type FollowUpDecision = z.infer<typeof followUpDecisionSchema>;
export const followUpRunDetailSchema = followUpRunSchema.extend({ decisions: z.array(followUpDecisionSchema) });
export type FollowUpRunDetail = z.infer<typeof followUpRunDetailSchema>;
export const listFollowUpRunsQuerySchema = pageQuerySchema;
export type ListFollowUpRunsQuery = z.infer<typeof listFollowUpRunsQuerySchema>;
export const followUpRunPageSchema = pageSchema(followUpRunSchema);
export type FollowUpRunPage = z.infer<typeof followUpRunPageSchema>;

// Action commands. The edge mints every ID from the idempotency key (G-6).
const settingsTarget = () => targetSchema.extend({ type: z.literal("agent_settings") });
const tenantTarget = (command: { target: { id: string; tenantId: string } }) => command.target.id === command.target.tenantId;

export const updateFollowUpSettingsCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.settings.update"),
  target: settingsTarget(),
  payload: updateFollowUpSettingsRequestSchema,
}).refine(tenantTarget, "Target must be the tenant's agent settings"));
export const killFollowUpCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.kill"),
  target: settingsTarget(),
  payload: killFollowUpRequestSchema,
}).refine(tenantTarget, "Target must be the tenant's agent settings"));
export const resumeFollowUpCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.resume"),
  target: settingsTarget(),
  payload: resumeFollowUpRequestSchema,
}).refine(tenantTarget, "Target must be the tenant's agent settings"));
export const followUpStatusOutputSchema = z.lazy(() => actionResultSchema.extend({ result: followUpStatusSchema }));
export type FollowUpStatusOutput = z.infer<typeof followUpStatusOutputSchema>;

export const startFollowUpRunInputSchema = z.strictObject({
  runId: idSchema, requestedBy: idSchema.nullable(),
  /** G-7: the run's limit, fixed when it starts; each decision checks it under the run's lock. */
  maxDecisions: z.number().int().min(1).max(1000),
});
export const startFollowUpRunCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.run.start"),
  target: targetSchema.extend({ type: z.literal("agent_run") }),
  payload: startFollowUpRunInputSchema,
}).refine((command) => command.target.id === command.payload.runId, "Target must equal the run ID"));
export const finishFollowUpRunInputSchema = z.strictObject({ runId: idSchema, stopReason: followUpStopReasonSchema.nullable() });
export const finishFollowUpRunCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.run.finish"),
  target: targetSchema.extend({ type: z.literal("agent_run") }),
  payload: finishFollowUpRunInputSchema,
}).refine((command) => command.target.id === command.payload.runId, "Target must equal the run ID"));
export const followUpRunOutputSchema = z.lazy(() => actionResultSchema.extend({ result: followUpRunSchema }));

const decisionRef = {
  followupId: idSchema, runId: idSchema, intakeItemId: idSchema, contactId: idSchema,
};
export const skipFollowUpInputSchema = z.strictObject({ ...decisionRef, reason: followUpSkipReasonSchema });
export const skipFollowUpCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.followup.skip"),
  target: targetSchema.extend({ type: z.literal("agent_followup") }),
  payload: skipFollowUpInputSchema,
}).refine((command) => command.target.id === command.payload.followupId, "Target must equal the decision ID"));
export const draftFollowUpInputSchema = z.strictObject({
  ...decisionRef, replyId: idSchema, approvalId: idSchema, subject: replySubjectSchema, body: replyBodySchema,
});
export const draftFollowUpCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.followup.draft"),
  target: targetSchema.extend({ type: z.literal("agent_followup") }),
  payload: draftFollowUpInputSchema,
}).refine((command) => command.target.id === command.payload.followupId, "Target must equal the decision ID"));
export const followUpDecisionOutputSchema = z.lazy(() => actionResultSchema.extend({ result: followUpDecisionSchema }));

/** G-9: what the model sees about one inquiry, and nothing else. */
export const followUpPromptSchema = z.strictObject({
  businessName: z.string(),
  customerName: z.string(),
  requestedAt: instantSchema,
  notes: z.string().nullable(),
  booking: z.strictObject({ startsAt: instantSchema, endsAt: instantSchema, timeZone: z.string() }).nullable(),
});
export type FollowUpPrompt = z.infer<typeof followUpPromptSchema>;
/** G-9: the model's answer, trimmed and held to the reply limits. */
export const followUpDraftSchema = z.object({ subject: replySubjectSchema, body: replyBodySchema });
export type FollowUpDraft = z.infer<typeof followUpDraftSchema>;
