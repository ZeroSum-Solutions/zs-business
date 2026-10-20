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

/** W-10: what a token may propose; nothing a token holds can read or act. */
export const AUTOMATION_SCOPES = Object.freeze(["contacts:propose", "deals:propose", "bookings:propose"] as const);
export const automationScopeSchema = z.enum(AUTOMATION_SCOPES);
export type AutomationScope = z.infer<typeof automationScopeSchema>;
export const createAutomationTokenRequestSchema = z.strictObject({
  name: postgresText(1, 100),
  scopes: z.array(automationScopeSchema).min(1).max(AUTOMATION_SCOPES.length).refine(unique, "Scopes must not repeat"),
  expiresInDays: z.number().int().min(1).max(365).nullable().default(null),
});
export type CreateAutomationTokenRequest = z.input<typeof createAutomationTokenRequestSchema>;
export const createAutomationTokenCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal("automation.token.create"),
  target: targetSchema.extend({ type: z.literal("automation_token") }),
  payload: z.strictObject({
    tokenId: idSchema,
    name: postgresText(1, 100),
    scopes: z.array(automationScopeSchema).min(1).max(AUTOMATION_SCOPES.length).refine(unique, "Scopes must not repeat"),
    expiresInDays: z.number().int().min(1).max(365).nullable(),
  }),
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
const proposalMeta = {
  /** Shown to the owner beside the exact action (approvals.md A-12). */
  summary: postgresText(1, 500).optional(),
  expiresInMinutes: z.number().int().min(1).max(43_200).default(10_080),
};
export const proposalRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("contact.upsert"), input: contactInputSchema, ...proposalMeta }),
  z.strictObject({ action: z.literal("deal.create"), input: createDealRequestSchema, ...proposalMeta }),
  z.strictObject({
    action: z.literal("deal.move_stage"),
    input: z.strictObject({ dealId: idSchema, ...moveDealStageRequestSchema.shape }),
    ...proposalMeta,
  }),
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
  name: z.string(),
  scopes: z.array(automationScopeSchema),
  expiresAt: instantSchema.nullable(),
});
export type AutomationWhoAmI = z.infer<typeof automationWhoAmISchema>;
