/**
 * Plain words for the inquiry follow-up agent (agents.md G-3..G-11): its state, why it cannot
 * draft, why a run stopped or a customer was skipped, and the settings form's fields. Shown copy
 * comes from these codes, never from a server message.
 */
import {
  agentKindConfigSchemas,
  createTemplateRevisionRequestSchema,
  followUpSettingsSchema,
  parseTemplateDraft,
  SMS_BODY_MAX,
  TEMPLATE_SUBJECT_MAX,
  TEMPLATE_TIMING_HOURS,
  TEMPLATE_VARIABLES,
  templatePlaceholders,
  ValidationFailed,
  type AgentKindStatus,
  type CreateTemplateRevisionRequest,
  type DeliveryChannel,
  type FollowUpRun,
  type FollowUpSettings,
  type FollowUpSkipReason,
  type FollowUpStatus,
  type FollowUpStopReason,
  type TemplatedKind,
  type TemplateRevision,
} from "@zs/contracts";

/** Why a run stopped, finishing "Stopped because …". */
export const STOP_REASONS: Record<FollowUpStopReason, string> = {
  global_killed: "support paused the agent",
  disabled: "the agent was turned off",
  tenant_killed: "the team stopped the agent",
  quiet_hours: "it was quiet hours",
  daily_cap: "it reached the daily draft limit",
  cost_cap: "it reached the daily cost limit for the writing service",
  stalled: "the run stopped answering, so it was closed",
};

/** Why it did not draft for one customer. */
export const SKIP_REASONS: Record<FollowUpSkipReason, string> = {
  no_email: "no email address on file",
  suppressed: "their email address cannot get mail (it bounced, or they unsubscribed)",
  consent_denied: "they said no to email",
  contact_cap: "they already got the most follow-ups allowed for now",
  answered: "someone on the team replied first",
  superseded: "they sent a newer request, which gets its own follow-up",
  model_error: "the writing service did not answer",
  model_invalid: "the writing service's draft could not be used",
  ...STOP_REASONS,
};

export const RUN_STATUS: Record<FollowUpRun["status"], { label: string; tone: "accent" | "success" | "warn" }> = {
  running: { label: "Running", tone: "accent" },
  completed: { label: "Finished", tone: "success" },
  stopped: { label: "Stopped", tone: "warn" },
};

/** "9:00 PM" for minutes past local midnight. */
export function minuteLabel(minute: number): string {
  const hours = Math.floor(minute / 60);
  const minutes = String(minute % 60).padStart(2, "0");
  return `${hours % 12 === 0 ? 12 : hours % 12}:${minutes} ${hours < 12 ? "AM" : "PM"}`;
}

/** "21:00" for an `<input type="time">`. */
export function minuteToTime(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** Minutes past midnight from "HH:MM", or NaN. */
export function timeToMinute(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return Number.NaN;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : Number.NaN;
}

export function quietHoursLabel(settings: Pick<FollowUpSettings, "quietStartMinute" | "quietEndMinute" | "timeZone">): string {
  if (settings.quietStartMinute === settings.quietEndMinute) return "No quiet hours";
  return `${minuteLabel(settings.quietStartMinute)} to ${minuteLabel(settings.quietEndMinute)}, ${zoneName(settings.timeZone)}`;
}

const zoneNames = new Map<string, string>();

/** "Eastern Time (New York)" for "America/New_York": the zone's name in words, with its city. */
export function zoneName(zone: string): string {
  if (zone === "UTC") return "UTC";
  const known = zoneNames.get(zone);
  if (known) return known;
  const city = zone.slice(zone.lastIndexOf("/") + 1).replaceAll("_", " ");
  let generic: string | undefined;
  try {
    generic = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longGeneric" })
      .formatToParts(0).find((part) => part.type === "timeZoneName")?.value;
  } catch {
    generic = undefined;
  }
  const name = generic && generic !== city ? `${generic} (${city})` : city;
  zoneNames.set(zone, name);
  return name;
}

/**
 * Whether the server can run the agent: false once `POST /runs` answered 404, which means no
 * model is configured (G-11). The status read does not say, so the screen learns it from Run now.
 */
export interface AgentReach {
  runnable: boolean;
}

/** The headline state: on, off, stopped here, or paused by support (the global switch, G-3). */
export function agentState(status: FollowUpStatus, reach: AgentReach = { runnable: true }): { label: string; tone: "success" | "neutral" | "warn" } {
  if (status.globalKilled) return { label: "Paused by support", tone: "warn" };
  if (status.killed) return { label: "Stopped", tone: "warn" };
  if (!status.settings.enabled) return { label: "Off", tone: "neutral" };
  if (!reach.runnable) return { label: "Can't draft yet", tone: "warn" };
  if (status.canDraft) return { label: "On", tone: "success" };
  return { label: "On, waiting", tone: "neutral" };
}

/** Why it cannot draft right now, as a sentence; null when it can. */
export function blockedSentence(status: FollowUpStatus, reach: AgentReach = { runnable: true }): string | null {
  // Quiet hours and the daily limit end by themselves; a missing model does not.
  if (!reach.runnable && !status.globalKilled && !status.killed && status.settings.enabled) return "No writing service is connected yet, so it drafts nothing.";
  switch (status.blockedBy) {
    case null:
      return null;
    case "global_killed":
      // Owners are not told how the service is shared: support paused it, and support resumes it.
      return "Support paused it. Nothing is drafted until support turns it back on.";
    case "disabled":
      return "It is turned off. An owner can turn it on in the agent's settings.";
    case "tenant_killed":
      return "It is stopped. Nothing is drafted until an owner resumes it.";
    case "quiet_hours":
      return `It is quiet hours (${quietHoursLabel(status.settings)}). It drafts again when they end.`;
    case "daily_cap":
      return `It drafted ${status.settings.maxDraftsPerDay} follow-ups in the last 24 hours, its daily limit. It drafts again as that count drops.`;
    case "cost_cap":
      return `The writing service cost ${dollars(status.costSpentMicros)} in the last 24 hours, its daily limit of ${dollars(status.costCapMicros)}. It drafts again as that cost drops.`;
    case "stalled":
      return "A run stopped answering and was closed. The next run starts fresh.";
  }
}

/** "$0.04" for USD millionths: whole cents, rounded up so a small spend never reads as free. */
export function dollars(micros: number): string {
  const cents = Math.ceil(micros / 10_000);
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** G-15: the writing service's cost in the last 24 hours against its daily limit, and whether it is near it. */
export function costLine(status: Pick<FollowUpStatus, "costSpentMicros" | "costCapMicros" | "costWarning">): { text: string; warning: boolean } {
  const text = `Writing service cost in the last 24 hours: ${dollars(status.costSpentMicros)} of ${dollars(status.costCapMicros)}.`;
  return { text: status.costWarning ? `${text} That is over 80% of the limit.` : text, warning: status.costWarning };
}

/** The settings form: numbers and times as typed, so a half-typed field is not lost. */
export interface SettingsForm {
  enabled: boolean;
  maxDraftsPerDay: string;
  maxDraftsPerContact: string;
  contactWindowHours: string;
  waitHours: string;
  lookbackDays: string;
  quietStart: string;
  quietEnd: string;
  timeZone: string;
}

export type SettingsField = Exclude<keyof SettingsForm, "enabled">;

export function toSettingsForm(settings: FollowUpSettings): SettingsForm {
  return {
    enabled: settings.enabled,
    maxDraftsPerDay: String(settings.maxDraftsPerDay),
    maxDraftsPerContact: String(settings.maxDraftsPerContact),
    contactWindowHours: String(settings.contactWindowHours),
    waitHours: String(settings.waitHours),
    lookbackDays: String(settings.lookbackDays),
    quietStart: minuteToTime(settings.quietStartMinute),
    quietEnd: minuteToTime(settings.quietEndMinute),
    timeZone: settings.timeZone,
  };
}

/** What each field accepts, in the contract's bounds (agents.md G-4, G-5, G-7). */
export const FIELD_HINTS: Record<SettingsField, string> = {
  maxDraftsPerDay: "A whole number from 1 to 200.",
  maxDraftsPerContact: "A whole number from 1 to 10.",
  contactWindowHours: "A whole number of hours from 1 to 2,160 (90 days).",
  waitHours: "A whole number of hours from 1 to 720 (30 days).",
  lookbackDays: "A whole number of days from 1 to 90.",
  quietStart: "Enter a time.",
  quietEnd: "Enter a time.",
  timeZone: "Pick a time zone.",
};

const FORM_FIELD: Record<keyof FollowUpSettings, SettingsField | null> = {
  enabled: null,
  maxDraftsPerDay: "maxDraftsPerDay",
  maxDraftsPerContact: "maxDraftsPerContact",
  contactWindowHours: "contactWindowHours",
  waitHours: "waitHours",
  lookbackDays: "lookbackDays",
  quietStartMinute: "quietStart",
  quietEndMinute: "quietEnd",
  timeZone: "timeZone",
};

const whole = (value: string) => (value.trim() === "" ? Number.NaN : Number(value));

/** The settings to send, or the fields that need another look, checked with the contract's schema. */
export function readSettingsForm(form: SettingsForm): { ok: true; settings: FollowUpSettings } | { ok: false; fields: SettingsField[] } {
  const parsed = followUpSettingsSchema.safeParse({
    enabled: form.enabled,
    maxDraftsPerDay: whole(form.maxDraftsPerDay),
    maxDraftsPerContact: whole(form.maxDraftsPerContact),
    contactWindowHours: whole(form.contactWindowHours),
    waitHours: whole(form.waitHours),
    lookbackDays: whole(form.lookbackDays),
    quietStartMinute: timeToMinute(form.quietStart),
    quietEndMinute: timeToMinute(form.quietEnd),
    timeZone: form.timeZone,
  });
  if (parsed.success) return { ok: true, settings: parsed.data };
  const fields = new Set<SettingsField>();
  for (const issue of parsed.error.issues) {
    const field = FORM_FIELD[issue.path[0] as keyof FollowUpSettings];
    if (field) fields.add(field);
  }
  return { ok: false, fields: [...fields] };
}

/** Zones the API accepts (`bookingTimeZoneSchema`: UTC or an Area/City name), with `current` kept. */
export function timeZoneChoices(current: string): string[] {
  let zones: string[] = [];
  try {
    zones = Intl.supportedValuesOf("timeZone").filter((zone) => zone.includes("/"));
  } catch {
    zones = [];
  }
  return [...new Set(["UTC", current, ...zones])].sort((a, b) => (a === "UTC" ? -1 : b === "UTC" ? 1 : a.localeCompare(b)));
}

// Templated kinds: appointment reminders and review requests (agents.md G-14, G-19, G-20,
// approvals.md A-15). They send wording an owner approved; every send still checks consent.

export const KIND_COPY: Record<TemplatedKind, {
  title: string; description: string; sendLabel: string; noun: string; timingLabel: string; when: "before" | "after";
}> = {
  appointment_reminder: {
    title: "Appointment reminders",
    description: "Reminds each customer of their appointment, in wording an owner approved.",
    sendLabel: "Send appointment reminders",
    noun: "appointment reminders",
    timingLabel: "Hours before the appointment",
    when: "before",
  },
  review_request: {
    title: "Review requests",
    description: "Asks customers for a review after their appointment, in wording an owner approved. Only customers who said yes to marketing messages get one.",
    sendLabel: "Send review requests",
    noun: "review requests",
    timingLabel: "Hours after the appointment",
    when: "after",
  },
};

/** What each variable fills in, by name. */
export const VARIABLE_HELP: Record<string, string> = {
  customer_first_name: "the customer's first name",
  business_name: "your business name",
  booking_start_local: "the appointment's date and time",
  booking_link: "the link to book or change an appointment",
  review_link: "your review link",
};

export const CHANNEL_LABELS: Record<DeliveryChannel, string> = { email: "Email", sms: "Text message" };

/** Shown by the wording form whenever the current wording is approved (A-15). */
export const UNAPPROVES_WARNING =
  "Saving new wording un-approves sends: the approved wording stops being used at once, and nothing is sent until an owner approves the new wording.";
/** Shown by the wording form when nothing approved would stop. */
export const NEEDS_APPROVAL_NOTE = "New wording is not sent until an owner approves it.";
/** G-20: the API refuses to turn review requests on without a review link (ValidationFailed, no detail). */
export const ENABLE_NEEDS_REVIEW_LINK = "Review requests need your review link. Add it below and save it, then turn them on.";
/** A-15: the revision changed or was replaced under the approval. */
export const TEMPLATE_CHANGED_MESSAGE = "The wording changed since you loaded it. The latest wording is shown. Read it, then approve it.";
export const TEMPLATE_STALE_MESSAGE = "Someone saved new wording while you were writing. It is shown above, and your text is still here. Save again to replace it.";

const hours = (count: number) => `${count} ${count === 1 ? "hour" : "hours"}`;

/** "24 hours before the appointment". */
export function timingSentence(kind: TemplatedKind, timingHours: number): string {
  return `${hours(timingHours)} ${KIND_COPY[kind].when} the appointment`;
}

/** The template's current revision, or null before the first. */
export function currentRevisionOf(state: { revisions: readonly TemplateRevision[] }): TemplateRevision | null {
  return state.revisions.find((revision) => revision.current) ?? null;
}

/** Whether sends may use this revision now, in a word. */
export function revisionState(revision: TemplateRevision): { label: string; tone: "success" | "warn" } {
  if (revision.approved) return { label: "Approved", tone: "success" };
  if (revision.pendingApprovalId) return { label: "Waiting for approval", tone: "warn" };
  if (revision.standing?.standing === "expired") return { label: "Approval ended", tone: "warn" };
  return { label: "Needs approval", tone: "warn" };
}

/**
 * The headline state of a templated kind. `current` is its current revision, null with none,
 * or undefined when this reader cannot see the wording (staff).
 */
export function kindState(status: AgentKindStatus, current: TemplateRevision | null | undefined): { label: string; tone: "success" | "neutral" | "warn" } {
  if (status.globalKilled) return { label: "Paused by support", tone: "warn" };
  if (status.killed) return { label: "Stopped", tone: "warn" };
  if (!status.settings.enabled) return { label: "Off", tone: "neutral" };
  if (current !== undefined && !current?.approved) return { label: "On, needs approval", tone: "warn" };
  if (status.canRun) return { label: "On", tone: "success" };
  return { label: "On, waiting", tone: "neutral" };
}

/** The toast after Run now on a templated kind. */
export function kindRunToast(run: Pick<FollowUpRun, "status" | "stopReason" | "considered" | "drafted" | "skipped">): string {
  if (run.status === "stopped" && run.stopReason) return `It sent nothing: ${STOP_REASONS[run.stopReason]}.`;
  if (run.considered === 0) return "Run finished. Nothing to send right now.";
  return `Run finished. Queued ${run.drafted} ${run.drafted === 1 ? "message" : "messages"}, skipped ${run.skipped}.`;
}

/** The wording form, as typed. */
export interface TemplateForm {
  channel: DeliveryChannel;
  subject: string;
  body: string;
  timingHours: string;
}
export type TemplateField = "subject" | "body" | "timingHours";

export function toTemplateForm(kind: TemplatedKind, revision: TemplateRevision | null): TemplateForm {
  if (!revision) return { channel: "email", subject: "", body: "", timingHours: String(TEMPLATE_TIMING_HOURS[kind].fallback) };
  return { channel: revision.channel, subject: revision.subject ?? "", body: revision.body, timingHours: String(revision.timingHours) };
}

/** Names between braces in the texts that are not the kind's variables, in order of first use. */
export function unknownPlaceholders(kind: TemplatedKind, ...texts: string[]): string[] {
  const allowed = new Set(TEMPLATE_VARIABLES[kind]);
  return [...new Set(texts.flatMap((text) => templatePlaceholders(text)))].filter((name) => !allowed.has(name));
}

const braces = (names: readonly string[]) => names.map((name) => `{${name}}`);
/** "a, b and c". */
const listed = (items: readonly string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

function placeholderError(kind: TemplatedKind, unknown: readonly string[]): string {
  const verb = unknown.length === 1 ? "is not a variable" : "are not variables";
  return `${listed(braces(unknown))} ${verb} for ${KIND_COPY[kind].noun}. Use only ${listed(braces(TEMPLATE_VARIABLES[kind]))}.`;
}

/**
 * The revision to send, or what to fix, field by field. The same checks as the server
 * (`parseTemplateDraft`), with words for people; the server still decides.
 */
export function readTemplateForm(kind: TemplatedKind, form: TemplateForm, expectedRevision: number):
  { ok: true; request: CreateTemplateRevisionRequest } | { ok: false; errors: Partial<Record<TemplateField, string>> } {
  const errors: Partial<Record<TemplateField, string>> = {};
  const email = form.channel === "email";
  const subject = email ? form.subject.trim() : null;
  const body = form.body.trim();
  const range = TEMPLATE_TIMING_HOURS[kind];
  const timing = form.timingHours.trim() === "" ? Number.NaN : Number(form.timingHours);

  if (subject !== null) {
    const unknown = unknownPlaceholders(kind, subject);
    if (subject === "") errors.subject = "Add a subject for the email.";
    else if (subject.length > TEMPLATE_SUBJECT_MAX) errors.subject = `A subject can be up to ${TEMPLATE_SUBJECT_MAX} characters.`;
    else if (unknown.length > 0) errors.subject = placeholderError(kind, unknown);
  }
  const unknown = unknownPlaceholders(kind, body);
  if (body === "") errors.body = "Write the message.";
  else if (unknown.length > 0) errors.body = placeholderError(kind, unknown);
  else if (!email && body.length > SMS_BODY_MAX) errors.body = `A text message can be up to ${SMS_BODY_MAX.toLocaleString("en-US")} characters.`;
  if (!Number.isInteger(timing) || timing < range.min || timing > range.max)
    errors.timingHours = `A whole number of hours from ${range.min} to ${range.max}.`;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  try {
    parseTemplateDraft(kind, { channel: form.channel, subject, body, timingHours: timing });
  } catch (error) {
    if (!(error instanceof ValidationFailed)) throw error;
    return { ok: false, errors: { body: /too long/.test(error.message) ? "The message is too long once its variables are filled in. Shorten it." : "This wording can't be used. Check it and try again." } };
  }
  const parsed = createTemplateRevisionRequestSchema.safeParse({ expectedRevision, channel: form.channel, subject, body, timingHours: timing });
  if (!parsed.success) return { ok: false, errors: { body: "This wording can't be used. Check it and try again." } };
  return { ok: true, request: parsed.data };
}

/** G-20: the review link as the kind's config takes it (https, at most 500 characters); empty is none. */
export function readReviewLink(value: string): { ok: true; reviewUrl: string | undefined } | { ok: false; message: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, reviewUrl: undefined };
  const parsed = agentKindConfigSchemas.review_request.shape.reviewUrl.safeParse(trimmed);
  return parsed.success ? { ok: true, reviewUrl: parsed.data } : { ok: false, message: "Enter a full link that starts with https://." };
}

/** Why a templated kind that is on cannot send right now, as a sentence; null when it can or is off. */
export function kindBlockedSentence(status: AgentKindStatus): string | null {
  switch (status.blockedBy) {
    case null:
    case "disabled":
      return null;
    case "global_killed":
      return "Support paused it. Nothing is sent until support turns it back on.";
    case "tenant_killed":
      return "It is stopped. Nothing is sent until an owner resumes it.";
    case "quiet_hours":
      return `It is quiet hours (${quietHoursLabel(status.settings)}). Messages wait until they end.`;
    case "daily_cap":
      return "It sent the most messages allowed in a day. It sends again as that count drops.";
    case "cost_cap":
      return `The writing service cost ${dollars(status.costSpentMicros)} in the last 24 hours, its daily limit. Suggestions wait until that cost drops.`;
    case "stalled":
      return "A run stopped answering and was closed. The next run starts fresh.";
  }
}
