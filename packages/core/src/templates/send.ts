// Templated agent kinds' actions (agents.md G-14, G-19, G-20; approvals.md A-15). Original code.
// Each runs as the kind's own principal through the shared dispatcher. A queue action renders
// one send from the current, approved template revision and commits the one
// `message.send_requested` event; delivery (D-5, D-6, D-9) still checks everything again.
import {
  Conflict,
  KIND_RUN_FINISH_ACTION,
  KIND_RUN_START_ACTION,
  KIND_SKIP_ACTION,
  MESSAGE_SEND_REQUESTED,
  REMINDER_QUEUE_ACTION,
  REVIEW_QUEUE_ACTION,
  TEMPLATE_VARIABLES,
  TenantDenied,
  ValidationFailed,
  finishKindRunCommandSchema,
  messageSendRequestedSchema,
  queueActionKind,
  reminderQueueCommandSchema,
  reviewQueueCommandSchema,
  skipKindCommandSchema,
  startKindRunCommandSchema,
  type ActionCommand,
  type KindDecision,
  type FollowUpRun,
  type Target,
  type TemplatedKind,
  agentKindConfigSchemas,
  type TemplatedSkipReason,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import type { ActionHandler } from "../actions/dispatch.js";
import { consentBlock, usableEmail } from "../delivery/policy.js";
import { gate, loadControls, readGlobalKilled, agentActorId, type AgentControls } from "../agents/controls.js";
import { closeRun } from "../agents/handlers.js";
import { loadRun } from "../agents/records.js";
import { parseOrFail, pgCode, pgConstraint, tenantVisible } from "../crm/rows.js";
import { derivedId } from "../edge/ids.js";
import { renderedContent, requireStandingApproval, type RevisionRow } from "./store.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** What the edge hands the handlers through the dispatcher's `config`. */
export interface TemplatedKindConfig {
  /** The tenant's public booking page link, or null when it has none. The edge owns the key, so core cannot build it. */
  readonly bookingLink?: BookingLinkProvider;
}
/** Reads in the caller's transaction, so the link is the one the tenant has at that moment. */
export type BookingLinkProvider = (tx: Transaction, tenantId: string) => Promise<string | null>;
const linkFor = async (config: unknown, tx: Transaction, tenantId: string): Promise<string | null> => {
  const fn = (config as TemplatedKindConfig | undefined)?.bookingLink;
  return typeof fn === "function" ? fn(tx, tenantId) : null;
};

/** The run's decision for a booking has this ID, so a booking is decided once per run. */
export const kindDecisionId = (tenantId: string, runId: string, bookingId: string) =>
  derivedId(tenantId, `agent:item:${runId}:${bookingId}`, "agent-decision");
/** The message a queued decision asked delivery to send. */
export const queueMessageId = (tenantId: string, decisionId: string) => derivedId(tenantId, decisionId, "agent-message");

// Bookings and customers

export interface BookingFact {
  readonly bookingId: string;
  readonly contactId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
}
interface FactRow { booking_id: string; contact_id: string; starts_at: Date; ends_at: Date; time_zone: string }
const fact = (row: FactRow): BookingFact => ({
  bookingId: row.booking_id, contactId: row.contact_id, startsAt: row.starts_at, endsAt: row.ends_at, timeZone: row.time_zone,
});
/**
 * A confirmed booking with its customer (booking-customer.md BC-1: an owner's link, or the
 * contact of the website request that made the booking).
 */
const CUSTOMER_BOOKINGS = `
  SELECT b.id AS booking_id, b.starts_at, b.ends_at, r.time_zone, coalesce(l.contact_id, i.contact_id) AS contact_id
    FROM bookings b
    JOIN booking_resources r ON r.tenant_id = b.tenant_id AND r.id = b.resource_id
    LEFT JOIN booking_contacts l ON l.tenant_id = b.tenant_id AND l.booking_id = b.id
    LEFT JOIN intake_items i ON i.tenant_id = b.tenant_id AND i.id = b.intake_item_id AND i.status IN ('new_contact','linked')
   WHERE b.tenant_id = $1 AND b.status = 'confirmed'`;

export async function loadBookingFact(tx: Transaction, tenantId: string, bookingId: string): Promise<BookingFact | null> {
  const row = (await tx.query<FactRow>(
    `SELECT * FROM (${CUSTOMER_BOOKINGS} AND b.id = $2) f WHERE contact_id IS NOT NULL`, [tenantId, bookingId],
  )).rows[0];
  return row ? fact(row) : null;
}

export interface KindWindow {
  readonly timingHours: number;
  /** Review requests only: the oldest end time still worth asking about. */
  readonly lookbackDays?: number;
}
/** Reminders: starts within `timingHours` after now. Reviews: ended at least `timingHours` and at most `lookbackDays` ago. */
function windowSql(kind: TemplatedKind, now: Date, window: KindWindow) {
  if (kind === "appointment_reminder")
    return { where: "f.starts_at > $2 AND f.starts_at <= $3", params: [now, new Date(now.getTime() + window.timingHours * HOUR_MS)], order: "f.starts_at" };
  return {
    where: "f.ends_at <= $2 AND f.ends_at >= $3",
    params: [new Date(now.getTime() - window.timingHours * HOUR_MS), new Date(now.getTime() - (window.lookbackDays ?? 7) * DAY_MS)],
    order: "f.ends_at",
  };
}

/**
 * G-19, G-20: bookings in the kind's window with a customer, none of them already queued for this
 * kind and none decided in this run. A skip in an earlier run does not use a booking up; those
 * decided longest ago come first, so a lasting skip (no address) cannot hold the whole batch.
 */
export async function findKindCandidates(
  tx: Transaction, tenantId: string, kind: TemplatedKind, window: KindWindow, now: Date, limit: number, runId: string,
): Promise<BookingFact[]> {
  if (limit < 1) return [];
  const sql = windowSql(kind, now, window);
  const rows = (await tx.query<FactRow>(
    `SELECT f.* FROM (${CUSTOMER_BOOKINGS}) f
      WHERE f.contact_id IS NOT NULL AND ${sql.where}
        AND NOT EXISTS (SELECT 1 FROM agent_decisions d WHERE d.tenant_id = $1 AND d.agent_kind = '${kind}'
              AND d.subject_id = f.booking_id AND (d.outcome = 'queued' OR d.run_id = $4))
      ORDER BY (SELECT max(d.created_at) FROM agent_decisions d WHERE d.tenant_id = $1 AND d.agent_kind = '${kind}'
                 AND d.subject_id = f.booking_id) ASC NULLS FIRST, ${sql.order}, f.booking_id
      LIMIT $5`,
    [tenantId, ...sql.params, runId, limit],
  )).rows;
  return rows.map(fact);
}

const firstName = (displayName: string | null): string => {
  const word = (displayName ?? "").trim().split(/\s+/)[0] ?? "";
  return word ? [...word].slice(0, 60).join("") : "there";
};
const businessLabel = (name: string): string => {
  const clean = name.replace(/\s+/g, " ").trim();
  return [...(clean || "our business")].slice(0, 120).join("");
};
/** G-19: the customer's local date and time of the visit, for example "Tue, Oct 27 at 3:30 PM". */
export function localStart(startsAt: Date, timeZone: string): string {
  let zone = timeZone;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "UTC"; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(startsAt).map((part) => [part.type, part.value]));
  return `${parts.weekday}, ${parts.month} ${parts.day} at ${parts.hour}:${parts.minute} ${parts.dayPeriod}`.slice(0, 60);
}

export interface ValueInputs {
  readonly displayName: string | null;
  readonly businessName: string;
  readonly bookingLink: string | null;
  readonly reviewUrl: string | null;
}
/** Every variable of the kind, as plain text. Unused links are the empty string. */
export function kindValues(kind: TemplatedKind, booking: BookingFact, input: ValueInputs): Record<string, string> {
  const all: Record<string, string> = {
    customer_first_name: firstName(input.displayName),
    business_name: businessLabel(input.businessName),
    booking_start_local: localStart(booking.startsAt, booking.timeZone),
    booking_link: input.bookingLink ?? "",
    review_link: input.reviewUrl ?? "",
  };
  return Object.fromEntries(TEMPLATE_VARIABLES[kind].map((name) => [name, all[name]!]));
}

/** What the queue action needs to know about the customer. */
export interface ContactFacts {
  display_name: string | null;
  email: string | null;
  phone: string | null;
  suppressed_email: boolean;
  suppressed_sms: boolean;
  consent_email: "granted" | "denied" | null;
  consent_sms: "granted" | "denied" | null;
  source_email: string | null;
  source_sms: string | null;
}
async function loadContactFacts(tx: Transaction, tenantId: string, contactId: string): Promise<ContactFacts | null> {
  return (await tx.query<ContactFacts>(
    `SELECT c.display_name, c.normalized_email AS email, c.e164_phone AS phone,
            EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id=c.tenant_id AND s.channel='email' AND s.address=c.normalized_email) AS suppressed_email,
            EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id=c.tenant_id AND s.channel='sms' AND s.address=c.e164_phone) AS suppressed_sms,
            (SELECT k.status::text FROM crm_contact_consent k WHERE k.tenant_id=c.tenant_id AND k.contact_id=c.id AND k.channel='email') AS consent_email,
            (SELECT k.status::text FROM crm_contact_consent k WHERE k.tenant_id=c.tenant_id AND k.contact_id=c.id AND k.channel='sms') AS consent_sms,
            (SELECT k.source FROM crm_contact_consent k WHERE k.tenant_id=c.tenant_id AND k.contact_id=c.id AND k.channel='email') AS source_email,
            (SELECT k.source FROM crm_contact_consent k WHERE k.tenant_id=c.tenant_id AND k.contact_id=c.id AND k.channel='sms') AS source_sms
       FROM crm_contacts c WHERE c.tenant_id=$1 AND c.id=$2`, [tenantId, contactId],
  )).rows[0] ?? null;
}

/** The customer and every variable's value for one booking, from the server's own data. Null when the customer is gone. */
export async function computeKindValues(
  tx: Transaction, tenantId: string, kind: TemplatedKind, booking: BookingFact, settings: TemplatedSettings, bookingLink: string | null,
): Promise<{ contact: ContactFacts; values: Record<string, string> } | null> {
  const contact = await loadContactFacts(tx, tenantId, booking.contactId);
  if (!contact) return null;
  const business = (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows[0]?.name ?? "";
  return {
    contact,
    values: kindValues(kind, booking, { displayName: contact.display_name, businessName: business, bookingLink, reviewUrl: settings.reviewUrl }),
  };
}

// Settings the kinds read

export interface TemplatedSettings {
  readonly maxSendsPerDay: number;
  readonly lookbackDays: number;
  readonly contactWindowDays: number;
  readonly reviewUrl: string | null;
  readonly timingHours: number;
}
export function templatedSettings(controls: AgentControls, kind: TemplatedKind): TemplatedSettings {
  // A field missing from the stored config reads as this kind's own default (G-14), never another kind's.
  const config = { ...agentKindConfigSchemas[kind].parse({}), ...(controls.config as object) } as
    Partial<Record<keyof TemplatedSettings, number | string>>;
  return {
    maxSendsPerDay: Number(config.maxSendsPerDay ?? 20),
    lookbackDays: Number(config.lookbackDays ?? 7),
    contactWindowDays: Number(config.contactWindowDays ?? 180),
    reviewUrl: typeof config.reviewUrl === "string" ? config.reviewUrl : null,
    timingHours: Number(config.timingHours ?? 24),
  };
}

/** G-4 style: messages the kind queued in the 24 hours before now. No upper bound, as for drafts. */
export async function queuedToday(tx: Transaction, tenantId: string, kind: TemplatedKind, now: Date): Promise<number> {
  return Number((await tx.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM agent_decisions WHERE tenant_id=$1 AND agent_kind=$2 AND outcome='queued' AND created_at > $3",
    [tenantId, kind, new Date(now.getTime() - DAY_MS)],
  )).rows[0]!.n);
}

// Decisions

interface DecisionRow {
  id: string; run_id: string; agent_kind: KindDecision["agentKind"]; subject_type: KindDecision["subjectType"]; subject_id: string;
  contact_id: string | null; outcome: KindDecision["outcome"]; reason: string | null; message_id: string | null;
  approval_id: string | null; created_at: Date;
}
export async function loadKindDecision(tx: Transaction, tenantId: string, id: string): Promise<KindDecision | null> {
  const row = (await tx.query<DecisionRow>(
    `SELECT id, run_id, agent_kind, subject_type, subject_id, contact_id, outcome, reason, message_id, approval_id, created_at
       FROM agent_decisions WHERE tenant_id=$1 AND id=$2`, [tenantId, id],
  )).rows[0];
  if (!row) return null;
  return {
    id: row.id, runId: row.run_id, agentKind: row.agent_kind, subjectType: row.subject_type, subjectId: row.subject_id,
    contactId: row.contact_id, outcome: row.outcome, reason: row.reason, messageId: row.message_id, approvalId: row.approval_id,
    createdAt: row.created_at.toISOString(),
  };
}

/** A templated kind's run with its decisions, oldest first. */
export async function loadKindRunDetail(tx: Transaction, tenantId: string, runId: string, kind: TemplatedKind) {
  const run = await loadRun(tx, tenantId, runId);
  if (!run || run.agent !== kind) return null;
  const ids = (await tx.query<{ id: string }>(
    "SELECT id FROM agent_decisions WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at, id", [tenantId, runId])).rows;
  const decisions: KindDecision[] = [];
  for (const row of ids) decisions.push((await loadKindDecision(tx, tenantId, row.id))!);
  return { ...run, decisions };
}
export type KindRunDetail = NonNullable<Awaited<ReturnType<typeof loadKindRunDetail>>>;

/** G-8: the reasons that end a run instead of skipping one booking. */
export const STOP_REASONS: ReadonlySet<string> = new Set(["global_killed", "disabled", "tenant_killed", "quiet_hours", "daily_cap"]);

async function resolveNewDecision(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "agent_decision") throw new ValidationFailed("Agent decisions require an agent_decision target");
  if (!(await tenantVisible(tx, target.tenantId))) return null;
  if (await loadKindDecision(tx, target.tenantId, target.id)) throw new Conflict("The decision ID is already in use", { reason: "id_in_use" });
  return { tenantId: target.tenantId, type: "agent_decision", id: target.id };
}
async function resolveRun(tx: Transaction, target: Target): Promise<Target | null> {
  if (target.type !== "agent_run") throw new ValidationFailed("Agent run actions require an agent_run target");
  return (await loadRun(tx, target.tenantId, target.id)) ? { tenantId: target.tenantId, type: "agent_run", id: target.id } : null;
}

/** The actor must be the principal of the kind the payload names. */
function requireKindActor(tenantId: string, actorId: string, kind: TemplatedKind) {
  if (actorId !== agentActorId(tenantId, kind)) throw new TenantDenied();
}

/**
 * G-7: the run must be this kind's, still open and under its limit. The run row stays locked until
 * the decision commits, so concurrent calls cannot decide more than its limit and a stalled run
 * refuses a late step (G-16).
 */
async function requireOpenKindRun(tx: Transaction, tenantId: string, runId: string, kind: TemplatedKind) {
  const run = (await tx.query<{ status: string; max_decisions: number; agent: string }>(
    "SELECT status, max_decisions, agent FROM agent_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, runId],
  )).rows[0];
  if (!run || run.agent !== kind) throw new TenantDenied();
  if (run.status !== "running") throw new Conflict("The run is closed", { reason: "run_closed" });
  const decided = (await tx.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM agent_decisions WHERE tenant_id=$1 AND run_id=$2", [tenantId, runId],
  )).rows[0]!.n;
  if (decided >= run.max_decisions) throw new Conflict("The run has decided its limit", { reason: "run_limit" });
}

async function recordSkip(
  tx: Transaction, tenantId: string,
  input: { decisionId: string; runId: string; agentKind: TemplatedKind; bookingId: string; contactId: string },
  reason: TemplatedSkipReason, now: Date,
) {
  await tx.query(
    `INSERT INTO agent_decisions (tenant_id, id, run_id, agent_kind, subject_type, subject_id, contact_id, outcome, reason, created_at)
     VALUES ($1,$2,$3,$4,'booking',$5,$6,'skipped',$7,$8)`,
    [tenantId, input.decisionId, input.runId, input.agentKind, input.bookingId, input.contactId, reason, now],
  );
  return {
    result: (await loadKindDecision(tx, tenantId, input.decisionId))!,
    event: { type: "agent.kind.skipped", payload: { runId: input.runId, decisionId: input.decisionId, agentKind: input.agentKind, reason } },
  };
}

/** G-14: start a run of a templated kind. It starts stopped when a switch, quiet hours or the daily cap forbids it. */
export const startKindRunHandler: ActionHandler = {
  async resolveTarget(tx, target) {
    if (target.type !== "agent_run") throw new ValidationFailed("Agent run actions require an agent_run target");
    if (!(await tenantVisible(tx, target.tenantId))) return null;
    if (await loadRun(tx, target.tenantId, target.id)) throw new Conflict("The run ID is already in use", { reason: "id_in_use" });
    return { tenantId: target.tenantId, type: "agent_run", id: target.id };
  },
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(startKindRunCommandSchema, command);
    const tenantId = binding.tenantId;
    const kind = payload.agentKind;
    requireKindActor(tenantId, binding.actorId, kind);
    const controls = await loadControls(tx, tenantId, false, kind);
    let stop = gate(controls, await readGlobalKilled(tx, false), now);
    if (!stop && (await queuedToday(tx, tenantId, kind, now)) >= templatedSettings(controls, kind).maxSendsPerDay) stop = "daily_cap";
    await tx.query(
      `INSERT INTO agent_runs (tenant_id, id, agent, requested_by, started_at, finished_at, status, stop_reason, max_decisions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, payload.runId, kind, payload.requestedBy, now, stop ? now : null, stop ? "stopped" : "running", stop, payload.maxDecisions],
    );
    return { result: (await loadRun(tx, tenantId, payload.runId))! };
  },
};

export const finishKindRunHandler: ActionHandler = {
  resolveTarget: resolveRun,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(finishKindRunCommandSchema, command);
    const tenantId = binding.tenantId;
    requireKindActor(tenantId, binding.actorId, payload.agentKind);
    const run = (await loadRun(tx, tenantId, payload.runId, true))!;
    if (run.agent !== payload.agentKind) throw new TenantDenied();
    if (run.status === "running") await closeRun(tx, tenantId, payload.runId, run.agent, now, payload.stopReason);
    return { result: (await loadRun(tx, tenantId, payload.runId))! as FollowUpRun };
  },
};

/** G-19: record a decision made before queueing, for example `template_not_approved`. */
export const skipKindHandler: ActionHandler = {
  resolveTarget: resolveNewDecision,
  async handle({ tx, command, binding, now }) {
    const { payload } = parseOrFail(skipKindCommandSchema, command);
    const tenantId = binding.tenantId;
    requireKindActor(tenantId, binding.actorId, payload.agentKind);
    await requireOpenKindRun(tx, tenantId, payload.runId, payload.agentKind);
    const booking = await loadBookingFact(tx, tenantId, payload.bookingId);
    if (!booking || booking.contactId !== payload.contactId) throw new Conflict("Not a candidate", { reason: "not_a_candidate" });
    return recordSkip(tx, tenantId, payload, payload.reason, now);
  },
};

/**
 * G-19, G-20, A-15: lock the switches and settings, the run, the standing approval and the
 * template, check everything again, then write the queued decision and its send event together,
 * or record why not. A reason that stops the run (a switch, quiet hours, the daily cap) is
 * recorded as the decision; `template_not_approved` is refused with a Conflict and the runner
 * records it.
 */
function queueHandler(kind: TemplatedKind, schema: typeof reminderQueueCommandSchema): ActionHandler {
  return {
    resolveTarget: resolveNewDecision,
    async handle({ tx, command, binding, clock, config }) {
      const { payload } = parseOrFail(schema, command as ActionCommand);
      const tenantId = binding.tenantId;
      requireKindActor(tenantId, binding.actorId, kind);
      if (payload.messageId !== queueMessageId(tenantId, payload.decisionId))
        throw new ValidationFailed("The message ID does not match the decision");
      // Lock order: global (shared advisory), the kind's settings row, the run row, then the approval, template and revision.
      const globalKilled = await readGlobalKilled(tx, true);
      const controls = await loadControls(tx, tenantId, true, kind);
      await requireOpenKindRun(tx, tenantId, payload.runId, kind);
      // An owner changing the customer holds this row, so the customer below is the current one.
      await tx.query("SELECT 1 FROM booking_contacts WHERE tenant_id=$1 AND booking_id=$2 FOR SHARE", [tenantId, payload.bookingId]);
      const booking = await loadBookingFact(tx, tenantId, payload.bookingId);
      if (!booking || booking.contactId !== payload.contactId) throw new Conflict("Not a candidate", { reason: "not_a_candidate" });
      const ref = { decisionId: payload.decisionId, runId: payload.runId, agentKind: kind, bookingId: payload.bookingId, contactId: payload.contactId };
      // Read the clock once the locks are held, so a wait on them counts toward quiet hours.
      const now = clock();
      const settings = templatedSettings(controls, kind);
      let stop: TemplatedSkipReason | null = gate(controls, globalKilled, now);
      if (!stop && (await queuedToday(tx, tenantId, kind, now)) >= settings.maxSendsPerDay) stop = "daily_cap";
      if (stop) return recordSkip(tx, tenantId, ref, stop, now);

      const revision: RevisionRow = await requireStandingApproval(
        tx, tenantId, kind, { approvalId: payload.standingApprovalId, revisionId: payload.templateRevisionId }, clock);
      const window = kind === "appointment_reminder"
        ? { timingHours: revision.timing_hours }
        : { timingHours: revision.timing_hours, lookbackDays: settings.lookbackDays };
      const inWindow = kind === "appointment_reminder"
        ? booking.startsAt.getTime() > now.getTime() && booking.startsAt.getTime() <= now.getTime() + window.timingHours * HOUR_MS
        : booking.endsAt.getTime() <= now.getTime() - window.timingHours * HOUR_MS &&
          booking.endsAt.getTime() >= now.getTime() - settings.lookbackDays * DAY_MS;
      if (!inWindow) throw new Conflict("Not a candidate", { reason: "not_a_candidate" });
      if ((await tx.query("SELECT 1 FROM agent_decisions WHERE tenant_id=$1 AND agent_kind=$2 AND subject_id=$3 AND outcome='queued'",
        [tenantId, kind, payload.bookingId])).rowCount)
        throw new Conflict("A message is already queued for this booking", { reason: "already_queued" });

      const computed = await computeKindValues(tx, tenantId, kind, booking, settings, await linkFor(config, tx, tenantId));
      if (!computed) throw new TenantDenied();
      const { contact, values } = computed;
      // G-19: the recorded values are the ones the server computes. A caller cannot put its own words in.
      const given = payload.values;
      const same = Object.keys(given).length === Object.keys(values).length && Object.entries(values).every(([name, value]) => given[name] === value);
      if (!same) throw new Conflict("The values changed", { reason: "values_changed" });

      const email = revision.channel === "email";
      const address = email ? usableEmail(contact.email) : contact.phone;
      if (!address) return recordSkip(tx, tenantId, ref, "no_address", now);
      const blocked = consentBlock({
        channel: revision.channel, purpose: revision.purpose,
        consent: email ? contact.consent_email : contact.consent_sms,
        source: email ? contact.source_email : contact.source_sms,
        suppressed: email ? contact.suppressed_email : contact.suppressed_sms,
      });
      if (blocked === "suppressed" || blocked === "consent_denied" || blocked === "consent_missing")
        return recordSkip(tx, tenantId, ref, blocked, now);
      if (kind === "review_request" && (await tx.query(
        `SELECT 1 FROM agent_decisions WHERE tenant_id=$1 AND agent_kind=$2 AND contact_id=$3 AND outcome='queued' AND created_at > $4 LIMIT 1`,
        [tenantId, kind, payload.contactId, new Date(now.getTime() - settings.contactWindowDays * DAY_MS)])).rowCount)
        return recordSkip(tx, tenantId, ref, "contact_cap", now);
      const needsLink = (name: string) => revision.variables.includes(name) && values[name] === "";
      if (needsLink("booking_link") || needsLink("review_link")) return recordSkip(tx, tenantId, ref, "no_link", now);

      const content = renderedContent(revision, values);
      const send = parseOrFail(messageSendRequestedSchema, {
        messageId: payload.messageId, contactId: payload.contactId, channel: revision.channel, purpose: revision.purpose,
        subject: content.subject, body: content.body,
      });
      await tx.query(
        `INSERT INTO agent_decisions (tenant_id, id, run_id, agent_kind, subject_type, subject_id, contact_id, outcome, message_id, approval_id, created_at)
         VALUES ($1,$2,$3,$4,'booking',$5,$6,'queued',$7,$8,$9)`,
        [tenantId, payload.decisionId, payload.runId, kind, payload.bookingId, payload.contactId, payload.messageId, payload.standingApprovalId, now],
      );
      return {
        result: (await loadKindDecision(tx, tenantId, payload.decisionId))!,
        event: { type: MESSAGE_SEND_REQUESTED, payload: { ...send } },
      };
    },
    mapError(error) {
      if (pgCode(error) === "23505" && pgConstraint(error) === "agent_decisions_one_message")
        return new Conflict("A message is already queued for this booking", { reason: "already_queued" });
      if (pgCode(error) === "23505" && pgConstraint(error) === "agent_decisions_pkey")
        return new Conflict("The decision ID is already in use", { reason: "id_in_use" });
      return undefined;
    },
  };
}

export const reminderQueueHandler = queueHandler("appointment_reminder", reminderQueueCommandSchema);
export const reviewQueueHandler = queueHandler("review_request", reviewQueueCommandSchema);

export const templatedKindHandlers: Readonly<Record<string, ActionHandler>> = Object.freeze({
  [KIND_RUN_START_ACTION]: startKindRunHandler,
  [KIND_RUN_FINISH_ACTION]: finishKindRunHandler,
  [KIND_SKIP_ACTION]: skipKindHandler,
  [REMINDER_QUEUE_ACTION]: reminderQueueHandler,
  [REVIEW_QUEUE_ACTION]: reviewQueueHandler,
});
export { queueActionKind };
