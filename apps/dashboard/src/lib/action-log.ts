// Plain words for the owner's action log (backlog B05). Pure functions, so tests read them directly.
import type { ActionActor, ActionLogEntry, AgentKind, SystemActor } from "@zs/contracts";

const AGENT_NAMES: Record<AgentKind, string> = {
  inquiry_followup: "Follow-up agent",
  appointment_reminder: "Reminder agent",
  review_request: "Review request agent",
  document_intake: "Document agent",
  voice_receptionist: "Phone agent",
};

const SYSTEM_NAMES: Record<SystemActor, string> = {
  public_intake: "Your booking page",
  unsubscribe: "A customer's unsubscribe link",
  inbound_sms: "An incoming text",
  sms_status: "Text delivery update",
  email_feedback: "Email delivery update",
  voice: "Your phone line",
  enrichment: "Company lookup",
  outreach: "Outreach",
  transcription: "Transcription",
  document_intake: "Document reader",
  images: "Image worker",
  automation: "An automation",
};

/** Who acted, in words. People show by role: the log names no one by address. */
export function actorLabel(actor: ActionActor): string {
  if (actor.kind === "agent") return AGENT_NAMES[actor.agent];
  if (actor.kind === "system") return SYSTEM_NAMES[actor.name];
  if (actor.memberId === null) return "A former member";
  return actor.role === "owner" ? "Owner" : "Staff";
}

/** "inbox.reply.send" → "Inbox reply send". Action types are code names; this keeps them readable. */
export function actionLabel(actionType: string): string {
  const words = actionType.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "inbox_reply" → "Inbox reply". */
export const recordLabel = (type: string) => actionLabel(type);

type Tone = "success" | "warn" | "neutral" | "danger";
/** Where the approval stands today; an action that ran under it was approved when it ran. */
const APPROVAL_LABEL: Record<NonNullable<ActionLogEntry["approval"]>["status"], { label: string; tone: Tone }> = {
  approved: { label: "Approved", tone: "success" },
  pending: { label: "Waiting for approval", tone: "warn" },
  rejected: { label: "Rejected", tone: "danger" },
  revoked: { label: "Approval revoked", tone: "warn" },
  expired: { label: "Approval expired", tone: "neutral" },
};

export function approvalBadge(approval: NonNullable<ActionLogEntry["approval"]>): { label: string; tone: Tone } {
  return APPROVAL_LABEL[approval.status];
}

/** "done" → "Done", "no_show" → "No show". */
export const outcomeLabel = (outcome: string) => actionLabel(outcome);

/** The first block of an ID, enough to match a record by eye. */
export const shortId = (id: string) => id.slice(0, 8);

/** The dashboard page of a record, where it has one. */
export function recordHref(target: ActionLogEntry["target"]): string | null {
  return target.type === "contact" ? `/customers/${encodeURIComponent(target.id)}` : null;
}
