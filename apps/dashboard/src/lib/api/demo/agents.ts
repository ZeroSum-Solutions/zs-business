/**
 * The demo adapter's inquiry follow-up agent (agents.md G-2..G-11). It keeps the rules the API
 * enforces: owners change settings, resume and run it; anyone who drafts may read and stop it;
 * a save names the revision it started from; a run checks the switches, quiet hours and caps,
 * skips customers it may not write to, and leaves each follow-up as a draft in the Inbox for an
 * owner to approve. It never approves or sends. Its "model" is a fixed template.
 */
import type { z } from "zod";
import {
  killFollowUpRequestSchema,
  listFollowUpRunsQuerySchema,
  resumeFollowUpRequestSchema,
  startFollowUpRunRequestSchema,
  updateFollowUpSettingsRequestSchema,
  uuidSchema,
  type ContactRecord,
  type FollowUpDecision,
  type FollowUpRun,
  type FollowUpRunDetail,
  type FollowUpSettings,
  type FollowUpSkipReason,
  type FollowUpStatus,
  type FollowUpStopReason,
  type IntakeItemRecord,
  type ReplyRecord,
} from "@zs/contracts";
import { formatDay, zonedParts } from "../../time";
import { demoError, runNotFound } from "../errors";
import { RUN_PAGE_SIZE, type FollowUpApi, type WriteOptions } from "../types";
import { DEMO_AGENT, DEMO_BUSINESS, DEMO_FOLLOW_UP_SUBJECT, DEMO_TENANT_ID, type DemoFollowUp } from "./seed";

export type DemoRole = "owner" | "staff";

/** Who the demo session is: the owner, or a staff member. */
export interface DemoActor {
  role: DemoRole;
  userId: string;
}

export interface DemoAgentControls {
  /** Another owner saves the agent's settings first, so this screen's save is `stale_revision`. */
  editAgentSettingsElsewhere(change?: Partial<FollowUpSettings>): FollowUpStatus;
  /** The operator's switch that stops agents for every business (G-3). */
  setGlobalAgentKill(killed: boolean): void;
  /** Whether that switch is engaged; the templated kinds read it too. */
  globalAgentKill(): boolean;
  /** Whether this server has a model configured; without one `POST /runs` is a 404 (G-11). */
  setFollowUpModel(available: boolean): void;
}

export interface DemoAgentContext {
  now(): Date;
  newId(): string;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>;
  actor(): DemoActor;
  contacts: Map<string, ContactRecord>;
  intakeItems: Map<string, IntakeItemRecord>;
  replies: Map<string, ReplyRecord>;
  seed: DemoFollowUp;
}

const HOUR_MS = 3_600_000;
/** `maxCandidatesPerRun`, the server's injected config. */
const MAX_CANDIDATES_PER_RUN = 5;
/** G-15: the demo prices a draft like the fake model (87 USD millionths) under the default daily cost limit. */
const DEMO_COST_PER_DRAFT_MICROS = 87;
const DEMO_COST_CAP_MICROS = 1_000_000;

const clone = <T>(value: T): T => structuredClone(value);
const byNewest = (a: FollowUpRun, b: FollowUpRun) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);

export function createDemoAgents(ctx: DemoAgentContext): FollowUpApi & DemoAgentControls {
  let settings = clone(ctx.seed.settings);
  let revision = ctx.seed.revision;
  let updatedAt = ctx.seed.updatedAt;
  let killed: FollowUpStatus["killed"] = null;
  let globalKilled = false;
  let modelAvailable = true;
  const runs = new Map(ctx.seed.runs.map((run) => [run.id, clone(run)]));
  const decisions: FollowUpDecision[] = clone(ctx.seed.decisions);

  /** The `agents` permission (owners only); anything else is TenantDenied, a 403. */
  const requireOwner = () => {
    if (ctx.actor().role !== "owner") throw demoError("Forbidden");
  };

  const draftsSince = (fromMs: number, contactId?: string) => decisions.filter((decision) =>
    decision.outcome === "drafted" && Date.parse(decision.createdAt) > fromMs && (!contactId || decision.contactId === contactId)).length;

  /** G-5: a window in the agent's zone; equal ends mean none, and it may cross midnight. */
  function inQuietHours(now: Date): boolean {
    const { quietStartMinute: start, quietEndMinute: end } = settings;
    if (start === end) return false;
    const { minute } = zonedParts(now, settings.timeZone);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  }

  /** G-3, G-4, G-5: the first reason it may not draft now, in the API's order. */
  function blockedBy(now: Date): FollowUpStopReason | null {
    if (globalKilled) return "global_killed";
    if (!settings.enabled) return "disabled";
    if (killed) return "tenant_killed";
    if (inQuietHours(now)) return "quiet_hours";
    if (draftsSince(now.getTime() - 24 * HOUR_MS) >= settings.maxDraftsPerDay) return "daily_cap";
    if (costSpent(now) >= DEMO_COST_CAP_MICROS) return "cost_cap";
    return null;
  }

  /** G-15: what the demo's drafts cost in the last 24 hours, at a fixed price per draft. */
  function costSpent(now: Date): number {
    return draftsSince(now.getTime() - 24 * HOUR_MS) * DEMO_COST_PER_DRAFT_MICROS;
  }

  function status(): FollowUpStatus {
    const reason = blockedBy(ctx.now());
    const now = ctx.now();
    const spent = costSpent(now);
    return {
      settings: { ...settings }, revision, updatedAt, killed: killed && { ...killed }, globalKilled, canDraft: reason === null, blockedBy: reason,
      costSpentMicros: spent, costCapMicros: DEMO_COST_CAP_MICROS, costWarning: spent * 5 >= DEMO_COST_CAP_MICROS * 4,
    };
  }

  /** G-7: each customer's latest website request in the window, not drafted for and not answered since. */
  function candidates(now: Date): IntakeItemRecord[] {
    const from = now.getTime() - settings.lookbackDays * 24 * HOUR_MS;
    const to = now.getTime() - settings.waitHours * HOUR_MS;
    const requests = [...ctx.intakeItems.values()].filter((item) => item.contactId && (item.status === "new_contact" || item.status === "linked"));
    return requests.filter((item) => {
      const at = Date.parse(item.createdAt);
      if (at < from || at > to) return false;
      if (requests.some((other) => other.contactId === item.contactId && other.createdAt > item.createdAt)) return false;
      if (decisions.some((decision) => decision.intakeItemId === item.id && decision.outcome === "drafted")) return false;
      return ![...ctx.replies.values()].some((reply) => reply.contactId === item.contactId && reply.status !== "discarded" && reply.createdAt > item.createdAt);
    }).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).slice(0, MAX_CANDIDATES_PER_RUN);
  }

  /** G-8: checked before the model sees anything about the customer. */
  function skipReason(contact: ContactRecord | undefined, now: Date): FollowUpSkipReason | null {
    if (!contact?.email) return "no_email";
    if (contact.consent.email?.status === "denied") return "consent_denied";
    if (draftsSince(now.getTime() - settings.contactWindowHours * HOUR_MS, contact.id) >= settings.maxDraftsPerContact) return "contact_cap";
    return null;
  }

  function draftFor(item: IntakeItemRecord, contact: ContactRecord, createdAt: string): ReplyRecord {
    const first = (contact.displayName ?? item.submitted.name).split(" ")[0];
    const reply: ReplyRecord = {
      id: ctx.newId(), tenantId: DEMO_TENANT_ID, contactId: contact.id, channel: "email", subject: DEMO_FOLLOW_UP_SUBJECT,
      body: `Hi ${first}, thank you for your request on ${formatDay(item.createdAt, settings.timeZone, "long")}. `
        + `We would be glad to help. Reply to this email with any questions, or with a time that suits you.\n\n${DEMO_BUSINESS}`,
      status: "draft", draftedBy: DEMO_AGENT, createdAt, approvedBy: null, approvedAt: null, discardedAt: null, settledAt: null,
    };
    ctx.replies.set(reply.id, reply);
    return reply;
  }

  function detail(run: FollowUpRun): FollowUpRunDetail {
    const made = decisions.filter((decision) => decision.runId === run.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return clone({ ...run, decisions: made });
  }

  return {
    async getFollowUpStatus() {
      await ctx.wait();
      return status();
    },

    updateFollowUpSettings(input, options) {
      return ctx.idempotent("agent.settings.update", input, options, () => {
        const request = ctx.parse(updateFollowUpSettingsRequestSchema, input);
        requireOwner();
        if (request.expectedRevision !== revision) throw demoError("Conflict", { reason: "stale_revision", currentRevision: revision });
        const { expectedRevision: _expected, ...next } = request;
        settings = next;
        revision += 1;
        updatedAt = ctx.now().toISOString();
        return status();
      });
    },

    killFollowUp(input, options) {
      return ctx.idempotent("agent.kill", input, options, () => {
        const request = ctx.parse(killFollowUpRequestSchema, input);
        // A switch already engaged keeps its first time and note.
        if (!killed) killed = { at: ctx.now().toISOString(), by: ctx.actor().userId, note: request.note ?? null };
        return status();
      });
    },

    resumeFollowUp(options) {
      return ctx.idempotent("agent.resume", {}, options, () => {
        ctx.parse(resumeFollowUpRequestSchema, {});
        requireOwner();
        killed = null;
        return status();
      });
    },

    startFollowUpRun(options) {
      return ctx.idempotent("agent.run.start", {}, options, () => {
        // Without a model the route does not exist.
        if (!modelAvailable) throw demoError("NotFound");
        ctx.parse(startFollowUpRunRequestSchema, {});
        requireOwner();
        const now = ctx.now();
        const startedAt = now.toISOString();
        const id = ctx.newId();
        let stopReason = blockedBy(now);
        if (!stopReason) {
          for (const item of candidates(now)) {
            if (draftsSince(now.getTime() - 24 * HOUR_MS) >= settings.maxDraftsPerDay) {
              stopReason = "daily_cap";
              break;
            }
            const contact = ctx.contacts.get(item.contactId!);
            const reason = skipReason(contact, now);
            const reply = reason || !contact ? null : draftFor(item, contact, startedAt);
            decisions.push({
              id: ctx.newId(), runId: id, intakeItemId: item.id, contactId: item.contactId!,
              outcome: reply ? "drafted" : "skipped", reason, replyId: reply?.id ?? null, approvalId: reply ? ctx.newId() : null, createdAt: startedAt,
            });
          }
        }
        const made = decisions.filter((decision) => decision.runId === id);
        const drafted = made.filter((decision) => decision.outcome === "drafted").length;
        const run: FollowUpRun = {
          id, agent: "inquiry_followup", requestedBy: ctx.actor().userId, startedAt, finishedAt: startedAt,
          status: stopReason ? "stopped" : "completed", stopReason, considered: made.length, drafted, skipped: made.length - drafted,
        };
        runs.set(id, run);
        return detail(run);
      });
    },

    async listFollowUpRuns(query = {}) {
      await ctx.wait();
      const { limit } = ctx.parse(listFollowUpRunsQuerySchema, { limit: query.limit ?? RUN_PAGE_SIZE });
      const rows = [...runs.values()].sort(byNewest);
      // Like the API's keyset cursor: the next page starts after the last run shown.
      const start = query.cursor ? rows.findIndex((run) => run.id === query.cursor) + 1 : 0;
      const items = rows.slice(start, start + limit);
      return { items: clone(items), nextCursor: start + limit < rows.length ? items.at(-1)!.id : null };
    },

    async getFollowUpRun(id) {
      await ctx.wait();
      const run = uuidSchema.safeParse(id).success ? runs.get(id) : undefined;
      if (!run) throw runNotFound();
      return detail(run);
    },

    editAgentSettingsElsewhere(change = { maxDraftsPerDay: Math.min(settings.maxDraftsPerDay + 5, 200) }) {
      settings = { ...settings, ...change };
      revision += 1;
      updatedAt = ctx.now().toISOString();
      return status();
    },

    setGlobalAgentKill(value) {
      globalKilled = value;
    },

    globalAgentKill() {
      return globalKilled;
    },

    setFollowUpModel(available) {
      modelAvailable = available;
    },
  };
}
