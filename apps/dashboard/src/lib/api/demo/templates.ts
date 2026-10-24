/**
 * The demo adapter's templated agent kinds (agents.md G-14, G-19, G-20, approvals.md A-15):
 * appointment reminders and review requests. It keeps the rules the API enforces: owners read,
 * write and approve the wording; a revision's placeholders must be the kind's variables; a save
 * names the revision it started from; an approval names the digest the owner read; and a new
 * revision ends the previous revision's approval, so nothing is sent until an owner approves the
 * new one. Review requests need a review link before they can be turned on. In memory and
 * deterministic: the same wording has the same digest in every session.
 */
import type { z } from "zod";
import {
  agentKindConfigSchemas,
  approveTemplateRequestSchema,
  createTemplateRevisionRequestSchema,
  defaultAgentKindSettings,
  parseTemplateDraft,
  startFollowUpRunRequestSchema,
  suggestTemplateRequestSchema,
  TEMPLATE_PURPOSES,
  TEMPLATE_REVISIONS_SHOWN,
  TEMPLATE_STANDING_GRANT_ACTION,
  TEMPLATE_VARIABLES,
  templatedKindSchema,
  templatePlaceholders,
  updateAgentKindSettingsRequestSchema,
  ValidationFailed,
  type AgentKindSettings,
  type AgentKindStatus,
  type ApprovalRecord,
  type ApproveApprovalResponse,
  type DeliveryChannel,
  type FollowUpStopReason,
  type TemplatedKind,
  type TemplateRevision,
  type TemplateState,
  type TemplateSuggestion,
} from "@zs/contracts";
import { zonedParts } from "../../time";
import { demoError } from "../errors";
import type { KindRunDetail, TemplatedKindsApi, WriteOptions } from "../types";
import type { DemoActor } from "./agents";
import { DEMO_TENANT_ID, DEMO_ZONE } from "./seed";


export interface DemoTemplateControls {
  /** Whether this server has a wording-suggestion model; without one the suggestion route is a 404 (G-19). */
  setTemplateSuggestions(available: boolean): void;
  /** Another owner writes new wording first, so this screen's save is `stale_revision` and its approval ends. */
  writeTemplateElsewhere(kind: TemplatedKind, body?: string): TemplateState;
}

export interface DemoTemplateContext {
  now(): Date;
  newId(): string;
  wait(): Promise<void>;
  idempotent<T>(operation: string, payload: unknown, options: WriteOptions, run: () => T): Promise<T>;
  parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T>;
  actor(): DemoActor;
  /** The operator's switch for every agent (G-3), shared with the follow-up agent. */
  globalKilled(): boolean;
}

/** Fixed per kind, like the API's `templateIdFor(tenantId, kind)`. */
const TEMPLATE_IDS: Record<TemplatedKind, string> = {
  appointment_reminder: "7d3e9a1c-2b4f-4c6d-8e1f-00000000a001",
  review_request: "7d3e9a1c-2b4f-4c6d-8e1f-00000000a002",
};
/** A-5: a standing approval lasts at most 30 days, and 30 days when the request names none. */
const STANDING_MINUTES = 43_200;
/** G-15: the demo prices a suggestion like the fake model. */
const SUGGESTION_COST_MICROS = 87;
const DAY_MS = 86_400_000;

interface StoredRevision extends Omit<TemplateRevision, "current" | "approved" | "standing"> {
  standing: { approvalId: string; standing: "approved" | "revoked"; expiresAt: string; sends: number } | null;
}
interface KindState {
  settings: AgentKindSettings;
  revision: number;
  updatedAt: string | null;
  /** Oldest first. */
  revisions: StoredRevision[];
  suggestions: string[];
}

/**
 * 64 hex characters from the wording, the same in every session: eight FNV-1a lanes with
 * different seeds. The API uses SHA-256; the demo needs no Web Crypto (plain-HTTP previews lack it).
 */
export function demoDigest(text: string): string {
  let out = "";
  for (let lane = 0; lane < 8; lane += 1) {
    let hash = (0x811c9dc5 ^ Math.imul(lane + 1, 0x9e3779b1)) >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    out += hash.toString(16).padStart(8, "0");
  }
  return out;
}

/** G-19: fixed wording per kind and channel, using only the kind's variables. */
const SUGGESTIONS: Record<TemplatedKind, Record<DeliveryChannel, { subject: string | null; body: string }>> = {
  appointment_reminder: {
    email: {
      subject: "Your appointment with {business_name}",
      body: "Hi {customer_first_name},\n\nThis is a reminder of your appointment on {booking_start_local}. "
        + "If you need to change it, you can pick a new time here: {booking_link}\n\nSee you soon,\n{business_name}",
    },
    sms: { subject: null, body: "Hi {customer_first_name}, a reminder of your appointment with {business_name} on {booking_start_local}. To change it: {booking_link}" },
  },
  review_request: {
    email: {
      subject: "How was your visit to {business_name}?",
      body: "Hi {customer_first_name},\n\nThank you for visiting us on {booking_start_local}. "
        + "If you have a minute, we would be grateful for a short review: {review_link}\n\nThank you,\n{business_name}",
    },
    sms: { subject: null, body: "Hi {customer_first_name}, thanks for visiting {business_name}. Would you leave us a short review? {review_link}" },
  },
};

export function createDemoTemplates(ctx: DemoTemplateContext): TemplatedKindsApi & DemoTemplateControls {
  const kinds: Record<TemplatedKind, KindState> = {
    appointment_reminder: fresh("appointment_reminder"),
    review_request: fresh("review_request"),
  };
  let suggestionsOn = true;

  function fresh(kind: TemplatedKind): KindState {
    return { settings: { ...defaultAgentKindSettings(kind), timeZone: DEMO_ZONE }, revision: 0, updatedAt: null, revisions: [], suggestions: [] };
  }

  /** An unknown kind's routes do not exist; the follow-up kind has its own (404, like `kindOf`). */
  const kindOf = (raw: unknown): TemplatedKind => {
    const parsed = templatedKindSchema.safeParse(raw);
    if (!parsed.success) throw demoError("NotFound");
    return parsed.data;
  };
  /** The `agents` permission (owners only); anything else is TenantDenied, a 403. */
  const requireOwner = () => {
    if (ctx.actor().role !== "owner") throw demoError("Forbidden");
  };

  const currentOf = (state: KindState) => state.revisions.at(-1) ?? null;

  function view(kind: TemplatedKind): TemplateState {
    const state = kinds[kind];
    const now = ctx.now().getTime();
    const current = currentOf(state);
    const revisions = [...state.revisions].reverse().slice(0, TEMPLATE_REVISIONS_SHOWN).map((stored): TemplateRevision => {
      const standing: TemplateRevision["standing"] = stored.standing && {
        ...stored.standing,
        standing: stored.standing.standing === "approved" && Date.parse(stored.standing.expiresAt) <= now ? "expired" : stored.standing.standing,
      };
      const isCurrent = stored === current;
      return { ...structuredClone(stored), standing, current: isCurrent, approved: isCurrent && standing?.standing === "approved" };
    });
    return {
      agentKind: kind, templateId: TEMPLATE_IDS[kind], purpose: TEMPLATE_PURPOSES[kind], variables: [...TEMPLATE_VARIABLES[kind]],
      currentRevision: current?.revision ?? 0, revisions,
    };
  }

  /** G-5: a window in the kind's zone; equal ends mean none, and it may cross midnight. */
  function inQuietHours(settings: AgentKindSettings, now: Date): boolean {
    const { quietStartMinute: start, quietEndMinute: end } = settings;
    if (start === end) return false;
    const { minute } = zonedParts(now, settings.timeZone);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  }

  const costSpent = (state: KindState, now: Date) =>
    state.suggestions.filter((at) => Date.parse(at) > now.getTime() - DAY_MS).length * SUGGESTION_COST_MICROS;

  function blockedBy(state: KindState, now: Date): FollowUpStopReason | null {
    if (ctx.globalKilled()) return "global_killed";
    if (!state.settings.enabled) return "disabled";
    if (inQuietHours(state.settings, now)) return "quiet_hours";
    if (costSpent(state, now) >= state.settings.maxCostMicrosPerDay) return "cost_cap";
    return null;
  }

  function status(kind: TemplatedKind): AgentKindStatus {
    const state = kinds[kind];
    const now = ctx.now();
    const reason = blockedBy(state, now);
    const spent = costSpent(state, now);
    const cap = state.settings.maxCostMicrosPerDay;
    return {
      agentKind: kind, settings: structuredClone(state.settings), revision: state.revision, updatedAt: state.updatedAt, killed: null,
      globalKilled: ctx.globalKilled(), canRun: reason === null, blockedBy: reason,
      costSpentMicros: spent, costCapMicros: cap, costWarning: cap > 0 && spent * 5 >= cap * 4,
    };
  }

  /** A-15: the next revision becomes current; the previous one's approval is revoked (`superseded`). */
  function writeRevision(kind: TemplatedKind, draft: { channel: DeliveryChannel; subject: string | null; body: string; timingHours: number }) {
    const state = kinds[kind];
    const checked = parseTemplateDraft(kind, { channel: draft.channel, subject: draft.subject, body: draft.body, timingHours: draft.timingHours });
    const previous = currentOf(state);
    if (previous?.standing?.standing === "approved") previous.standing = { ...previous.standing, standing: "revoked" };
    const revision = (previous?.revision ?? 0) + 1;
    state.revisions.push({
      id: ctx.newId(), revision, channel: checked.channel, purpose: checked.purpose, subject: checked.subject, body: checked.body,
      variables: [...checked.variables], timingHours: checked.timingHours,
      contentDigest: demoDigest(JSON.stringify([kind, checked.channel, checked.purpose, checked.subject, checked.body, checked.variables, checked.timingHours])),
      createdBy: ctx.actor().userId, createdAt: ctx.now().toISOString(), standing: null, pendingApprovalId: null,
    });
  }

  return {
    async getAgentKindStatus(rawKind) {
      await ctx.wait();
      return status(kindOf(rawKind));
    },

    updateAgentKindSettings(rawKind, input, options) {
      return ctx.idempotent("agent.kind.settings.update", { agentKind: rawKind, ...input }, options, () => {
        const kind = kindOf(rawKind);
        const request = ctx.parse(updateAgentKindSettingsRequestSchema, input);
        requireOwner();
        const config = ctx.parse(agentKindConfigSchemas[kind], request.config) as AgentKindSettings["config"];
        // G-20: like the API, a ValidationFailed with no detail.
        if (request.enabled && kind === "review_request" && !config.reviewUrl) throw demoError("ValidationFailed");
        const state = kinds[kind];
        if (request.expectedRevision !== state.revision) throw demoError("Conflict", { reason: "stale_revision", currentRevision: state.revision });
        const { expectedRevision: _expected, ...settings } = request;
        state.settings = { ...settings, config };
        state.revision += 1;
        state.updatedAt = ctx.now().toISOString();
        return status(kind);
      });
    },

    async getTemplate(rawKind) {
      await ctx.wait();
      const kind = kindOf(rawKind);
      requireOwner();
      return view(kind);
    },

    createTemplateRevision(rawKind, input, options) {
      return ctx.idempotent("template.revision.create", { agentKind: rawKind, ...input }, options, () => {
        const kind = kindOf(rawKind);
        const request = ctx.parse(createTemplateRevisionRequestSchema, input);
        requireOwner();
        const state = kinds[kind];
        try {
          parseTemplateDraft(kind, { channel: request.channel, subject: request.subject, body: request.body, timingHours: request.timingHours });
        } catch (error) {
          // The API's ValidationFailed from a handler carries no issues.
          if (error instanceof ValidationFailed) throw demoError("ValidationFailed");
          throw error;
        }
        const current = currentOf(state)?.revision ?? 0;
        if (request.expectedRevision !== current) throw demoError("Conflict", { reason: "stale_revision", currentRevision: current });
        writeRevision(kind, request);
        return view(kind);
      });
    },

    approveTemplate(rawKind, input, options) {
      return ctx.idempotent("template.approve", { agentKind: rawKind, ...input }, options, (): ApproveApprovalResponse => {
        const kind = kindOf(rawKind);
        const request = ctx.parse(approveTemplateRequestSchema, input);
        requireOwner();
        const state = kinds[kind];
        const stored = state.revisions.find((candidate) => candidate.revision === request.revision);
        if (!stored) throw demoError("NotFound");
        if (stored.contentDigest !== request.contentDigest) throw demoError("Conflict", { reason: "template_changed" });
        if (stored !== currentOf(state)) throw demoError("Conflict", { reason: "template_superseded" });
        const now = ctx.now();
        const at = now.toISOString();
        const expiresAt = new Date(now.getTime() + (request.expiresInMinutes ?? STANDING_MINUTES) * 60_000).toISOString();
        const approvalId = ctx.newId();
        const executionId = ctx.newId();
        stored.standing = { approvalId, standing: "approved", expiresAt, sends: 0 };
        const payload = { templateId: TEMPLATE_IDS[kind], revision: stored.revision, contentDigest: stored.contentDigest };
        const approval: ApprovalRecord = {
          id: approvalId, tenantId: DEMO_TENANT_ID, actionType: TEMPLATE_STANDING_GRANT_ACTION,
          target: { tenantId: DEMO_TENANT_ID, type: "message_template_revision", id: stored.id }, payload,
          summary: `Send the ${kind === "appointment_reminder" ? "appointment reminder" : "review request"} wording, revision ${stored.revision}`,
          status: "approved", standing: "approved", requestedBy: ctx.actor().userId, requestedAt: at, expiresAt,
          decidedBy: ctx.actor().userId, decidedAt: at, decisionNote: null, revokedBy: null, revokedAt: null, revokeNote: null, executedActionId: executionId,
        };
        return { approval: { actionId: ctx.newId(), result: approval }, execution: { actionId: executionId, result: payload } };
      });
    },

    async suggestTemplate(rawKind, input, options) {
      // Without a suggestion model the route does not exist.
      if (!suggestionsOn) {
        await ctx.wait();
        throw demoError("NotFound");
      }
      return ctx.idempotent("template.suggest", { agentKind: rawKind, ...input }, options, (): TemplateSuggestion => {
        const kind = kindOf(rawKind);
        const request = ctx.parse(suggestTemplateRequestSchema, input);
        requireOwner();
        const state = kinds[kind];
        state.suggestions.push(ctx.now().toISOString());
        const { subject, body } = SUGGESTIONS[kind][request.channel];
        const spent = costSpent(state, ctx.now());
        const cap = state.settings.maxCostMicrosPerDay;
        return {
          agentKind: kind, channel: request.channel, subject, body,
          variables: [...new Set([...templatePlaceholders(body), ...templatePlaceholders(subject ?? "")])].sort(),
          costSpentMicros: spent, costCapMicros: cap, costWarning: cap > 0 && spent * 5 >= cap * 4,
        };
      });
    },

    startKindRun(rawKind, options) {
      return ctx.idempotent("agent.kind.run.start", { agentKind: rawKind }, options, (): KindRunDetail => {
        const kind = kindOf(rawKind);
        ctx.parse(startFollowUpRunRequestSchema, {});
        requireOwner();
        const at = ctx.now().toISOString();
        const stopReason = blockedBy(kinds[kind], ctx.now());
        // The demo has no bookings due for a message, so a run that may act finds nothing to send.
        return {
          id: ctx.newId(), agent: kind, requestedBy: ctx.actor().userId, startedAt: at, finishedAt: at,
          status: stopReason ? "stopped" : "completed", stopReason, considered: 0, drafted: 0, skipped: 0, decisions: [],
        };
      });
    },

    setTemplateSuggestions(available) {
      suggestionsOn = available;
    },

    writeTemplateElsewhere(kind, body = "Hi {customer_first_name}, see you soon at {business_name}.") {
      const current = currentOf(kinds[kind]);
      writeRevision(kind, {
        channel: current?.channel ?? "email", subject: current ? current.subject : "A note from {business_name}", body,
        timingHours: current?.timingHours ?? 24,
      });
      return view(kind);
    },
  };
}
