// M5 Activepieces inbound edge (activepieces.md W-9..W-13). An Activepieces flow holds one
// automation token. The token names its tenant and is checked against the server key before any
// database work, then against its row (revoked, expired) under that tenant's own scope. The
// principal the server builds may run one action: write a pending approval. It cannot read
// customers, approve, or act; an owner's approval runs the proposed action (approvals.md A-7).
import {
  automationWhoAmISchema,
  idempotencyKeySchema,
  NotFound,
  PROPOSAL_ACTIONS,
  proposalRecordSchema,
  proposalRequestSchema,
  TenantDenied,
  uuidSchema,
  type AutomationScope,
  type AutomationWhoAmI,
  type JsonValue,
  type ProposalAction,
  type ProposalRecord,
} from "@zs/contracts";
import { readClock } from "../booking/slots.js";
import { loadApproval } from "../approvals/records.js";
import { Unauthenticated } from "../edge/errors.js";
import { derivedId } from "../edge/ids.js";
import { directDispatch, parseInput, type Authorize, type EdgeDependencies } from "../edge/session.js";
import { CREATE_PROPOSAL_ACTION, proposalRecord } from "./handlers.js";
import { verifyAutomationToken, type AutomationKeySecrets } from "./keys.js";
import { guardToken, INVALID_TOKEN } from "./guard.js";
import { automationActorId, loadToken, tokenActive } from "./records.js";

/** A verified token. Never built from a request body. */
export interface AutomationPrincipal {
  readonly tenantId: string;
  readonly tokenId: string;
  readonly actorId: string;
  readonly name: string;
  readonly scopes: readonly AutomationScope[];
  readonly expiresAt: Date | null;
}

/**
 * W-11, H-3: the token principal may write proposals and nothing else, and only while its row says
 * so. This runs inside the dispatch transaction before the replay lookup, so a replayed proposal is
 * refused for a revoked token exactly as a fresh one is. The lock is exclusive (`update`): two
 * proposals of one token queue instead of deadlocking by upgrading a shared lock.
 */
const proposalAuthorize = (
  clock: { now(): Date },
  tokenId: string,
  scope: AutomationScope,
): Authorize => async (tx, binding) => {
  if (binding.actionType !== CREATE_PROPOSAL_ACTION) throw new TenantDenied();
  const { row } = await guardToken(tx, clock, binding.tenantId, tokenId, "update");
  if (!row.scopes.includes(scope)) throw new TenantDenied();
};

/**
 * A one-line description of the proposed action, for the owner's approval list (approvals.md A-12).
 * One canonical text for every transport (hub-access.md H-4): the same key and input sent by REST
 * and by MCP is the same proposal, so nothing here may depend on how the request arrived.
 */
function describe(action: ProposalAction, input: Record<string, unknown>, tokenName: string): string {
  const what = {
    "contact.upsert": `add or find the customer ${String(input.email ?? input.phone ?? "")}`,
    "deal.create": `create the deal "${String(input.title ?? "")}"`,
    "deal.move_stage": "move a deal to another stage",
    "booking.create": `book ${String(input.startsAt ?? "")}`,
  }[action];
  return `Automation token (${tokenName}) proposes to ${what}`.slice(0, 500);
}

export function createAutomationInbound(deps: EdgeDependencies, config: { readonly keySecrets: AutomationKeySecrets }) {
  const now = () => new Date(readClock(deps.clock));

  /**
   * W-9, H-5: the tag check alone. Pure CPU, no database access: it names the tenant and token a
   * request claims, or is the 401 an anonymous or forged caller gets before anything else.
   */
  const verifyTag = (header: string | undefined): { readonly tenantId: string; readonly tokenId: string } => {
    const match = /^Bearer (zsap1_[A-Za-z0-9_-]{86})$/.exec(header ?? "");
    const ref = match ? verifyAutomationToken(config.keySecrets, match[1]!) : null;
    if (!ref) throw new Unauthenticated(INVALID_TOKEN);
    return ref;
  };

  /**
   * W-9: the checked token row for a verified tag; a missing, revoked or expired token is the same
   * 401 as a bad tag. The /mcp edge calls verifyTag, the quota, then this (hub-access.md H-5).
   */
  const principalFor = async (ref: { readonly tenantId: string; readonly tokenId: string }): Promise<AutomationPrincipal> => {
    const row = await deps.db.tenant(ref.tenantId, (tx) => loadToken(tx, ref.tenantId, ref.tokenId));
    // The clock is read after the row is loaded, so a slow query counts toward expiry.
    if (!row || !tokenActive(row, now())) throw new Unauthenticated(INVALID_TOKEN);
    return {
      tenantId: ref.tenantId, tokenId: ref.tokenId, actorId: automationActorId(ref.tenantId, ref.tokenId),
      name: row.name, scopes: [...row.scopes], expiresAt: row.expires_at,
    };
  };

  return {
    verifyTag,
    principalFor,
    /** W-9: `Authorization: Bearer zsap1_…`; every failure is the same 401. */
    authenticate: async (header: string | undefined): Promise<AutomationPrincipal> => principalFor(verifyTag(header)),

    /**
     * For a flow's connection test: which token this is and what it may propose. H-3: it runs the
     * token guard, so a revoked or expired token is a 401 here too, and it answers from the
     * locked row, not from the principal built at authentication.
     */
    async whoAmI(principal: AutomationPrincipal): Promise<AutomationWhoAmI> {
      const { row } = await deps.db.tenant(principal.tenantId, (tx) =>
        guardToken(tx, deps.clock, principal.tenantId, principal.tokenId, "share"));
      return parseInput(automationWhoAmISchema, {
        tokenId: row.id, name: row.name, scopes: [...row.scopes], expiresAt: row.expires_at?.toISOString() ?? null,
      }, "result");
    },

    /**
     * W-12: one proposal per flow key. The target and approval IDs derive from the token and the
     * key, so a flow that retries gets the same proposal back, and two tokens never collide. The
     * summary and the derivation do not depend on the transport (hub-access.md H-4: the remote
     * MCP edge proposes through this same path). H-3: the token is locked and checked inside the
     * dispatch transaction, before the replay lookup (see proposalAuthorize).
     */
    async propose(principal: AutomationPrincipal, body: unknown, rawKey: unknown): Promise<ProposalRecord> {
      const request = parseInput(proposalRequestSchema, body);
      const flowKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
      const { tenantId, tokenId, actorId } = principal;
      const { actionType, scope } = PROPOSAL_ACTIONS[request.action];
      // A cheap refusal before any database work; the locked row inside the transaction decides.
      if (!principal.scopes.includes(scope)) throw new TenantDenied();
      const key = `activepieces:${derivedId(tenantId, tokenId, flowKey)}`;
      const input = request.input as Record<string, JsonValue>;
      const minted = (type: string) => derivedId(tenantId, key, type);
      const action = ((): { target: { type: string; id: string }; payload: Record<string, JsonValue> } => {
        switch (request.action) {
          case "contact.upsert": {
            const id = minted("contact");
            return { target: { type: "contact", id }, payload: {
              contactId: id, displayName: input.displayName ?? null, email: input.email ?? null, phone: input.phone ?? null,
              mode: "interactive", consent: { email: null, sms: null },
            } };
          }
          case "deal.create": {
            const id = minted("deal");
            return { target: { type: "deal", id }, payload: { ...input, dealId: id } };
          }
          case "deal.move_stage":
            return { target: { type: "deal", id: String(input.dealId) }, payload: { ...input } };
          case "booking.create": {
            const id = minted("booking");
            return { target: { type: "booking", id }, payload: { ...input, bookingId: id } };
          }
          default:
            return request satisfies never;
        }
      })();
      const proposalId = derivedId(tenantId, key, "approval-record");
      const output = await directDispatch(deps, tenantId, actorId, proposalAuthorize(deps.clock, tokenId, scope))({
        actionType: CREATE_PROPOSAL_ACTION,
        target: { tenantId, type: "approval", id: proposalId },
        approvalReference: { tenantId, id: derivedId(tenantId, key, "approval") },
        idempotencyKey: key,
        payload: {
          proposalId, tokenId,
          action: { actionType, ...action },
          summary: request.summary ?? describe(request.action, input, principal.name),
          expiresInMinutes: request.expiresInMinutes,
        },
      });
      return parseInput(proposalRecordSchema, output.result, "result");
    },

    /** W-13: a token reads the proposals it made, and no others. H-3: through the token guard. */
    async getProposal(principal: AutomationPrincipal, proposalId: unknown): Promise<ProposalRecord> {
      const id = parseInput(uuidSchema, proposalId, "proposal ID");
      return deps.db.tenant(principal.tenantId, async (tx) => {
        const { now } = await guardToken(tx, deps.clock, principal.tenantId, principal.tokenId, "share");
        const row = await loadApproval(tx, principal.tenantId, id);
        if (!row || row.requested_by !== principal.actorId) throw new NotFound();
        return parseInput(proposalRecordSchema, proposalRecord(row, now), "result");
      });
    },
  };
}
export type AutomationInbound = ReturnType<typeof createAutomationInbound>;
