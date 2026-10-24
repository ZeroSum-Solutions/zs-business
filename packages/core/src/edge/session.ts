// M1 edge session: the one place the HTTP API and the MCP server bind a verified principal to
// the shared dispatcher. Inputs are parsed with the contracts schemas; writes run through
// createDispatcher; reads run inside ScopedDatabase.tenant under the runtime role.
// M2a: every transaction first requires the principal's membership and the permission the
// read or action needs (members/access.ts), so a removed member is refused at once.
// M3b: stored approvals (approvals.md) run through approvedDispatch beside the direct path.
import {
  ROLE_PERMISSIONS,
  WALLET_TOPUP_CREATE_ACTION,
  CALENDAR_GOOGLE_CONNECT_ACTION,
  CALENDAR_GOOGLE_DISCONNECT_ACTION,
  calendarConnectionSchema,
  pendingGoogleConnectSchema,
  confirmGoogleConnectRequestSchema,
  type PendingGoogleConnect,
  connectGoogleCalendarRequestSchema,
  connectGoogleCalendarResponseSchema,
  type CalendarConnection,
  type CalendarConnectionList,
  type ConnectGoogleCalendarResponse,
  createTopUpRequestSchema,
  type CreateTopUpResponse,
  type TopUp,
  ValidationFailed,
  Conflict,
  approvalOutputSchema,
  changeMemberRoleRequestSchema,
  createBookingRequestSchema,
  createDealRequestSchema,
  decideApprovalRequestSchema,
  draftReplyRequestSchema,
  businessProfileOutputSchema,
  updateBusinessProfileRequestSchema,
  followUpStatusOutputSchema,
  killFollowUpRequestSchema,
  listFollowUpRunsQuerySchema,
  resumeFollowUpRequestSchema,
  updateFollowUpSettingsRequestSchema,
  idempotencyKeySchema,
  inviteMemberRequestSchema,
  linkIntakeItemRequestSchema,
  memberOutputSchema,
  IdempotencyConflict,
  BindingMismatch,
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
  type FollowUpRunDetail,
  type FollowUpRunPage,
  type FollowUpStatus,
  type BusinessProfile,
  type BusinessProfileOutput,
  type FollowUpStatusOutput,
  type JsonValue,
  type BookingPageSummary,
  type MeResponse,
  type MemberList,
  type MemberOutput,
  type ObserveSourceOutput,
  type Permission,
  type ReplyOutput,
  type ReplyRecord,
  type RemoveMemberOutput,
  activateSiteReleaseRequestSchema,
  createSiteRequestSchema,
  publishSiteRequestSchema,
  type SiteList,
  type SiteReleaseList,
  type SiteReleaseResponse,
  type SiteSyncResponse,
  type SiteEdgeStatus,
  type SiteObjectStore,
  SITE_PREVIEW_HTML_BYTES,
  type SitePreview,
  type WalletSummary,
  type SourceList,
} from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import type { KeyObject } from "node:crypto";
import { createDispatcher, type DispatchConfig, type DispatchContext } from "../actions/dispatch.js";
import { AGENT_MEMBER_PERMISSIONS, agentHandlers, followUpStatus, getRun, listRuns } from "../agents/index.js";
import { businessHandlers, getBusinessProfile } from "../business/index.js";
import { transcriptionHandlers } from "../transcription/handlers.js";
import { APPROVAL_POLICIES, approvalHandlers, approvalPolicy, listApprovals, loadApproval, approvalRecord, resolveStoredApproval, type ApprovalPolicy } from "../approvals/index.js";
import { bookingHandlers, createBooking } from "../booking/index.js";
import { readClock } from "../booking/slots.js";
import { createDeal, createOrFindContact, crmHandlers, moveDealStage } from "../crm/index.js";
import { dealDetailsHandlers, setDealDetails } from "../deals/details.js";
import { discardReply, draftReply, inboxHandlers, openSendApproval, requireEmail, RESUME_REPLY_ACTION, SEND_REPLY_ACTION } from "../inbox/index.js";
import { smsStatusHandlers } from "../delivery/sms-status.js";
import { suppressionHandlers } from "../delivery/suppression.js";
import { automationHandlers } from "../automation/handlers.js";
import { intakeHandlers, linkIntakeItem, rejectIntakeItem, signBookingKey } from "../intake/index.js";
import { listBookingPages, listIntakeItems } from "../reads/intake.js";
import { getContact, listContacts, listDeals, listPipelines } from "../reads/crm.js";
import { homeResults } from "../reads/home.js";
import { getThread, listThreads, loadReply } from "../reads/inbox.js";
import { findSlots, listBookings, listResources } from "../reads/booking.js";
import { memberProfile, requireMember } from "../members/access.js";
import { listMembers, memberHandlers } from "../members/handlers.js";
import {
  activateSiteRelease, createSite, getRelease, getSite, listReleases, listSites, publishSiteRelease, siteHandlers,
  storeReleaseFiles, syncSiteEdge, verifyCompiledSite, type ProjectOptions, type SiteCompiler,
} from "../sites/index.js";
import { getWallet } from "../wallet/index.js";
import { listSourceRecords, SOURCE_SUBJECTS, sourceHandlers, subjectExists } from "../sources/index.js";
import { getTopUpForCheckout, listTopUps, rememberCheckoutUrl, startTopUp, topUpHandlers, type TopUpDispatchConfig } from "../billing/topups.js";
import type { StripeClient } from "../billing/stripe.js";
import { calendarHandlers, getCalendarConnection, googleConnectIdempotencyKey, listCalendarConnections, resourceInTenant } from "../calendar/connections.js";
import { CONNECT_STATE_LIFETIME_MS, pkceChallenge, pkceVerifier, signConnectState, type OAuthStateSecrets } from "../calendar/oauth-state.js";
import { pendingGrantId, verifyPendingGrant, type PendingGrant } from "../calendar/pending-grant.js";
import type { GoogleClient } from "../calendar/types.js";
import { derivedId } from "./ids.js";
import { SiteStoreUnavailable, validationError } from "./errors.js";

export interface EdgeDependencies {
  /** Runtime-role scoped database; never a service or superuser pool. */
  readonly db: ScopedDatabase;
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  /** Signs public booking keys for the owner's page list (public-intake.md P-2, P-12). */
  readonly bookingKeys?: { readonly secret: string; readonly publicBaseUrl: string };
  /** Stripe Checkout for wallet top-ups (stripe.md S-1, S-2); absent means top-ups are off. */
  readonly billing?: { readonly stripe: StripeClient };
  /**
   * Google Calendar busy sync (google-calendar.md G-1..G-3); absent means connecting is off. The
   * API holds only the public key that seals refresh tokens; the calendar worker opens them.
   */
  readonly calendar?: {
    readonly google: GoogleClient;
    readonly stateSecrets: OAuthStateSecrets;
    readonly tokenPublicKey: KeyObject;
  };
  /**
   * Site publishing (M4b): the object store releases go to and the compiler; absent means off.
   * `syncTimeoutMs` caps the edge projection after a committed write (default 5 s).
   */
  readonly sites?: { readonly store: SiteObjectStore; readonly compiler: SiteCompiler; readonly syncTimeoutMs?: number };
  /** Milliseconds left before the request's deadline, when it has one. */
  readonly timeLeft?: () => number;
}

/** The edge projection's default time, and the time kept back to send the answer. */
const SITE_SYNC_TIMEOUT_MS = 5_000;
const SITE_SYNC_MARGIN_MS = 1_000;

/** `work`'s status, or `pending` once `ms` pass. The projection may finish later; it is safe to. */
function withinBudget(work: Promise<SiteEdgeStatus>, ms: number): Promise<SiteEdgeStatus> {
  if (ms <= 0) return Promise.resolve("pending");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<SiteEdgeStatus>((resolve) => { timer = setTimeout(() => resolve("pending"), ms); });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
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
  ...approvalHandlers, ...sourceHandlers, ...suppressionHandlers, ...smsStatusHandlers, ...topUpHandlers, ...calendarHandlers, ...automationHandlers, ...siteHandlers,
  ...agentHandlers, ...businessHandlers, ...transcriptionHandlers,
});

/**
 * The permission each member action needs. An action missing here is refused, so the public
 * request (public-intake.md P-1), the suppression actions (delivery.md D-9), the SMS status
 * record (twilio.md T-6), the Activepieces actions (activepieces.md W-1, W-11, which authorize
 * themselves) and the agent's own run actions (agents.md G-1) are never reachable from a member
 * session.
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
  "inbox.reply.resume": "approve",
  "intake.item.link": "intake",
  "intake.item.reject": "intake",
  "member.invite": "members",
  "member.change-role": "members",
  "member.remove": "members",
  "site.create": "publish",
  "site.release.publish": "publish",
  "site.release.activate": "publish",
  "approval.approve": "approve",
  "approval.reject": "approve",
  // stripe.md S-1: only owners add money.
  "wallet.topup.create": "billing",
  // google-calendar.md G-1, G-5: a connected calendar decides what the public pages offer.
  "calendar.google.connect": "publish",
  "calendar.google.disconnect": "publish",
  // agents.md G-2, G-3: owners change settings and resume; any member may stop the agent.
  ...AGENT_MEMBER_PERMISSIONS,
  // business-profile.md BP-6: only owners change who the business is.
  "business.profile.update": "business",
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
          ? resolveStoredApproval(tx, tenantId, row.id, () => new Date(readClock(deps.clock)))
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
export function directDispatch(deps: EdgeDependencies, tenantId: string, actorId: string, authorize: Authorize, config: DispatchConfig = {}) {
  return (command: ActionCommand): Promise<ActionResult> => {
    const { idempotencyKey: _key, ...fields } = command;
    const approved: ActionBinding = { ...fields, tenantId, actorId };
    const ctx: DispatchContext = {
      tenantId,
      actor: { id: actorId, tenantId },
      db: deps.db,
      clock: deps.clock,
      config,
      generateId: deps.generateId,
      resolveApproval: async (_tx, reference) =>
        reference.tenantId === tenantId && reference.id === command.approvalReference.id ? approved : null,
      authorize,
    };
    return dispatch(ctx, command);
  };
}

/**
 * The member session's write path: the principal's membership and the action's permission are
 * re-checked inside the action's transaction. createSession writes through it, and so does the
 * Google OAuth callback for the member its signed state names (google-calendar.md G-2).
 */
export function memberDispatch(deps: EdgeDependencies, principal: Principal) {
  const tenantId = uuidSchema.parse(principal.tenantId);
  const actorId = uuidSchema.parse(principal.actorId);
  return directDispatch(deps, tenantId, actorId, memberAuthorize(tenantId, actorId));
}

/** Optional fields a caller left out are absent from a payload, never `undefined` (JSON). */
function defined<T extends Record<string, unknown>>(value: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as { [K in keyof T]: Exclude<T[K], undefined> };
}

/** A parsed value as the JSON a payload carries: optional keys left out are absent, never `undefined`. */
function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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
  const run = memberDispatch(deps, { tenantId, actorId });
  /** A grant the callback staged for this member (G-2); anything else reads as nothing staged. */
  const stagedGrant = (token: unknown): PendingGrant & { readonly grantId: string } => {
    const calendar = deps.calendar;
    if (!calendar) throw new NotFound();
    const grant = verifyPendingGrant(calendar.stateSecrets, typeof token === "string" ? token : undefined, new Date(readClock(deps.clock)));
    if (!grant || grant.tenantId !== tenantId.toLowerCase() || grant.actorId !== actorId.toLowerCase()) throw new NotFound("No Google Calendar connection waits for you");
    return { ...grant, grantId: pendingGrantId(token as string) };
  };
  const runApproved = approvedDispatch(deps, tenantId, actorId);
  const writeContext = { dispatch: run };

  /** Envelope for one write: target and approval IDs derive from the key, so replays match. */
  type EnvelopeType = "booking" | "contact" | "deal" | "inbox_reply" | "intake_item" | "member" | "approval" | "wallet_topup" | "calendar_connection" | "site";
  const envelope = <Type extends EnvelopeType>(rawKey: unknown, type: Type, targetId?: string) =>
    keyedEnvelope(parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key"), type, targetId);
  /** The envelope for a key the server built itself, such as a reserved `inbox:` step key. */
  const keyedEnvelope = <Type extends EnvelopeType>(idempotencyKey: string, type: Type, targetId?: string) => {
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
  /**
   * inbox-home.md I-6: a key for one step of a reply write, derived so a retry replays that step.
   * `inbox:` is a reserved prefix (SERVER_IDEMPOTENCY_PREFIXES), so no caller can take it first.
   */
  const stepKey = (key: string, step: string) => `inbox:${step}:${derivedId(tenantId, key, step)}`;
  /** I-6, approvals.md A-5: propose sending one drafted reply, for an owner to approve. */
  const proposeSend = async (reply: ReplyRecord, key: string) => {
    const { id, ...rest } = keyedEnvelope(key, "approval");
    const request = requestApprovalRequestSchema.parse({
      action: { actionType: SEND_REPLY_ACTION, target: { type: "inbox_reply", id: reply.id }, payload: { replyId: reply.id } },
      summary: `Send the reply "${reply.subject}"`,
    });
    return parseInput(approvalOutputSchema,
      await run({ actionType: "approval.request", ...rest, payload: { approvalId: id, ...request } }), "result").result;
  };
  const notDraft = (status: string) => new Conflict("The reply is no longer a draft", { reason: "not_draft", status });
  /** agents.md G-2: the settings target is the tenant itself. */
  /** business-profile.md BP-6: the profile target is the tenant itself, like the agent settings. */
  const businessEnvelope = (rawKey: unknown) => {
    const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
    return {
      target: { tenantId, type: "business_profile", id: tenantId },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
    };
  };
  const agentSettingsEnvelope = (rawKey: unknown) => {
    const idempotencyKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
    return {
      target: { tenantId, type: "agent_settings", id: tenantId },
      approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
      idempotencyKey,
    };
  };


  /**
   * Project committed state to the edge, re-checking the caller's permission in that read. It
   * gets its own time, short of the request's deadline: past it the answer is `pending`, and the
   * request still answers before its deadline would turn a committed write into a 503.
   */
  const syncSite = (sites: NonNullable<EdgeDependencies["sites"]>, siteId: string, options?: ProjectOptions) => {
    const budget = Math.min(sites.syncTimeoutMs ?? SITE_SYNC_TIMEOUT_MS, (deps.timeLeft?.() ?? Infinity) - SITE_SYNC_MARGIN_MS);
    if (budget <= 0) return Promise.resolve<SiteEdgeStatus>("pending");
    const work = syncSiteEdge(deps.db, sites.store, tenantId, siteId, async (tx) => { await requireMember(tx, tenantId, actorId, "publish"); }, options);
    work.catch(() => undefined);
    return withinBudget(work, budget);
  };
  /** After a committed write the answer is that write's result: a failed projection is only `pending`. */
  const syncAfterWrite = (sites: NonNullable<EdgeDependencies["sites"]>, siteId: string, options?: ProjectOptions) =>
    syncSite(sites, siteId, options).catch(() => "pending" as const);
  /** Sites are off without a store: every site route is then unknown. */
  const requireSites = () => {
    if (!deps.sites) throw new NotFound();
    return deps.sites;
  };

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
     * was withdrawn), then runs the send as that owner (approvals.md A-6, A-7). A reply with no
     * address is refused before anything is decided, so its proposal stays pending. A proposal
     * this owner approved under another call (whose run failed) is resumed under this call's key;
     * one another owner approved is theirs to finish. A retry with the same key replays.
     */
    async approveReply(replyId: unknown, body: unknown, key: unknown): Promise<ReplyOutput> {
      const id = parseInput(uuidSchema, replyId, "reply ID");
      parseInput(replyStepRequestSchema, body);
      const idempotencyKey = parseInput(idempotencyKeySchema, key, "Idempotency-Key");
      const now = new Date(readClock(deps.clock));
      const { reply, open, bound } = await read("approve", async (tx) => {
        const reply = await loadReply(tx, tenantId, id);
        if (reply?.status === "draft") await requireEmail(tx, tenantId, reply.contactId);
        const open = await openSendApproval(tx, tenantId, id, now);
        // The proposal to send this reply that this key already approved or resumed: a retry of
        // that call. Found whatever its status is now, so a send that committed replays after its
        // proposal expired or was revoked; the dispatcher refuses one that never ran (A-7).
        const bound = (await tx.query<{ id: string }>(
          `SELECT a.id FROM actions x JOIN approvals a ON a.tenant_id=x.tenant_id AND a.id::text = lower(x.payload->>'approvalId')
            WHERE x.tenant_id=$1 AND x.idempotency_key=$2 AND x.action_type IN ('approval.approve', $3)
              AND a.action_type=$4 AND a.target_type='inbox_reply' AND a.target_id=$5`,
          [tenantId, idempotencyKey, RESUME_REPLY_ACTION, SEND_REPLY_ACTION, id],
        )).rows[0]?.id ?? null;
        return { reply, open, bound };
      });
      if (!reply) throw new TenantDenied();
      const retry = bound !== null;
      // Once the reply has left draft, only a retry of the call that sent it replays.
      if (reply.status !== "draft" && !retry) throw notDraft(reply.status);
      let approvalId = bound ?? open?.id;
      if (!retry && open?.status === "approved") {
        // Only the deciding owner runs an approved action (A-7).
        if (open.decidedBy !== actorId)
          throw new Conflict("Another owner approved this reply", { reason: "approved_by_other", approvedBy: open.decidedBy });
        const { id: _id, ...rest } = envelope(idempotencyKey, "inbox_reply", id);
        await run({ actionType: RESUME_REPLY_ACTION, ...rest, payload: { replyId: id, approvalId: open.id } });
      } else if (!retry) {
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
        const { id: _approval, ...step } = keyedEnvelope(stepKey(rest.idempotencyKey, "withdraw"), "approval", open.id);
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

    // M4b sites: every read and write needs the publish permission (owners).
    listSites: async (): Promise<SiteList> => {
      requireSites();
      return { items: await read("publish", (tx) => listSites(tx, tenantId)) };
    },
    getSite: (siteId: unknown) => {
      requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      return read("publish", (tx) => getSite(tx, tenantId, id));
    },
    listSiteReleases: async (siteId: unknown): Promise<SiteReleaseList> => {
      requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      return { items: await read("publish", (tx) => listReleases(tx, tenantId, id)) };
    },
    getSiteRelease: (siteId: unknown, releaseId: unknown) => {
      requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const release = parseInput(uuidSchema, releaseId, "release ID");
      return read("publish", (tx) => getRelease(tx, tenantId, id, release));
    },
    async createSite(body: unknown, key: unknown) {
      requireSites();
      const request = parseInput(createSiteRequestSchema, body);
      const { id, ...rest } = envelope(key, "site");
      return createSite({ actionType: "site.create", ...rest, target: { tenantId, type: "site", id }, payload: { siteId: id, ...request } }, writeContext);
    },
    /**
     * Compile the spec, store its files, record the release and make it live, then move the
     * edge. Retried with its key, it compiles the same files and replays the recorded result
     * without touching the store, so a retry after a lost answer works during a store outage.
     */
    async publishSite(siteId: unknown, body: unknown, key: unknown): Promise<SiteReleaseResponse> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const request = parseInput(publishSiteRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "site", id);
      // Permission and ownership first, so nobody else's request stores bytes under this tenant.
      const recorded = await read("publish", async (tx) => {
        const site = await getSite(tx, tenantId, id);
        const replay = (await tx.query("SELECT 1 FROM actions WHERE tenant_id=$1 AND idempotency_key=$2", [tenantId, rest.idempotencyKey])).rowCount === 1;
        // Fail a stale edit before compiling and storing; the handler checks again under the site lock.
        if (!replay && request.expectedCurrentReleaseId !== undefined && site.currentReleaseId !== request.expectedCurrentReleaseId)
          throw new Conflict("Another release went live since this edit started", { reason: "stale_release" });
        return replay;
      });
      const release = await verifyCompiledSite(await sites.compiler.compile(request.spec));
      // A recorded key replays (or is refused as reused) in dispatch; its files were stored then.
      const verifiedBlobs = recorded ? undefined : await storeReleaseFiles(sites.store, tenantId, release).catch((cause: unknown) => {
        throw new SiteStoreUnavailable({ cause });
      });
      const output = await publishSiteRelease({
        actionType: "site.release.publish", ...rest, target: { tenantId, type: "site", id },
        payload: {
          siteId: id, releaseId: derivedId(tenantId, rest.idempotencyKey, "site_release"), spec: request.spec,
          entry: release.entry, digest: release.digest, files: [...release.files],
          // Only when sent: a payload without the key still matches what older keys recorded.
          ...(request.expectedCurrentReleaseId !== undefined ? { expectedCurrentReleaseId: request.expectedCurrentReleaseId } : {}),
        },
      }, writeContext);
      return { ...output, edge: await syncAfterWrite(sites, id, verifiedBlobs ? { verifiedBlobs } : {}) };
    },
    /** Compile without storing or recording anything: what a publish of this spec would serve. */
    async previewSite(siteId: unknown, body: unknown): Promise<SitePreview> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const request = parseInput(publishSiteRequestSchema, body);
      await read("publish", (tx) => getSite(tx, tenantId, id));
      const release = await verifyCompiledSite(await sites.compiler.compile(request.spec));
      const entry = release.files.find((file) => file.path === release.entry)!;
      const html = entry.mediaType.startsWith("text/html") && entry.bytes <= SITE_PREVIEW_HTML_BYTES
        ? new TextDecoder("utf-8", { fatal: false }).decode(release.bytes.get(entry.path)) : null;
      return { entry: release.entry, digest: release.digest, files: [...release.files], entryHtml: html };
    },
    /** Make an earlier (or later) release live again: the rollback. */
    async activateSiteRelease(siteId: unknown, releaseId: unknown, body: unknown, key: unknown): Promise<SiteReleaseResponse> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const release = parseInput(uuidSchema, releaseId, "release ID");
      const request = parseInput(activateSiteReleaseRequestSchema, body);
      const { id: _id, ...rest } = envelope(key, "site", id);
      const output = await activateSiteRelease({
        actionType: "site.release.activate", ...rest, target: { tenantId, type: "site", id },
        payload: { siteId: id, releaseId: release, expectedCurrentReleaseId: request.expectedCurrentReleaseId },
      }, writeContext);
      return { ...output, edge: await syncAfterWrite(sites, id) };
    },
    /** Retry the edge projection after a `pending` answer. */
    async syncSite(siteId: unknown): Promise<SiteSyncResponse> {
      const sites = requireSites();
      const id = parseInput(uuidSchema, siteId, "site ID");
      const site = await read("publish", (tx) => getSite(tx, tenantId, id));
      return { site, edge: await syncSite(sites, id) };
    },

    /** business-profile.md BP-5: who the business is; any member reads it. */
    getBusiness: (): Promise<BusinessProfile> => read(null, (tx) => getBusinessProfile(tx, tenantId)),
    /** BP-6, BP-7: owners change the fields named in `changes`, compare-and-set on the revision. */
    async updateBusiness(body: unknown, key: unknown): Promise<BusinessProfileOutput> {
      const request = parseInput(updateBusinessProfileRequestSchema, body);
      return parseInput(businessProfileOutputSchema,
        await run({ actionType: "business.profile.update", ...businessEnvelope(key), payload: toJson(request) }), "result");
    },

    /** The caller's own membership; any member may ask. `profile` adds the business name and email. */
    me: (options: { profile?: boolean } = {}): Promise<MeResponse> => deps.db.tenant(tenantId, async (tx) => {
      const access = await requireMember(tx, tenantId, actorId, null);
      const profile = options.profile ? await memberProfile(tx, tenantId, access.memberId) : {};
      return {
        tenantId, userId: actorId, memberId: access.memberId, role: access.role, permissions: [...ROLE_PERMISSIONS[access.role]],
        ...profile,
      };
    }),
    listMembers: async (): Promise<MemberList> => ({ items: await read("members", (tx) => listMembers(tx, tenantId)) }),
    /** The prepaid wallet (delivery.md D-4); billing is an owner permission. */
    getWallet: (): Promise<WalletSummary> => read("billing", (tx) => getWallet(tx, tenantId)),
    listTopUps: async (): Promise<{ items: TopUp[] }> => ({ items: await read("billing", (tx) => listTopUps(tx, tenantId)) }),

    /** stripe.md S-1, S-2: a pending top-up and its Stripe Checkout URL. */
    async createTopUp(body: unknown, key: unknown, signal?: AbortSignal): Promise<CreateTopUpResponse> {
      const billing = deps.billing;
      if (!billing) throw new NotFound();
      const request = parseInput(createTopUpRequestSchema, body);
      const { id, ...rest } = envelope(key, "wallet_topup");
      const config = billing.stripe.config;
      // S-1: the terms travel as dispatch config, never in the stored payload.
      const terms: TopUpDispatchConfig = { topUp: {
        currency: config.currency, minAmount: config.minTopUp, maxAmount: config.maxTopUp,
        checkout: { successUrl: config.successUrl, cancelUrl: config.cancelUrl, productName: config.productName },
      } };
      return startTopUp({
        command: { actionType: WALLET_TOPUP_CREATE_ACTION, ...rest, payload: { topupId: id, amount: request.amount } },
        dispatch: directDispatch(deps, tenantId, actorId, memberAuthorize(tenantId, actorId), terms),
        read: (topupId) => read("billing", (tx) => getTopUpForCheckout(tx, tenantId, topupId)),
        remember: (topupId, url) => read("billing", (tx) => rememberCheckoutUrl(tx, tenantId, topupId, url)),
        stripe: billing.stripe,
        tenantId,
        now: new Date(readClock(deps.clock)),
        ...(signal ? { signal } : {}),
      });
    },

    /** google-calendar.md G-5: the tenant's connections, never a token. */
    listCalendarConnections: async (): Promise<CalendarConnectionList> =>
      ({ items: await read("calendar", (tx) => listCalendarConnections(tx, tenantId)) }),
    /**
     * G-1: the consent URL for connecting one resource. Changes nothing: the connection ID derives
     * from the tenant and the key, the signed state names who asked, for what and from which
     * browser, and the PKCE verifier derives from the state secret and the connection ID, so the
     * callback rebuilds both.
     */
    async startGoogleConnect(body: unknown, key: unknown): Promise<ConnectGoogleCalendarResponse> {
      const calendar = deps.calendar;
      if (!calendar) throw new NotFound();
      const request = parseInput(connectGoogleCalendarRequestSchema, body);
      const { id: connectionId } = envelope(key, "calendar_connection");
      const now = readClock(deps.clock);
      await read("publish", async (tx) => {
        if (!(await resourceInTenant(tx, tenantId, request.resourceId)))
          throw new TenantDenied("Booking resource is not owned by this tenant");
        // The key names one connection: reused for another resource, or after that connection
        // retired, it would only end at a consent screen that answers `conflict`.
        const found = await getCalendarConnection(tx, tenantId, connectionId);
        if (found && (found.resourceId !== request.resourceId || found.status !== "active"))
          throw new IdempotencyConflict("Idempotency key belongs to another calendar connection");
      });
      const secret = calendar.stateSecrets.current;
      const state = signConnectState(secret, {
        tenantId, actorId, resourceId: request.resourceId, connectionId, browserBinding: request.browserBinding,
        expiresAt: now + CONNECT_STATE_LIFETIME_MS,
      });
      return parseInput(connectGoogleCalendarResponseSchema, {
        authorizeUrl: calendar.google.authorizeUrl({ state, codeChallenge: pkceChallenge(pkceVerifier(secret, connectionId)) }),
      }, "result");
    },
    /** G-2: the grant the callback staged for this member, for the owner to check its account. */
    async pendingGoogleConnect(token: unknown): Promise<PendingGoogleConnect> {
      await read("publish", async () => undefined);
      const grant = stagedGrant(token);
      return parseInput(pendingGoogleConnectSchema, {
        grantId: grant.grantId, resourceId: grant.resourceId, accountEmail: grant.accountEmail, expiresAt: new Date(grant.expiresAt).toISOString(),
      }, "result");
    },
    /**
     * G-2: connect the staged grant, as the member it names, under the reserved key
     * `oauth-google:<connection ID>` (so a repeat replays). Only an active connection for the
     * grant's resource counts as connected; one since retired, or another tab's grant for another
     * resource, is a conflict. `body.grantId` names the grant the owner was shown: a grant that
     * replaced it since is refused (409 `grant_changed`), never confirmed in its place.
     */
    async confirmGoogleConnect(token: unknown, body: unknown): Promise<CalendarConnection> {
      await read("publish", async () => undefined);
      const request = parseInput(confirmGoogleConnectRequestSchema, body);
      const grant = stagedGrant(token);
      if (request.grantId !== grant.grantId)
        throw new Conflict("Another Google account is waiting to be confirmed; check it again", { reason: "grant_changed" });
      const { connectionId, resourceId } = grant;
      const settled = async () => {
        const found = await read("publish", (tx) => getCalendarConnection(tx, tenantId, connectionId));
        if (found?.status === "active" && found.resourceId === resourceId) return found;
        throw new Conflict("Calendar connection changed since Google answered", { reason: "conflict" });
      };
      if (await read("publish", (tx) => getCalendarConnection(tx, tenantId, connectionId))) return settled();
      const idempotencyKey = googleConnectIdempotencyKey(connectionId);
      try {
        await run({
          actionType: CALENDAR_GOOGLE_CONNECT_ACTION,
          target: { tenantId, type: "calendar_connection", id: connectionId },
          approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
          idempotencyKey,
          payload: {
            connectionId, resourceId, accountEmail: grant.accountEmail, scope: grant.scope, refreshTokenSealed: grant.refreshTokenSealed,
          },
        });
      } catch (error) {
        // Another confirmation for this connection committed first, with its own grant.
        if (error instanceof IdempotencyConflict || error instanceof BindingMismatch) return settled();
        throw error;
      }
      return settled();
    },
    /** G-5: hand a connection to the worker for cleanup (G-9); a retired one answers as it is. */
    async disconnectCalendar(connectionId: unknown, key: unknown): Promise<{ actionId: string; result: CalendarConnection }> {
      const id = parseInput(uuidSchema, connectionId, "connection ID");
      const { id: _id, ...rest } = envelope(key, "calendar_connection", id);
      const outcome = await run({ actionType: CALENDAR_GOOGLE_DISCONNECT_ACTION, ...rest, payload: { connectionId: id } });
      return { actionId: outcome.actionId, result: parseInput(calendarConnectionSchema, outcome.result, "result") };
    },

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
      // A-6: when this caller already approved it and its action has not run (the run failed),
      // approve goes straight to the run, whatever key it carries; the run key stays the approval's.
      const decided = await read("approve", async (tx) => {
        const row = await loadApproval(tx, tenantId, id);
        if (!row || row.status !== "approved" || row.decided_by !== actorId || row.executed_action_id !== null) return null;
        return (await tx.query<{ id: string; result: JsonValue }>(
          `SELECT id, result FROM actions
            WHERE tenant_id=$1 AND action_type='approval.approve' AND target->>'type'='approval' AND target->>'id'=$2 AND actor_id=$3
            ORDER BY created_at LIMIT 1`, [tenantId, id, actorId])).rows[0] ?? null;
      });
      const approval = parseInput(approvalOutputSchema, decided
        ? { actionId: decided.id, result: decided.result }
        : await run({ actionType: "approval.approve", ...rest, payload: defined({ approvalId: id, ...request }) }), "result");
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

    /** agents.md G-11: the follow-up agent's settings and switches; any member who drafts may read them. */
    getFollowUpStatus: (): Promise<FollowUpStatus> => {
      const now = new Date(readClock(deps.clock));
      return read("inbox.drafts", (tx) => followUpStatus(tx, tenantId, now));
    },
    /** G-2: owners replace the settings, compare-and-set on the revision. */
    async updateFollowUpSettings(body: unknown, key: unknown): Promise<FollowUpStatusOutput> {
      const request = parseInput(updateFollowUpSettingsRequestSchema, body);
      return parseInput(followUpStatusOutputSchema,
        await run({ actionType: "agent.settings.update", ...agentSettingsEnvelope(key), payload: request }), "result");
    },
    /** G-3: stop the agent drafting for this tenant at once; staff may too. */
    async killFollowUp(body: unknown, key: unknown): Promise<FollowUpStatusOutput> {
      const request = parseInput(killFollowUpRequestSchema, body);
      return parseInput(followUpStatusOutputSchema,
        await run({ actionType: "agent.kill", ...agentSettingsEnvelope(key), payload: defined(request) }), "result");
    },
    /** G-3: owners let it draft again. */
    async resumeFollowUp(body: unknown, key: unknown): Promise<FollowUpStatusOutput> {
      const request = parseInput(resumeFollowUpRequestSchema, body);
      return parseInput(followUpStatusOutputSchema,
        await run({ actionType: "agent.resume", ...agentSettingsEnvelope(key), payload: request }), "result");
    },
    listFollowUpRuns: (query: unknown): Promise<FollowUpRunPage> => {
      const parsed = parseInput(listFollowUpRunsQuerySchema, query, "query");
      return read("inbox.drafts", (tx) => listRuns(tx, tenantId, parsed));
    },
    getFollowUpRun: (runId: unknown): Promise<FollowUpRunDetail> => {
      const id = parseInput(uuidSchema, runId, "run ID");
      return read("inbox.drafts", async (tx) => {
        const found = await getRun(tx, tenantId, id);
        if (!found) throw new NotFound();
        return found;
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
