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
  type ProposalRecord,
} from "@zs/contracts";
import { readClock } from "../booking/slots.js";
import { loadApproval } from "../approvals/records.js";
import { Unauthenticated } from "../edge/errors.js";
import { derivedId } from "../edge/ids.js";
import { directDispatch, parseInput, type Authorize, type EdgeDependencies } from "../edge/session.js";
import { CREATE_PROPOSAL_ACTION, proposalRecord } from "./handlers.js";
import { verifyAutomationToken, type AutomationKeySecrets } from "./keys.js";
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

/** W-11: the token principal may write proposals and nothing else. */
const proposalOnly: Authorize = async (_tx, binding) => {
  if (binding.actionType !== CREATE_PROPOSAL_ACTION) throw new TenantDenied();
};

const INVALID_TOKEN = "Invalid or missing automation token";

/** A one-line description of the proposed action, for the owner's approval list (approvals.md A-12). */
function describe(action: string, input: Record<string, unknown>, tokenName: string): string {
  const what = {
    "contact.upsert": `add or find the customer ${String(input.email ?? input.phone ?? "")}`,
    "deal.create": `create the deal "${String(input.title ?? "")}"`,
    "deal.move_stage": "move a deal to another stage",
    "booking.create": `book ${String(input.startsAt ?? "")}`,
  }[action] ?? action;
  return `Activepieces (${tokenName}) proposes to ${what}`.slice(0, 500);
}

export function createAutomationInbound(deps: EdgeDependencies, config: { readonly keySecrets: AutomationKeySecrets }) {
  const now = () => new Date(readClock(deps.clock));

  return {
    /** W-9: `Authorization: Bearer zsap1_…`; every failure is the same 401. */
    async authenticate(header: string | undefined): Promise<AutomationPrincipal> {
      const match = /^Bearer (zsap1_[A-Za-z0-9_-]{86})$/.exec(header ?? "");
      const ref = match ? verifyAutomationToken(config.keySecrets, match[1]!) : null;
      if (!ref) throw new Unauthenticated(INVALID_TOKEN);
      const at = now();
      const row = await deps.db.tenant(ref.tenantId, (tx) => loadToken(tx, ref.tenantId, ref.tokenId));
      if (!row || !tokenActive(row, at)) throw new Unauthenticated(INVALID_TOKEN);
      return {
        tenantId: ref.tenantId, tokenId: ref.tokenId, actorId: automationActorId(ref.tenantId, ref.tokenId),
        name: row.name, scopes: [...row.scopes], expiresAt: row.expires_at,
      };
    },

    /** For a flow's connection test: which token this is and what it may propose. */
    whoAmI: (principal: AutomationPrincipal): AutomationWhoAmI => parseInput(automationWhoAmISchema, {
      tokenId: principal.tokenId, name: principal.name, scopes: [...principal.scopes],
      expiresAt: principal.expiresAt?.toISOString() ?? null,
    }, "result"),

    /**
     * W-12: one proposal per flow key. The target and approval IDs derive from the token and the
     * key, so a flow that retries gets the same proposal back, and two tokens never collide.
     */
    async propose(principal: AutomationPrincipal, body: unknown, rawKey: unknown): Promise<ProposalRecord> {
      const request = parseInput(proposalRequestSchema, body);
      const flowKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
      const { tenantId, tokenId, actorId } = principal;
      const { actionType, scope } = PROPOSAL_ACTIONS[request.action as keyof typeof PROPOSAL_ACTIONS];
      if (!principal.scopes.includes(scope)) throw new TenantDenied();
      const key = `activepieces:${derivedId(tenantId, tokenId, flowKey)}`;
      const input = request.input as Record<string, JsonValue>;
      const minted = (type: string) => derivedId(tenantId, key, type);
      const action = (() => {
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
            return { target: { type: "deal", id }, payload: { dealId: id, ...input } };
          }
          case "deal.move_stage":
            return { target: { type: "deal", id: String(input.dealId) }, payload: { ...input } };
          default: {
            const id = minted("booking");
            return { target: { type: "booking", id }, payload: { bookingId: id, ...input } };
          }
        }
      })();
      const proposalId = derivedId(tenantId, key, "approval-record");
      const output = await directDispatch(deps, tenantId, actorId, proposalOnly)({
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

    /** W-13: a token reads the proposals it made, and no others. */
    async getProposal(principal: AutomationPrincipal, proposalId: unknown): Promise<ProposalRecord> {
      const id = parseInput(uuidSchema, proposalId, "proposal ID");
      const at = now();
      const row = await deps.db.tenant(principal.tenantId, (tx) => loadApproval(tx, principal.tenantId, id));
      if (!row || row.requested_by !== principal.actorId) throw new NotFound();
      return parseInput(proposalRecordSchema, proposalRecord(row, at), "result");
    },
  };
}
export type AutomationInbound = ReturnType<typeof createAutomationInbound>;
