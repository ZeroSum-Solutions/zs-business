import { z } from "zod";
import { actionCommandSchema, targetSchema, uuidSchema } from "./index.js";

// Managed-tier connections (docs/requirements/connections.md). Root re-exports this module, so
// shared root schemas are reached lazily, as in calendar.ts. No Composio slug or ID a caller
// could pass back lives here: callers see our connection IDs and our tool names (C-1, C-6).
const idSchema = z.lazy(() => uuidSchema);
const instantSchema = z.iso.datetime({ precision: 3 });

export const CONNECTION_CONNECT_ACTION = "connection.connect";
export const CONNECTION_DISCONNECT_ACTION = "connection.disconnect";
/** The event the disconnect action commits with the state change (C-13). */
export const CONNECTION_DISCONNECT_REQUESTED_EVENT = "connection.disconnect_requested";
export const CONNECTION_CONNECTED_EVENT = "connection.connected";

/** C-4: the toolkit in a URL, and the only shop address form the pilot accepts. */
export const toolkitSchema = z.string().regex(/^[a-z0-9_-]{1,40}$/);
/** Trimmed and lower-cased before the pattern, so every side compares one spelling. */
export const shopDomainSchema = z.string().max(200).trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/);
/** C-14: 1..120 characters (code points, as `normalizeAccountLabel` cuts and Postgres counts). */
export const accountLabelSchema = z.string().max(480).refine((value) => {
  const length = [...value].length;
  return length >= 1 && length <= 120;
}, "A label is 1 to 120 characters");
/** The SHA-256 (base64url) of the dashboard's browser key (G-1). */
const browserBindingSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** C-4, C-5: headers between the dashboard and the API (lower case, as HTTP delivers them). */
export const CONNECT_ATTEMPT_HEADER = "x-zs-connect-attempt";
export const CONNECT_GRANT_HEADER = "x-zs-connect-grant";
/** The browser key travels in calendar.ts's CONNECT_BROWSER_KEY_HEADER (`x-zs-browser-key`). */
export const CONNECT_ATTEMPT_PATTERN = /^zca1\.[A-Za-z0-9_-]{1,2400}\.[A-Za-z0-9_-]{43}$/;
export const CONNECT_GRANT_PATTERN = /^zcg1\.[A-Za-z0-9_-]{1,2800}\.[A-Za-z0-9_-]{43}$/;
/** C-5: why the callback or its status call ended without a connection. */
export const CONNECT_ERROR_REASONS = Object.freeze([
  "invalid_attempt", "browser_mismatch", "attempt_changed", "forbidden", "rate_limited", "conflict", "not_connected", "expired", "provider_unavailable",
] as const);
export const connectErrorReasonSchema = z.enum(CONNECT_ERROR_REASONS);
export type ConnectErrorReason = z.infer<typeof connectErrorReasonSchema>;

const grantIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** C-4: POST /v1/connections/:toolkit/connect. */
export const connectConnectionRequestSchema = z.strictObject({
  shopDomain: shopDomainSchema,
  browserBinding: browserBindingSchema,
});
export type ConnectConnectionRequest = z.infer<typeof connectConnectionRequestSchema>;
export const connectConnectionResponseSchema = z.strictObject({ authorizeUrl: z.url({ protocol: /^https$/ }) });
export type ConnectConnectionResponse = z.infer<typeof connectConnectionResponseSchema>;

/** C-5: what the owner reviews before confirming. */
export const pendingConnectionSchema = z.strictObject({
  grantId: grantIdSchema,
  toolkit: toolkitSchema,
  shopDomain: shopDomainSchema,
  accountLabel: accountLabelSchema,
  expiresAt: instantSchema,
  tokensWithAccess: z.number().int().nonnegative(),
});
export type PendingConnection = z.infer<typeof pendingConnectionSchema>;
export const confirmConnectionRequestSchema = z.strictObject({ grantId: grantIdSchema });
export type ConfirmConnectionRequest = z.infer<typeof confirmConnectionRequestSchema>;

/** C-14: NFC; control, format and bidirectional characters removed; whitespace collapsed; 1..120 (longer is cut). */
export function normalizeAccountLabel(raw: string): string | null {
  // Remove first, compose last: a format character between a base and its mark would otherwise leave the result
  // decomposed after the strip, and a second pass would compose it (not idempotent).
  const label = raw.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    .replace(/[\p{Cc}\u2028\u2029]/gu, " ")
    .replace(/[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, "")
    .normalize("NFC")
    .replace(/\s+/gu, " ").trim();
  const cut = [...label].slice(0, 120).join("").trim().normalize("NFC");
  return cut.length > 0 ? cut : null;
}

/**
 * C-5: the payload the confirm handler builds from the staged grant; nothing here is client input. It
 * names no Composio account (C-1): the insert takes that from the worker's verified attempt (C-7).
 */
export const connectConnectionInputSchema = z.strictObject({
  connectionId: idSchema,
  toolkit: toolkitSchema,
  externalAccountId: z.string().min(1).max(64),
  accountDomain: shopDomainSchema,
  accountLabel: accountLabelSchema,
});
export type ConnectConnectionInput = z.infer<typeof connectConnectionInputSchema>;
export const connectConnectionCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CONNECTION_CONNECT_ACTION),
  target: targetSchema.extend({ type: z.literal("connection") }),
  payload: connectConnectionInputSchema,
}));
export const disconnectConnectionInputSchema = z.strictObject({ connectionId: idSchema });
export const disconnectConnectionCommandSchema = z.lazy(() => actionCommandSchema.extend({
  actionType: z.literal(CONNECTION_DISCONNECT_ACTION),
  target: targetSchema.extend({ type: z.literal("connection") }),
  payload: disconnectConnectionInputSchema,
}));

export const connectionStatusSchema = z.enum(["active", "reauthorize", "disconnecting", "disconnected"]);
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;
export const connectionReauthorizeReasonSchema = z.enum(["provider_status", "auth_error"]);

/** C-13: what an owner sees of a connection; never a Composio or external ID. */
export const connectionSchema = z.strictObject({
  id: idSchema,
  toolkit: toolkitSchema,
  accountLabel: z.string().nullable(),
  accountDomain: z.string(),
  status: connectionStatusSchema,
  reauthorizeReason: connectionReauthorizeReasonSchema.nullable(),
  /** True when the last revoke failed: the screen then tells the owner to remove the app in Shopify admin. */
  revokeFailed: z.boolean(),
  /**
   * True while the store's app permissions block the catalog reads (the provider answered 403 to the last run). The
   * connection stays `active`: reconnecting cannot fix it (C-8, C-10); the owner changes the app's permissions in the store.
   */
  readBlocked: z.boolean().default(false), // a result stored before this field existed replays as not blocked
  lastCheckedAt: instantSchema,
  createdAt: instantSchema,
});
export type Connection = z.infer<typeof connectionSchema>;
export const connectionListSchema = z.strictObject({ items: z.array(connectionSchema) });
export type ConnectionList = z.infer<typeof connectionListSchema>;

// C-6: the catalog as callers see it. Composio slugs and pinned versions stay in core.
export const SHOPIFY_TOOLKIT = "shopify";
export const SHOPIFY_LIST_ORDERS_TOOL = "shopify_list_orders";
export const SHOPIFY_GET_ORDER_TOOL = "shopify_get_order";
const MAX_RANGE_MS = 92 * 24 * 60 * 60 * 1000;

/** `shopify_list_orders`: at most 50 orders over a range of at most 92 days. */
export const shopifyListOrdersInputSchema = z.strictObject({
  createdAfter: instantSchema.optional(),
  createdBefore: instantSchema.optional(),
  status: z.enum(["open", "closed", "cancelled", "any"]).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).refine((value) => {
  if (!value.createdAfter || !value.createdBefore) return true;
  const span = Date.parse(value.createdBefore) - Date.parse(value.createdAfter);
  return span > 0 && span <= MAX_RANGE_MS;
}, "createdBefore must be after createdAfter, within 92 days");
export const shopifyGetOrderInputSchema = z.strictObject({ orderId: z.string().regex(/^[0-9]{1,20}$/) });
export const SHOPIFY_MAX_RANGE_MS = MAX_RANGE_MS;

export interface ConnectionToolInfo {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}
export interface ConnectionToolkitInfo {
  readonly toolkit: string;
  readonly displayName: string;
  /** Scopes the provider app is granted (C-6, C-11): shown on the confirm screen. */
  readonly providerScopes: readonly string[];
  readonly tools: readonly ConnectionToolInfo[];
}
export const CONNECTION_TOOLKITS: readonly ConnectionToolkitInfo[] = Object.freeze([Object.freeze({
  toolkit: SHOPIFY_TOOLKIT,
  displayName: "Shopify",
  // Recorded on preview, 2026-11-07 (C-17): the auth config `zs-business-preview-shopify` holds exactly `read_orders` (read
  // from Composio's API), and Shopify's consent screen worded it as "View customer data" and "View store data: Orders". An
  // earlier placeholder also listed `read_customers`; nothing granted it. Never list a scope the auth config does not hold.
  providerScopes: Object.freeze(["read_orders"]),
  tools: Object.freeze([
    Object.freeze({
      name: SHOPIFY_LIST_ORDERS_TOOL,
      description: "List up to 50 orders from the connected Shopify store, newest first, within a date range of at most 92 days. Read only.",
      inputSchema: shopifyListOrdersInputSchema,
    }),
    Object.freeze({
      name: SHOPIFY_GET_ORDER_TOOL,
      description: "Read one order from the connected Shopify store by its numeric ID. Read only.",
      inputSchema: shopifyGetOrderInputSchema,
    }),
  ]),
})]);
export const connectionToolkit = (toolkit: string): ConnectionToolkitInfo | undefined =>
  CONNECTION_TOOLKITS.find((entry) => entry.toolkit === toolkit);
/** C-14: shown on the confirm screen beside the provider scopes. */
export const CONNECTION_RETENTION_LINE =
  "Composio, our connection provider, keeps a log of what the agent asks for and what comes back for up to one year. Disconnecting stops our access and asks Shopify to remove the app's access.";

/** C-10: the error codes a tool result can carry; never provider text. */
export const CONNECTION_TOOL_ERROR_CODES = Object.freeze([
  "not_found", "invalid_arguments", "connection_needs_reconnect", "provider_rate_limited", "provider_unavailable", "provider_permission_denied",
] as const);
export const connectionToolErrorCodeSchema = z.enum(CONNECTION_TOOL_ERROR_CODES);
export type ConnectionToolErrorCode = z.infer<typeof connectionToolErrorCodeSchema>;
export const connectionToolErrorSchema = z.strictObject({
  error: z.strictObject({ code: connectionToolErrorCodeSchema, retryAfterSeconds: z.number().int().positive().max(86_400).optional() }),
});
export type ConnectionToolError = z.infer<typeof connectionToolErrorSchema>;

export const listConnectionsToolInputSchema = z.strictObject({});
export const listConnectionToolsInputSchema = z.strictObject({ connectionId: idSchema });
export const runConnectionToolInputSchema = z.strictObject({
  connectionId: idSchema,
  tool: z.string().min(1).max(40),
  arguments: z.record(z.string(), z.unknown()).default({}),
});
export type RunConnectionToolInput = z.infer<typeof runConnectionToolInputSchema>;
/** C-10: the data is at most 64 KiB of JSON; the notice is never trimmed. */
export const CONNECTION_RESULT_MAX_BYTES = 64 * 1024;
export const connectionToolResultSchema = z.strictObject({
  data: z.unknown(),
  truncated: z.boolean(),
  notice: z.string().min(1),
});
export type ConnectionToolResult = z.infer<typeof connectionToolResultSchema>;

// C-3: the worker's five internal operations. The API signs these bodies; the worker parses
// them again. Domain outcomes come back as 200 with an `outcome`; a refusal of the request
// itself (signature, shape) is a 4xx with no domain meaning.
export const connectorLinkRequestSchema = z.strictObject({
  tenantId: idSchema,
  toolkit: toolkitSchema,
  attemptId: idSchema,
  connectionId: idSchema,
  shopDomain: shopDomainSchema,
  createdBy: idSchema,
  browserHash: browserBindingSchema,
});
export const connectorLinkResponseSchema = z.strictObject({
  outcome: z.literal("linked"),
  redirectUrl: z.url({ protocol: /^https$/ }),
  composioAccountId: z.string().min(1).max(128),
  authConfigId: z.string().min(1).max(128),
  expiresAt: instantSchema,
}).or(z.strictObject({
  outcome: z.literal("refused"),
  code: z.enum(["provider_unavailable", "provider_rate_limited", "not_found"]),
  retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  /**
   * C-4: set only when the worker knows no provider account exists for this link (see `confirmedNothingCreated` in
   * worker.ts for the one allow-list). Absent means unknown, and the API keeps the connect charge.
   */
  nothingCreated: z.literal(true).optional(),
}));
export type ConnectorLinkResponse = z.infer<typeof connectorLinkResponseSchema>;

export const connectorCompleteRequestSchema = z.strictObject({
  tenantId: idSchema,
  attemptId: idSchema,
  /** Null on the status call, which repeats the account read without the redemption (C-5). */
  sessionUri: z.string().min(1).max(2048).nullable(),
});
export const connectorCompleteResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("verified"),
    composioAccountId: z.string().min(1).max(128),
    externalAccountId: z.string().min(1).max(64),
    accountDomain: shopDomainSchema,
    accountLabel: accountLabelSchema,
  }),
  z.strictObject({ outcome: z.literal("pending") }),
  z.strictObject({ outcome: z.literal("refused"), reason: connectErrorReasonSchema }),
]);
export type ConnectorCompleteResponse = z.infer<typeof connectorCompleteResponseSchema>;

export const connectorCancelRequestSchema = z.strictObject({ tenantId: idSchema, attemptId: idSchema });
/**
 * C-5: `cancelled` once the attempt can no longer connect and its account is gone (`revokeFailed`: the
 * revoke call failed, so the owner should check Shopify admin); `refused` when the account is not ours
 * to remove or the budget is spent (the attempt stays cancelling, for a retry or the sweep), or
 * `in_progress` while another cancel or the sweep is removing it (B-10: ask again after
 * `retryAfterSeconds`; the outcome is not known yet).
 */
export const connectorCancelResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("cancelled"), revokeFailed: z.boolean() }),
  z.strictObject({ outcome: z.literal("not_found") }),
  z.strictObject({
    outcome: z.literal("refused"),
    code: z.enum(["account_mismatch", "provider_rate_limited", "in_progress"]),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  }),
]);

export const connectorRunRequestSchema = z.strictObject({
  tenantId: idSchema,
  connectionId: idSchema,
  tool: z.string().min(1).max(40),
  arguments: z.record(z.string(), z.unknown()),
});
export const connectorRunResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("ok"), data: z.unknown(), truncated: z.boolean() }),
  z.strictObject({ outcome: z.literal("error"), code: connectionToolErrorCodeSchema, retryAfterSeconds: z.number().int().positive().max(86_400).optional() }),
]);
export type ConnectorRunResponse = z.infer<typeof connectorRunResponseSchema>;

export const connectorDisconnectRequestSchema = z.strictObject({ tenantId: idSchema, connectionId: idSchema });
export const connectorDisconnectResponseSchema = z.strictObject({ outcome: z.enum(["disconnected", "pending", "not_found"]) });
export const CONNECTOR_OPERATIONS = Object.freeze(["link", "complete", "cancel", "run", "disconnect"] as const);
export type ConnectorOperation = (typeof CONNECTOR_OPERATIONS)[number];
