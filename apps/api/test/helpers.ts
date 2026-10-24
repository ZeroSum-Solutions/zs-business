import { randomUUID } from "node:crypto";
import { createDealOutputSchema, createOrFindContactOutputSchema } from "@zs/contracts";
import {
  createTestDatabase,
  createTwoTenantFixture,
  startAuthSession,
  upsertAuthUser,
  type TestDatabase,
  type TwoTenantFixture,
} from "@zs/db/testing";
import { createLocalStubSessionCheck, InMemoryAudioStore, InMemoryIntakeFileStore, InMemoryVoicemails, signBookingKey, type AutomationEdgeConfig, type EnrichmentConfigInput, type SiteCompiler } from "@zs/core";
import type { SiteObjectStore } from "@zs/contracts";
import {
  createApp,
  createHs256Verifier,
  createPostgresRateLimiter,
  type App,
  type PublicIntakeConfig,
  type ResendWebhookConfig,
  type TwilioWebhookConfig,
  type UnsubscribeConfig,
} from "../src/app.js";
import { signDevToken } from "../src/dev-token.js";

/** Synthetic HS256 key, built at runtime so secret scanners do not flag a literal. */
export const SECRET = ["test", "secret", "x".repeat(32)].join("-");
/** Monday 08:00 UTC; tenant calendars open Monday 09:00-17:00 UTC. */
export const NOW = "2026-10-19T08:00:00.000Z";
export const ORIGIN = "http://localhost:3000";
export const clock = { now: () => new Date(NOW) };
/** Synthetic booking key secrets, built at runtime like SECRET. */
export const KEY_SECRET = ["test", "booking", "k".repeat(32)].join("-");
export const PREVIOUS_KEY_SECRET = ["test", "booking", "p".repeat(32)].join("-");
export const PUBLIC_BASE_URL = "http://book.test";
/** Synthetic unsubscribe token secrets, built at runtime like SECRET. */
export const UNSUBSCRIBE_SECRET = ["test", "unsubscribe", "u".repeat(32)].join("-");
export const PREVIOUS_UNSUBSCRIBE_SECRET = ["test", "unsubscribe", "q".repeat(32)].join("-");
/** Synthetic Resend webhook secrets in the `whsec_<base64>` shape, built at runtime like SECRET. */
export const RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from(["test", "resend", "w".repeat(32)].join("-")).toString("base64");
/** Test-only Twilio values: random-looking hex, never a real account. */
export const TWILIO_AUTH_TOKEN = "0123456789abcdef".repeat(2);
export const PREVIOUS_TWILIO_AUTH_TOKEN = "fedcba9876543210".repeat(2);
export const TWILIO_ACCOUNT_SID = `AC${"a1".repeat(16)}`;
export const TWILIO_WEBHOOK_BASE_URL = "https://api.example.test";
/** Synthetic transcription worker bearer token, built at runtime like SECRET. */
export const WORKER_TOKEN = ["test", "worker", "w".repeat(32)].join("-");
/** Synthetic document-intake worker bearer token, built at runtime like SECRET. */
export const INTAKE_WORKER_TOKEN = ["test", "intake", "i".repeat(32)].join("-");
export const ACTIVEPIECES_KEY_SECRET = ["test", "activepieces", "a".repeat(32)].join("-");
export const PREVIOUS_RESEND_WEBHOOK_SECRET = "whsec_" + Buffer.from(["test", "resend", "r".repeat(32)].join("-")).toString("base64");

/** A signed-in member: an auth user with a live session and a membership row. */
export interface MemberSetup {
  tenantId: string;
  actorId: string;
  sessionId: string;
  memberId: string;
  email: string;
  role: "owner" | "staff";
  token: string;
}
export interface TenantSetup extends MemberSetup {
  resourceId: string;
  pipelineId: string;
  stages: [string, string];
}
export interface ApiHarness {
  database: TestDatabase;
  fixture: TwoTenantFixture;
  app: App;
  a: TenantSetup;
  b: TenantSetup;
  /** The transcription fakes, when the harness turned the routes on. */
  transcription?: { audio: InMemoryAudioStore; voicemails: InMemoryVoicemails };
  /** The document-intake PDF store, when the harness turned the routes on. */
  documentIntake?: { store: InMemoryIntakeFileStore };
  close(): Promise<void>;
}

/** Sign a token for an existing user and session (defaults: a one-hour token now). */
export function tokenFor(member: Pick<MemberSetup, "tenantId" | "actorId" | "sessionId">, ttlSeconds = 3600): Promise<string> {
  return signDevToken(SECRET, member, clock, ttlSeconds);
}

/** Create an auth user with a live session and, unless `membership: false`, a membership row. */
export async function signedInMember(
  database: TestDatabase,
  fixture: TwoTenantFixture,
  tenantId: string,
  role: "owner" | "staff",
  options: { membership?: boolean } = {},
): Promise<MemberSetup> {
  const memberId = randomUUID();
  const email = `${role}-${memberId.slice(0, 8)}@example.com`;
  const actorId = await upsertAuthUser(database.pool, { email, appMetadata: { tenant_id: tenantId } });
  const sessionId = await startAuthSession(database.pool, actorId);
  if (options.membership ?? true)
    await fixture.service((tx) => tx.query(
      `INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$6)`,
      [tenantId, memberId, email, actorId, role, NOW],
    ));
  const member = { tenantId, actorId, sessionId, memberId, email, role };
  return { ...member, token: await tokenFor(member) };
}

async function provision(database: TestDatabase, fixture: TwoTenantFixture, tenantId: string): Promise<TenantSetup> {
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
      `INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position,outcome)
       VALUES ($1,$2,$3,'New',0,'open'),($1,$4,$3,'Won',1,'won')`,
      [tenantId, stages[0], pipelineId, stages[1]],
    );
  });
  const owner = await signedInMember(database, fixture, tenantId, "owner");
  return { ...owner, resourceId, pipelineId, stages };
}

export interface HarnessOptions {
  /** Turns the public booking routes on; secrets and base URL default to the test values. */
  publicIntake?: Partial<PublicIntakeConfig>;
  /** Where the public and unsubscribe limits count; "postgres" builds the shared limiter on the harness database. */
  limiterStore?: "memory" | "postgres";
  /** Turns the unsubscribe routes on; the token secret defaults to UNSUBSCRIBE_SECRET. */
  unsubscribe?: Partial<UnsubscribeConfig>;
  /** Turns POST /webhooks/resend on; the signing secret defaults to RESEND_WEBHOOK_SECRET. */
  resendWebhook?: Partial<ResendWebhookConfig>;
  /** Turns the /webhooks/twilio routes on with the TWILIO_* test values below. */
  twilioWebhook?: Partial<TwilioWebhookConfig>;
  /** Turns the Activepieces routes on; the key defaults to ACTIVEPIECES_KEY_SECRET. */
  activepieces?: Partial<AutomationEdgeConfig>;
  /** Enrichment gates and prices (enrichment.md E-5); absent, the routes answer enrichment_unavailable. */
  enrichment?: EnrichmentConfigInput;
  /** Turns the /v1/transcriptions and /worker/v1 routes on over in-memory audio and voicemails. */
  transcription?: boolean;
  /** Turns the /v1/document-intake and /v1/workers/document-intake routes on over an in-memory PDF store. */
  documentIntake?: boolean;
  clock?: { now(): Date };
  /** Turns the /v1/sites routes on over this store and compiler. */
  sites?: { store: SiteObjectStore; compiler: SiteCompiler; syncTimeoutMs?: number };
}

export async function createApiHarness(options: HarnessOptions = {}): Promise<ApiHarness> {
  const database = await createTestDatabase();
  const fixture = await createTwoTenantFixture(database);
  const appClock = options.clock ?? clock;
  // As in the server: one shared limiter for the booking and unsubscribe routes.
  const shared = options.limiterStore === "postgres" ? { limiter: createPostgresRateLimiter(database.db, appClock) } : {};
  const transcription = options.transcription ? { audio: new InMemoryAudioStore(), voicemails: new InMemoryVoicemails() } : undefined;
  const documentIntake = options.documentIntake ? { store: new InMemoryIntakeFileStore() } : undefined;
  const app = createApp({
    verifier: createHs256Verifier(SECRET, { clock: appClock }),
    // The loopback auth stub stands in for Supabase Auth; core's tests cover the Supabase check.
    sessionCheck: createLocalStubSessionCheck(database.db, appClock),
    clock: appClock,
    db: database.db,
    generateId: randomUUID,
    config: { allowedOrigins: [ORIGIN] },
    ...(options.enrichment ? { enrichment: options.enrichment } : {}),
    ...(options.publicIntake
      ? { publicIntake: {
        keySecrets: { current: KEY_SECRET },
        publicBaseUrl: PUBLIC_BASE_URL,
        ...shared,
        ...options.publicIntake,
      } }
      : {}),
    ...(options.sites ? { sites: options.sites } : {}),
    ...(options.unsubscribe
      ? { unsubscribe: { tokenSecrets: { current: UNSUBSCRIBE_SECRET }, ...shared, ...options.unsubscribe } }
      : {}),
    ...(options.resendWebhook
      ? { resendWebhook: { secrets: { current: RESEND_WEBHOOK_SECRET }, ...options.resendWebhook } }
      : {}),
    ...(options.twilioWebhook
      ? { twilioWebhook: {
        tokens: { current: TWILIO_AUTH_TOKEN }, accountSid: TWILIO_ACCOUNT_SID, webhookBaseUrl: TWILIO_WEBHOOK_BASE_URL,
        ...options.twilioWebhook,
      } }
      : {}),
    ...(options.activepieces
      ? { activepieces: { keySecrets: { current: ACTIVEPIECES_KEY_SECRET }, ...options.activepieces } }
      : {}),
    ...(transcription ? { transcription: { ...transcription, workerToken: WORKER_TOKEN } } : {}),
    ...(documentIntake ? { documentIntake: { ...documentIntake, workerToken: INTAKE_WORKER_TOKEN } } : {}),
  });
  return {
    database,
    fixture,
    app,
    a: await provision(database, fixture, fixture.a.tenantId),
    b: await provision(database, fixture, fixture.b.tenantId),
    ...(transcription ? { transcription } : {}),
    ...(documentIntake ? { documentIntake } : {}),
    close: () => database.close(),
  };
}

export interface Call {
  token?: string;
  body?: unknown;
  key?: string;
  headers?: Record<string, string>;
  /** The TCP peer the Node server would report; absent, the request has no socket. */
  socket?: string;
}
export async function call(app: App, method: string, path: string, options: Call = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.key) headers["Idempotency-Key"] = options.key;
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await app.request(path, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  }, options.socket === undefined ? undefined : { incoming: { socket: { remoteAddress: options.socket } } });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

/** Create a contact and a deal in the first stage over HTTP. */
export async function contactAndDeal(harness: ApiHarness, tenant: TenantSetup, email: string) {
  const contact = createOrFindContactOutputSchema.parse((await call(harness.app, "POST", "/v1/crm/contacts", {
    token: tenant.token, key: randomUUID(), body: { displayName: "Ada", email },
  })).body);
  const deal = createDealOutputSchema.parse((await call(harness.app, "POST", "/v1/crm/deals", {
    token: tenant.token, key: randomUUID(),
    body: { contactId: contact.result.contact.id, pipelineId: tenant.pipelineId, stageId: tenant.stages[0], title: "Ring" },
  })).body);
  return { contactId: contact.result.contact.id, dealId: deal.result.id };
}

export interface PageSetup {
  pageId: string;
  key: string;
}
/** Provision a booking page as the service role would; the key is signed like the owner list. */
export async function provisionPage(
  harness: ApiHarness,
  tenant: TenantSetup,
  options: { published?: boolean; resourceIds?: string[]; disclosureVersion?: string } = {},
): Promise<PageSetup> {
  const pageId = randomUUID();
  await harness.fixture.service(async (tx) => {
    await tx.query(
      `INSERT INTO booking_pages (tenant_id,id,title,published,disclosure_version,created_at)
       VALUES ($1,$2,'Book a fitting',$3,$4,$5)`,
      [tenant.tenantId, pageId, options.published ?? true, options.disclosureVersion ?? "v1", NOW],
    );
    for (const [position, resourceId] of (options.resourceIds ?? [tenant.resourceId]).entries())
      await tx.query(
        "INSERT INTO booking_page_resources (tenant_id,page_id,resource_id,position) VALUES ($1,$2,$3,$4)",
        [tenant.tenantId, pageId, resourceId, position],
      );
  });
  return { pageId, key: signBookingKey(KEY_SECRET, { tenantId: tenant.tenantId, pageId }) };
}
