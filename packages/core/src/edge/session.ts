// M1 edge session: the one place the HTTP API and the MCP server bind a verified principal to
// the shared dispatcher. Inputs are parsed with the contracts schemas; writes run through
// createDispatcher; reads run inside ScopedDatabase.tenant under the runtime role.
import {
  createBookingRequestSchema,
  createDealRequestSchema,
  idempotencyKeySchema,
  linkIntakeItemRequestSchema,
  NotFound,
  listBookingsQuerySchema,
  listIntakeItemsQuerySchema,
  listDealsQuerySchema,
  moveDealStageRequestSchema,
  pageQuerySchema,
  rejectIntakeItemRequestSchema,
  slotsQuerySchema,
  upsertContactRequestSchema,
  uuidSchema,
  type ActionBinding,
  type ActionCommand,
  type ActionResult,
  type BookingPageSummary,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { createDispatcher, type DispatchContext } from "../actions/dispatch.js";
import { bookingHandlers, createBooking } from "../booking/index.js";
import { readClock } from "../booking/slots.js";
import { createDeal, createOrFindContact, crmHandlers, moveDealStage } from "../crm/index.js";
import { intakeHandlers, linkIntakeItem, rejectIntakeItem, signBookingKey } from "../intake/index.js";
import { listBookingPages, listIntakeItems } from "../reads/intake.js";
import { listContacts, listDeals, listPipelines } from "../reads/crm.js";
import { findSlots, listBookings, listResources } from "../reads/booking.js";
import { derivedId } from "./ids.js";
import { validationError } from "./errors.js";

export interface EdgeDependencies {
  /** Runtime-role scoped database; never a service or superuser pool. */
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** Signs public booking keys for the owner's page list (public-intake.md P-2, P-12). */
  readonly bookingKeys?: { readonly secret: string; readonly publicBaseUrl: string };
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

const dispatch = createDispatcher({ ...bookingHandlers, ...crmHandlers, ...intakeHandlers });

/**
 * Direct approval: the principal approves exactly the command it submits. resolveApproval returns
 * that binding only for this command's own reference. Owner sessions and the server-built public
 * principal (public-intake.md P-3) both dispatch through here.
 */
export function directDispatch(deps: EdgeDependencies, tenantId: string, actorId: string) {
  return (command: ActionCommand): Promise<ActionResult> => {
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
}

/** Drop trailing slashes in one linear pass; a /\/+$/ regex backtracks on long runs of "/". */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}

/** Embed snippets for one page; the key is the only tenant reference a website ever holds. */
export function bookingPageSnippets(publicBaseUrl: string, publicKey: string) {
  const base = trimTrailingSlashes(publicBaseUrl);
  const bookingUrl = `${base}/book/${publicKey}`;
  return {
    bookingUrl,
    embedScript: `<div data-zs-booking="${publicKey}"></div>\n<script src="${base}/embed.js" async></script>`,
    embedIframe: `<iframe src="${bookingUrl}?embed=1" title="Book an appointment" style="width:100%;min-height:640px;border:0" loading="lazy"></iframe>`,
  };
}

export function createSession(deps: EdgeDependencies, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  const run = directDispatch(deps, tenantId, actorId);
  const writeContext = { dispatch: run };

  /** Envelope for one write: target and approval IDs derive from the key, so replays match. */
  const envelope = <Type extends "booking" | "contact" | "deal" | "intake_item">(rawKey: unknown, type: Type, targetId?: string) => {
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
    async linkIntakeItem(itemId: unknown, body: unknown, key: unknown) {
      const id = parseInput(uuidSchema, itemId, "intake item ID");
      const request = parseInput(linkIntakeItemRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "intake_item", id);
      return linkIntakeItem({ actionType: "intake.item.link", ...rest, payload: { intakeItemId: id, ...request } }, writeContext);
    },

    async rejectIntakeItem(itemId: unknown, body: unknown, key: unknown) {
      const id = parseInput(uuidSchema, itemId, "intake item ID");
      parseInput(rejectIntakeItemRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "intake_item", id);
      return rejectIntakeItem({ actionType: "intake.item.reject", ...rest, payload: { intakeItemId: id } }, writeContext);
    },

    listIntakeItems: (query: unknown) => {
      const parsed = parseInput(listIntakeItemsQuerySchema, query, "query");
      return read((tx) => listIntakeItems(tx, tenantId, parsed));
    },
    listBookingPages: async (): Promise<BookingPageSummary[]> => {
      const keys = deps.bookingKeys;
      if (!keys) throw new NotFound();
      const pages = await read((tx) => listBookingPages(tx, tenantId));
      return pages.map((page) => {
        const publicKey = signBookingKey(keys.secret, { tenantId, pageId: page.id });
        return { ...page, publicKey, ...bookingPageSnippets(keys.publicBaseUrl, publicKey) };
      });
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
