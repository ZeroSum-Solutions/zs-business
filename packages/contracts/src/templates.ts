import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema, ValidationFailed } from "./index.js";
import { approvalStandingSchema } from "./approvals.js";
import { agentKindSchema, followUpRunSchema, followUpStopReasonSchema, type AgentKind } from "./agents.js";
import {
  deliveryChannelSchema,
  deliveryPurposeSchema,
  EMAIL_BODY_MAX,
  messageSendRequestedSchema,
  SMS_BODY_MAX,
  type DeliveryChannel,
  type DeliveryPurpose,
} from "./delivery.js";
import { isPostgresText } from "./json.js";

// Message templates and the templated agent kinds (docs/requirements/agents.md G-19, G-20 and
// approvals.md A-15). Root re-exports this module, so shared root schemas are reached lazily.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

/** G-19: the two kinds that send text rendered from an approved template revision. */
export const TEMPLATED_KINDS = ["appointment_reminder", "review_request"] as const;
export const templatedKindSchema = z.enum(TEMPLATED_KINDS);
export type TemplatedKind = z.infer<typeof templatedKindSchema>;
export const isTemplatedKind = (kind: AgentKind | string): kind is TemplatedKind =>
  (TEMPLATED_KINDS as readonly string[]).includes(kind);

export const REMINDER_QUEUE_ACTION = "agent.reminder.queue";
export const REVIEW_QUEUE_ACTION = "agent.review.queue";
export const TEMPLATE_REVISION_CREATE_ACTION = "template.revision.create";
export const TEMPLATE_STANDING_GRANT_ACTION = "template.standing.grant";
export const KIND_RUN_START_ACTION = "agent.kind.run.start";
export const KIND_RUN_FINISH_ACTION = "agent.kind.run.finish";
export const KIND_SKIP_ACTION = "agent.kind.skip";
/** The queue action each templated kind's principal runs (G-14, G-19). */
export const QUEUE_ACTIONS: Readonly<Record<TemplatedKind, string>> = Object.freeze({
  appointment_reminder: REMINDER_QUEUE_ACTION,
  review_request: REVIEW_QUEUE_ACTION,
});
export const queueActionKind = (actionType: string): TemplatedKind | null =>
  actionType === REMINDER_QUEUE_ACTION ? "appointment_reminder" : actionType === REVIEW_QUEUE_ACTION ? "review_request" : null;

/** G-19: the variables a body may use, per kind. Sorted, so a revision's list is the same everywhere. */
export const TEMPLATE_VARIABLES: Readonly<Record<TemplatedKind, readonly string[]>> = Object.freeze({
  appointment_reminder: Object.freeze(["booking_link", "booking_start_local", "business_name", "customer_first_name"]),
  review_request: Object.freeze(["booking_start_local", "business_name", "customer_first_name", "review_link"]),
});
/** G-19, G-20: reminders are transactional, review requests are marketing. */
export const TEMPLATE_PURPOSES: Readonly<Record<TemplatedKind, DeliveryPurpose>> = Object.freeze({
  appointment_reminder: "transactional",
  review_request: "marketing",
});
/** G-19, G-20: the allowed range of a revision's `timingHours`. */
export const TEMPLATE_TIMING_HOURS: Readonly<Record<TemplatedKind, { readonly min: number; readonly max: number; readonly fallback: number }>> =
  Object.freeze({
    appointment_reminder: Object.freeze({ min: 1, max: 168, fallback: 24 }),
    review_request: Object.freeze({ min: 1, max: 720, fallback: 24 }),
  });
/** The longest value each variable takes, so a body that fits with these always fits (see `parseTemplateDraft`). */
export const TEMPLATE_VALUE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  customer_first_name: 60,
  business_name: 120,
  booking_start_local: 60,
  booking_link: 500,
  review_link: 500,
});
export const TEMPLATE_SUBJECT_MAX = 200;
/** The most revisions a read returns, newest first. */
export const TEMPLATE_REVISIONS_SHOWN = 20;

const PLACEHOLDER = /\{([^{}]*)\}/g;
/** The names between braces in the text, in order of first use. */
export function templatePlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]!))];
}
/** G-19: values go in as plain text, once: a value that looks like a placeholder is not expanded again. */
export function renderTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(values, name) ? values[name]! : whole));
}

const worstCaseValues = (kind: TemplatedKind): Record<string, string> =>
  Object.fromEntries(TEMPLATE_VARIABLES[kind].map((name) => [name, "W".repeat(TEMPLATE_VALUE_LIMITS[name]!)]));

export interface TemplateDraft {
  readonly channel: DeliveryChannel;
  readonly subject: string | null;
  readonly body: string;
  readonly timingHours: number;
}
export interface CheckedTemplate extends TemplateDraft {
  readonly agentKind: TemplatedKind;
  readonly purpose: DeliveryPurpose;
  /** The variables the text uses, sorted. */
  readonly variables: readonly string[];
}

const subjectSchema = z.string().min(1).max(TEMPLATE_SUBJECT_MAX).refine(isPostgresText, "Text is not valid in Postgres")
  .refine((value) => !/[\r\n]/.test(value), "Subject must be one line");
const bodySchema = z.string().min(1).max(EMAIL_BODY_MAX).refine(isPostgresText, "Text is not valid in Postgres");

/**
 * G-19: check a wording against its kind. Any placeholder outside the kind's variables is
 * `ValidationFailed`; an email needs a subject and an SMS has none; and the text rendered with
 * the longest value of every variable must still be a valid `message.send_requested` (D-1), so a
 * send can never exceed a channel's limit. Returns what the revision stores.
 */
export function parseTemplateDraft(kind: AgentKind, input: unknown): CheckedTemplate {
  if (!isTemplatedKind(kind)) throw new ValidationFailed(`${kind} has no message template`);
  const range = TEMPLATE_TIMING_HOURS[kind];
  const parsed = z.strictObject({
    channel: deliveryChannelSchema,
    subject: subjectSchema.nullable(),
    body: bodySchema,
    timingHours: z.number().int().min(range.min).max(range.max),
  }).safeParse(input);
  if (!parsed.success) throw new ValidationFailed(`Invalid template: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const draft = parsed.data;
  if (draft.channel === "email" ? draft.subject === null : draft.subject !== null)
    throw new ValidationFailed(draft.channel === "email" ? "An email template needs a subject" : "A text message template has no subject");
  if (draft.channel === "sms" && draft.body.length > SMS_BODY_MAX) throw new ValidationFailed("The text message is too long");
  const allowed = new Set(TEMPLATE_VARIABLES[kind]);
  const used = new Set<string>();
  for (const name of [...templatePlaceholders(draft.body), ...templatePlaceholders(draft.subject ?? "")]) {
    if (!allowed.has(name)) throw new ValidationFailed(`{${name}} is not a variable of ${kind}`);
    used.add(name);
  }
  const values = worstCaseValues(kind);
  const probe = messageSendRequestedSchema.safeParse({
    messageId: "00000000-0000-4000-8000-000000000000", contactId: "00000000-0000-4000-8000-000000000000",
    channel: draft.channel, purpose: TEMPLATE_PURPOSES[kind],
    subject: draft.subject === null ? null : renderTemplate(draft.subject, values), body: renderTemplate(draft.body, values),
  });
  if (!probe.success) throw new ValidationFailed("The template is too long once its variables are filled in");
  return {
    agentKind: kind, channel: draft.channel, purpose: TEMPLATE_PURPOSES[kind], subject: draft.subject, body: draft.body,
    timingHours: draft.timingHours, variables: [...used].sort(),
  };
}

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** PUT-like: POST /v1/agents/:agentKind/template/revisions. The kind comes from the path. */
export const createTemplateRevisionRequestSchema = z.strictObject({
  /** Compare-and-set on the template's current revision; 0 when it has none. */
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
  channel: deliveryChannelSchema,
  subject: subjectSchema.nullable(),
  body: bodySchema,
  timingHours: z.number().int().min(1).max(720),
});
export type CreateTemplateRevisionRequest = z.infer<typeof createTemplateRevisionRequestSchema>;

/** POST /v1/agents/:agentKind/template/approve: an owner's standing approval of one revision (A-15). */
export const approveTemplateRequestSchema = z.strictObject({
  revision: z.number().int().min(1).max(2_147_483_647),
  /** The digest the owner saw, so an approval can never cover wording they did not read. */
  contentDigest: digestSchema,
  /** How long the approval stands; at most 30 days (A-5). Left out, 30 days. */
  expiresInMinutes: z.number().int().min(1).max(43_200).optional(),
});
export type ApproveTemplateRequest = z.infer<typeof approveTemplateRequestSchema>;

/** G-19: a revision as a member reads it. */
export const templateRevisionSchema = z.strictObject({
  id: idSchema,
  revision: z.number().int().min(1),
  channel: deliveryChannelSchema,
  purpose: deliveryPurposeSchema,
  subject: z.string().nullable(),
  body: z.string(),
  variables: z.array(z.string()),
  timingHours: z.number().int().min(1),
  contentDigest: digestSchema,
  createdBy: idSchema,
  createdAt: instantSchema,
  /** The template's current revision. */
  current: z.boolean(),
  /** A-15: the standing approval recorded for it, with the number of sends it covered (A-11). */
  standing: z.strictObject({
    approvalId: idSchema,
    standing: approvalStandingSchema,
    expiresAt: instantSchema,
    sends: z.number().int().min(0),
  }).nullable(),
  /** A pending grant waiting for an owner's decision, if any. */
  pendingApprovalId: idSchema.nullable(),
  /** Whether sends may use it now: current, and its standing approval is `approved`. */
  approved: z.boolean(),
});
export type TemplateRevision = z.infer<typeof templateRevisionSchema>;

export const templateStateSchema = z.strictObject({
  agentKind: templatedKindSchema,
  templateId: idSchema,
  purpose: deliveryPurposeSchema,
  /** The variables a body of this kind may use. */
  variables: z.array(z.string()),
  /** 0 until the first revision exists. */
  currentRevision: z.number().int().min(0),
  /** Newest first, at most TEMPLATE_REVISIONS_SHOWN. */
  revisions: z.array(templateRevisionSchema),
});
export type TemplateState = z.infer<typeof templateStateSchema>;

/** POST /v1/agents/:agentKind/template-suggestion: the input holds no customer data (G-19). */
export const suggestTemplateRequestSchema = z.strictObject({ channel: deliveryChannelSchema });
export type SuggestTemplateRequest = z.infer<typeof suggestTemplateRequestSchema>;
export const templateSuggestionSchema = z.strictObject({
  agentKind: templatedKindSchema,
  channel: deliveryChannelSchema,
  subject: z.string().nullable(),
  body: z.string(),
  variables: z.array(z.string()),
  costSpentMicros: z.number().int().min(0),
  costCapMicros: z.number().int().min(0),
  costWarning: z.boolean(),
});
export type TemplateSuggestion = z.infer<typeof templateSuggestionSchema>;

// Actions

const templateTarget = () => targetSchema.extend({ type: z.literal("message_template") });
export const templateRevisionCreateInputSchema = z.strictObject({
  templateId: idSchema,
  revisionId: idSchema,
  agentKind: templatedKindSchema,
  expectedRevision: z.number().int().min(0).max(2_147_483_647),
  channel: deliveryChannelSchema,
  subject: subjectSchema.nullable(),
  body: bodySchema,
  timingHours: z.number().int().min(1).max(720),
});
export const templateRevisionCreateCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(TEMPLATE_REVISION_CREATE_ACTION),
  target: templateTarget(),
  payload: templateRevisionCreateInputSchema,
}).refine((command) => command.target.id === command.payload.templateId, "Target must equal the template ID"));
export const templateStateOutputSchema = z.lazy(() => actionResultSchema.extend({ result: templateStateSchema }));

/** A-15: the grant's payload and target are exactly as written there. */
export const templateStandingGrantInputSchema = z.strictObject({
  templateId: idSchema,
  revision: z.number().int().min(1).max(2_147_483_647),
  contentDigest: digestSchema,
});
export const templateStandingGrantCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(TEMPLATE_STANDING_GRANT_ACTION),
  target: targetSchema.extend({ type: z.literal("message_template_revision") }),
  payload: templateStandingGrantInputSchema,
}));

const valuesSchema = z.record(z.string(), z.string().max(500));
/** A-15, G-19: a send names its revision, its standing approval and every value it rendered. */
export const queueMessageInputSchema = z.strictObject({
  decisionId: idSchema,
  runId: idSchema,
  bookingId: idSchema,
  contactId: idSchema,
  messageId: idSchema,
  templateRevisionId: idSchema,
  standingApprovalId: idSchema,
  values: valuesSchema,
});
export type QueueMessageInput = z.infer<typeof queueMessageInputSchema>;
const queueCommand = (actionType: string) => z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(actionType),
  target: targetSchema.extend({ type: z.literal("agent_decision") }),
  payload: queueMessageInputSchema,
}).refine((command) => command.target.id === command.payload.decisionId, "Target must equal the decision ID"));
export const reminderQueueCommandSchema = queueCommand(REMINDER_QUEUE_ACTION);
export const reviewQueueCommandSchema = queueCommand(REVIEW_QUEUE_ACTION);

/** G-14: a decision of a kind that keeps its decisions in `agent_decisions`. */
export const kindDecisionSchema = z.strictObject({
  id: idSchema,
  runId: idSchema,
  agentKind: agentKindSchema,
  subjectType: z.enum(["booking", "intake_item", "document", "call"]),
  subjectId: idSchema,
  contactId: idSchema.nullable(),
  outcome: z.enum(["queued", "proposed", "skipped"]),
  reason: z.string().nullable(),
  messageId: idSchema.nullable(),
  approvalId: idSchema.nullable(),
  createdAt: instantSchema,
});
export type KindDecision = z.infer<typeof kindDecisionSchema>;
export const kindDecisionOutputSchema = z.lazy(() => actionResultSchema.extend({ result: kindDecisionSchema }));

export const startKindRunInputSchema = z.strictObject({
  runId: idSchema, agentKind: templatedKindSchema, requestedBy: idSchema.nullable(),
  maxDecisions: z.number().int().min(1).max(1000),
});
export const startKindRunCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(KIND_RUN_START_ACTION),
  target: targetSchema.extend({ type: z.literal("agent_run") }),
  payload: startKindRunInputSchema,
}).refine((command) => command.target.id === command.payload.runId, "Target must equal the run ID"));
export const finishKindRunInputSchema = z.strictObject({
  runId: idSchema, agentKind: templatedKindSchema, stopReason: followUpStopReasonSchema.nullable(),
});
export const finishKindRunCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(KIND_RUN_FINISH_ACTION),
  target: targetSchema.extend({ type: z.literal("agent_run") }),
  payload: finishKindRunInputSchema,
}).refine((command) => command.target.id === command.payload.runId, "Target must equal the run ID"));
export const kindRunOutputSchema = z.lazy(() => actionResultSchema.extend({ result: followUpRunSchema }));

/** G-19, G-20: why a templated kind did not queue one message. */
export const templatedSkipReasonSchema = z.enum([
  "no_address", "suppressed", "consent_denied", "consent_missing", "template_not_approved", "contact_cap", "no_link",
  "global_killed", "disabled", "tenant_killed", "quiet_hours", "daily_cap", "cost_cap",
]);
export type TemplatedSkipReason = z.infer<typeof templatedSkipReasonSchema>;
export const skipKindInputSchema = z.strictObject({
  decisionId: idSchema, runId: idSchema, agentKind: templatedKindSchema, bookingId: idSchema, contactId: idSchema,
  reason: templatedSkipReasonSchema,
});
export const skipKindCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(KIND_SKIP_ACTION),
  target: targetSchema.extend({ type: z.literal("agent_decision") }),
  payload: skipKindInputSchema,
}).refine((command) => command.target.id === command.payload.decisionId, "Target must equal the decision ID"));
