// M2a owner/staff matrix, enforced in core: every action and read the edge session offers,
// run as an owner, a staff member and a signed-in stranger under the runtime role. M3 intake
// review is owner-only; the public principal runs the one public action and nothing else.
// M3b: owners decide approvals; source records need their subject's permission.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS, TenantDenied, roleCan, type MemberRole, type Permission } from "@zs/contracts";
import { asService, type Transaction } from "@zs/db";
import { createTestDatabase, createTwoTenantFixture, type TestDatabase, type TwoTenantFixture } from "@zs/db/testing";
import { createPublicSession } from "../src/edge/public-session.js";
import { ACTION_PERMISSIONS, PAYLOAD_PERMISSION_ACTIONS, createSession, type EdgeDependencies, type Session } from "../src/edge/session.js";
import { PUBLIC_REQUEST_ACTION } from "../src/intake/public-request.js";
import {
  AGENT_ACTIONS, agentHandlers, browserHandlers, createFakeImageWorkflowPort, createImageWorker, creditWallet, enrichmentHandlers, approvalHandlers, bookingContactHandlers, bookingHandlers, businessHandlers, calendarHandlers, createDispatcher, createMemorySiteStore,
  crmHandlers, dealDetailsHandlers, documentIntakeHandlers, generateSealKeyPair, imageHandlers, inboxHandlers, intakeHandlers, memberHandlers, parseSealPublicKey,
  parseImageConfig, pendingGrantId, plainSiteCompiler, sealRefreshToken, signPendingGrant, siteHandlers, sourceHandlers, stripeConfigSchema, topUpHandlers, type DispatchContext,
  type GoogleClient, type StripeClient,
} from "../src/index.js";
import { encodeRgbaPng } from "../src/images/png.js";

const NOW = "2026-10-19T08:00:00.000Z";
const clock = { now: () => new Date(NOW) };
/** Synthetic booking key secret, built at runtime so secret scanners do not flag a literal. */
const bookingKeys = { secret: ["test", "booking", "k".repeat(32)].join("-"), publicBaseUrl: "http://book.test" };

/** The image worker's own steps: its principal runs them, no member does (image-port.md IM-10). */
const IMAGE_WORKER_ACTIONS = ["media.variant.stage", "media.variant.fail"];

/** What each action needs, written out so a change to the map has to change this test too. */
const EXPECTED_ACTIONS: Record<string, Permission> = {
  "booking.create": "calendar",
  "media.asset.upload": "publish",
  "media.variant.generate": "publish",
  "media.variant.approve": "publish",
  "media.variant.reject": "publish",
  // booking-customer.md BC-3: the handler also needs `customers`; staff and owners hold both.
  "booking.contact.link": "calendar",
  "booking.contact.unlink": "calendar",
  "crm.contact.create-or-find": "customers",
  "crm.deal.create": "customers",
  "crm.deal.move-stage": "customers",
  "crm.deal.set-details": "customers",
  "inbox.reply.draft": "inbox.drafts",
  "inbox.reply.discard": "inbox.drafts",
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
  "wallet.topup.create": "billing",
  "calendar.google.connect": "publish",
  "calendar.google.disconnect": "publish",
  "catalog.intake.apply": "publish",
  "catalog.intake.discard": "publish",
  "catalog.intake.upload": "publish",
  "agent.settings.update": "agents",
  "agent.kill": "inbox.drafts",
  "agent.resume": "agents",
  "agent.kind.settings.update": "agents",
  "agent.kind.kill": "inbox.drafts",
  "agent.kind.resume": "agents",
  // browser-tasks.md BT-9, BT-11: owners change and run website tasks; any member who drafts may stop them.
  "browser.kill": "inbox.drafts",
  "browser.resume": "agents",
  "browser.run.request": "agents",
  "browser.settings.update": "agents",
  "browser.target.save": "agents",
  "business.profile.update": "business",
  "enrichment.request": "enrich",
  "contact.enrichment.block": "customers",
  "contact.enrichment.unblock": "enrich",
  "contact.region.attest": "enrich",
  "contact.profile.apply": "enrich",
};

interface Tenant {
  tenantId: string;
  resourceId: string;
  pipelineId: string;
  stages: [string, string];
  ownerId: string;
  dealId: string;
  contactId: string;
  /** A published booking page over its own every-day resource, for website requests. */
  pageId: string;
  publicResourceId: string;
  /** A published site and its first release, for the site reads and the rollback. */
  siteId: string;
  releaseId: string;
}

let database: TestDatabase;
let fixture: TwoTenantFixture;
let tenant: Tenant;

async function addMember(tenantId: string, role: MemberRole): Promise<{ userId: string; memberId: string }> {
  const userId = randomUUID();
  const memberId = randomUUID();
  await fixture.service((tx) => tx.query(
    "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)",
    [tenantId, memberId, `${role}-${memberId.slice(0, 8)}@example.com`, userId, role, NOW],
  ));
  return { userId, memberId };
}

/** A Stripe client that answers every Checkout request; the key is synthetic, built at runtime. */
const stripe: StripeClient = {
  config: stripeConfigSchema.parse({
    secretKey: ["sk", "test", "x".repeat(24)].join("_"), successUrl: "https://app.test/paid", cancelUrl: "https://app.test/cancel",
  }),
  createCheckoutSession: async (request) => ({ id: `cs_test_${request.topupId.replaceAll("-", "")}`, url: "https://checkout.stripe.test/pay" }),
};
/** Google answers only the consent URL here; the OAuth callback has its own tests. */
const unused = async (): Promise<never> => { throw new Error("not used"); };
const google: GoogleClient = {
  authorizeUrl: ({ state, codeChallenge }) => `https://accounts.google.test/auth?state=${state}&code_challenge=${codeChallenge}`,
  exchangeCode: unused, refreshAccessToken: unused, revoke: unused, listEvents: unused, insertEvent: unused, watch: unused, stopChannel: unused,
};
const tokenPublicKey = parseSealPublicKey(generateSealKeyPair().publicKey);
/** Synthetic OAuth state secret, built at runtime like the booking key secret. */
const calendar = { google, stateSecrets: { current: ["test", "oauth", "s".repeat(32)].join("-") }, tokenPublicKey };
const sites = { store: createMemorySiteStore(), compiler: plainSiteCompiler };
const images = { store: createMemorySiteStore(), config: parseImageConfig({ environment: "test", adapter: "fake" }) };
const deps = (): EdgeDependencies => ({ db: database.db, clock, generateId: randomUUID, bookingKeys, billing: { stripe }, calendar, sites, images });
const siteSpec = { kind: "plain", title: "Halden & Rowe" };
const sessionFor = (actorId: string, tenantId = tenant.tenantId): Session => createSession(deps(), { tenantId, actorId });

/** Each website request takes the next free hour, from Tuesday 09:00 UTC. */
let publicSlot = 0;
/** A website request from a known email: a `possible_match` item the owner must review. */
async function intakeItem(): Promise<string> {
  const n = publicSlot++;
  const startsAt = `2026-10-${20 + Math.floor(n / 8)}T${String(9 + (n % 8)).padStart(2, "0")}:00:00.000Z`;
  const reply = await createPublicSession(deps(), { tenantId: tenant.tenantId, pageId: tenant.pageId }).request({
    resourceId: tenant.publicResourceId, startsAt, name: "Ada", email: "ada@example.com",
    consent: { email: false, sms: false }, disclosureVersion: "v1", channel: "widget", website: "",
  }, randomUUID());
  return reply.requestId;
}

async function actionRows(tenantId: string, actorId: string): Promise<number> {
  return Number((await fixture.service((tx) => tx.query<{ n: string }>(
    "SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND actor_id=$2", [tenantId, actorId],
  ))).rows[0]!.n);
}

beforeAll(async () => {
  database = await createTestDatabase();
  fixture = await createTwoTenantFixture(database);
  const tenantId = fixture.a.tenantId;
  const resourceId = randomUUID();
  const pipelineId = randomUUID();
  const stages: [string, string] = [randomUUID(), randomUUID()];
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,30,0,0,0,20160)`,
      [tenantId, resourceId, JSON.stringify([{ weekday: 1, windows: [{ startMinute: 540, endMinute: 1020 }] }])],
    );
    await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,'Sales')", [tenantId, pipelineId]);
    await tx.query(
      "INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position) VALUES ($1,$2,$3,'New',0),($1,$4,$3,'Won',1)",
      [tenantId, stages[0], pipelineId, stages[1]],
    );
  });
  const publicResourceId = randomUUID();
  const pageId = randomUUID();
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
         buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
       VALUES ($1,$2,'UTC',$3::jsonb,'[]'::jsonb,60,60,0,0,0,20160)`,
      [tenantId, publicResourceId, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
    );
    await tx.query(
      "INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at) VALUES ($1,$2,'Book',true,'v1',$3)",
      [tenantId, pageId, NOW],
    );
    await tx.query("INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,0)", [tenantId, pageId, publicResourceId]);
  });
  const owner = await addMember(tenantId, "owner");
  const ownerSession = createSession(deps(), { tenantId, actorId: owner.userId });
  const contact = await ownerSession.upsertContact({ displayName: "Ada", email: "ada@example.com" }, randomUUID());
  const deal = await ownerSession.createDeal(
    { contactId: contact.result.contact.id, pipelineId, stageId: stages[0], title: "Ring" }, randomUUID());
  const site = await ownerSession.createSite({ name: "Main" }, randomUUID());
  const release = await ownerSession.publishSite(site.result.id, { spec: siteSpec }, randomUUID());
  tenant = {
    tenantId, resourceId, pipelineId, stages, ownerId: owner.userId, dealId: deal.result.id, contactId: contact.result.contact.id,
    pageId, publicResourceId, siteId: site.result.id, releaseId: release.result.release.id,
  };
});
afterAll(async () => { await database?.close(); });

/** Monday 09:00-17:00 UTC: each booking takes the next free hour. */
let hour = 9;
let shade = 1;

/** A draft by the owner, for steps any caller may then try on it. */
async function ownerDraft(): Promise<string> {
  return (await sessionFor(tenant.ownerId).draftReply({ contactId: tenant.contactId, body: "Thanks, see you soon." }, randomUUID())).result.id;
}

/** IM-22, IM-23: a fresh upload upscaled and staged by the image worker, for the variant decisions. */
async function stagedVariant(): Promise<{ id: string; sha256: string }> {
  const owner = sessionFor(tenant.ownerId);
  const source = await owner.uploadMediaAsset(
    encodeRgbaPng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(shade++ % 250 + 1) }), "image/png", randomUUID());
  const queued = await owner.generateImageVariant({ sourceAssetId: source.result.id, preset: "upscale_2k", params: {} }, randomUUID());
  const service = <T>(work: (tx: Transaction) => Promise<T>) => asService(database.servicePool, work);
  // Other operations leave queued jobs behind: pay for them too, and run until this one is done.
  await service((tx) => creditWallet(tx, {
    tenantId: tenant.tenantId, ledgerId: randomUUID(), amount: 100_000, idempotencyKey: `credit:${randomUUID()}`, now: new Date(NOW),
  }));
  const worker = createImageWorker({
    service, db: database.db, store: images.store, port: createFakeImageWorkflowPort(), config: images.config, clock, generateId: randomUUID,
  });
  let staged = await owner.getImageVariant(queued.result.id);
  for (let pass = 0; pass < 10 && staged.status === "queued"; pass += 1) {
    await worker.runOnce();
    staged = await owner.getImageVariant(queued.result.id);
  }
  expect(staged.status).toBe("staged");
  return { id: staged.id, sha256: staged.sha256! };
}

/** A booking made by the tenant's owner, for the booking-contact steps. */
let customerSlot = 0;
let customerResource: string | undefined;
async function ownerBooking(): Promise<string> {
  // A resource open every day, so these steps never use the Monday hours the other operations count on.
  if (!customerResource) {
    customerResource = await freshResource();
    await fixture.service((tx) => tx.query(
      "UPDATE booking_resources SET weekly=$3::jsonb, slot_step_minutes=60 WHERE tenant_id=$1 AND id=$2",
      [tenant.tenantId, customerResource, JSON.stringify([1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, windows: [{ startMinute: 540, endMinute: 1020 }] })))],
    ));
  }
  const n = customerSlot++;
  const startsAt = `2026-10-${20 + Math.floor(n / 8)}T${String(9 + (n % 8)).padStart(2, "0")}:00:00.000Z`;
  return (await sessionFor(tenant.ownerId).createBooking({ resourceId: customerResource, startsAt }, randomUUID())).result.id;
}

/** One call per session operation. Each builds fresh inputs, so it can run for any caller. */
function operations(session: Session, actorId: string = randomUUID()): Record<string, { permission: Permission | null; run: () => Promise<unknown> }> {
  return {
    createBooking: { permission: "calendar", run: () => session.createBooking(
      { resourceId: tenant.resourceId, startsAt: `2026-10-19T${String(hour++).padStart(2, "0")}:00:00.000Z` }, randomUUID()) },
    // booking-customer.md BC-3: the booking is the owner's; the caller under test links its customer.
    linkBookingContact: { permission: "calendar", run: async () => {
      const bookingId = await ownerBooking();
      return session.linkBookingContact(bookingId, { contactId: tenant.contactId, expectedRevision: 0 }, randomUUID());
    } },
    unlinkBookingContact: { permission: "calendar", run: async () => {
      const bookingId = await ownerBooking();
      await sessionFor(tenant.ownerId).linkBookingContact(bookingId, { contactId: tenant.contactId, expectedRevision: 0 }, randomUUID());
      return session.unlinkBookingContact(bookingId, { expectedRevision: 1 }, randomUUID());
    } },
    getBooking: { permission: "calendar", run: async () => session.getBooking(await ownerBooking()) },
    upsertContact: { permission: "customers", run: () => session.upsertContact({ displayName: "Bo", email: `${randomUUID()}@example.com` }, randomUUID()) },
    createDeal: { permission: "customers", run: async () => {
      const contact = await sessionFor(tenant.ownerId).upsertContact({ email: `${randomUUID()}@example.com` }, randomUUID());
      return session.createDeal({ contactId: contact.result.contact.id, pipelineId: tenant.pipelineId, stageId: tenant.stages[0], title: "Band" }, randomUUID());
    } },
    setDealDetails: { permission: "customers", run: async () => {
      const deals = await sessionFor(tenant.ownerId).listDeals({ limit: 100 });
      const current = deals.items.find((deal) => deal.id === tenant.dealId)!;
      return session.setDealDetails(tenant.dealId,
        { expectedRevision: current.revision, value: { amountMinor: 1_000, currency: "USD" }, leadSource: "referral" }, randomUUID());
    } },
    draftReply: { permission: "inbox.drafts", run: () => session.draftReply({ contactId: tenant.contactId, body: "Hello from the shop" }, randomUUID()) },
    approveReply: { permission: "approve", run: async () => session.approveReply(await ownerDraft(), {}, randomUUID()) },
    discardReply: { permission: "inbox.drafts", run: async () => session.discardReply(await ownerDraft(), {}, randomUUID()) },
    listThreads: { permission: "inbox.drafts", run: () => session.listThreads({}) },
    getThread: { permission: "inbox.drafts", run: async () => {
      await ownerDraft();
      return session.getThread(`c_${tenant.contactId}`);
    } },
    homeResults: { permission: "reports", run: () => session.homeResults({ zone: "America/New_York" }) },
    moveDealStage: { permission: "customers", run: async () => {
      const deals = await sessionFor(tenant.ownerId).listDeals({ limit: 100 });
      const current = deals.items.find((deal) => deal.id === tenant.dealId)!;
      const stageId = current.stageId === tenant.stages[0] ? tenant.stages[1] : tenant.stages[0];
      return session.moveDealStage(tenant.dealId, { pipelineId: tenant.pipelineId, stageId, expectedRevision: current.revision }, randomUUID());
    } },
    inviteMember: { permission: "members", run: () => session.inviteMember({ email: `${randomUUID()}@example.com`, role: "staff" }, randomUUID()) },
    changeMemberRole: { permission: "members", run: async () => {
      const target = await addMember(tenant.tenantId, "staff");
      return session.changeMemberRole(target.memberId, { role: "owner" }, randomUUID());
    } },
    removeMember: { permission: "members", run: async () => {
      const target = await addMember(tenant.tenantId, "staff");
      return session.removeMember(target.memberId, randomUUID());
    } },
    listBookings: { permission: "calendar", run: () => session.listBookings({}) },
    listResources: { permission: "calendar", run: () => session.listResources() },
    findSlots: { permission: "calendar", run: () => session.findSlots(
      { resourceId: tenant.resourceId, from: "2026-10-19T08:00:00.000Z", to: "2026-10-20T08:00:00.000Z" }) },
    listContacts: { permission: "customers", run: () => session.listContacts({}) },
    getContact: { permission: "customers", run: () => session.getContact(tenant.contactId) },
    listDeals: { permission: "customers", run: () => session.listDeals({}) },
    listPipelines: { permission: "customers", run: () => session.listPipelines() },
    listMembers: { permission: "members", run: () => session.listMembers() },
    uploadMediaAsset: { permission: "publish", run: () => session.uploadMediaAsset(
      encodeRgbaPng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(shade++ % 250 + 1) }), "image/png", randomUUID()) },
    generateImageVariant: { permission: "publish", run: async () => {
      const source = await sessionFor(tenant.ownerId).uploadMediaAsset(
        encodeRgbaPng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(shade++ % 250 + 1) }), "image/png", randomUUID());
      return session.generateImageVariant({ sourceAssetId: source.result.id, preset: "background_remove", params: {} }, randomUUID());
    } },
    listMediaAssets: { permission: "publish", run: () => session.listMediaAssets() },
    listImageVariants: { permission: "publish", run: () => session.listImageVariants() },
    getImageVariant: { permission: "publish", run: async () => {
      const source = await sessionFor(tenant.ownerId).uploadMediaAsset(
        encodeRgbaPng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(shade++ % 250 + 1) }), "image/png", randomUUID());
      const queued = await sessionFor(tenant.ownerId).generateImageVariant({ sourceAssetId: source.result.id, preset: "background_remove", params: {} }, randomUUID());
      return session.getImageVariant(queued.result.id);
    } },
    readMediaAssetContent: { permission: "publish", run: async () => {
      const source = await sessionFor(tenant.ownerId).uploadMediaAsset(
        encodeRgbaPng({ width: 2, height: 2, rgba: new Uint8Array(16).fill(shade++ % 250 + 1) }), "image/png", randomUUID());
      return session.readMediaAssetContent(source.result.id);
    } },
    readImageVariantContent: { permission: "publish", run: async () => session.readImageVariantContent((await stagedVariant()).id) },
    requestImageVariantApproval: { permission: "publish", run: async () => {
      const staged = await stagedVariant();
      return session.requestImageVariantApproval(staged.id, { sha256: staged.sha256 }, randomUUID());
    } },
    rejectImageVariant: { permission: "publish", run: async () => {
      const staged = await stagedVariant();
      return session.rejectImageVariant(staged.id, { sha256: staged.sha256 }, randomUUID());
    } },
    getWallet: { permission: "billing", run: () => session.getWallet() },
    // stripe.md S-1: only owners add money.
    listTopUps: { permission: "billing", run: () => session.listTopUps() },
    createTopUp: { permission: "billing", run: () => session.createTopUp({ amount: 1_000 }, randomUUID()) },
    linkIntakeItem: { permission: "intake", run: async () => session.linkIntakeItem(await intakeItem(), { contactId: tenant.contactId }, randomUUID()) },
    rejectIntakeItem: { permission: "intake", run: async () => session.rejectIntakeItem(await intakeItem(), {}, randomUUID()) },
    listIntakeItems: { permission: "intake", run: () => session.listIntakeItems({}) },
    listBookingPages: { permission: "publish", run: () => session.listBookingPages() },
    listSites: { permission: "publish", run: () => session.listSites() },
    getSite: { permission: "publish", run: () => session.getSite(tenant.siteId) },
    listSiteReleases: { permission: "publish", run: () => session.listSiteReleases(tenant.siteId) },
    getSiteRelease: { permission: "publish", run: () => session.getSiteRelease(tenant.siteId, tenant.releaseId) },
    createSite: { permission: "publish", run: () => session.createSite({ name: "Another" }, randomUUID()) },
    publishSite: { permission: "publish", run: () => session.publishSite(tenant.siteId, { spec: { ...siteSpec, tagline: randomUUID() } }, randomUUID()) },
    activateSiteRelease: { permission: "publish", run: async () => {
      const live = await sessionFor(tenant.ownerId).getSite(tenant.siteId);
      return session.activateSiteRelease(tenant.siteId, tenant.releaseId, { expectedCurrentReleaseId: live.currentReleaseId }, randomUUID());
    } },
    previewSite: { permission: "publish", run: () => session.previewSite(tenant.siteId, { spec: siteSpec }) },
    syncSite: { permission: "publish", run: () => session.syncSite(tenant.siteId) },
    me: { permission: null, run: () => session.me() },
    // M3b approvals: anyone may request what they may do; owners decide (approvals.md A-5, A-6).
    requestApproval: { permission: "calendar", run: () => session.requestApproval({ action: proposal(), summary: "Book" }, randomUUID()) },
    approveApproval: { permission: "approve", run: async () => session.approveApproval(await ownerProposal(true), {}, randomUUID()) },
    rejectApproval: { permission: "approve", run: async () => session.rejectApproval(await ownerProposal(), {}, randomUUID()) },
    revokeApproval: { permission: "approve", run: async () => session.revokeApproval(await ownerProposal(), {}, randomUUID()) },
    listApprovals: { permission: null, run: () => session.listApprovals({}) },
    // Another member's approval reads as NotFound to staff (A-11, approvals.test.ts); their own is visible.
    getApproval: { permission: "calendar", run: async () =>
      session.getApproval((await session.requestApproval({ action: proposal(), summary: "Mine" }, randomUUID())).result.id) },
    observeSource: { permission: "customers", run: () => session.observeSource(
      { subject: { type: "contact", id: tenant.contactId }, source: "owner" }, randomUUID()) },
    listSources: { permission: "customers", run: () => session.listSources({ subjectType: "contact", subjectId: tenant.contactId }) },
    // google-calendar.md G-1, G-5: owners connect and disconnect; members with the calendar see the list.
    listCalendarConnections: { permission: "calendar", run: () => session.listCalendarConnections() },
    startGoogleConnect: { permission: "publish", run: () => session.startGoogleConnect({ resourceId: tenant.resourceId, browserBinding: "b".repeat(43) }, randomUUID()) },
    disconnectCalendar: { permission: "publish", run: async () => session.disconnectCalendar(await calendarConnection(), randomUUID()) },
    // G-2: the owner reads and confirms a grant the callback staged for them.
    pendingGoogleConnect: { permission: "publish", run: async () => session.pendingGoogleConnect(stagedGrant(actorId, await freshResource())) },
    confirmGoogleConnect: { permission: "publish", run: async () => {
      const token = stagedGrant(actorId, await freshResource());
      return session.confirmGoogleConnect(token, { grantId: pendingGrantId(token) });
    } },
    // M6 follow-up agent: owners set it up and resume it; anyone who drafts may read it or stop it (agents.md G-11).
    // business-profile.md BP-5, BP-6: any member reads the profile; only owners change it.
    getBusiness: { permission: null, run: () => session.getBusiness() },
    updateBusiness: { permission: "business", run: async () => {
      const { revision } = await sessionFor(tenant.ownerId).getBusiness();
      return session.updateBusiness({ expectedRevision: revision, changes: { currency: "EUR" } }, randomUUID());
    } },
    getFollowUpStatus: { permission: "inbox.drafts", run: () => session.getFollowUpStatus() },
    updateFollowUpSettings: { permission: "agents", run: async () => {
      const { settings, revision } = await sessionFor(tenant.ownerId).getFollowUpStatus();
      return session.updateFollowUpSettings({ ...settings, expectedRevision: revision }, randomUUID());
    } },
    killFollowUp: { permission: "inbox.drafts", run: () => session.killFollowUp({ note: "Stop" }, randomUUID()) },
    resumeFollowUp: { permission: "agents", run: () => session.resumeFollowUp({}, randomUUID()) },
    getAgentKindStatus: { permission: "inbox.drafts", run: () => session.getAgentKindStatus("review_request") },
    updateAgentKindSettings: { permission: "agents", run: async () => {
      const { settings, revision } = await sessionFor(tenant.ownerId).getAgentKindStatus("review_request");
      return session.updateAgentKindSettings("review_request", { ...settings, expectedRevision: revision }, randomUUID());
    } },
    killAgentKind: { permission: "inbox.drafts", run: () => session.killAgentKind("review_request", { note: "Stop" }, randomUUID()) },
    resumeAgentKind: { permission: "agents", run: () => session.resumeAgentKind("review_request", {}, randomUUID()) },
    listFollowUpRuns: { permission: "inbox.drafts", run: () => session.listFollowUpRuns({}) },
    getFollowUpRun: { permission: "inbox.drafts", run: async () => {
      const runId = randomUUID();
      await fixture.service((tx) => tx.query(
        "INSERT INTO agent_runs (tenant_id,id,started_at,finished_at,status,max_decisions) VALUES ($1,$2,$3,$3,'completed',3)", [tenant.tenantId, runId, NOW]));
      return session.getFollowUpRun(runId);
    } },
  };
}

/** A booking resource of its own, so each calendar connection has a free one. */
async function freshResource(): Promise<string> {
  const resourceId = randomUUID();
  await fixture.service((tx) => tx.query(
    `INSERT INTO booking_resources (tenant_id,id,time_zone,weekly,overrides,slot_length_minutes,slot_step_minutes,
       buffer_before_minutes,buffer_after_minutes,minimum_notice_minutes,booking_horizon_minutes)
     VALUES ($1,$2,'UTC','[]'::jsonb,'[]'::jsonb,60,30,0,0,0,20160)`, [tenant.tenantId, resourceId]));
  return resourceId;
}

/** A grant the OAuth callback staged for `actorId` (G-2). */
function stagedGrant(actorId: string, resourceId: string): string {
  const connectionId = randomUUID();
  return signPendingGrant(calendar.stateSecrets.current, {
    tenantId: tenant.tenantId, actorId, resourceId, connectionId, accountEmail: "owner@calendar.test", scope: "https://www.googleapis.com/auth/calendar",
    refreshTokenSealed: sealRefreshToken(tokenPublicKey, { tenantId: tenant.tenantId, connectionId }, "1//refresh"), expiresAt: Date.parse(NOW) + 60_000,
  })!;
}

/** An active connection on its own resource, as the OAuth callback's connect action leaves it. */
async function calendarConnection(): Promise<string> {
  const id = randomUUID();
  const resourceId = await freshResource();
  await fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO calendar_connections (tenant_id,id,resource_id,status,refresh_token_sealed,created_by,next_sync_at,created_at,updated_at)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$6,$6)`,
      [tenant.tenantId, id, resourceId, sealRefreshToken(tokenPublicKey, { tenantId: tenant.tenantId, connectionId: id }, "1//refresh"),
        tenant.ownerId, NOW]);
  });
  return id;
}

/** A booking proposal; only one that will run needs a free hour (`next`). */
function proposal(next = false) {
  const bookingId = randomUUID();
  const startsAt = next ? `2026-10-19T${String(hour++).padStart(2, "0")}:00:00.000Z` : "2026-10-19T09:00:00.000Z";
  return { actionType: "booking.create", target: { type: "booking", id: bookingId }, payload: { bookingId, resourceId: tenant.resourceId, startsAt } };
}
/** A pending approval the tenant's owner asked for; only approvers may see or decide it. */
async function ownerProposal(next = false): Promise<string> {
  return (await sessionFor(tenant.ownerId).requestApproval({ action: proposal(next), summary: "Book" }, randomUUID())).result.id;
}

describe("permission map", () => {
  it("names a permission for every registered action, and only those", () => {
    // The public request is the one action no member session may run (public-intake.md P-1).
    // M3b: three actions take their permission from the payload (approvals.md A-8, A-9, F-2).
    const registered = Object.keys({
      ...bookingHandlers, ...bookingContactHandlers, ...crmHandlers, ...dealDetailsHandlers, ...inboxHandlers, ...intakeHandlers, ...memberHandlers,
      ...approvalHandlers, ...sourceHandlers, ...topUpHandlers, ...calendarHandlers, ...siteHandlers, ...agentHandlers, ...browserHandlers, ...businessHandlers, ...imageHandlers, ...enrichmentHandlers, ...documentIntakeHandlers,
    })
      // M6: the agent's own run actions belong to the agent principal only (agents.md G-1); the intake worker's result and fail actions
      // belong to its server-side principal (document-intake.md DL-5); the image worker's to its own.
      .filter((action) => action !== PUBLIC_REQUEST_ACTION && !PAYLOAD_PERMISSION_ACTIONS.includes(action) && !AGENT_ACTIONS.includes(action) && !IMAGE_WORKER_ACTIONS.includes(action) && action !== "catalog.intake.result" && action !== "catalog.intake.fail")
      .sort();
    expect([...PAYLOAD_PERMISSION_ACTIONS].sort()).toEqual(["approval.request", "approval.revoke", "source.observe"]);
    expect(Object.keys(ACTION_PERMISSIONS).sort()).toEqual(registered);
    expect(Object.keys(ACTION_PERMISSIONS)).not.toContain(PUBLIC_REQUEST_ACTION);
    for (const action of AGENT_ACTIONS) expect(Object.keys(ACTION_PERMISSIONS)).not.toContain(action);
    expect({ ...ACTION_PERMISSIONS }).toEqual(EXPECTED_ACTIONS);
  });

  it("leaves members, billing, plan, publish, intake review, approving, reports, integrations, agents and the business profile to owners", () => {
    expect(ROLE_PERMISSIONS.staff).toEqual(["calendar", "customers", "inbox.drafts"]);
    for (const permission of ["members", "billing", "plan", "publish", "intake", "approve", "reports", "integrations", "agents", "business", "enrich"] as const) {
      expect(roleCan("staff", permission)).toBe(false);
      expect(roleCan("owner", permission)).toBe(true);
    }
  });
});

describe("every session operation, per role", () => {
  it("covers every operation a session offers", () => {
    const session = sessionFor(randomUUID());
    const offered = Object.keys(session).filter((name) => typeof session[name as keyof Session] === "function");
    expect(Object.keys(operations(session)).sort()).toEqual(offered.sort());
  });

  for (const role of ["owner", "staff"] as const) {
    it(`${role}: allowed exactly where the role grants the permission`, async () => {
      const { userId } = await addMember(tenant.tenantId, role);
      const session = sessionFor(userId);
      for (const [name, operation] of Object.entries(operations(session, userId))) {
        const allowed = operation.permission === null || roleCan(role, operation.permission);
        if (allowed) await expect(operation.run(), `${role} ${name}`).resolves.toBeDefined();
        else await expect(operation.run(), `${role} ${name}`).rejects.toBeInstanceOf(TenantDenied);
      }
      // Staff wrote calendar and customer actions, never a member action.
      const memberActions = Number((await fixture.service((tx) => tx.query<{ n: string }>(
        "SELECT count(*) AS n FROM actions WHERE tenant_id=$1 AND actor_id=$2 AND action_type LIKE 'member.%'", [tenant.tenantId, userId],
      ))).rows[0]!.n);
      expect(memberActions).toBe(role === "owner" ? 3 : 0);
    });
  }

  it("refuses a caller with no membership, and a member of another tenant, everything", async () => {
    const outsiders = [randomUUID(), (await addMember(fixture.b.tenantId, "owner")).userId];
    for (const actorId of outsiders) {
      for (const [name, operation] of Object.entries(operations(sessionFor(actorId), actorId)))
        await expect(operation.run(), name).rejects.toBeInstanceOf(TenantDenied);
      expect(await actionRows(tenant.tenantId, actorId)).toBe(0);
    }
  });

  it("re-reads the role on every call: a demoted owner loses member actions at once", async () => {
    const promoted = await addMember(tenant.tenantId, "owner");
    const session = sessionFor(promoted.userId);
    await expect(session.listMembers()).resolves.toBeDefined();
    await sessionFor(tenant.ownerId).changeMemberRole(promoted.memberId, { role: "staff" }, randomUUID());
    await expect(session.listMembers()).rejects.toBeInstanceOf(TenantDenied);
    await expect(session.inviteMember({ email: `${randomUUID()}@example.com`, role: "owner" }, randomUUID())).rejects.toBeInstanceOf(TenantDenied);
    await expect(session.listContacts({})).resolves.toBeDefined();
  });
});

describe("member handlers", () => {
  it("refuse staff even when dispatched without the edge's authorize hook", async () => {
    const staff = await addMember(tenant.tenantId, "staff");
    const target = await addMember(tenant.tenantId, "staff");
    const dispatch = createDispatcher({ ...memberHandlers });
    const key = randomUUID();
    const command = {
      actionType: "member.change-role",
      target: { tenantId: tenant.tenantId, type: "member", id: target.memberId },
      approvalReference: { tenantId: tenant.tenantId, id: randomUUID() },
      idempotencyKey: key,
      payload: { memberId: target.memberId, role: "owner" },
    } as const;
    const { idempotencyKey: _key, ...fields } = command;
    const ctx: DispatchContext = {
      tenantId: tenant.tenantId,
      actor: { id: staff.userId, tenantId: tenant.tenantId },
      db: database.db,
      clock,
      config: {},
      generateId: randomUUID,
      resolveApproval: async () => ({ ...fields, tenantId: tenant.tenantId, actorId: staff.userId }),
    };
    await expect(dispatch(ctx, command)).rejects.toBeInstanceOf(TenantDenied);
    const roles = await fixture.service((tx) => tx.query<{ role: string }>(
      "SELECT role::text AS role FROM tenant_members WHERE tenant_id=$1 AND id=$2", [tenant.tenantId, target.memberId]));
    expect(roles.rows[0]?.role).toBe("staff");
  });
});
