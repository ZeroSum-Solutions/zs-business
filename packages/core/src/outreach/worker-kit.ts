// What the outreach worker's parts share (outreach-sequencer.md OS-12..OS-16, OS-19, OS-20): the context, the lease-checked
// transaction, the operator reports and a few small helpers. A leaf module: the parts import it, it imports none of them.
import { KeyObject } from "node:crypto";
import { z } from "zod";
import { uuidSchema } from "@zs/contracts";
import type { ScopedDatabase, Transaction } from "@zs/db";
import type { GmailPort } from "./gmail-port.js";
import { DEFAULT_WARMUP } from "./schedule.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

export const outreachWorkerConfigSchema = z.strictObject({
  /** OUTREACH_TOKEN_PRIVATE_KEY, parsed (parseSealPrivateKey). */
  privateKey: z.custom<KeyObject>(
    (value) => value instanceof KeyObject && value.type === "private" && value.asymmetricKeyType === "x25519",
    "privateKey must be an X25519 private key"),
  /** OS-1: OUTREACH_TENANTS. Every query names `tenant_id = ANY(...)` of these or one tenant of a row it found there. */
  tenants: z.array(uuidSchema).max(100).transform((ids) => ids.map((id) => id.toLowerCase())),
  /** OS-10: true only for the exact string `true` in the environment (apps/api/src/outreach/config.ts). */
  sendEnabled: z.boolean().default(false),
  /** OS-12: OUTREACH_MAILBOX_DAILY_LIMIT. */
  mailboxDailyLimit: z.number().int().min(1).max(50).default(20),
  /** OS-12: the warm-up ramp; tests change it, the defaults are the contract. */
  warmup: z.strictObject({
    start: z.number().int().min(1).max(50), step: z.number().int().min(0).max(50), periodDays: z.number().int().min(1).max(60),
  }).default({ ...DEFAULT_WARMUP }),
  sendsPerTick: z.number().int().min(1).max(5).default(1),
  minGapMs: z.number().int().min(0).max(DAY).default(4 * MINUTE),
  probeDelayMs: z.number().int().min(0).max(DAY).default(2 * MINUTE),
  /** OS-13: at most 20 s, because Vercel stops the function at 30 s. */
  runBudgetMs: z.number().int().min(1).max(20 * SECOND).default(20 * SECOND),
  leaseMs: z.number().int().min(1000).max(10 * MINUTE).default(60 * SECOND),
  /** The longest one Gmail or token call may take. */
  requestTimeoutMs: z.number().int().min(1).max(20 * SECOND).default(8 * SECOND),
  mailboxesPerRun: z.number().int().min(1).max(50).default(10),
  /** OS-16: pages of history one probe reads before it gives up and leaves the attempt uncertain. */
  maxHistoryPages: z.number().int().min(1).max(100).default(20),
  /** OS-19: header reads one run makes for new mail before it leaves the cursor where it was. */
  maxInboundMessages: z.number().int().min(1).max(1000).default(200),
  /** OS-14: how long a follow-up waits for the previous step's Message-ID before the prospect stops. */
  messageIdWaitMs: z.number().int().min(0).max(30 * DAY).default(DAY),
  /** OS-20 */
  bounceMinSent: z.number().int().min(1).default(40),
  bouncePercent: z.number().min(0.1).max(100).default(5),
  /** OS-18: `<base>/<token>` is the link in each email; the secret signs the token. */
  unsubscribeBaseUrl: z.url(),
  unsubscribeSecret: z.string().min(16),
});
export type OutreachWorkerConfig = z.input<typeof outreachWorkerConfigSchema>;
export type ParsedOutreachConfig = z.infer<typeof outreachWorkerConfigSchema>;

/** Operator events (OS-3, OS-13, OS-15, OS-16, OS-19, OS-20). Ids and our codes only, cut to 200 characters; never a token. */
export type OutreachReport =
  | { readonly kind: "outreach_mailbox_reauthorize"; readonly tenantId: string; readonly mailboxId: string; readonly code: string }
  | { readonly kind: "outreach_history_reset"; readonly tenantId: string; readonly mailboxId: string; readonly reason: "no_cursor" | "expired"; readonly paused?: boolean }
  | { readonly kind: "outreach_gmail_daily_limit"; readonly tenantId: string; readonly mailboxId: string }
  | { readonly kind: "outreach_send_outcome_unknown"; readonly tenantId: string; readonly mailboxId: string; readonly sendId: string }
  | { readonly kind: "outreach_bounce_rate"; readonly tenantId: string; readonly campaignId: string; readonly sent: number; readonly bounced: number }
  | { readonly kind: "outreach_campaign_paused"; readonly tenantId: string; readonly campaignId: string; readonly reason: string }
  | { readonly kind: "outreach_prospect_stopped"; readonly tenantId: string; readonly prospectId: string; readonly status: string }
  | { readonly kind: "outreach_lost_lease"; readonly tenantId: string; readonly mailboxId: string }
  | { readonly kind: "outreach_deadline_reached"; readonly tenantId: string; readonly mailboxId: string }
  | { readonly kind: "outreach_step_failed"; readonly step: string; readonly tenantId?: string; readonly mailboxId?: string; readonly error: string };

export interface OutreachWorkerDeps {
  /** A service-role transaction: `(work) => asService(servicePool, work)`. */
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  /** The runtime-role database the bounce suppression is dispatched through (OS-19). */
  readonly db: ScopedDatabase;
  readonly gmail: GmailPort;
  /** The token endpoint: a fresh access token, and a revoke. */
  readonly oauth: {
    refreshAccessToken(refreshToken: string, options?: { readonly signal?: AbortSignal }): Promise<{ accessToken: string; expiresInSeconds: number }>;
    revoke(token: string, options?: { readonly signal?: AbortSignal }): Promise<void>;
  };
  readonly clock: { now(): Date };
  readonly generateId: () => string;
  readonly config: OutreachWorkerConfig;
  readonly report?: (event: OutreachReport) => void;
}

export interface OutreachRunCounts {
  mailboxes: number;
  /** Mailboxes skipped because the lease was lost or the budget ended. */
  lostLeases: number;
  deadlineStops: number;
  reauthorized: number;
  /** OS-16 */
  probed: number;
  settledSent: number;
  lost: number;
  /** OS-19 */
  inboundRead: number;
  replies: number;
  ownerReplies: number;
  bounces: number;
  autoReplies: number;
  historyResets: number;
  /** OS-14, OS-15 */
  sends: number;
  accepted: number;
  notSent: number;
  rejected: number;
  uncertain: number;
  stopped: number;
  campaignsPaused: number;
  campaignsCompleted: number;
  stepsFailed: number;
  /** Steps that ran to their end: the cron outcome compares it with `stepsFailed`. */
  stepsSucceeded: number;
}
export const emptyCounts = (): OutreachRunCounts => ({
  mailboxes: 0, lostLeases: 0, deadlineStops: 0, reauthorized: 0, probed: 0, settledSent: 0, lost: 0, inboundRead: 0, replies: 0,
  ownerReplies: 0, bounces: 0, autoReplies: 0, historyResets: 0, sends: 0, accepted: 0, notSent: 0, rejected: 0, uncertain: 0, stopped: 0,
  campaignsPaused: 0, campaignsCompleted: 0, stepsFailed: 0, stepsSucceeded: 0,
});

/** One leased mailbox, for the length of one run. `accessToken` is in memory only (OS-21). */
export interface Box {
  readonly tenantId: string;
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly leaseToken: string;
  readonly dailyLimit: number;
  readonly pausedUntil: Date | null;
  readonly historyId: string | null;
  accessToken: string;
}

/** What the parts of the worker use. */
export interface Ctx {
  readonly cfg: ParsedOutreachConfig;
  readonly deps: OutreachWorkerDeps;
  readonly gmail: GmailPort;
  readonly counts: OutreachRunCounts;
  now(): Date;
  /** Milliseconds left of this run's budget (OS-13); can be 0 or less. */
  timeLeft(): number;
  report(event: OutreachReport): void;
  /** A service transaction that first checks the mailbox lease is still ours and unexpired; throws LostLease. */
  leased<T>(box: Box, work: (tx: Transaction) => Promise<T>): Promise<T>;
  /**
   * One Gmail or token call with a timeout bounded by the time left. Throws OutOfTime without calling when the budget
   * has passed.
   */
  call<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs?: number): Promise<T>;
}

/** The mailbox lease is no longer ours: the run writes nothing more for it (OS-13). */
export class LostLease extends Error {
  constructor() { super("Lease lost"); this.name = "LostLease"; }
}
/** The run's budget has passed: no new Gmail call starts (OS-13). */
export class OutOfTime extends Error {
  constructor() { super("Run budget reached"); this.name = "OutOfTime"; }
}

/** Codes fit the 1..100 error columns and carry nothing but a code. */
export const codeText = (code: string, max = 100) => (code.replace(/[^A-Za-z0-9_:.-]/g, "_").slice(0, max) || "unknown");

/** Our code for a thrown value: the `code` of a Gmail or token failure, else a generic one. Never the message. */
export function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return codeText(error.code);
  return "unexpected_error";
}
export const errorStatus = (error: unknown): number | null =>
  typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : null;
export const errorReason = (error: unknown): string | null =>
  typeof error === "object" && error !== null && "reason" in error && typeof error.reason === "string" ? error.reason.toLowerCase() : null;

/** A mailbox that Google no longer lets us use: the refresh token is revoked or lacks a scope (OS-3). */
export function needsReauthorization(error: unknown): boolean {
  const status = errorStatus(error);
  return errorCode(error) === "invalid_grant" || status === 401 || (status === 403 && errorReason(error) === "insufficientpermissions");
}

/** A far-future instant: a mailbox paused "until an operator reconnects it". Not `infinity`, which node-postgres reads as a NaN date. */
export const PAUSED_UNTIL_OPERATOR = new Date("9999-12-31T00:00:00.000Z");

/** An operator-event text: our words, cut to 200 characters. */
export const reportText = (value: unknown): string => (value instanceof Error ? `${value.name}` : String(value)).slice(0, 200);

/** The paused statuses a prospect stops in when it can no longer be mailed (OS-14). */
export const OPEN_PROSPECT = "('pending','active')";

/** Stops one open prospect; false when it was not open. */
export async function stopProspect(tx: Transaction, tenantId: string, prospectId: string, status: string, at: Date): Promise<boolean> {
  return (await tx.query(
    `UPDATE outreach_prospects SET status=$3, next_step=NULL, next_due_on=NULL, stopped_at=$4, updated_at=$4
      WHERE tenant_id=$1 AND id=$2 AND status IN ('pending','active')`, [tenantId, prospectId, status, at])).rowCount === 1;
}

/** Pauses an active campaign with a reason; false when it was not active. */
export async function pauseCampaign(tx: Transaction, tenantId: string, campaignId: string, reason: string, at: Date): Promise<boolean> {
  return (await tx.query(
    "UPDATE outreach_campaigns SET status='paused', paused_reason=$3, updated_at=$4 WHERE tenant_id=$1 AND id=$2 AND status='active'",
    [tenantId, campaignId, codeText(reason), at])).rowCount === 1;
}
