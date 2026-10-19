// M1 edge session: the one place the HTTP API and the MCP server bind a verified principal to
// the shared dispatcher. Inputs are parsed with the contracts schemas; writes run through
// createDispatcher; reads run inside ScopedDatabase.tenant under the runtime role.
// M2a: every transaction first requires the principal's membership and the permission the
// read or action needs (members/access.ts), so a removed member is refused at once.
import {
  ROLE_PERMISSIONS,
  changeMemberRoleRequestSchema,
  createBookingRequestSchema,
  createDealRequestSchema,
  idempotencyKeySchema,
  inviteMemberRequestSchema,
  memberOutputSchema,
  removeMemberOutputSchema,
  TenantDenied,
  listBookingsQuerySchema,
  listContactsQuerySchema,
  listDealsQuerySchema,
  moveDealStageRequestSchema,
  slotsQuerySchema,
  upsertContactRequestSchema,
  uuidSchema,
  type ActionBinding,
  type ActionCommand,
  type ActionResult,
  type MeResponse,
  type MemberList,
  type MemberOutput,
  type Permission,
  type RemoveMemberOutput,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { createDispatcher, type DispatchContext } from "../actions/dispatch.js";
import { bookingHandlers, createBooking } from "../booking/index.js";
import { readClock } from "../booking/slots.js";
import { createDeal, createOrFindContact, crmHandlers, moveDealStage } from "../crm/index.js";
import { getContact, listContacts, listDeals, listPipelines } from "../reads/crm.js";
import { findSlots, listBookings, listResources } from "../reads/booking.js";
import { requireMember } from "../members/access.js";
import { listMembers, memberHandlers } from "../members/handlers.js";
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

const dispatch = createDispatcher({ ...bookingHandlers, ...crmHandlers, ...memberHandlers });

/** The permission each action needs. An action missing here is refused. */
export const ACTION_PERMISSIONS: Readonly<Record<string, Permission>> = Object.freeze({
  "booking.create": "calendar",
  "crm.contact.create-or-find": "customers",
  "crm.deal.create": "customers",
  "crm.deal.move-stage": "customers",
  "member.invite": "members",
  "member.change-role": "members",
  "member.remove": "members",
});

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
      // Membership changes hold the membership lock exclusively, so they serialize with each
      // other and with every role check.
      authorize: async (tx, binding) => {
        const permission = ACTION_PERMISSIONS[binding.actionType];
        if (!permission) throw new TenantDenied();
        await requireMember(tx, tenantId, actorId, permission, binding.actionType.startsWith("member.") ? "exclusive" : "shared");
      },
    };
    return dispatch(ctx, command);
  };
  const writeContext = { dispatch: run };

  /** Envelope for one write: target and approval IDs derive from the key, so replays match. */
  const envelope = <Type extends "booking" | "contact" | "deal" | "member">(rawKey: unknown, type: Type, targetId?: string) => {
    const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
    const id = targetId ?? derivedId(tenantId, idempotencyKey, type);
    return {
      id,
      target: { tenantId, type, id },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
    };
  };
  const read = <T>(permission: Permission | null, work: (tx: Transaction) => Promise<T>) =>
    deps.db.tenant(tenantId, async (tx) => {
      await requireMember(tx, tenantId, actorId, permission);
      return work(tx);
    });

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
      return read("calendar", (tx) => listBookings(tx, tenantId, parsed));
    },
    listContacts: (query: unknown) => {
      const parsed = parseInput(listContactsQuerySchema, query, "query");
      return read("customers", (tx) => listContacts(tx, tenantId, parsed));
    },
    getContact: (contactId: unknown) => {
      const id = parseInput(uuidSchema, contactId, "contact ID");
      return read("customers", (tx) => getContact(tx, tenantId, id));
    },
    listDeals: (query: unknown) => {
      const parsed = parseInput(listDealsQuerySchema, query, "query");
      return read("customers", (tx) => listDeals(tx, tenantId, parsed));
    },
    listPipelines: () => read("customers", (tx) => listPipelines(tx, tenantId)),
    listResources: () => read("calendar", (tx) => listResources(tx, tenantId)),
    findSlots: (query: unknown) => {
      const parsed = parseInput(slotsQuerySchema, query, "query");
      const now = new Date(readClock(deps.clock));
      return read("calendar", (tx) => findSlots(tx, tenantId, parsed, now));
    },

    /** The caller's own membership; any member may ask. */
    me: (): Promise<MeResponse> => deps.db.tenant(tenantId, async (tx) => {
      const access = await requireMember(tx, tenantId, actorId, null);
      return { tenantId, userId: actorId, memberId: access.memberId, role: access.role, permissions: [...ROLE_PERMISSIONS[access.role]] };
    }),
    listMembers: async (): Promise<MemberList> => ({ items: await read("members", (tx) => listMembers(tx, tenantId)) }),

    async inviteMember(body: unknown, key: unknown): Promise<MemberOutput> {
      const request = parseInput(inviteMemberRequestSchema, body);
      const { id, ...rest } = envelope(key, "member");
      return parseInput(memberOutputSchema, await run({ actionType: "member.invite", ...rest, payload: { memberId: id, ...request } }), "result");
    },
    async changeMemberRole(memberId: unknown, body: unknown, key: unknown): Promise<MemberOutput> {
      const id = parseInput(uuidSchema, memberId, "member ID");
      const request = parseInput(changeMemberRoleRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "member", id);
      return parseInput(memberOutputSchema, await run({ actionType: "member.change-role", ...rest, payload: { memberId: id, ...request } }), "result");
    },
    async removeMember(memberId: unknown, key: unknown): Promise<RemoveMemberOutput> {
      const id = parseInput(uuidSchema, memberId, "member ID");
      const { id: _id, ...rest } = envelope(key, "member", id);
      return parseInput(removeMemberOutputSchema, await run({ actionType: "member.remove", ...rest, payload: { memberId: id } }), "result");
    },
  };
}
export type Session = ReturnType<typeof createSession>;
