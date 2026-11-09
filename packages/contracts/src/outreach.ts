import { z } from "zod";
import { actionCommandSchema, actionResultSchema, targetSchema, uuidSchema } from "./index.js";
import { isPostgresText } from "./json.js";
import { pageSchema } from "./page.js";

// Cold-email outreach sequencer (docs/requirements/outreach-sequencer.md OS-1..OS-25). Root re-exports
// this module, so shared root schemas are reached lazily, as in enrichment.ts and agents.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });
const postgresText = (min: number, max: number) =>
  z.string().min(min).max(max).refine(isPostgresText, "Text is not valid in Postgres");

/** OS-5: the only variables a template may use, in the order the contract names them. */
export const OUTREACH_VARIABLES = Object.freeze(["first_name", "company", "industry"] as const);
export type OutreachVariable = (typeof OUTREACH_VARIABLES)[number];

/** OS-7: why one prospect row of an import is refused. */
export const OUTREACH_ROW_REASONS = Object.freeze([
  "invalid_email", "role_address", "missing_field", "hard_suppressed", "suppressed", "consent_denied",
  "duplicate", "mailbox_not_in_campaign", "render_too_long",
] as const);
export type OutreachRowReason = (typeof OUTREACH_ROW_REASONS)[number];

/** OS-23: the only error codes a tenant sees. Gmail's own errors never reach one. */
export const OUTREACH_ERROR_CODES = Object.freeze([
  ...OUTREACH_ROW_REASONS,
  // OS-8: why an activation is refused (the OS-6 reasons included).
  "campaign_not_activatable", "campaign_changed", "no_prospects", "mailbox_unavailable", "time_zone_missing",
  "postal_address_missing", "postal_address_placeholder", "template_placeholder",
  "campaign_active", "unknown_variable",
] as const);
export type OutreachErrorCode = (typeof OUTREACH_ERROR_CODES)[number];

export const OUTREACH_CAMPAIGN_CREATE_ACTION = "outreach.campaign.create";
export const OUTREACH_PROSPECTS_IMPORT_ACTION = "outreach.prospects.import";
export const OUTREACH_CAMPAIGN_ACTIVATE_ACTION = "outreach.campaign.activate";
export const OUTREACH_CAMPAIGN_PAUSE_ACTION = "outreach.campaign.pause";
export const OUTREACH_PROSPECT_STOP_ACTION = "outreach.prospect.stop";
export const OUTREACH_MAILBOX_CONNECT_ACTION = "outreach.mailbox.connect";
export const OUTREACH_MAILBOX_DISCONNECT_ACTION = "outreach.mailbox.disconnect";

export const OUTREACH_CAMPAIGN_TARGET = "outreach_campaign";
export const OUTREACH_PROSPECT_TARGET = "outreach_prospect";
export const OUTREACH_MAILBOX_TARGET = "outreach_mailbox";

export const OUTREACH_MAX_STEPS = 5;
export const OUTREACH_MAX_PROSPECTS_PER_CALL = 500;
export const OUTREACH_MAX_PROSPECTS_PER_CAMPAIGN = 5000;
export const OUTREACH_MAX_MAILBOXES = 5;
export const OUTREACH_DEFAULT_DAILY_CAP = 20;

export const OUTREACH_CAMPAIGN_STATUSES = Object.freeze(["draft", "active", "paused", "completed"] as const);
export const outreachCampaignStatusSchema = z.enum(OUTREACH_CAMPAIGN_STATUSES);
export type OutreachCampaignStatus = z.infer<typeof outreachCampaignStatusSchema>;

export const OUTREACH_MAILBOX_STATUSES = Object.freeze(["active", "reauthorize", "disconnected"] as const);
export const outreachMailboxStatusSchema = z.enum(OUTREACH_MAILBOX_STATUSES);
export type OutreachMailboxStatus = z.infer<typeof outreachMailboxStatusSchema>;

export const OUTREACH_PROSPECT_STATUSES = Object.freeze([
  "pending", "excluded", "active", "completed", "replied", "owner_replied", "bounced", "unsubscribed",
  "suppressed", "hard_suppressed", "consent_denied", "invalid_address", "send_outcome_unknown",
  "thread_unavailable", "stopped",
] as const);
export const outreachProspectStatusSchema = z.enum(OUTREACH_PROSPECT_STATUSES);
export type OutreachProspectStatus = z.infer<typeof outreachProspectStatusSchema>;

/** The statuses from which a prospect never moves again. */
export const OUTREACH_OPEN_PROSPECT_STATUSES: readonly OutreachProspectStatus[] = Object.freeze(["pending", "active"] as const);

/** OS-4: "HH:MM", 24-hour, in the tenant's time zone. */
export const outreachClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
export const outreachWindowSchema = z.strictObject({ start: outreachClockSchema, end: outreachClockSchema })
  .superRefine((window, ctx) => {
    const minutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    if (minutes(window.end) - minutes(window.start) < 30)
      ctx.addIssue({ code: "custom", message: "The window must end at least 30 minutes after it starts", path: ["end"] });
  });
export type OutreachWindow = z.infer<typeof outreachWindowSchema>;

/** A header-safe single line: no CR, LF or NUL. */
const singleLine = (max: number) => postgresText(1, max).refine((value) => !/[\r\n]/.test(value), "No line breaks");

export const outreachStepInputSchema = z.strictObject({
  /** Step 1 only. Later steps reuse step 1's subject with "Re: " (OS-5). */
  subject: singleLine(150).optional(),
  body: postgresText(1, 5000),
  delayBusinessDays: z.number().int().min(0).max(30),
});
export type OutreachStepInput = z.infer<typeof outreachStepInputSchema>;

/** OS-4: step 1 has a subject and delay 0; steps 2..5 have no subject and a delay of 1..30. */
export const outreachStepsSchema = z.array(outreachStepInputSchema).min(1).max(OUTREACH_MAX_STEPS)
  .superRefine((steps, ctx) => {
    steps.forEach((step, index) => {
      if (index === 0) {
        if (step.subject === undefined) ctx.addIssue({ code: "custom", message: "Step 1 needs a subject", path: [0, "subject"] });
        if (step.delayBusinessDays !== 0) ctx.addIssue({ code: "custom", message: "Step 1 has no delay", path: [0, "delayBusinessDays"] });
      } else {
        if (step.subject !== undefined) ctx.addIssue({ code: "custom", message: "Only step 1 has a subject", path: [index, "subject"] });
        if (step.delayBusinessDays < 1) ctx.addIssue({ code: "custom", message: "A follow-up waits at least 1 business day", path: [index, "delayBusinessDays"] });
      }
    });
  });

const dailyCapSchema = z.number().int().min(1).max(50);
const mailboxIdsSchema = z.array(idSchema).min(1).max(OUTREACH_MAX_MAILBOXES)
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, "Mailboxes must be distinct");

const campaignFields = {
  name: postgresText(1, 120).refine((value) => value.trim() === value && value !== "", "No blank name"),
  steps: outreachStepsSchema,
  window: outreachWindowSchema,
  dailyCapPerMailbox: dailyCapSchema.optional(),
  mailboxIds: mailboxIdsSchema,
};

/** HTTP and MCP body of `POST /v1/outreach/campaigns`; the edge mints the campaign ID from the key. */
export const createOutreachCampaignRequestSchema = z.strictObject(campaignFields);
export type CreateOutreachCampaignRequest = z.input<typeof createOutreachCampaignRequestSchema>;

export const createOutreachCampaignInputSchema = z.strictObject({ campaignId: idSchema, ...campaignFields });
export const createOutreachCampaignCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(OUTREACH_CAMPAIGN_CREATE_ACTION),
  target: targetSchema.extend({ type: z.literal(OUTREACH_CAMPAIGN_TARGET) }),
  payload: createOutreachCampaignInputSchema,
}).refine((command) => command.target.id === command.payload.campaignId, "Target must be the campaign"));

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/, "Expected a SHA-256 digest");

/** One prospect row of an import. Lenient on purpose: a bad row is rejected with a reason, not the call (OS-7). */
export const outreachProspectRowSchema = z.strictObject({
  email: postgresText(0, 320),
  firstName: postgresText(0, 100),
  lastName: postgresText(1, 100).optional(),
  company: postgresText(0, 200),
  industry: postgresText(0, 100).optional(),
  website: postgresText(1, 300).optional(),
  mailboxId: idSchema.optional(),
  /** True = contacted elsewhere (for example by Smartlead): reserve the address, never send. */
  excluded: z.boolean().optional(),
});
export type OutreachProspectRow = z.infer<typeof outreachProspectRowSchema>;

export const importOutreachProspectsRequestSchema = z.strictObject({
  prospects: z.array(outreachProspectRowSchema).min(1).max(OUTREACH_MAX_PROSPECTS_PER_CALL),
});
export type ImportOutreachProspectsRequest = z.input<typeof importOutreachProspectsRequestSchema>;
export const importOutreachProspectsInputSchema = z.strictObject({
  campaignId: idSchema,
  prospects: importOutreachProspectsRequestSchema.shape.prospects,
});
export const importOutreachProspectsCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(OUTREACH_PROSPECTS_IMPORT_ACTION),
  target: targetSchema.extend({ type: z.literal(OUTREACH_CAMPAIGN_TARGET) }),
  payload: importOutreachProspectsInputSchema,
}).refine((command) => command.target.id === command.payload.campaignId, "Target must be the campaign"));

export const importOutreachProspectsResultSchema = z.strictObject({
  imported: z.number().int().min(0),
  excluded: z.number().int().min(0),
  rejected: z.array(z.strictObject({ index: z.number().int().min(0), reason: z.enum(OUTREACH_ROW_REASONS) })),
});
export type ImportOutreachProspectsResult = z.infer<typeof importOutreachProspectsResultSchema>;
export const importOutreachProspectsOutputSchema = z.lazy(() => actionResultSchema.extend({ result: importOutreachProspectsResultSchema }));
export type ImportOutreachProspectsOutput = z.infer<typeof importOutreachProspectsOutputSchema>;

/** OS-8: the activation approval binds the campaign's content and the prospects it will send to. */
export const activateOutreachCampaignInputSchema = z.strictObject({
  campaignId: idSchema,
  contentDigest: digestSchema,
  prospectsDigest: digestSchema,
  prospectCount: z.number().int().min(0).max(OUTREACH_MAX_PROSPECTS_PER_CAMPAIGN),
});
export type ActivateOutreachCampaignInput = z.infer<typeof activateOutreachCampaignInputSchema>;
export const activateOutreachCampaignCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(OUTREACH_CAMPAIGN_ACTIVATE_ACTION),
  target: targetSchema.extend({ type: z.literal(OUTREACH_CAMPAIGN_TARGET) }),
  payload: activateOutreachCampaignInputSchema,
}).refine((command) => command.target.id === command.payload.campaignId, "Target must be the campaign"));
export const activationRequestResultSchema = z.strictObject({ approvalId: idSchema });
export type ActivationRequestResult = z.infer<typeof activationRequestResultSchema>;

export const pauseOutreachCampaignInputSchema = z.strictObject({ campaignId: idSchema });
export const pauseOutreachCampaignCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(OUTREACH_CAMPAIGN_PAUSE_ACTION),
  target: targetSchema.extend({ type: z.literal(OUTREACH_CAMPAIGN_TARGET) }),
  payload: pauseOutreachCampaignInputSchema,
}).refine((command) => command.target.id === command.payload.campaignId, "Target must be the campaign"));

export const stopOutreachProspectInputSchema = z.strictObject({ prospectId: idSchema });
export const stopOutreachProspectCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(OUTREACH_PROSPECT_STOP_ACTION),
  target: targetSchema.extend({ type: z.literal(OUTREACH_PROSPECT_TARGET) }),
  payload: stopOutreachProspectInputSchema,
}).refine((command) => command.target.id === command.payload.prospectId, "Target must be the prospect"));

/** OS-2, OS-3: the operator's mailbox actions. The sealed token is the only secret; it never leaves the payload. */
export const connectOutreachMailboxInputSchema = z.strictObject({
  mailboxId: idSchema,
  email: postgresText(3, 254).refine((value) => value === value.toLowerCase() && value.includes("@"), "Expected a lower-case address"),
  displayName: postgresText(1, 100),
  dailyLimit: dailyCapSchema,
  sealedRefreshToken: z.string().regex(/^zsg1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,2800}$/, "Expected a sealed token"),
  grantedScopes: z.array(postgresText(1, 200)).min(1).max(10),
});
export const connectOutreachMailboxCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(OUTREACH_MAILBOX_CONNECT_ACTION),
  target: targetSchema.extend({ type: z.literal(OUTREACH_MAILBOX_TARGET) }),
  payload: connectOutreachMailboxInputSchema,
}).refine((command) => command.target.id === command.payload.mailboxId, "Target must be the mailbox"));
export const disconnectOutreachMailboxInputSchema = z.strictObject({ mailboxId: idSchema });
export const disconnectOutreachMailboxCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(OUTREACH_MAILBOX_DISCONNECT_ACTION),
  target: targetSchema.extend({ type: z.literal(OUTREACH_MAILBOX_TARGET) }),
  payload: disconnectOutreachMailboxInputSchema,
}).refine((command) => command.target.id === command.payload.mailboxId, "Target must be the mailbox"));

// Records the owner reads (OS-22). No token, cursor or lease ever appears in one.
export const outreachMailboxRecordSchema = z.strictObject({
  id: idSchema,
  email: z.string(),
  displayName: z.string(),
  status: outreachMailboxStatusSchema,
  pausedUntil: instantSchema.nullable(),
  dailyLimit: z.number().int(),
  sendsToday: z.number().int().min(0),
});
export type OutreachMailboxRecord = z.infer<typeof outreachMailboxRecordSchema>;
export const outreachMailboxListSchema = z.strictObject({ items: z.array(outreachMailboxRecordSchema) });
export type OutreachMailboxList = z.infer<typeof outreachMailboxListSchema>;
export const connectOutreachMailboxResultSchema = z.strictObject({
  id: idSchema, email: z.string(), status: outreachMailboxStatusSchema,
});
export type ConnectOutreachMailboxResult = z.infer<typeof connectOutreachMailboxResultSchema>;

export const outreachStepRecordSchema = z.strictObject({
  stepNumber: z.number().int().min(1).max(OUTREACH_MAX_STEPS),
  delayBusinessDays: z.number().int(),
  subject: z.string().nullable(),
  body: z.string(),
});
export const outreachCampaignRecordSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  status: outreachCampaignStatusSchema,
  pausedReason: z.string().nullable(),
  window: outreachWindowSchema,
  dailyCapPerMailbox: z.number().int(),
  contentDigest: digestSchema,
  mailboxIds: z.array(idSchema),
  activationApprovalId: idSchema.nullable(),
  activatedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type OutreachCampaignRecord = z.infer<typeof outreachCampaignRecordSchema>;
export const outreachCampaignOutputSchema = z.lazy(() => actionResultSchema.extend({ result: outreachCampaignRecordSchema }));
export type OutreachCampaignOutput = z.infer<typeof outreachCampaignOutputSchema>;
export const outreachCampaignListSchema = z.strictObject({ items: z.array(outreachCampaignRecordSchema) });
export type OutreachCampaignList = z.infer<typeof outreachCampaignListSchema>;

export const outreachCampaignDetailSchema = z.strictObject({
  campaign: outreachCampaignRecordSchema,
  steps: z.array(outreachStepRecordSchema),
  /** Prospect counts by status; a status with none is absent. */
  prospectCounts: z.record(z.string(), z.number().int().min(0)),
  /** Today's counted sends per mailbox, in the tenant's time zone. */
  sendsToday: z.array(z.strictObject({ mailboxId: idSchema, count: z.number().int().min(0) })),
});
export type OutreachCampaignDetail = z.infer<typeof outreachCampaignDetailSchema>;

export const outreachProspectRecordSchema = z.strictObject({
  id: idSchema,
  campaignId: idSchema,
  mailboxId: idSchema,
  email: z.string(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  company: z.string(),
  industry: z.string().nullable(),
  website: z.string().nullable(),
  status: outreachProspectStatusSchema,
  nextStep: z.number().int().nullable(),
  nextDueOn: z.string().nullable(),
  stoppedAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type OutreachProspectRecord = z.infer<typeof outreachProspectRecordSchema>;
export const outreachProspectOutputSchema = z.lazy(() => actionResultSchema.extend({ result: outreachProspectRecordSchema }));
export type OutreachProspectOutput = z.infer<typeof outreachProspectOutputSchema>;

export const OUTREACH_PROSPECTS_PAGE_MAX = 200;
export const listOutreachProspectsQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(OUTREACH_PROSPECTS_PAGE_MAX).default(50),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/, "Not a page cursor").optional(),
  status: outreachProspectStatusSchema.optional(),
});
export type ListOutreachProspectsQuery = z.infer<typeof listOutreachProspectsQuerySchema>;
/** Keyset page: `nextCursor` is opaque; offset paging is not offered. */
export const outreachProspectPageSchema = pageSchema(outreachProspectRecordSchema);
export type OutreachProspectPage = z.infer<typeof outreachProspectPageSchema>;
