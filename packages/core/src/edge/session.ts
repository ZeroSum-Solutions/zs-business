// M1 edge session: the one place the HTTP API and the MCP server bind a verified principal to
// the shared dispatcher. Inputs are parsed with the contracts schemas; writes run through
// createDispatcher; reads run inside ScopedDatabase.tenant under the runtime role.
// M2a: every transaction first requires the principal's membership and the permission the
// read or action needs (members/access.ts), so a removed member is refused at once.
// M3b: stored approvals (approvals.md) run through approvedDispatch beside the direct path.
import {
  ROLE_PERMISSIONS,
  ValidationFailed,
  Conflict,
  approvalOutputSchema,
  changeMemberRoleRequestSchema,
  createBookingRequestSchema,
  createDealRequestSchema,
  decideApprovalRequestSchema,
  draftReplyRequestSchema,
  idempotencyKeySchema,
  inviteMemberRequestSchema,
  linkIntakeItemRequestSchema,
  memberOutputSchema,
  NotFound,
  removeMemberOutputSchema,
  TenantDenied,
  listApprovalsQuerySchema,
  listBookingsQuerySchema,
  listIntakeItemsQuerySchema,
  listContactsQuerySchema,
  listDealsQuerySchema,
  listSourcesQuerySchema,
  listThreadsQuerySchema,
  moveDealStageRequestSchema,
  observeSourceOutputSchema,
  observeSourceRequestSchema,
  rejectIntakeItemRequestSchema,
  replyOutputSchema,
  replyStepRequestSchema,
  requestApprovalInputSchema,
  requestApprovalRequestSchema,
  resultsQuerySchema,
  roleCan,
  setDealDetailsRequestSchema,
  slotsQuerySchema,
  threadIdSchema,
  upsertContactRequestSchema,
  uuidSchema,
  type ActionBinding,
  type ActionCommand,
  type ActionResult,
  type ApprovalOutput,
  type ApprovalPage,
  type ApprovalRecord,
  type ApproveApprovalResponse,
  type BookingPageSummary,
  type MeResponse,
  type MemberList,
  type MemberOutput,
  type ObserveSourceOutput,
  type Permission,
  type ReplyOutput,
  type ReplyRecord,
  type RemoveMemberOutput,
  type SourceList,
  type WalletSummary,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import { createDispatcher, type DispatchContext } from "../actions/dispatch.js";
import { APPROVAL_POLICIES, approvalHandlers, approvalPolicy, listApprovals, loadApproval, approvalRecord, resolveStoredApproval, type ApprovalPolicy } from "../approvals/index.js";
import { bookingHandlers, createBooking } from "../booking/index.js";
import { readClock } from "../booking/slots.js";
import { createDeal, createOrFindContact, crmHandlers, moveDealStage } from "../crm/index.js";
import { dealDetailsHandlers, setDealDetails } from "../deals/details.js";
import { discardReply, draftReply, inboxHandlers, openSendApproval, requireEmail, SEND_REPLY_ACTION } from "../inbox/index.js";
import { smsStatusHandlers } from "../delivery/sms-status.js";
import { suppressionHandlers } from "../delivery/suppression.js";
import { intakeHandlers, linkIntakeItem, rejectIntakeItem, signBookingKey } from "../intake/index.js";
import { listBookingPages, listIntakeItems } from "../reads/intake.js";
import { getContact, listContacts, listDeals, listPipelines } from "../reads/crm.js";
import { homeResults } from "../reads/home.js";
import { getThread, listThreads, loadReply } from "../reads/inbox.js";
import { findSlots, listBookings, listResources } from "../reads/booking.js";
import { requireMember } from "../members/access.js";
import { listMembers, memberHandlers } from "../members/handlers.js";
import { listSourceRecords, SOURCE_SUBJECTS, sourceHandlers, subjectExists } from "../sources/index.js";
import { getWallet } from "../wallet/index.js";
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

const dispatch = createDispatcher({
  ...bookingHandlers, ...crmHandlers, ...dealDetailsHandlers, ...intakeHandlers, ...inboxHandlers, ...memberHandlers,
  ...approvalHandlers, ...sourceHandlers, ...suppressionHandlers, ...smsStatusHandlers,
});

/**
 * The permission each member action needs. An action missing here is refused, so the public
 * request (public-intake.md P-1), the suppression actions (delivery.md D-9) and the SMS status
 * record (twilio.md T-6) are never
 * reachable from a member session.
 */
export const ACTION_PERMISSIONS: Readonly<Record<string, Permission>> = Object.freeze({
  "booking.create": "calendar",
  "crm.contact.create-or-find": "customers",
  "crm.deal.create": "customers",
  "crm.deal.move-stage": "customers",
  "crm.deal.set-details": "customers",
  "inbox.reply.draft": "inbox.drafts",
  "inbox.reply.discard": "inbox.drafts",
  // inbox-home.md I-6: also `required` in APPROVAL_POLICIES, so only an owner's approval runs it.
  "inbox.reply.send": "inbox.drafts",
  "intake.item.link": "intake",
  "intake.item.reject": "intake",
  "member.invite": "members",
  "member.change-role": "members",
  "member.remove": "members",
  "approval.approve": "approve",
  "approval.reject": "approve",
});

/** Registered actions whose permission depends on their payload (payloadPermission below). */
export const PAYLOAD_PERMISSION_ACTIONS: readonly string[] = Object.freeze(["approval.request", "approval.revoke", "source.observe"]);

/**
 * Actions whose permission depends on their payload: an approval request needs the proposed
 * action's request permission (approvals.md A-9), a withdrawal or revocation is checked by its
 * handler (A-8), and a source observation needs its subject's permission (F-2).
 */
function payloadPermission(binding: ActionBinding, policies: Readonly<Record<string, ApprovalPolicy>>): Permission | null | undefined {
  switch (binding.actionType) {
    case "approval.request": {
      const parsed = requestApprovalInputSchema.safeParse(binding.payload);
      if (!parsed.success) throw new ValidationFailed(parsed.error.message);
      const policy = approvalPolicy(parsed.data.action.actionType, ACTION_PERMISSIONS, policies);
      if (!policy) throw new ValidationFailed("That action cannot be approved");
      return policy.request;
    }
    case "approval.revoke":
      return null;
    case "source.observe": {
      const type = (binding.payload as { subject?: { type?: unknown } } | null)?.subject?.type;
      if (typeof type !== "string" || !Object.hasOwn(SOURCE_SUBJECTS, type)) throw new ValidationFailed("Unknown source subject");
      return SOURCE_SUBJECTS[type as keyof typeof SOURCE_SUBJECTS].permission;
    }
    default:
      return undefined;
  }
}

/** Checks inside the action's transaction, before its idempotency lock, that the caller may run it. */
export type Authorize = NonNullable<DispatchContext["authorize"]>;

/**
 * M2a: a member session runs only the actions its role grants. Membership changes hold the
 * membership lock exclusively, so they serialize with each other and with every role check.
 * M3b: an action whose approval policy is `required` never runs directly (approvals.md A-9).
 */
export function memberAuthorize(
  tenantId: string,
  actorId: string,
  policies: Readonly<Record<string, ApprovalPolicy>> = APPROVAL_POLICIES,
): Authorize {
  return async (tx, binding) => {
    const dynamic = payloadPermission(binding, policies);
    const permission = dynamic === undefined ? ACTION_PERMISSIONS[binding.actionType] : dynamic;
    if (permission === undefined || (Object.hasOwn(policies, binding.actionType) && policies[binding.actionType]!.required))
      throw new TenantDenied();
    await requireMember(tx, tenantId, actorId, permission, binding.actionType.startsWith("member.") ? "exclusive" : "shared");
  };
}

/**
 * approvals.md A-7: run a stored, approved action as its decider. The command is rebuilt from
 * the record and keyed by the approval, so a retry replays; resolveApproval re-reads the record
 * under a shared row lock, so a revocation that commits first stops the run.
 */
export function approvedDispatch(deps: EdgeDependencies, tenantId: string, actorId: string) {
  return async (approvalId: string): Promise<ActionResult> => {
    const row = await deps.db.tenant(tenantId, async (tx) => {
      const access = await requireMember(tx, tenantId, actorId, null);
      const found = await loadApproval(tx, tenantId, approvalId);
      // A-11: a member who may not see the approval cannot learn that it exists.
      return found && (roleCan(access.role, "approve") || found.requested_by === actorId) ? found : null;
    });
    if (!row) throw new NotFound();
    const target = { tenantId, type: row.target_type, id: row.target_id };
    const approvalReference = { tenantId, id: row.id };
    const ctx: DispatchContext = {
      tenantId,
      actor: { id: actorId, tenantId },
      db: deps.db,
      clock: deps.clock,
      config: {},
      generateId: deps.generateId,
      resolveApproval: async (tx, reference) =>
        reference.tenantId === tenantId && reference.id === row.id
          ? resolveStoredApproval(tx, tenantId, row.id, new Date(readClock(deps.clock)))
          : null,
      authorize: async (tx, binding) => {
        const permission = ACTION_PERMISSIONS[binding.actionType];
        if (!permission) throw new TenantDenied();
        await requireMember(tx, tenantId, actorId, permission, binding.actionType.startsWith("member.") ? "exclusive" : "shared");
      },
    };
    return dispatch(ctx, {
      actionType: row.action_type, target, payload: row.payload, approvalReference, idempotencyKey: `approval:${row.id}`,
    });
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

/** Optional fields a caller left out are absent from a payload, never `undefined` (JSON). */
function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
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

type EnvelopeType = "booking" | "contact" | "deal" | "inbox_reply" | "intake_item" | "member" | "approval";

export function createSession(deps: EdgeDependencies, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  const run = directDispatch(deps, tenantId, actorId, memberAuthorize(tenantId, actorId));
  const runApproved = approvedDispatch(deps, tenantId, actorId);
  const writeContext = { dispatch: run };

  /** Envelope for one write: target and approval IDs derive from the key, so replays match. */
  const envelope = <Type extends EnvelopeType>(rawKey: unknown, type: Type, targetId?: string) =>
    keyed(parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key"), type, targetId);
  /** The same for a key the server built, which may use a reserved prefix (SERVER_IDEMPOTENCY_PREFIXES). */
  const keyed = <Type extends EnvelopeType>(idempotencyKey: string, type: Type, targetId?: string) => {
    // An approval record's ID must differ from the request's own direct approval ID below:
    // the actions_tenant_approval index allows one action per approval ID (approvals.md A-7).
    const id = targetId ?? derivedId(tenantId, idempotencyKey, type === "approval" ? "approval-record" : type);
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
  /** inbox-home.md I-6: a key for one step of a reply write, derived so a retry replays that step. */
  const stepKey = (key: string, step: string) => `inbox:${step}:${derivedId(tenantId, key, step)}`;
  /** I-6, approvals.md A-5: propose sending one drafted reply, for an owner to approve. */
  const proposeSend = async (reply: ReplyRecord, key: string) => {
    const { id, ...rest } = keyed(key, "approval");
    const request = requestApprovalRequestSchema.parse({
      action: { actionType: SEND_REPLY_ACTION, target: { type: "inbox_reply", id: reply.id }, payload: { replyId: reply.id } },
      summary: `Send the reply "${reply.subject}"`,
    });
    return parseInput(approvalOutputSchema,
      await run({ actionType: "approval.request", ...rest, payload: { approvalId: id, ...request } }), "result").result;
  };
  const notDraft = (status: string) => new Conflict("The reply is no longer a draft", { reason: "not_draft", status });

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

    async setDealDetails(dealId: unknown, body: unknown, key: unknown) {
      const id = parseInput(uuidSchema, dealId, "deal ID");
      const request = parseInput(setDealDetailsRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "deal", id);
      return setDealDetails({ actionType: "crm.deal.set-details", ...rest, payload: { dealId: id, ...request } }, writeContext);
    },

    /** I-5: draft, then propose sending it (approvals.md A-5). A retry replays both steps. */
    async draftReply(body: unknown, key: unknown): Promise<ReplyOutput> {
      const request = parseInput(draftReplyRequestSchema, body);
      const { id, ...rest } = envelope(key, "inbox_reply");
      const draft = await draftReply({ actionType: "inbox.reply.draft", ...rest, payload: { replyId: id, ...request } }, writeContext);
      await proposeSend(draft.result, stepKey(rest.idempotencyKey, "propose"));
      return draft;
    },
    /**
     * I-6: an owner approves the reply's open proposal (proposing again first when it expired or
     * was withdrawn), then runs the send as that owner (approvals.md A-6, A-7). A retry with the
     * same key replays; after a failed run a new key retries the run on the same approval. A reply
     * with no address is refused before anything is decided, so its proposal stays pending.
     */
    async approveReply(replyId: unknown, body: unknown, key: unknown): Promise<ReplyOutput> {
      const id = parseInput(uuidSchema, replyId, "reply ID");
      parseInput(replyStepRequestSchema, body);
      const idempotencyKey = parseInput(idempotencyKeySchema, key, "Idempotency-Key");
      const now = new Date(readClock(deps.clock));
      const { reply, open, decided } = await read("approve", async (tx) => {
        const reply = await loadReply(tx, tenantId, id);
        if (reply?.status === "draft") await requireEmail(tx, tenantId, reply.contactId);
        // Whether this key already decided an approval: a retry of a call that went through.
        const decided = (await tx.query(
          "SELECT 1 FROM actions WHERE tenant_id=$1 AND idempotency_key=$2 AND action_type='approval.approve'", [tenantId, idempotencyKey],
        )).rowCount === 1;
        return { reply, open: await openSendApproval(tx, tenantId, id, now), decided };
      });
      if (!reply) throw new TenantDenied();
      // Once the reply has left draft, only a retry of the call that sent it replays.
      if (reply.status !== "draft" && !(decided && open?.status === "approved")) throw notDraft(reply.status);
      let approvalId = open?.id;
      if (open?.status !== "approved") {
        approvalId ??= (await proposeSend(reply, stepKey(idempotencyKey, "propose"))).id;
        const { id: _id, ...rest } = envelope(idempotencyKey, "approval", approvalId);
        await run({ actionType: "approval.approve", ...rest, payload: { approvalId } });
      }
      return parseInput(replyOutputSchema, await runApproved(approvalId!), "result");
    },
    /** I-7: discard the draft, then withdraw its open proposal where this member may (A-8). */
    async discardReply(replyId: unknown, body: unknown, key: unknown): Promise<ReplyOutput> {
      const id = parseInput(uuidSchema, replyId, "reply ID");
      parseInput(replyStepRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "inbox_reply", id);
      const discarded = await discardReply({ actionType: "inbox.reply.discard", ...rest, payload: { replyId: id } }, writeContext);
      const now = new Date(readClock(deps.clock));
      const { access, open } = await deps.db.tenant(tenantId, async (tx) => ({
        access: await requireMember(tx, tenantId, actorId, "inbox.drafts"), open: await openSendApproval(tx, tenantId, id, now),
      }));
      if (open && (roleCan(access.role, "approve") || (open.status === "pending" && open.requestedBy === actorId))) {
        const { id: _approval, ...step } = keyed(stepKey(rest.idempotencyKey, "withdraw"), "approval", open.id);
        await run({ actionType: "approval.revoke", ...step, payload: { approvalId: open.id } });
      }
      return discarded;
    },
    listThreads: (query: unknown) => {
      const parsed = parseInput(listThreadsQuerySchema, query, "query");
      return read("inbox.drafts", (tx) => listThreads(tx, tenantId, parsed));
    },
    getThread: (threadId: unknown) => {
      const id = parseInput(threadIdSchema, threadId, "thread ID");
      return read("inbox.drafts", (tx) => getThread(tx, tenantId, id));
    },
    /** H-3: the clock is read once, here, so both weeks come from the same instant. */
    homeResults: (query: unknown) => {
      const parsed = parseInput(resultsQuerySchema, query, "query");
      const now = readClock(deps.clock);
      return read("reports", (tx) => homeResults(tx, tenantId, parsed, now));
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

    /** The caller's own membership; any member may ask. */
    me: (): Promise<MeResponse> => deps.db.tenant(tenantId, async (tx) => {
      const access = await requireMember(tx, tenantId, actorId, null);
      return { tenantId, userId: actorId, memberId: access.memberId, role: access.role, permissions: [...ROLE_PERMISSIONS[access.role]] };
    }),
    listMembers: async (): Promise<MemberList> => ({ items: await read("members", (tx) => listMembers(tx, tenantId)) }),
    /** The prepaid wallet (delivery.md D-4); billing is an owner permission. */
    getWallet: (): Promise<WalletSummary> => read("billing", (tx) => getWallet(tx, tenantId)),

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

    /** approvals.md A-5: propose one exact action for an owner to approve. */
    async requestApproval(body: unknown, key: unknown): Promise<ApprovalOutput> {
      const request = parseInput(requestApprovalRequestSchema, body);
      const { id, ...rest } = envelope(key, "approval");
      return parseInput(approvalOutputSchema,
        await run({ actionType: "approval.request", ...rest, payload: { approvalId: id, ...request } }), "result");
    },
    /** A-6 then A-7: approve, then run the approved action as this owner. A retry replays both. */
    async approveApproval(approvalId: unknown, body: unknown, key: unknown): Promise<ApproveApprovalResponse> {
      const id = parseInput(uuidSchema, approvalId, "approval ID");
      const request = parseInput(decideApprovalRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "approval", id);
      const approval = parseInput(approvalOutputSchema,
        await run({ actionType: "approval.approve", ...rest, payload: defined({ approvalId: id, ...request }) }), "result");
      return { approval, execution: await runApproved(id) };
    },
    async rejectApproval(approvalId: unknown, body: unknown, key: unknown): Promise<ApprovalOutput> {
      const id = parseInput(uuidSchema, approvalId, "approval ID");
      const request = parseInput(decideApprovalRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "approval", id);
      return parseInput(approvalOutputSchema,
        await run({ actionType: "approval.reject", ...rest, payload: defined({ approvalId: id, ...request }) }), "result");
    },
    /** A-8: owners revoke; a requester withdraws their own pending request. */
    async revokeApproval(approvalId: unknown, body: unknown, key: unknown): Promise<ApprovalOutput> {
      const id = parseInput(uuidSchema, approvalId, "approval ID");
      const request = parseInput(decideApprovalRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "approval", id);
      return parseInput(approvalOutputSchema,
        await run({ actionType: "approval.revoke", ...rest, payload: defined({ approvalId: id, ...request }) }), "result");
    },
    /** A-11: owners see every approval, other members the ones they requested. */
    listApprovals: (query: unknown): Promise<ApprovalPage> => {
      const parsed = parseInput(listApprovalsQuerySchema, query, "query");
      const now = new Date(readClock(deps.clock));
      return deps.db.tenant(tenantId, async (tx) => {
        const access = await requireMember(tx, tenantId, actorId, null);
        return listApprovals(tx, tenantId, parsed, now, roleCan(access.role, "approve") ? null : actorId);
      });
    },
    getApproval: (approvalId: unknown): Promise<ApprovalRecord> => {
      const id = parseInput(uuidSchema, approvalId, "approval ID");
      const now = new Date(readClock(deps.clock));
      return deps.db.tenant(tenantId, async (tx) => {
        const access = await requireMember(tx, tenantId, actorId, null);
        const row = await loadApproval(tx, tenantId, id);
        if (!row || !(roleCan(access.role, "approve") || row.requested_by === actorId)) throw new NotFound();
        return approvalRecord(row, now);
      });
    },

    /** approvals.md F-4: one record per subject and source, so its ID derives from both. */
    async observeSource(body: unknown, key: unknown): Promise<ObserveSourceOutput> {
      const request = parseInput(observeSourceRequestSchema, body);
      const idempotencyKey = parseInput(idempotencyKeySchema, key, "Idempotency-Key");
      const id = derivedId(tenantId, request.subject.type, request.subject.id, request.source, "source-record");
      return parseInput(observeSourceOutputSchema, await run({
        actionType: "source.observe",
        target: { tenantId, type: "source_record", id },
        approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
        idempotencyKey,
        payload: defined({ sourceRecordId: id, ...request }),
      }), "result");
    },
    /** F-7: a subject's records; an unknown subject reads as not found. */
    listSources: (query: unknown): Promise<SourceList> => {
      const parsed = parseInput(listSourcesQuerySchema, query, "query");
      const subject = { type: parsed.subjectType, id: parsed.subjectId };
      const now = new Date(readClock(deps.clock));
      return read(SOURCE_SUBJECTS[subject.type].permission, async (tx) => {
        if (!(await subjectExists(tx, tenantId, subject))) throw new NotFound();
        return { items: await listSourceRecords(tx, tenantId, subject, now) };
      });
    },
  };
}
export type Session = ReturnType<typeof createSession>;
