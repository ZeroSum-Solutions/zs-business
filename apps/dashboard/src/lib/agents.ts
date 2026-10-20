/**
 * Plain words for the inquiry follow-up agent (agents.md G-3..G-11): its state, why it cannot
 * draft, why a run stopped or a customer was skipped, and the settings form's fields. Shown copy
 * comes from these codes, never from a server message.
 */
import { followUpSettingsSchema, type FollowUpRun, type FollowUpSettings, type FollowUpSkipReason, type FollowUpStatus, type FollowUpStopReason } from "@zs/contracts";

/** Why a run stopped, finishing "Stopped because …". */
export const STOP_REASONS: Record<FollowUpStopReason, string> = {
  global_killed: "agents were stopped for every business on this service",
  disabled: "the agent was turned off",
  tenant_killed: "someone stopped the agent",
  quiet_hours: "it was quiet hours",
  daily_cap: "it reached the daily draft limit",
};

/** Why it did not draft for one customer. */
export const SKIP_REASONS: Record<FollowUpSkipReason, string> = {
  no_email: "no email address on file",
  suppressed: "their email address cannot get mail (it bounced, or they unsubscribed)",
  consent_denied: "they said no to email",
  contact_cap: "they already got the most follow-ups allowed for now",
  answered: "someone on the team replied first",
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
  return `${minuteLabel(settings.quietStartMinute)} to ${minuteLabel(settings.quietEndMinute)}, ${settings.timeZone.replaceAll("_", " ")} time`;
}

/** The headline state: on, off, stopped here, or stopped for every business. */
export function agentState(status: FollowUpStatus): { label: string; tone: "success" | "neutral" | "warn" | "danger" } {
  if (status.globalKilled) return { label: "Stopped for all businesses", tone: "danger" };
  if (status.killed) return { label: "Stopped", tone: "danger" };
  if (!status.settings.enabled) return { label: "Off", tone: "neutral" };
  if (status.canDraft) return { label: "On", tone: "success" };
  return { label: "On, waiting", tone: "warn" };
}

/** Why it cannot draft right now, as a sentence; null when it can. */
export function blockedSentence(status: FollowUpStatus): string | null {
  switch (status.blockedBy) {
    case null:
      return null;
    case "global_killed":
      return "Agents are stopped for every business on this service. Nothing is drafted until the service turns them back on.";
    case "disabled":
      return "It is turned off. An owner can turn it on in the agent's settings.";
    case "tenant_killed":
      return "Someone stopped it. Nothing is drafted until an owner resumes it.";
    case "quiet_hours":
      return `It is quiet hours (${quietHoursLabel(status.settings)}). It drafts again when they end.`;
    case "daily_cap":
      return `It drafted ${status.settings.maxDraftsPerDay} follow-ups in the last 24 hours, its daily limit. It drafts again as that count drops.`;
  }
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
