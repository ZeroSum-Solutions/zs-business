// Inbound email, slice 1 (docs/requirements/inbound-email.md IE-3, IE-4, IE-9, IE-17). The tenant
// comes only from a hub address in `to`, `cc` or `bcc`, looked up with inbound_email_route; each
// routed tenant's receive then runs in that tenant's own scope through the dispatcher, as a server
// principal that may run the inbound actions only. Original code.
import {
  ActionError,
  Conflict,
  IdempotencyConflict,
  INBOUND_EMAIL_IDEMPOTENCY_PREFIX,
  INBOUND_EMAIL_RECEIVE_ACTION,
  inboundEmailReceiveResultSchema,
  type ActionCommand,
} from "@zs/contracts";
import { inboundEmailId, OVER_ADMISSION } from "../inbound-email/actions.js";
import {
  collapseByTenant,
  inboundSubject,
  routeRecipients,
  senderAddress,
  type InboundEmailEvent,
  type RoutedRecipient,
} from "../inbound-email/routing.js";
import { only, toJson } from "./dispatch-util.js";
import { derivedId } from "./ids.js";
import { directDispatch, type EdgeDependencies } from "./session.js";

/** IE-9: the server principal; it may run the inbound actions and nothing else. */
export const inboundEmailActorId = (tenantId: string) => derivedId(tenantId, "inbound-email", "actor");

export interface InboundEmailSessionOptions {
  /** `INBOUND_EMAIL_DOMAIN`: only recipients at this domain route (IE-1, IE-3). */
  readonly domain: string;
}

/** What one tenant's receive did. IDs only: never an address, subject or body (IE-4). */
export type InboundTenantOutcome =
  | { readonly tenantId: string; readonly outcome: "received"; readonly inboundEmailId: string; readonly senderKey: string }
  /** A second event for one `email_id` that built another payload (an address retired in between): the row is already there. */
  | { readonly tenantId: string; readonly outcome: "already_received"; readonly inboundEmailId: string }
  /** IE-17: past the admission cap nothing is stored for that tenant. */
  | { readonly tenantId: string; readonly outcome: typeof OVER_ADMISSION };

export type InboundEmailOutcome =
  | { readonly handled: true; readonly tenants: readonly InboundTenantOutcome[]; readonly receivedForUnrouted: number }
  | { readonly handled: false; readonly reason: "unrouted"; readonly receivedForUnrouted: number }
  /** IE-8: a signed `email.received` whose sender cannot be read; answered 400 so Resend retries. */
  | { readonly handled: false; readonly reason: "malformed_event" };

interface Route {
  readonly tenantId: string;
  readonly addressId: string;
  readonly recipient: RoutedRecipient;
}

const isOverAdmission = (error: unknown) =>
  error instanceof Conflict && (error as ActionError).details?.reason === OVER_ADMISSION;

export function createInboundEmailSession(deps: EdgeDependencies, options: InboundEmailSessionOptions) {
  const domain = options.domain.trim().toLowerCase();

  /** IE-3: each distinct handle once, through the definer function; disabled and unknown handles return nothing. */
  async function lookUp(recipients: readonly RoutedRecipient[]): Promise<Route[]> {
    const handles = [...new Set(recipients.map((recipient) => recipient.handle))];
    if (handles.length === 0) return [];
    const found = await deps.db.withoutTenant(async (tx) => (await tx.query<{ handle: string; tenant_id: string; address_id: string }>(
      `SELECT h.handle, r.tenant_id, r.address_id
         FROM unnest($1::text[]) AS h(handle), LATERAL public.inbound_email_route(h.handle) r`,
      [handles])).rows);
    const byHandle = new Map(found.map((row) => [row.handle, row]));
    return recipients.flatMap((recipient) => {
      const row = byHandle.get(recipient.handle);
      return row ? [{ tenantId: row.tenant_id, addressId: row.address_id, recipient }] : [];
    });
  }

  async function receiveFor(route: Route, providerEmailId: string, fromAddress: string, subject: string | null): Promise<InboundTenantOutcome> {
    const { tenantId } = route;
    const id = inboundEmailId(tenantId, providerEmailId);
    const idempotencyKey = `${INBOUND_EMAIL_IDEMPOTENCY_PREFIX}${providerEmailId}`;
    const command: ActionCommand = {
      actionType: INBOUND_EMAIL_RECEIVE_ACTION,
      target: { tenantId, type: "inbound_email", id },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
      payload: toJson({
        inboundEmailId: id, provider: "resend", providerEmailId, addressId: route.addressId,
        replyRef: route.recipient.replyRef, fromAddress, subject,
      }),
    };
    const run = directDispatch(deps, tenantId, inboundEmailActorId(tenantId), only(INBOUND_EMAIL_RECEIVE_ACTION));
    try {
      const { result } = await run(command);
      const parsed = inboundEmailReceiveResultSchema.parse(result);
      return { tenantId, outcome: "received", inboundEmailId: parsed.inboundEmailId, senderKey: parsed.senderKey };
    } catch (error) {
      if (isOverAdmission(error)) return { tenantId, outcome: OVER_ADMISSION };
      // The key names the message: a stored receive with another payload means the row is already there.
      if (error instanceof IdempotencyConflict) return { tenantId, outcome: "already_received", inboundEmailId: id };
      throw error;
    }
  }

  return {
    /**
     * Routes one signed `email.received` and receives it once per routed tenant, in turn. A database
     * error propagates (the route answers 503 and Resend retries); tenants already received replay.
     */
    async receive(event: InboundEmailEvent): Promise<InboundEmailOutcome> {
      const routing = routeRecipients(event, domain);
      const routes = collapseByTenant(await lookUp(routing.recipients));
      // IE-4: mail with no routed recipient is acknowledged and leaves nothing, whatever its sender says.
      if (routes.length === 0) return { handled: false, reason: "unrouted", receivedForUnrouted: routing.receivedForUnrouted };
      // IE-8: routed mail whose sender cannot be read is a 400, so Resend shows it failed and retries.
      const fromAddress = senderAddress(event.data.from);
      if (fromAddress === null) return { handled: false, reason: "malformed_event" };
      const subject = inboundSubject(event.data.subject);
      // Every routed tenant is tried, even after one fails, so one tenant's fault never holds back another's
      // mail. Then the first failure propagates (503 or 500) and Resend retries; the tenants stored replay.
      const tenants: InboundTenantOutcome[] = [];
      let failure: { readonly error: unknown } | null = null;
      for (const route of routes) {
        try {
          tenants.push(await receiveFor(route, event.data.email_id, fromAddress, subject));
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
      return { handled: true, tenants, receivedForUnrouted: routing.receivedForUnrouted };
    },
  };
}
export type InboundEmailSession = ReturnType<typeof createInboundEmailSession>;
