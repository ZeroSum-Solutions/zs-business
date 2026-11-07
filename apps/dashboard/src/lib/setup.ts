/**
 * The setup screen's pure parts (industry-templates.md IT-7, IT-10): opening hours in words, the
 * zone the confirm starts with, and the stage a new deal goes into.
 */
import type { IndustryTemplatePreview, PipelineSummary, RECOMMENDABLE_CONNECTIONS } from "@zs/contracts";
import { minuteLabel } from "./agents";

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

type Weekly = IndustryTemplatePreview["resource"]["weekly"];

/** "Mon–Fri 9:00 AM–5:00 PM": weekdays in a row with the same hours share a line. */
export function hoursLines(weekly: Weekly): string[] {
  const hoursOf = (rule: Weekly[number]) => rule.windows.map((w) => `${minuteLabel(w.startMinute)}–${minuteLabel(w.endMinute)}`).join(", ");
  const days = [...weekly].sort((a, b) => a.weekday - b.weekday).map((rule) => ({ weekday: rule.weekday, hours: hoursOf(rule) }));
  const runs: { from: number; to: number; hours: string }[] = [];
  for (const day of days) {
    const last = runs.at(-1);
    if (last && last.to === day.weekday - 1 && last.hours === day.hours) last.to = day.weekday;
    else runs.push({ from: day.weekday, to: day.weekday, hours: day.hours });
  }
  return runs.map((run) => {
    const name = (weekday: number) => DAY_NAMES[weekday - 1]!;
    const span = run.from === run.to ? name(run.from) : `${name(run.from)}–${name(run.to)}`;
    return `${span} ${run.hours}`;
  });
}

/** IT-7: the confirm starts with the profile's zone, else the browser's. */
export function initialZone(profileZone: string | null | undefined, browser: string): string {
  return profileZone || browser;
}

export type DealTarget = { pipelineId: string; stageId: string };
export type DealTargetResult = DealTarget | { problem: "no_pipeline" | "no_open_stage" };

/**
 * IT-10: a new deal goes into the first stage that is neither won nor lost of the template's
 * pipeline. `setupPipelineId` is the applied template's pipeline, or null when the setup read
 * definitively says no template was applied; only then does the business's first pipeline stand in.
 * Callers pass nothing while the setup read is pending or failed. An applied pipeline that is gone
 * is "no pipeline", never another pipeline.
 */
export function dealTarget(pipelines: readonly PipelineSummary[], setupPipelineId: string | null): DealTargetResult {
  const pipeline = setupPipelineId === null ? pipelines[0] : pipelines.find((item) => item.id === setupPipelineId);
  if (!pipeline) return { problem: "no_pipeline" };
  const stage = [...pipeline.stages].sort((a, b) => a.position - b.position).find((item) => item.outcome === "open");
  return stage ? { pipelineId: pipeline.id, stageId: stage.id } : { problem: "no_open_stage" };
}

/** "24 hours before the appointment, by email": the preview message's own timing and channel. */
export function messageTimingLine(message: IndustryTemplatePreview["messages"][number]): string {
  const count = message.timingHours;
  const channel = message.channel === "sms" ? "text message" : "email";
  return `${count} ${count === 1 ? "hour" : "hours"} ${message.timing} the appointment, by ${channel}`;
}

export type RecommendableConnection = (typeof RECOMMENDABLE_CONNECTIONS)[number];

export const CONNECTION_LABELS: Record<RecommendableConnection, string> = { shopify: "Shopify", google_calendar: "Google Calendar" };

/** "45 minutes", "12 hours", "60 days". */
export function durationLabel(minutes: number): string {
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  if (minutes > 0 && minutes % 1440 === 0) return unit(minutes / 1440, "day");
  if (minutes > 0 && minutes % 60 === 0) return unit(minutes / 60, "hour");
  return unit(minutes, "minute");
}

/**
 * Google Calendar counts as connected for the template's calendar only while a connection is
 * active. A connection that needs a reconnect (`reauthorize`) no longer keeps busy times in sync.
 */
export function calendarConnected(connections: readonly { resourceId: string; status: string }[], resourceId: string): boolean {
  return connections.some((item) => item.resourceId === resourceId && item.status === "active");
}
