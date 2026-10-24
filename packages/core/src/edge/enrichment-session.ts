// Member-facing enrichment edge (enrichment.md E-4, E-6, E-7, E-17). Writes go through the shared
// dispatcher as the member; the config travels as dispatch config, never in a stored payload.
import {
  blockEnrichmentRequestSchema,
  contactEnrichmentSchema,
  enrichmentProposalListSchema,
  createEnrichmentRequestSchema,
  enrichmentRequestOutputSchema,
  enrichmentRequestRecordSchema,
  ENRICHMENT_REQUEST_TARGET,
  idempotencyKeySchema,
  NotFound,
  profileOutputSchema,
  roleCan,
  TenantDenied,
  uuidSchema,
  type ContactEnrichment,
  type EnrichmentProposalList,
  type EnrichmentRequestOutput,
  type EnrichmentRequestRecord,
  type ProfileOutput,
} from "@zs/contracts";
import { readClock } from "../booking/slots.js";
import type { EnrichmentConfigInput } from "../enrichment/config.js";
import {
  ENRICHMENT_BLOCK_ACTION,
  ENRICHMENT_REQUEST_ACTION,
  ENRICHMENT_UNBLOCK_ACTION,
  REGION_ATTEST_ACTION,
} from "../enrichment/handlers.js";
import { getContactEnrichment, getEnrichmentRequest, listEnrichmentProposals } from "../enrichment/reads.js";
import { requireMember } from "../members/access.js";
import { derivedId } from "./ids.js";
import { directDispatch, memberAuthorize, parseInput, type EdgeDependencies, type Principal } from "./session.js";

/** E-5: the actor the worker files approvals under; it is no member and holds no permission. */
export const enrichmentActorId = (tenantId: string): string => derivedId(tenantId, "enrichment", "actor");

export function createEnrichmentSession(deps: EdgeDependencies, principal: Principal, enrichment: EnrichmentConfigInput | undefined) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  const run = directDispatch(deps, tenantId, actorId, memberAuthorize(tenantId, actorId), enrichment ? { enrichment } : {});
  const envelope = (rawKey: unknown, type: string, targetId: string) => {
    const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
    return {
      target: { tenantId, type, id: targetId },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
    };
  };
  /** E-17: a read needs `enrich` or `customers`. */
  const readEnrichment = <T>(work: Parameters<typeof deps.db.tenant<T>>[1]) =>
    deps.db.tenant(tenantId, async (tx) => {
      const access = await requireMember(tx, tenantId, actorId, null);
      if (!roleCan(access.role, "enrich") && !roleCan(access.role, "customers")) throw new TenantDenied();
      return work(tx);
    });
  const contactId = (raw: unknown) => parseInput(uuidSchema, raw, "contact ID");

  return {
    /** E-4: the request ID derives from the key, so a retry replays the stored answer. */
    async requestEnrichment(body: unknown, key: unknown): Promise<EnrichmentRequestOutput> {
      const request = parseInput(createEnrichmentRequestSchema, body);
      const idempotencyKey = parseInput(idempotencyKeySchema, key, "Idempotency-Key");
      const requestId = derivedId(tenantId, idempotencyKey, ENRICHMENT_REQUEST_TARGET);
      return parseInput(enrichmentRequestOutputSchema, await run({
        actionType: ENRICHMENT_REQUEST_ACTION,
        ...envelope(idempotencyKey, ENRICHMENT_REQUEST_TARGET, requestId),
        payload: { requestId, op: request.op, contactId: request.contactId },
      }), "result");
    },
    async getRequest(rawId: unknown): Promise<EnrichmentRequestRecord> {
      const id = parseInput(uuidSchema, rawId, "request ID");
      const found = await readEnrichment((tx) => getEnrichmentRequest(tx, tenantId, id));
      if (!found) throw new NotFound();
      return parseInput(enrichmentRequestRecordSchema, found, "result");
    },
    async getContactEnrichment(rawId: unknown): Promise<ContactEnrichment> {
      const id = contactId(rawId);
      const now = new Date(readClock(deps.clock));
      const found = await readEnrichment((tx) => getContactEnrichment(tx, tenantId, id, now));
      if (!found) throw new NotFound();
      return parseInput(contactEnrichmentSchema, found, "result");
    },
    /** E-14: the pending proposals, each with the current and the found value. */
    async listProposals(): Promise<EnrichmentProposalList> {
      const now = new Date(readClock(deps.clock));
      const items = await readEnrichment((tx) => listEnrichmentProposals(tx, tenantId, now));
      return parseInput(enrichmentProposalListSchema, { items }, "result");
    },
    /** E-6: staff and owners may stop enrichment of a contact. */
    async block(rawId: unknown, body: unknown, key: unknown): Promise<ProfileOutput> {
      const id = contactId(rawId);
      const request = parseInput(blockEnrichmentRequestSchema, body);
      return parseInput(profileOutputSchema, await run({
        actionType: ENRICHMENT_BLOCK_ACTION, ...envelope(key, "contact", id), payload: { contactId: id, reason: request.reason },
      }), "result");
    },
    /** E-6: only an owner lifts it. */
    async unblock(rawId: unknown, key: unknown): Promise<ProfileOutput> {
      const id = contactId(rawId);
      return parseInput(profileOutputSchema, await run({
        actionType: ENRICHMENT_UNBLOCK_ACTION, ...envelope(key, "contact", id), payload: { contactId: id },
      }), "result");
    },
    /** E-7: an owner says this contact is outside the EU and UK. */
    async attestRegion(rawId: unknown, key: unknown): Promise<ProfileOutput> {
      const id = contactId(rawId);
      return parseInput(profileOutputSchema, await run({
        actionType: REGION_ATTEST_ACTION, ...envelope(key, "contact", id), payload: { contactId: id },
      }), "result");
    },
  };
}
export type EnrichmentSession = ReturnType<typeof createEnrichmentSession>;
