import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema, ValidationFailed } from "./index.js";
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
  "no_email", "suppressed", "consent_denied", "contact_cap", "answered", "superseded", "model_error", "model_invalid",
  "global_killed", "disabled", "tenant_killed", "quiet_hours", "daily_cap",
]);
export type FollowUpSkipReason = z.infer<typeof followUpSkipReasonSchema>;
/** G-3, G-4, G-5, G-8: reasons that apply to the whole tenant and end a run. */
export const followUpSwitchReasonSchema = z.enum(["global_killed", "disabled", "tenant_killed", "quiet_hours", "daily_cap"]);
export type FollowUpSwitchReason = z.infer<typeof followUpSwitchReasonSchema>;
/** Those, plus the two that come from the run itself: G-15's cost cap and G-16's stall. */
export const followUpStopReasonSchema = z.enum([...followUpSwitchReasonSchema.options, "cost_cap", "stalled"]);
export type FollowUpStopReason = z.infer<typeof followUpStopReasonSchema>;
/** Whether a decision's skip reason ends the whole run (G-8). */
export const isStopReason = (reason: FollowUpSkipReason): reason is FollowUpSwitchReason =>
  (followUpSwitchReasonSchema.options as readonly string[]).includes(reason);

/** G-14: the five agent kinds. A new kind needs a revision of agents.md. */
export const AGENT_KINDS = ["inquiry_followup", "appointment_reminder", "review_request", "document_intake", "voice_receptionist"] as const;
export const agentKindSchema = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof agentKindSchema>;
/** G-18: where a model call may go. `personal_data` input may hold a customer's personal data. */
export const agentLaneSchema = z.enum(["personal_data", "no_personal_data"]);
export type AgentLane = z.infer<typeof agentLaneSchema>;

const httpsUrlSchema = z.url().max(500).refine((value) => value.startsWith("https://"), "Must be an https URL");
/**
 * G-14: each kind's own settings, held in `agent_settings.config`. Unknown keys are refused.
 * `inquiry_followup` keeps its settings in columns (G-2), so its config is empty. The limits come
 * from G-19..G-21 and `voice-receptionist.md`; the kinds that use them are built later.
 */
export const agentKindConfigSchemas = {
  inquiry_followup: z.strictObject({}),
  appointment_reminder: z.strictObject({
    timingHours: z.number().int().min(1).max(168).default(24),
    maxSendsPerDay: z.number().int().min(1).max(500).default(200),
  }),
  review_request: z.strictObject({
    timingHours: z.number().int().min(1).max(720).default(24),
    lookbackDays: z.number().int().min(1).max(30).default(7),
    contactWindowDays: z.number().int().min(1).max(730).default(180),
    maxSendsPerDay: z.number().int().min(1).max(100).default(20),
    reviewUrl: httpsUrlSchema.optional(),
  }),
  document_intake: z.strictObject({
    maxDocumentsPerDay: z.number().int().min(1).max(500).default(50),
    maxPagesPerDocument: z.number().int().min(1).max(50).default(20),
  }),
  voice_receptionist: z.strictObject({}),
} as const satisfies Record<AgentKind, z.ZodType>;

/** G-15: USD millionths one kind may spend on model calls in 24 hours. */
export const maxCostMicrosPerDaySchema = z.number().int().min(0).max(100_000_000);
export const DEFAULT_MAX_COST_MICROS_PER_DAY = 1_000_000;

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
  /** G-15: left out, the kind keeps its current cap. */
  maxCostMicrosPerDay: maxCostMicrosPerDaySchema.optional(),
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
  /** G-15: model cost in the last 24 hours against the daily cap (USD millionths). */
  costSpentMicros: z.number().int().min(0),
  costCapMicros: maxCostMicrosPerDaySchema,
  /** True once the cost reaches 80% of the cap. */
  costWarning: z.boolean(),
});
export type FollowUpStatus = z.infer<typeof followUpStatusSchema>;

export const followUpRunStatusSchema = z.enum(["running", "completed", "stopped"]);
export type FollowUpRunStatus = z.infer<typeof followUpRunStatusSchema>;
export const followUpRunSchema = z.strictObject({
  id: idSchema,
  agent: agentKindSchema,
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

// G-14: settings, kill and resume for the kinds besides inquiry_followup, on /v1/agents/:agentKind.
const quietMinute = z.number().int().min(0).max(1439);
const agentKindTimeZoneSchema = bookingTimeZoneSchema.refine((zone) => zone.length <= 100, "Time zone is too long");
export const agentKindSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  quietStartMinute: quietMinute,
  quietEndMinute: quietMinute,
  timeZone: agentKindTimeZoneSchema,
  maxCostMicrosPerDay: maxCostMicrosPerDaySchema,
  /** Checked against `agentKindConfigSchemas[kind]`, with the kind's defaults filled in. */
  config: z.record(z.string(), z.json()),
});
export type AgentKindSettings = z.infer<typeof agentKindSettingsSchema>;
/** G-14: a kind's settings when its row is missing: off, with the kind's defaults. */
export function defaultAgentKindSettings(kind: AgentKind): AgentKindSettings {
  return {
    enabled: false, quietStartMinute: 21 * 60, quietEndMinute: 8 * 60, timeZone: "UTC",
    maxCostMicrosPerDay: DEFAULT_MAX_COST_MICROS_PER_DAY, config: agentKindConfigSchemas[kind].parse({}) as AgentKindSettings["config"],
  };
}
const checkKindConfig = (value: { agentKind: AgentKind; config: Record<string, unknown> }, ctx: z.RefinementCtx) => {
  const parsed = agentKindConfigSchemas[value.agentKind].safeParse(value.config);
  if (!parsed.success)
    for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", message: issue.message, path: ["config", ...issue.path] });
};
/** The config parsed against the kind's schema, defaults filled in; a bad one is `ValidationFailed`. */
export function parseAgentKindConfig(kind: AgentKind, config: Record<string, unknown>): AgentKindSettings["config"] {
  const parsed = agentKindConfigSchemas[kind].safeParse(config);
  if (!parsed.success) throw new ValidationFailed("Invalid agent settings");
  return parsed.data as AgentKindSettings["config"];
}

/** PUT /v1/agents/:agentKind/settings: the whole settings, compare-and-set on `expectedRevision`. */
export const updateAgentKindSettingsRequestSchema = agentKindSettingsSchema.extend({
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
});
export type UpdateAgentKindSettingsRequest = z.infer<typeof updateAgentKindSettingsRequestSchema>;
export const killAgentKindRequestSchema = killFollowUpRequestSchema;
export const resumeAgentKindRequestSchema = resumeFollowUpRequestSchema;

export const agentKindStatusSchema = z.strictObject({
  agentKind: agentKindSchema,
  settings: agentKindSettingsSchema,
  revision: z.number().int().min(0),
  updatedAt: instantSchema.nullable(),
  killed: z.strictObject({ at: instantSchema, by: idSchema, note: z.string().nullable() }).nullable(),
  globalKilled: z.boolean(),
  /** Whether the kind may act now; `blockedBy` names the first reason it may not. */
  canRun: z.boolean(),
  blockedBy: followUpStopReasonSchema.nullable(),
  costSpentMicros: z.number().int().min(0),
  costCapMicros: maxCostMicrosPerDaySchema,
  costWarning: z.boolean(),
});
export type AgentKindStatus = z.infer<typeof agentKindStatusSchema>;

const kindSettingsPayload = updateAgentKindSettingsRequestSchema.extend({ agentKind: agentKindSchema }).superRefine(checkKindConfig);
export const updateAgentKindSettingsCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.kind.settings.update"),
  target: settingsTarget(),
  payload: kindSettingsPayload,
}).refine(tenantTarget, "Target must be the tenant's agent settings"));
export const killAgentKindCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.kind.kill"),
  target: settingsTarget(),
  payload: killFollowUpRequestSchema.extend({ agentKind: agentKindSchema }),
}).refine(tenantTarget, "Target must be the tenant's agent settings"));
export const resumeAgentKindCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.kind.resume"),
  target: settingsTarget(),
  payload: z.strictObject({ agentKind: agentKindSchema }),
}).refine(tenantTarget, "Target must be the tenant's agent settings"));
export const agentKindStatusOutputSchema = z.lazy(() => actionResultSchema.extend({ result: agentKindStatusSchema }));
export type AgentKindStatusOutput = z.infer<typeof agentKindStatusOutputSchema>;

/** G-16: the scheduler closes a run that stayed `running` too long. Any kind's principal may run it for its own kind. */
export const stallRunInputSchema = z.strictObject({ runId: idSchema, agentKind: agentKindSchema });
export const stallRunCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.run.stall"),
  target: targetSchema.extend({ type: z.literal("agent_run") }),
  payload: stallRunInputSchema,
}).refine((command) => command.target.id === command.payload.runId, "Target must equal the run ID"));

/** G-15: the call that took the 24-hour cost to 80% of the cap records one warning per local date. */
export const costWarnInputSchema = z.strictObject({
  agentKind: agentKindSchema,
  localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
/** The numbers are read when the action runs, so a replay with the same key carries the same input. */
export const costWarnResultSchema = costWarnInputSchema.extend({
  spentMicros: z.number().int().min(0),
  capMicros: maxCostMicrosPerDaySchema,
});
export const costWarnCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("agent.cost.warn"),
  target: settingsTarget(),
  payload: costWarnInputSchema,
}).refine(tenantTarget, "Target must be the tenant's agent settings"));
export const costWarnOutputSchema = z.lazy(() => actionResultSchema.extend({ result: costWarnResultSchema }));

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
