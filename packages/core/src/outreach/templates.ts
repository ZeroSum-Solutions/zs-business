// Templates, footer and digests for cold outreach (outreach-sequencer.md OS-4, OS-5, OS-6, OS-8). Pure functions: no
// clock, no environment, no database.
import { createHash } from "node:crypto";
import { OUTREACH_VARIABLES, type OutreachVariable } from "@zs/contracts";

export interface TemplateStep {
  readonly subject?: string | null | undefined;
  readonly body: string;
}
/** The prospect fields a template can use. */
export interface TemplateValues {
  readonly firstName: string;
  readonly company: string;
  readonly industry: string | null;
}

const VARIABLE = /\{\{(first_name|company|industry)\}\}/g;

/** True when the text holds a `{{` or `}}` that is not one of the three allowed variables written exactly (OS-5). */
export function hasUnknownVariable(text: string): boolean {
  const rest = text.replace(VARIABLE, "");
  return rest.includes("{{") || rest.includes("}}");
}

/** The variables a text uses. */
export function variablesUsed(text: string): Set<OutreachVariable> {
  const found = new Set<OutreachVariable>();
  for (const match of text.matchAll(VARIABLE)) found.add(match[1] as OutreachVariable);
  return found;
}

export interface StepProblem {
  /** The input path, as the API reports a validation issue: `steps.<index>.<field>`. */
  readonly path: string;
  readonly code: "unknown_variable";
}
/** OS-5: the first step field that uses an unknown variable, or null. */
export function unknownVariableProblem(steps: readonly TemplateStep[]): StepProblem | null {
  for (const [index, step] of steps.entries()) {
    if (step.subject != null && hasUnknownVariable(step.subject)) return { path: `steps.${index}.subject`, code: "unknown_variable" };
    if (hasUnknownVariable(step.body)) return { path: `steps.${index}.body`, code: "unknown_variable" };
  }
  return null;
}

/** Every variable any step of the campaign uses. */
export function campaignVariables(steps: readonly TemplateStep[]): Set<OutreachVariable> {
  const found = new Set<OutreachVariable>();
  for (const step of steps) {
    for (const name of variablesUsed(step.subject ?? "")) found.add(name);
    for (const name of variablesUsed(step.body)) found.add(name);
  }
  return found;
}

const valueOf = (values: TemplateValues, name: OutreachVariable): string =>
  name === "first_name" ? values.firstName : name === "company" ? values.company : values.industry ?? "";

/** Variables the campaign uses for which the prospect has no value (OS-7 `missing_field`). */
export function missingVariables(steps: readonly TemplateStep[], values: TemplateValues): OutreachVariable[] {
  return OUTREACH_VARIABLES.filter((name) => campaignVariables(steps).has(name) && valueOf(values, name).trim() === "");
}

/** Replaces each variable once, in a single pass: a value that holds `{{` is text and is never scanned again. */
export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(VARIABLE, (_match, name: OutreachVariable) => valueOf(values, name));
}

export type RenderedStep =
  | { readonly ok: true; readonly subject: string; readonly body: string }
  | { readonly ok: false; readonly reason: "missing_field" | "subject_line_break" | "unknown_variable" };

/**
 * OS-5: the subject and body of step `stepNumber` (1-based). Steps 2 and later have no subject of their own: it is
 * `Re: ` plus step 1's rendered subject. The body is sent as written (the footer comes after, OS-6).
 */
export function renderStep(steps: readonly TemplateStep[], stepNumber: number, values: TemplateValues): RenderedStep {
  const step = steps[stepNumber - 1];
  const first = steps[0];
  if (!step || !first || first.subject == null) return { ok: false, reason: "unknown_variable" };
  if (unknownVariableProblem(steps) !== null) return { ok: false, reason: "unknown_variable" };
  if (missingVariables([first, step], values).length > 0) return { ok: false, reason: "missing_field" };
  const base = renderTemplate(first.subject, values);
  if (/[\r\n\0]/.test(base)) return { ok: false, reason: "subject_line_break" };
  return { ok: true, subject: stepNumber === 1 ? base : `Re: ${base}`, body: renderTemplate(step.body, values) };
}

/**
 * OS-7: true when any step would render too long to send: a subject over 300 characters, or a body that with the footer
 * would pass the 20,000 the send row keeps. The same limits stop a prospect at send time.
 */
export function renderTooLong(steps: readonly TemplateStep[], values: TemplateValues): boolean {
  for (let number = 1; number <= steps.length; number += 1) {
    const rendered = renderStep(steps, number, values);
    if (rendered.ok && (rendered.subject.length > RENDER_MAX_SUBJECT || rendered.body.length > RENDER_MAX_BODY)) return true;
  }
  return false;
}
/** The send row's limits (300 and 20,000) less 2,000 characters kept for the footer. */
export const RENDER_MAX_SUBJECT = 300;
export const RENDER_MAX_BODY = 18_000;

// OS-6: the footer and the postal-address guard.

export interface PostalAddress {
  readonly line1: string;
  readonly line2?: string | undefined;
  readonly city: string;
  readonly region?: string | undefined;
  readonly postalCode?: string | undefined;
  readonly country: string;
}
export interface FooterProfile {
  readonly displayName: string;
  readonly legalName: string | null;
  readonly postalAddress: PostalAddress | null;
}

/** `line1`, `line2`, then `city, region postalCode`, then the country code unless it is `US`. */
export function formatPostalAddress(address: PostalAddress): string {
  const lines = [address.line1];
  if (address.line2) lines.push(address.line2);
  lines.push(`${address.city}${address.region ? `, ${address.region}` : ""}${address.postalCode ? ` ${address.postalCode}` : ""}`);
  if (address.country !== "US") lines.push(address.country);
  return lines.join("\n");
}

const PLACEHOLDER = /placeholder/i;
export type AddressProblem = "postal_address_missing" | "postal_address_placeholder";
/** OS-6: why the profile cannot send, or null. Any name or address field with the word `placeholder` fails. */
export function addressProblem(profile: FooterProfile): AddressProblem | null {
  const address = profile.postalAddress;
  if (address === null) return "postal_address_missing";
  const fields = [profile.displayName, profile.legalName ?? "", address.line1, address.line2 ?? "", address.city, address.region ?? "",
    address.postalCode ?? "", address.country];
  return fields.some((field) => PLACEHOLDER.test(field)) ? "postal_address_placeholder" : null;
}

/** OS-6: `template_placeholder` when a subject or body holds the word `placeholder` in any case. */
export function templateProblem(steps: readonly TemplateStep[]): "template_placeholder" | null {
  return steps.some((step) => PLACEHOLDER.test(step.subject ?? "") || PLACEHOLDER.test(step.body)) ? "template_placeholder" : null;
}

/** OS-6: the footer every email ends with. The profile must pass `addressProblem` first. */
export function buildFooter(profile: FooterProfile, unsubscribeUrl: string): string {
  if (profile.postalAddress === null) throw new Error("A footer needs a postal address");
  return ["--", profile.legalName ?? profile.displayName, formatPostalAddress(profile.postalAddress),
    `To stop these emails: ${unsubscribeUrl}  (or reply "stop")`].join("\n");
}
export const appendFooter = (body: string, footer: string): string => `${body.trimEnd()}\n\n${footer}\n`;

// OS-4, OS-8: digests that bind an approval to exactly what an owner saw.

/** JSON with sorted object keys; array order and scalars are significant. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

export interface CampaignContent {
  readonly steps: ReadonlyArray<{ readonly subject?: string | null | undefined; readonly body: string; readonly delayBusinessDays: number }>;
  readonly window: { readonly start: string; readonly end: string };
  readonly dailyCapPerMailbox: number;
  readonly mailboxIds: readonly string[];
}
/** OS-4: SHA-256 (hex) of the canonical JSON of steps, window, cap and sorted mailbox ids. */
export function contentDigest(content: CampaignContent): string {
  return sha256Hex(canonicalJson({
    steps: content.steps.map((step) => ({ subject: step.subject ?? null, body: step.body, delayBusinessDays: step.delayBusinessDays })),
    window: { start: content.window.start, end: content.window.end },
    dailyCapPerMailbox: content.dailyCapPerMailbox,
    mailboxIds: [...content.mailboxIds].map((id) => id.toLowerCase()).sort(),
  }));
}
/** OS-8: SHA-256 of the sorted `id:status` of the campaign's pending and active prospects. */
export function prospectsDigest(prospects: ReadonlyArray<{ readonly id: string; readonly status: string }>): string {
  return sha256Hex(prospects.map((prospect) => `${prospect.id.toLowerCase()}:${prospect.status}`).sort().join("\n"));
}
