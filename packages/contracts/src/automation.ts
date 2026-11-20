import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";
import { contactEmailInputSchema, contactPhoneSchema } from "./crm.js";
import { createBookingRequestSchema, createDealRequestSchema, moveDealStageRequestSchema } from "./http.js";
import { isPostgresText } from "./json.js";
import { pageQuerySchema, pageSchema } from "./page.js";

// M5 Activepieces (docs/requirements/activepieces.md W-1..W-16): outbound webhooks for business
// events and the narrow inbound endpoint that only proposes actions. Root re-exports this module,
// so shared root schemas are reached lazily, as in approvals.ts.
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });
const postgresText = (min: number, max: number) =>
  z.string().min(min).max(max).refine(isPostgresText, "Text is not valid in Postgres");
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/** W-3: the business events an endpoint may subscribe to. */
export const AUTOMATION_EVENT_TYPES = Object.freeze(["lead.created", "booking.created", "deal.won", "message.received"] as const);
export const automationEventTypeSchema = z.enum(AUTOMATION_EVENT_TYPES);
export type AutomationEventType = z.infer<typeof automationEventTypeSchema>;

/** W-2: the URL is the owner's; the server's URL policy (no private addresses) checks it again. */
export const webhookUrlSchema = z.url({ protocol: /^https?$/ }).max(2048)
  .refine((url) => !/[\s\u0000]/.test(url), "Invalid URL");
const eventListSchema = z.array(automationEventTypeSchema).min(1).max(AUTOMATION_EVENT_TYPES.length)
  .refine(unique, "Events must not repeat");

export const createWebhookEndpointRequestSchema = z.strictObject({
  url: webhookUrlSchema,
  events: eventListSchema,
  description: postgresText(1, 200).nullable().default(null),
});
export type CreateWebhookEndpointRequest = z.input<typeof createWebhookEndpointRequestSchema>;
export const updateWebhookEndpointRequestSchema = z.strictObject({
  url: webhookUrlSchema.optional(),
  events: eventListSchema.optional(),
  description: postgresText(1, 200).nullable().optional(),
  enabled: z.boolean().optional(),
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1),
});
export type UpdateWebhookEndpointRequest = z.infer<typeof updateWebhookEndpointRequestSchema>;
/** W-5: 0 retires the old secret at once (a leak); otherwise it keeps signing for the grace. */
export const WEBHOOK_ROTATION_DEFAULT_MINUTES = 1440;
export const rotateWebhookSecretRequestSchema = z.strictObject({
  graceMinutes: z.number().int().min(0).max(10_080).default(WEBHOOK_ROTATION_DEFAULT_MINUTES),
});
export type RotateWebhookSecretRequest = z.input<typeof rotateWebhookSecretRequestSchema>;

const endpointFields = {
  endpointId: idSchema,
  url: webhookUrlSchema,
  events: eventListSchema,
  description: postgresText(1, 200).nullable(),
};
export const createWebhookEndpointCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("webhook.endpoint.create"),
  target: targetSchema.extend({ type: z.literal("webhook_endpoint") }),
  payload: z.strictObject(endpointFields),
}).refine((command) => command.target.id === command.payload.endpointId, "Target must equal the endpoint ID"));
export const updateWebhookEndpointCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("webhook.endpoint.update"),
  target: targetSchema.extend({ type: z.literal("webhook_endpoint") }),
  payload: updateWebhookEndpointRequestSchema.extend({ endpointId: idSchema }),
}).refine((command) => command.target.id === command.payload.endpointId, "Target must equal the endpoint ID"));
export const rotateWebhookSecretCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("webhook.endpoint.rotate"),
  target: targetSchema.extend({ type: z.literal("webhook_endpoint") }),
  payload: z.strictObject({ endpointId: idSchema, graceMinutes: z.number().int().min(0).max(10_080) }),
}).refine((command) => command.target.id === command.payload.endpointId, "Target must equal the endpoint ID"));
export const replayWebhookDeliveryCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("webhook.delivery.replay"),
  target: targetSchema.extend({ type: z.literal("webhook_delivery") }),
  payload: z.strictObject({ deliveryId: idSchema }),
}).refine((command) => command.target.id === command.payload.deliveryId, "Target must equal the delivery ID"));

export const webhookEndpointSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  url: z.string(),
  events: z.array(automationEventTypeSchema),
  description: z.string().nullable(),
  enabled: z.boolean(),
  revision: z.number().int().min(1),
  secretVersion: z.number().int().min(1),
  /** W-5: until when the previous secret still signs, or null. */
  previousSecretValidUntil: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type WebhookEndpoint = z.infer<typeof webhookEndpointSchema>;
/** W-5: the signing secret is shown on create and rotate only. */
export const webhookEndpointWithSecretSchema = z.strictObject({
  endpoint: webhookEndpointSchema,
  signingSecret: z.string().regex(/^whsec_[A-Za-z0-9+/]{43}=$/),
});
export type WebhookEndpointWithSecret = z.infer<typeof webhookEndpointWithSecretSchema>;
export const webhookEndpointListSchema = z.strictObject({ items: z.array(webhookEndpointSchema) });
export type WebhookEndpointList = z.infer<typeof webhookEndpointListSchema>;

export const webhookDeliveryStatusSchema = z.enum(["pending", "leased", "delivered", "dead"]);
export type WebhookDeliveryStatus = z.infer<typeof webhookDeliveryStatusSchema>;
export const webhookDeliveryFinalReasonSchema = z.enum([
  "max_attempts", "endpoint_gone", "endpoint_disabled", "url_refused", "worker_error", "approval_withdrawn",
]);
export type WebhookDeliveryFinalReason = z.infer<typeof webhookDeliveryFinalReasonSchema>;
export const webhookDeliverySchema = z.strictObject({
  id: idSchema,
  endpointId: idSchema,
  /** The `webhook-id` header: the same on every attempt and replay (W-8). */
  eventId: z.string(),
  eventType: automationEventTypeSchema,
  status: webhookDeliveryStatusSchema,
  attempts: z.number().int().min(0),
  nextAttemptAt: instantSchema,
  lastStatusCode: z.number().int().nullable(),
  lastError: z.string().nullable(),
  finalReason: webhookDeliveryFinalReasonSchema.nullable(),
  deliveredAt: instantSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type WebhookDelivery = z.infer<typeof webhookDeliverySchema>;
export const listWebhookDeliveriesQuerySchema = pageQuerySchema.omit({ cursor: true }).extend({
  status: webhookDeliveryStatusSchema.optional(),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesQuerySchema>;
export const webhookDeliveryPageSchema = pageSchema(webhookDeliverySchema);
export type WebhookDeliveryPage = z.infer<typeof webhookDeliveryPageSchema>;
export const replayWebhookDeliveryRequestSchema = z.strictObject({});

/** W-10: what a token may propose. */
export const PROPOSE_SCOPES = Object.freeze(["contacts:propose", "deals:propose", "bookings:propose"] as const);
/** hub-access.md H-2: what a token may read. Operation scopes, not field filters. */
export const READ_SCOPES = Object.freeze([
  "contacts:read", "deals:read", "bookings:read", "inbox:read", "results:read", "business:read", "connections:read",
] as const);
/** hub-access.md H-13: act on the sites named at creation (publish, roll back, sync). Not a read scope. */
export const SITE_SCOPES = Object.freeze(["sites:publish"] as const);
export const AUTOMATION_SCOPES = Object.freeze([...PROPOSE_SCOPES, ...READ_SCOPES, ...SITE_SCOPES] as const);
export const automationScopeSchema = z.enum(AUTOMATION_SCOPES);
export type AutomationScope = z.infer<typeof automationScopeSchema>;
export const readScopeSchema = z.enum(READ_SCOPES);
export type ReadScope = z.infer<typeof readScopeSchema>;
export const hasReadScope = (scopes: readonly AutomationScope[]) => scopes.some((scope) => (READ_SCOPES as readonly string[]).includes(scope));
export const hasSiteScope = (scopes: readonly AutomationScope[]) => scopes.some((scope) => (SITE_SCOPES as readonly string[]).includes(scope));
/** H-1, H-13: a token with a read scope or `sites:publish` always expires. */
export const scopesNeedExpiry = (scopes: readonly AutomationScope[]) => hasReadScope(scopes) || hasSiteScope(scopes);
/** H-14: the most sites one token may name. */
export const MAX_TOKEN_SITES = 10;

/** hub-access.md "What each read scope discloses": the text an owner sees when choosing scopes. */
export const READ_SCOPE_DISCLOSURES: Readonly<Record<ReadScope, string>> = Object.freeze({
  "contacts:read": "Customer names, emails, phones, marketing consent.",
  "deals:read": "Deal titles, values, stages, lead sources and their contacts.",
  "bookings:read": "Bookings with times, resources and the linked customer's name and ID.",
  "inbox:read": "Website requests and replies with customer identities and message text, and the names and emails of staff who replied.",
  "results:read": "Lead, booking and revenue totals by source.",
  "business:read": "The business profile (name, contact details, address, currency, zone).",
  // connections.md C-11: every store the business connects now or later, not only the ones connected today.
  "connections:read": "Orders from every store the business connects, now or later: customer names and emails, line items and totals.",
});

/** hub-access.md H-13: the text an owner sees beside `sites:publish`. */
export const SITE_SCOPE_DISCLOSURES: Readonly<Record<(typeof SITE_SCOPES)[number], string>> = Object.freeze({
  "sites:publish": "Publish and roll back the named sites. Cannot read customers.",
});

/** One-line meaning of each propose scope, beside the read disclosures (hub-access.md H-9). */
export const PROPOSE_SCOPE_DESCRIPTIONS: Readonly<Record<(typeof PROPOSE_SCOPES)[number], string>> = Object.freeze({
  "contacts:propose": "Propose adding a customer; an owner approves before anything is created. Reads nothing.",
  "deals:propose": "Propose creating a deal or moving it to another stage; an owner approves. Reads nothing.",
  "bookings:propose": "Propose a booking on a resource; an owner approves. Reads nothing.",
});
/** H-9: every scope with the text an owner sees when choosing scopes. */
export const automationScopeInfoSchema = z.strictObject({
  scope: automationScopeSchema,
  kind: z.enum(["propose", "read", "publish"]),
  disclosure: z.string().min(1).max(500),
});
export const automationScopeListSchema = z.strictObject({ items: z.array(automationScopeInfoSchema) });
export type AutomationScopeList = z.infer<typeof automationScopeListSchema>;
export const AUTOMATION_SCOPE_INFO: AutomationScopeList = Object.freeze({
  items: AUTOMATION_SCOPES.map((scope) => {
    if (scope === "sites:publish") return { scope, kind: "publish" as const, disclosure: SITE_SCOPE_DISCLOSURES[scope] };
    return scope.endsWith(":read")
      ? { scope, kind: "read" as const, disclosure: READ_SCOPE_DISCLOSURES[scope as ReadScope] }
      : { scope, kind: "propose" as const, disclosure: PROPOSE_SCOPE_DESCRIPTIONS[scope as (typeof PROPOSE_SCOPES)[number]] };
  }),
});

/** H-1, H-13: a token with a read scope or `sites:publish` expires in 1 to 365 days; the request default is 90. */
export const READ_TOKEN_DEFAULT_DAYS = 90;
const expiryDaysSchema = z.number().int().min(1).max(365);
const scopeListSchema = z.array(automationScopeSchema).min(1).max(AUTOMATION_SCOPES.length).refine(unique, "Scopes must not repeat");
const readNeedsExpiry = (value: { scopes: readonly AutomationScope[]; expiresInDays: number | null }) =>
  !scopesNeedExpiry(value.scopes) || value.expiresInDays !== null;
const READ_EXPIRY_MESSAGE = "A token with a read scope or sites:publish needs an expiry of 1 to 365 days";
/** H-14: 1 to 10 distinct sites, with `sites:publish` and only then. */
const siteIdListSchema = z.array(idSchema).max(MAX_TOKEN_SITES).refine(unique, "Sites must not repeat");
const SITE_IDS_MESSAGE = "siteIds (1 to 10 sites) are required with sites:publish and refused without it";
const siteIdsMatchScopes = (value: { scopes: readonly AutomationScope[]; siteIds?: readonly string[] | undefined }) =>
  hasSiteScope(value.scopes) ? (value.siteIds?.length ?? 0) >= 1 : value.siteIds === undefined;
export const createAutomationTokenRequestSchema = z.strictObject({
  name: postgresText(1, 100),
  scopes: scopeListSchema,
  /** Left out: 90 days when the token holds a read scope or sites:publish, else no expiry (W-9). An explicit null is refused for those. */
  expiresInDays: expiryDaysSchema.nullable().optional(),
  /** H-14: the sites `sites:publish` acts on. Required with that scope, refused without it. */
  siteIds: siteIdListSchema.optional(),
}).refine((value) => value.expiresInDays !== null || !scopesNeedExpiry(value.scopes), {
  message: READ_EXPIRY_MESSAGE, path: ["expiresInDays"],
}).refine(siteIdsMatchScopes, { message: SITE_IDS_MESSAGE, path: ["siteIds"] })
  .transform((value) => ({
  name: value.name,
  scopes: value.scopes,
  expiresInDays: value.expiresInDays ?? (scopesNeedExpiry(value.scopes) ? READ_TOKEN_DEFAULT_DAYS : null),
  siteIds: value.siteIds ?? [],
}));
export type CreateAutomationTokenRequest = z.input<typeof createAutomationTokenRequestSchema>;
export const createAutomationTokenCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("automation.token.create"),
  target: targetSchema.extend({ type: z.literal("automation_token") }),
  payload: z.strictObject({
    tokenId: idSchema,
    name: postgresText(1, 100),
    scopes: scopeListSchema,
    expiresInDays: expiryDaysSchema.nullable(),
    /** Absent in an action stored before revision 4: a token without sites. */
    siteIds: siteIdListSchema.default([]),
  }).refine(readNeedsExpiry, { message: READ_EXPIRY_MESSAGE, path: ["expiresInDays"] })
    .refine((value) => hasSiteScope(value.scopes) ? value.siteIds.length >= 1 : value.siteIds.length === 0, { message: SITE_IDS_MESSAGE, path: ["siteIds"] }),
}).refine((command) => command.target.id === command.payload.tokenId, "Target must equal the token ID"));
export const revokeAutomationTokenCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("automation.token.revoke"),
  target: targetSchema.extend({ type: z.literal("automation_token") }),
  payload: z.strictObject({ tokenId: idSchema }),
}).refine((command) => command.target.id === command.payload.tokenId, "Target must equal the token ID"));
export const revokeAutomationTokenRequestSchema = z.strictObject({});

export const automationTokenSchema = z.strictObject({
  id: idSchema,
  tenantId: idSchema,
  name: z.string(),
  scopes: z.array(automationScopeSchema),
  /** H-14: the sites `sites:publish` acts on; empty for a token without that scope (and for a result stored before revision 4). */
  siteIds: z.array(idSchema).default([]),
  /** The actor the token's proposals carry as `requestedBy` (W-11). */
  actorId: idSchema,
  createdBy: idSchema,
  createdAt: instantSchema,
  expiresAt: instantSchema.nullable(),
  revokedAt: instantSchema.nullable(),
  revokedBy: idSchema.nullable(),
});
export type AutomationToken = z.infer<typeof automationTokenSchema>;
/** W-9: the token text is shown on create only. */
export const automationTokenWithSecretSchema = z.strictObject({
  token: automationTokenSchema,
  secret: z.string().regex(/^zsap1_[A-Za-z0-9_-]{86}$/),
});
export type AutomationTokenWithSecret = z.infer<typeof automationTokenWithSecretSchema>;
export const automationTokenListSchema = z.strictObject({ items: z.array(automationTokenSchema) });
export type AutomationTokenList = z.infer<typeof automationTokenListSchema>;

/**
 * W-12: what a flow may propose. Inputs are the member request bodies; a contact proposal
 * carries no consent evidence (an automation cannot attest that a person agreed).
 */
const contactInputSchema = z.strictObject({
  displayName: postgresText(1, 200).nullable().default(null),
  email: contactEmailInputSchema.nullable().default(null),
  phone: contactPhoneSchema.nullable().default(null),
}).refine((value) => value.email !== null || value.phone !== null, "At least one identity is required");
/** Shown to the owner beside the exact action (approvals.md A-12); the MCP tools reuse it. */
export const proposalSummarySchema = postgresText(1, 500);
const proposalMeta = {
  summary: proposalSummarySchema.optional(),
  expiresInMinutes: z.number().int().min(1).max(43_200).default(10_080),
};
/** The `input` of each proposal: the member request body of the action (hub-access.md H-6 reuses these). */
const moveStageInputSchema = z.strictObject({ dealId: idSchema, ...moveDealStageRequestSchema.shape });
export const proposalInputSchemas = {
  "contact.upsert": contactInputSchema,
  "deal.create": createDealRequestSchema,
  "deal.move_stage": moveStageInputSchema,
  "booking.create": createBookingRequestSchema,
} as const;
export const proposalRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("contact.upsert"), input: contactInputSchema, ...proposalMeta }),
  z.strictObject({ action: z.literal("deal.create"), input: createDealRequestSchema, ...proposalMeta }),
  z.strictObject({ action: z.literal("deal.move_stage"), input: moveStageInputSchema, ...proposalMeta }),
  z.strictObject({ action: z.literal("booking.create"), input: createBookingRequestSchema, ...proposalMeta }),
]);
export type ProposalRequest = z.input<typeof proposalRequestSchema>;
export const PROPOSAL_ACTIONS = Object.freeze({
  "contact.upsert": { actionType: "crm.contact.create-or-find", scope: "contacts:propose" },
  "deal.create": { actionType: "crm.deal.create", scope: "deals:propose" },
  "deal.move_stage": { actionType: "crm.deal.move-stage", scope: "deals:propose" },
  "booking.create": { actionType: "booking.create", scope: "bookings:propose" },
} as const satisfies Record<string, { actionType: string; scope: AutomationScope }>);
export type ProposalAction = keyof typeof PROPOSAL_ACTIONS;

export const createProposalCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("automation.proposal.create"),
  target: targetSchema.extend({ type: z.literal("approval") }),
  payload: z.strictObject({
    proposalId: idSchema,
    tokenId: idSchema,
    action: z.strictObject({
      actionType: z.enum(["crm.contact.create-or-find", "crm.deal.create", "crm.deal.move-stage", "booking.create"]),
      target: z.strictObject({ type: z.string().min(1).max(100), id: idSchema }),
      payload: z.record(z.string(), z.unknown()),
    }),
    summary: postgresText(1, 500),
    expiresInMinutes: z.number().int().min(1).max(43_200),
  }),
}).refine((command) => command.target.id === command.payload.proposalId, "Target must equal the proposal ID"));

/** W-13: what a flow learns about its own proposal; nothing about who decided. */
export const proposalStandingSchema = z.enum(["pending", "approved", "rejected", "revoked", "expired"]);
export const proposalRecordSchema = z.strictObject({
  id: idSchema,
  action: z.enum(["contact.upsert", "deal.create", "deal.move_stage", "booking.create"]),
  target: z.strictObject({ type: z.string(), id: idSchema }),
  standing: proposalStandingSchema,
  /** True once the approved action has committed. A proposal is never a booking until then. */
  executed: z.boolean(),
  requestedAt: instantSchema,
  expiresAt: instantSchema,
  decidedAt: instantSchema.nullable(),
});
export type ProposalRecord = z.infer<typeof proposalRecordSchema>;
export const automationWhoAmISchema = z.strictObject({
  tokenId: idSchema,
  /** W-13 amendment (revision 4): the token's own tenant and the sites it names. */
  tenantId: idSchema,
  name: z.string(),
  scopes: z.array(automationScopeSchema),
  siteIds: z.array(idSchema),
  expiresAt: instantSchema.nullable(),
});
export type AutomationWhoAmI = z.infer<typeof automationWhoAmISchema>;

/**
 * hub-access.md H-8: what an owner reads of one token's use over the last 168 hours. One entry per
 * hour that saw a request, oldest first; `totals` adds them up.
 */
export const automationUsageHourSchema = z.strictObject({
  hour: instantSchema,
  requests: z.number().int().min(0),
  reads: z.number().int().min(0),
  proposals: z.number().int().min(0),
  refusals: z.number().int().min(0),
});
export type AutomationUsageHour = z.infer<typeof automationUsageHourSchema>;
export const automationUsageSchema = z.strictObject({
  tokenId: idSchema,
  from: instantSchema,
  to: instantSchema,
  hours: z.array(automationUsageHourSchema),
  totals: z.strictObject({
    requests: z.number().int().min(0),
    reads: z.number().int().min(0),
    proposals: z.number().int().min(0),
    refusals: z.number().int().min(0),
  }),
});
export type AutomationUsage = z.infer<typeof automationUsageSchema>;
