// M5 Activepieces owner edge (activepieces.md W-1, W-2, W-5, W-9, W-14). Owners holding
// `integrations` manage receiver endpoints and automation tokens through the shared dispatcher.
// Secrets are derived, never stored: the edge computes an endpoint's signing secret and a
// token's text after the action commits, so a replay with the same key shows the same value.
import {
  automationTokenListSchema,
  automationTokenSchema,
  automationTokenWithSecretSchema,
  createAutomationTokenRequestSchema,
  createWebhookEndpointRequestSchema,
  idempotencyKeySchema,
  listWebhookDeliveriesQuerySchema,
  NotFound,
  replayWebhookDeliveryRequestSchema,
  revokeAutomationTokenRequestSchema,
  rotateWebhookSecretRequestSchema,
  TenantDenied,
  updateWebhookEndpointRequestSchema,
  uuidSchema,
  webhookDeliverySchema,
  webhookEndpointListSchema,
  webhookEndpointSchema,
  webhookEndpointWithSecretSchema,
  type AutomationToken,
  type JsonValue,
  type AutomationTokenList,
  type AutomationTokenWithSecret,
  type WebhookDelivery,
  type WebhookDeliveryPage,
  type WebhookEndpoint,
  type WebhookEndpointList,
  type WebhookEndpointWithSecret,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { readClock } from "../booking/slots.js";
import { derivedId } from "../edge/ids.js";
import { validationError } from "../edge/errors.js";
import { directDispatch, parseInput, type Authorize, type EdgeDependencies, type Principal } from "../edge/session.js";
import { requireMember } from "../members/access.js";
import {
  CREATE_ENDPOINT_ACTION,
  CREATE_TOKEN_ACTION,
  INTEGRATION_ACTIONS,
  REPLAY_DELIVERY_ACTION,
  REVOKE_TOKEN_ACTION,
  ROTATE_ENDPOINT_ACTION,
  UPDATE_ENDPOINT_ACTION,
} from "./handlers.js";
import { signAutomationToken, webhookSigningSecret, type AutomationKeySecrets } from "./keys.js";
import {
  DELIVERY_COLUMNS,
  deliveryRecord,
  ENDPOINT_COLUMNS,
  endpointRecord,
  loadEndpoint,
  TOKEN_COLUMNS,
  tokenRecord,
  type DeliveryRow,
  type EndpointRow,
  type TokenRow,
} from "./records.js";
import { webhookUrlProblem, type UrlPolicy } from "./transport.js";

export interface AutomationEdgeConfig {
  /** W-5, W-9: derives signing secrets and tokens; `previous` during a key rotation. */
  readonly keySecrets: AutomationKeySecrets;
  /** W-2: which receiver URLs may be saved. Loopback only in tests and local development. */
  readonly urlPolicy?: UrlPolicy;
}

/** W-1: integration actions run for a member holding `integrations`, and nothing else does. */
export function integrationsAuthorize(tenantId: string, actorId: string): Authorize {
  return async (tx, binding) => {
    if (!INTEGRATION_ACTIONS.includes(binding.actionType)) throw new TenantDenied();
    await requireMember(tx, tenantId, actorId, "integrations");
  };
}

export function createAutomationAdmin(deps: EdgeDependencies, config: AutomationEdgeConfig, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  const run = directDispatch(deps, tenantId, actorId, integrationsAuthorize(tenantId, actorId));
  const now = () => new Date(readClock(deps.clock));
  const read = <T>(work: (tx: Transaction) => Promise<T>) =>
    deps.db.tenant(tenantId, async (tx) => {
      await requireMember(tx, tenantId, actorId, "integrations");
      return work(tx);
    });
  /** Target and approval IDs derive from the key, so a replay rebuilds the stored command. */
  const envelope = (rawKey: unknown, type: string, targetId?: string) => {
    const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
    const id = targetId ?? derivedId(tenantId, idempotencyKey, type);
    return { id, target: { tenantId, type, id }, approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") }, idempotencyKey };
  };
  const checkUrl = (url: string | undefined) => {
    const problem = url === undefined ? null : webhookUrlProblem(url, config.urlPolicy);
    if (problem) throw validationError("Invalid request", [{ path: ["url"], message: `The URL is refused: ${problem}` }]);
  };
  const withSecret = (endpoint: WebhookEndpoint): WebhookEndpointWithSecret => parseInput(webhookEndpointWithSecretSchema, {
    endpoint,
    signingSecret: webhookSigningSecret(config.keySecrets.current, tenantId, endpoint.id, endpoint.secretVersion),
  }, "result");

  return {
    principal: { tenantId, actorId } as Principal,

    /** W-2, W-5: the signing secret is shown here and on rotation only. */
    async createEndpoint(body: unknown, key: unknown): Promise<WebhookEndpointWithSecret> {
      const request = parseInput(createWebhookEndpointRequestSchema, body);
      checkUrl(request.url);
      const { id, ...rest } = envelope(key, "webhook_endpoint");
      const output = await run({ actionType: CREATE_ENDPOINT_ACTION, ...rest, payload: { endpointId: id, ...request } });
      return withSecret(parseInput(webhookEndpointSchema, output.result, "result"));
    },
    listEndpoints: (): Promise<WebhookEndpointList> => read(async (tx) => {
      const at = now();
      const rows = (await tx.query<EndpointRow>(
        `SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints WHERE tenant_id=$1 ORDER BY created_at, id`, [tenantId])).rows;
      return parseInput(webhookEndpointListSchema, { items: rows.map((row) => endpointRecord(row, at)) }, "result");
    }),
    async updateEndpoint(endpointId: unknown, body: unknown, key: unknown): Promise<WebhookEndpoint> {
      const id = parseInput(uuidSchema, endpointId, "endpoint ID");
      const request = parseInput(updateWebhookEndpointRequestSchema, body);
      checkUrl(request.url);
      const { id: _id, ...rest } = envelope(key, "webhook_endpoint", id);
      const payload = Object.fromEntries(Object.entries({ endpointId: id, ...request })
        .filter(([, value]) => value !== undefined)) as { [key: string]: JsonValue };
      return parseInput(webhookEndpointSchema, (await run({ actionType: UPDATE_ENDPOINT_ACTION, ...rest, payload })).result, "result");
    },
    async rotateEndpointSecret(endpointId: unknown, body: unknown, key: unknown): Promise<WebhookEndpointWithSecret> {
      const id = parseInput(uuidSchema, endpointId, "endpoint ID");
      const request = parseInput(rotateWebhookSecretRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "webhook_endpoint", id);
      const output = await run({ actionType: ROTATE_ENDPOINT_ACTION, ...rest, payload: { endpointId: id, ...request } });
      return withSecret(parseInput(webhookEndpointSchema, output.result, "result"));
    },
    /** W-14: one endpoint's deliveries, newest first. */
    listDeliveries: (endpointId: unknown, query: unknown): Promise<WebhookDeliveryPage> => {
      const id = parseInput(uuidSchema, endpointId, "endpoint ID");
      const parsed = parseInput(listWebhookDeliveriesQuerySchema, query, "query");
      return read(async (tx) => {
        if (!(await loadEndpoint(tx, tenantId, id))) throw new NotFound();
        const rows = (await tx.query<DeliveryRow>(
          `SELECT ${DELIVERY_COLUMNS} FROM webhook_deliveries
            WHERE tenant_id=$1 AND endpoint_id=$2 AND ($3::text IS NULL OR status=$3)
            ORDER BY created_at DESC, id LIMIT $4 OFFSET $5`,
          [tenantId, id, parsed.status ?? null, parsed.limit + 1, parsed.offset])).rows;
        const more = rows.length > parsed.limit;
        return {
          items: rows.slice(0, parsed.limit).map(deliveryRecord),
          limit: parsed.limit,
          offset: parsed.offset,
          nextOffset: more ? parsed.offset + parsed.limit : null,
          nextCursor: null,
        };
      });
    },
    async replayDelivery(deliveryId: unknown, body: unknown, key: unknown): Promise<WebhookDelivery> {
      const id = parseInput(uuidSchema, deliveryId, "delivery ID");
      parseInput(replayWebhookDeliveryRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "webhook_delivery", id);
      return parseInput(webhookDeliverySchema,
        (await run({ actionType: REPLAY_DELIVERY_ACTION, ...rest, payload: { deliveryId: id } })).result, "result");
    },

    /** W-9: the token text is shown here only. */
    async createToken(body: unknown, key: unknown): Promise<AutomationTokenWithSecret> {
      const request = parseInput(createAutomationTokenRequestSchema, body);
      const { id, ...rest } = envelope(key, "automation_token");
      const token = parseInput(automationTokenSchema,
        (await run({ actionType: CREATE_TOKEN_ACTION, ...rest, payload: { tokenId: id, ...request } })).result, "result");
      return parseInput(automationTokenWithSecretSchema, {
        token, secret: signAutomationToken(config.keySecrets.current, { tenantId, tokenId: token.id }),
      }, "result");
    },
    listTokens: (): Promise<AutomationTokenList> => read(async (tx) => {
      const rows = (await tx.query<TokenRow>(
        `SELECT ${TOKEN_COLUMNS} FROM automation_tokens WHERE tenant_id=$1 ORDER BY created_at, id`, [tenantId])).rows;
      return parseInput(automationTokenListSchema, { items: rows.map(tokenRecord) }, "result");
    }),
    async revokeToken(tokenId: unknown, body: unknown, key: unknown): Promise<AutomationToken> {
      const id = parseInput(uuidSchema, tokenId, "token ID");
      parseInput(revokeAutomationTokenRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "automation_token", id);
      return parseInput(automationTokenSchema,
        (await run({ actionType: REVOKE_TOKEN_ACTION, ...rest, payload: { tokenId: id } })).result, "result");
    },
  };
}
export type AutomationAdmin = ReturnType<typeof createAutomationAdmin>;
