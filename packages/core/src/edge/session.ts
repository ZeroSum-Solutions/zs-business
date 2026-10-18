// M1 edge session: the one place the HTTP API and the MCP server bind a verified principal to
// the shared dispatcher. Inputs are parsed with the contracts schemas; writes run through
// createDispatcher; reads run inside ScopedDatabase.tenant under the runtime role.
import {
  createBookingRequestSchema,
  createDealRequestSchema,
  idempotencyKeySchema,
  listBookingsQuerySchema,
  listDealsQuerySchema,
  moveDealStageRequestSchema,
  pageQuerySchema,
  slotsQuerySchema,
  upsertContactRequestSchema,
  uuidSchema,
  type ActionBinding,
  type ActionCommand,
  type ActionResult,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { createDispatcher, type DispatchContext } from "../actions/dispatch.js";
import { bookingHandlers, createBooking } from "../booking/index.js";
import { readClock } from "../booking/slots.js";
import { createDeal, createOrFindContact, crmHandlers, moveDealStage } from "../crm/index.js";
import { listContacts, listDeals, listPipelines } from "../reads/crm.js";
import { findSlots, listBookings, listResources } from "../reads/booking.js";
import { derivedId } from "./ids.js";
import { validationError } from "./errors.js";

export interface EdgeDependencies {
  /** Runtime-role scoped database; never a service or superuser pool. */
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
}
/** A verified caller. Never built from request bodies or tool input. */
export interface Principal {
  readonly tenantId: string;
  readonly actorId: string;
}

interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
}
export function parseInput<T>(schema: Parser<T>, value: unknown, what = "request"): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw validationError(`Invalid ${what}`, parsed.error.issues);
  return parsed.data;
}

const dispatch = createDispatcher({ ...bookingHandlers, ...crmHandlers });

export function createSession(deps: EdgeDependencies, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);

  /**
   * Direct approval: the authenticated principal approves exactly the command it submits.
   * resolveApproval returns that binding only for this command's own reference.
   */
  const run = (command: ActionCommand): Promise<ActionResult> => {
    const { idempotencyKey: _key, ...fields } = command;
    const approved: ActionBinding = { ...fields, tenantId, actorId };
    const ctx: DispatchContext = {
      tenantId,
      actor: { id: actorId, tenantId },
      db: deps.db,
      clock: deps.clock,
      config: {},
      generateId: deps.generateId,
      resolveApproval: async (_tx, reference) =>
        reference.tenantId === tenantId && reference.id === command.approvalReference.id ? approved : null,
    };
    return dispatch(ctx, command);
  };
  const writeContext = { dispatch: run };

  /** Envelope for one write: target and approval IDs derive from the key, so replays match. */
  const envelope = <Type extends "booking" | "contact" | "deal">(rawKey: unknown, type: Type, targetId?: string) => {
    const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
    const id = targetId ?? derivedId(tenantId, idempotencyKey, type);
    return {
      id,
      target: { tenantId, type, id },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
    };
  };
  const read = <T>(work: (tx: Transaction) => Promise<T>) => deps.db.tenant(tenantId, work);

  return {
    principal: { tenantId, actorId } as Principal,

    async createBooking(body: unknown, key: unknown) {
      const request = parseInput(createBookingRequestSchema, body);
      const { id, ...rest } = envelope(key, "booking");
      return createBooking({ actionType: "booking.create", ...rest, payload: { bookingId: id, ...request } }, writeContext);
    },

    async upsertContact(body: unknown, key: unknown) {
      const request = parseInput(upsertContactRequestSchema, body);
      const { id, ...rest } = envelope(key, "contact");
      return createOrFindContact(
        { actionType: "crm.contact.create-or-find", ...rest, payload: { contactId: id, ...request } }, writeContext);
    },

    async createDeal(body: unknown, key: unknown) {
      const request = parseInput(createDealRequestSchema, body);
      const { id, ...rest } = envelope(key, "deal");
      return createDeal({ actionType: "crm.deal.create", ...rest, payload: { dealId: id, ...request } }, writeContext);
    },

    async moveDealStage(dealId: unknown, body: unknown, key: unknown) {
      const id = parseInput(uuidSchema, dealId, "deal ID");
      const request = parseInput(moveDealStageRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "deal", id);
      return moveDealStage({ actionType: "crm.deal.move-stage", ...rest, payload: { dealId: id, ...request } }, writeContext);
    },

    listBookings: (query: unknown) => {
      const parsed = parseInput(listBookingsQuerySchema, query, "query");
      return read((tx) => listBookings(tx, tenantId, parsed));
    },
    listContacts: (query: unknown) => {
      const parsed = parseInput(pageQuerySchema, query, "query");
      return read((tx) => listContacts(tx, tenantId, parsed));
    },
    listDeals: (query: unknown) => {
      const parsed = parseInput(listDealsQuerySchema, query, "query");
      return read((tx) => listDeals(tx, tenantId, parsed));
    },
    listPipelines: () => read((tx) => listPipelines(tx, tenantId)),
    listResources: () => read((tx) => listResources(tx, tenantId)),
    findSlots: (query: unknown) => {
      const parsed = parseInput(slotsQuerySchema, query, "query");
      const now = new Date(readClock(deps.clock));
      return read((tx) => findSlots(tx, tenantId, parsed, now));
    },
  };
}
export type Session = ReturnType<typeof createSession>;
