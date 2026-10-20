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
  linkIntakeItemRequestSchema,
  memberOutputSchema,
  NotFound,
  removeMemberOutputSchema,
  TenantDenied,
  listBookingsQuerySchema,
  listIntakeItemsQuerySchema,
  listContactsQuerySchema,
  listDealsQuerySchema,
  moveDealStageRequestSchema,
  rejectIntakeItemRequestSchema,
  slotsQuerySchema,
  upsertContactRequestSchema,
  uuidSchema,
  type ActionBinding,
  type ActionCommand,
  type ActionResult,
  type BookingPageSummary,
  type MeResponse,
  type MemberList,
  type MemberOutput,
  type Permission,
  type RemoveMemberOutput,
  activateSiteReleaseRequestSchema,
  createSiteRequestSchema,
  publishSiteRequestSchema,
  type SiteList,
  type SiteReleaseList,
  type SiteReleaseResponse,
  type SiteSyncResponse,
  type SiteObjectStore,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { createDispatcher, type DispatchContext } from "../actions/dispatch.js";
import { bookingHandlers, createBooking } from "../booking/index.js";
import { readClock } from "../booking/slots.js";
import { createDeal, createOrFindContact, crmHandlers, moveDealStage } from "../crm/index.js";
import { intakeHandlers, linkIntakeItem, rejectIntakeItem, signBookingKey } from "../intake/index.js";
import { listBookingPages, listIntakeItems } from "../reads/intake.js";
import { getContact, listContacts, listDeals, listPipelines } from "../reads/crm.js";
import { findSlots, listBookings, listResources } from "../reads/booking.js";
import { requireMember } from "../members/access.js";
import { listMembers, memberHandlers } from "../members/handlers.js";
import {
  activateSiteRelease, createSite, getRelease, getSite, listReleases, listSites, publishSiteRelease, siteHandlers,
  storeReleaseFiles, syncSiteEdge, verifyCompiledSite, type SiteCompiler,
} from "../sites/index.js";
import { derivedId } from "./ids.js";
import { validationError } from "./errors.js";

export interface EdgeDependencies {
  /** Runtime-role scoped database; never a service or superuser pool. */
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** Signs public booking keys for the owner's page list (public-intake.md P-2, P-12). */
  readonly bookingKeys?: { readonly secret: string; readonly publicBaseUrl: string };
  /** Site publishing (M4b): the object store releases go to and the compiler; absent means off. */
  readonly sites?: { readonly store: SiteObjectStore; readonly compiler: SiteCompiler };
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

const dispatch = createDispatcher({ ...bookingHandlers, ...crmHandlers, ...intakeHandlers, ...memberHandlers, ...siteHandlers });

/**
 * The permission each member action needs. An action missing here is refused, so the public
 * request (public-intake.md P-1) is never reachable from a member session.
 */
export const ACTION_PERMISSIONS: Readonly<Record<string, Permission>> = Object.freeze({
  "booking.create": "calendar",
  "crm.contact.create-or-find": "customers",
  "crm.deal.create": "customers",
  "crm.deal.move-stage": "customers",
  "intake.item.link": "intake",
  "intake.item.reject": "intake",
  "member.invite": "members",
  "member.change-role": "members",
  "member.remove": "members",
  "site.create": "publish",
  "site.release.publish": "publish",
  "site.release.activate": "publish",
});

/** Checks inside the action's transaction, before its idempotency lock, that the caller may run it. */
export type Authorize = NonNullable<DispatchContext["authorize"]>;

/**
 * M2a: a member session runs only the actions its role grants. Membership changes hold the
 * membership lock exclusively, so they serialize with each other and with every role check.
 */
export function memberAuthorize(tenantId: string, actorId: string): Authorize {
  return async (tx, binding) => {
    const permission = ACTION_PERMISSIONS[binding.actionType];
    if (!permission) throw new TenantDenied();
    await requireMember(tx, tenantId, actorId, permission, binding.actionType.startsWith("member.") ? "exclusive" : "shared");
  };
}

/**
 * Direct approval: the principal approves exactly the command it submits. resolveApproval returns
 * that binding only for this command's own reference. Member sessions and the server-built public
 * principal (public-intake.md P-3) both dispatch through here, each with its own authorize.
 */
export function directDispatch(deps: EdgeDependencies, tenantId: string, actorId: string, authorize: Authorize) {
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
      authorize,
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
  const run = directDispatch(deps, tenantId, actorId, memberAuthorize(tenantId, actorId));
  const writeContext = { dispatch: run };

  /** Envelope for one write: target and approval IDs derive from the key, so replays match. */
  const envelope = <Type extends "booking" | "contact" | "deal" | "intake_item" | "member" | "site">(rawKey: unknown, type: Type, targetId?: string) => {
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

  /** Project committed state to the edge, re-checking the caller's permission in that read. */
  const syncSite = (store: SiteObjectStore, siteId: string) =>
    syncSiteEdge(deps.db, store, tenantId, siteId, async (tx) => { await requireMember(tx, tenantId, actorId, "publish"); });
  /** After a committed write the answer is that write's result: a failed projection is only `pending`. */
  const syncAfterWrite = (store: SiteObjectStore, siteId: string) => syncSite(store, siteId).catch(() => "pending" as const);

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
      return read("intake", (tx) => listIntakeItems(tx, tenantId, parsed));
    },
    /** Public keys and embed snippets put a page on a website, so only publishers see them. */
    listBookingPages: async (): Promise<BookingPageSummary[]> => {
      const keys = deps.bookingKeys;
      if (!keys) throw new NotFound();
      const pages = await read("publish", (tx) => listBookingPages(tx, tenantId));
      return pages.map((page) => {
        const publicKey = signBookingKey(keys.secret, { tenantId, pageId: page.id });
        return { ...page, publicKey, ...bookingPageSnippets(keys.publicBaseUrl, publicKey) };
      });
    },
    listPipelines: () => read("customers", (tx) => listPipelines(tx, tenantId)),
    listResources: () => read("calendar", (tx) => listResources(tx, tenantId)),
    findSlots: (query: unknown) => {
      const parsed = parseInput(slotsQuerySchema, query, "query");
      const now = new Date(readClock(deps.clock));
      return read("calendar", (tx) => findSlots(tx, tenantId, parsed, now));
    },

    // M4b sites: every read and write needs the publish permission (owners).
    listSites: async (): Promise<SiteList> => ({ items: await read("publish", (tx) => listSites(tx, tenantId)) }),
    getSite: (siteId: unknown) => {
      const id = parseInput(uuidSchema, siteId, "site ID");
      return read("publish", (tx) => getSite(tx, tenantId, id));
    },
    listSiteReleases: async (siteId: unknown): Promise<SiteReleaseList> => {
      const id = parseInput(uuidSchema, siteId, "site ID");
      return { items: await read("publish", (tx) => listReleases(tx, tenantId, id)) };
    },
    getSiteRelease: (siteId: unknown, releaseId: unknown) => {
      const id = parseInput(uuidSchema, siteId, "site ID");
      const release = parseInput(uuidSchema, releaseId, "release ID");
      return read("publish", (tx) => getRelease(tx, tenantId, id, release));
    },
    async createSite(body: unknown, key: unknown) {
      const request = parseInput(createSiteRequestSchema, body);
      const { id, ...rest } = envelope(key, "site");
      return createSite({ actionType: "site.create", ...rest, target: { tenantId, type: "site", id }, payload: { siteId: id, ...request } }, writeContext);
    },
    /**
     * Compile the spec, store its files, record the release and make it live, then move the
     * edge. Retried with its key, it rebuilds the same files and replays the recorded result.
     */
    async publishSite(siteId: unknown, body: unknown, key: unknown): Promise<SiteReleaseResponse> {
      const sites = deps.sites;
      if (!sites) throw new NotFound();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const request = parseInput(publishSiteRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "site", id);
      // Permission and ownership first, so nobody else's request stores bytes under this tenant.
      await read("publish", (tx) => getSite(tx, tenantId, id));
      const release = await verifyCompiledSite(await sites.compiler.compile(request.spec));
      await storeReleaseFiles(sites.store, tenantId, release);
      const output = await publishSiteRelease({
        actionType: "site.release.publish", ...rest, target: { tenantId, type: "site", id },
        payload: {
          siteId: id, releaseId: derivedId(tenantId, rest.idempotencyKey, "site_release"), spec: request.spec,
          entry: release.entry, digest: release.digest, files: [...release.files],
        },
      }, writeContext);
      return { ...output, edge: await syncAfterWrite(sites.store, id) };
    },
    /** Make an earlier (or later) release live again: the rollback. */
    async activateSiteRelease(siteId: unknown, releaseId: unknown, body: unknown, key: unknown): Promise<SiteReleaseResponse> {
      const sites = deps.sites;
      if (!sites) throw new NotFound();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const release = parseInput(uuidSchema, releaseId, "release ID");
      const request = parseInput(activateSiteReleaseRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "site", id);
      const output = await activateSiteRelease({
        actionType: "site.release.activate", ...rest, target: { tenantId, type: "site", id },
        payload: { siteId: id, releaseId: release, expectedCurrentReleaseId: request.expectedCurrentReleaseId },
      }, writeContext);
      return { ...output, edge: await syncAfterWrite(sites.store, id) };
    },
    /** Retry the edge projection after a `pending` answer. */
    async syncSite(siteId: unknown): Promise<SiteSyncResponse> {
      const sites = deps.sites;
      if (!sites) throw new NotFound();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const site = await read("publish", (tx) => getSite(tx, tenantId, id));
      return { site, edge: await syncSite(sites.store, id) };
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
