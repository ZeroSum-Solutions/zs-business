// The Settings form for the business profile (business-profile.md BP-2, BP-3, BP-6): what a person
// types becomes the `changes` a save sends. Pure, so the rules are tested without a screen.
import {
  BUSINESS_POLICIES_MAX,
  BUSINESS_POLICY_TEXT_MAX,
  BUSINESS_POLICY_TITLE_MAX,
  BUSINESS_SERVICES_MAX,
  BUSINESS_SERVICE_NAME_MAX,
  BUSINESS_TONE_MAX,
  COUNTRY_CODES,
  WEEKDAYS,
  type BusinessHours,
  type BusinessPolicyInput,
  type BusinessProfile,
  type BusinessProfileChanges,
  type FactMark,
  type MarkedFact,
  type PostalAddress,
  type Weekday,
} from "@zs/contracts";
import { normalizePhone } from "./api/types";

export interface BusinessForm {
  displayName: string;
  legalName: string;
  phone: string;
  /** "" is not set. */
  timeZone: string;
  currency: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  /** "" is not set. */
  country: string;
  /** BP-13: what the business is, in a few sentences. "" is not set. */
  description: string;
  /** BP-14: one service per line. "" is none. */
  services: string;
  /** BP-16: each day open or closed, with its times as `<input type="time">` gives them. No open day is not set. */
  hours: Record<Weekday, DayHours>;
  /** BP-17: the tone of voice note. "" is not set. */
  tone: string;
  /** BP-18: the policies in order; a row with both parts empty is left out. */
  policies: PolicyDraft[];
}
export interface DayHours { isOpen: boolean; open: string; close: string }
export interface PolicyDraft { title: string; text: string }
export type BusinessField = keyof BusinessForm;
/** The fields a single text input or select edits. */
export type BusinessTextField = Exclude<BusinessField, "hours" | "policies">;
export type BusinessFormErrors = Partial<Record<BusinessField, string>>;
export type BusinessRead = { ok: true; changes: BusinessProfileChanges } | { ok: false; errors: BusinessFormErrors };

const ADDRESS_FIELDS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;
const LINE_MAX = 120;
const LEGAL_NAME_MAX = 200;
const DESCRIPTION_MAX = 2000;

export const BUSINESS_MESSAGES = {
  displayName: "Enter your business name, up to 120 characters.",
  legalName: "A legal name can be up to 200 characters.",
  phone: "Enter a phone number with country code, like +1 212 555 0142.",
  timeZone: "Choose a time zone from the list.",
  currency: "Choose a supported currency.",
  line1: "Enter the street address.",
  city: "Enter the city.",
  country: "Choose the country.",
  tooLong: "Keep this under 120 characters.",
  description: "A description can be up to 2000 characters.",
  services: `List up to ${BUSINESS_SERVICES_MAX} services, one per line, each up to ${BUSINESS_SERVICE_NAME_MAX} characters, none twice.`,
  hours: "Give each open day an opening time and a later closing time.",
  tone: `A tone of voice note can be up to ${BUSINESS_TONE_MAX} characters.`,
  policies: `Give each policy a title (one line, up to ${BUSINESS_POLICY_TITLE_MAX} characters) and its text (up to ${BUSINESS_POLICY_TEXT_MAX}). Up to ${BUSINESS_POLICIES_MAX} policies, each title once.`,
} as const;

export const WEEKDAY_NAMES: Record<Weekday, string> = {
  mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday",
};

/** A time input cannot show 24:00, so a day that closes at midnight shows 00:00, and 00:00 as a closing time saves as 24:00. */
const closeForInput = (close: string) => (close === "24:00" ? "00:00" : close);
const closeFromInput = (close: string) => (close === "00:00" ? "24:00" : close);

function hoursForm(hours: BusinessHours | null): Record<Weekday, DayHours> {
  return Object.fromEntries(WEEKDAYS.map((day) => {
    const times = hours?.[day] ?? null;
    return [day, times ? { isOpen: true, open: times.open, close: closeForInput(times.close) } : { isOpen: false, open: "", close: "" }];
  })) as Record<Weekday, DayHours>;
}

const CLOCK = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
/** The hours a form describes: null when no day is open (not set), or the day that is wrong. */
function hoursOf(form: Record<Weekday, DayHours>): { ok: true; hours: BusinessHours | null } | { ok: false } {
  const hours = {} as Record<Weekday, { open: string; close: string } | null>;
  for (const day of WEEKDAYS) {
    const entry = form[day];
    if (!entry.isOpen) { hours[day] = null; continue; }
    const close = closeFromInput(entry.close);
    if (!CLOCK.test(entry.open) || !(CLOCK.test(close) || close === "24:00") || entry.open >= close) return { ok: false };
    hours[day] = { open: entry.open, close };
  }
  return { ok: true, hours: WEEKDAYS.some((day) => hours[day] !== null) ? hours : null };
}

const sameDay = (a: { open: string; close: string } | null, b: { open: string; close: string } | null) =>
  a === null || b === null ? a === b : a.open === b.open && a.close === b.close;
const sameHours = (a: BusinessHours | null, b: BusinessHours | null) =>
  a === null || b === null ? a === b : WEEKDAYS.every((day) => sameDay(a[day], b[day]));

/** The policies a form describes, trimmed, rows with both parts empty dropped; null when one is not valid. */
function policiesOf(drafts: PolicyDraft[]): BusinessPolicyInput[] | null {
  const policies = drafts.map((draft) => ({ title: draft.title.trim(), text: draft.text.trim() })).filter((policy) => policy.title !== "" || policy.text !== "");
  const valid = policies.length <= BUSINESS_POLICIES_MAX
    && policies.every((policy) => policy.title !== "" && policy.text !== ""
      && [...policy.title].length <= BUSINESS_POLICY_TITLE_MAX && !/[\u0000-\u001f\u007f]/.test(policy.title)
      && [...policy.text].length <= BUSINESS_POLICY_TEXT_MAX)
    && new Set(policies.map((policy) => policy.title.toLowerCase())).size === policies.length;
  return valid ? policies : null;
}

/**
 * Who set a fact and when (BP-19), for the line under it: not known when the fact is empty, whatever
 * mark it carries (a mark also records who cleared it). A fact set before marks were kept, or by a setup
 * step, has no mark.
 */
export function factProvenance(profile: BusinessProfile, fact: MarkedFact): { known: false } | { known: true; mark: Pick<FactMark, "setBy" | "setAt"> | null } {
  const value = fact === "displayName" ? profile.displayName
    : fact === "services" || fact === "policies" ? (profile[fact].length > 0 ? profile[fact] : null)
    : profile[fact];
  if (value === null || value === "") return { known: false };
  // The list's own mark is its last change; a list stored before it was kept falls back to its newest policy.
  const newestPolicy = fact === "policies" ? [...profile.policies].sort((a, b) => b.setAt.localeCompare(a.setAt))[0] : undefined;
  const mark = profile.factMarks[fact] ?? newestPolicy;
  return { known: true, mark: mark ? { setBy: mark.setBy, setAt: mark.setAt } : null };
}

/**
 * The form as a save would read it, for telling whether anything changed: a closed day's times and a
 * policy row with nothing in it are not part of it.
 */
export function normalizedForm(form: BusinessForm): BusinessForm {
  return {
    ...form,
    hours: Object.fromEntries(WEEKDAYS.map((day) => {
      const entry = form.hours[day];
      return [day, entry.isOpen ? { isOpen: true, open: entry.open, close: entry.close } : { isOpen: false, open: "", close: "" }];
    })) as Record<Weekday, DayHours>,
    policies: form.policies.filter((policy) => policy.title.trim() !== "" || policy.text.trim() !== ""),
  };
}

export function toBusinessForm(profile: BusinessProfile): BusinessForm {
  const address = profile.postalAddress;
  return {
    displayName: profile.displayName,
    legalName: profile.legalName ?? "",
    phone: profile.phoneE164 ?? "",
    timeZone: profile.timeZone ?? "",
    currency: profile.currency,
    line1: address?.line1 ?? "",
    line2: address?.line2 ?? "",
    city: address?.city ?? "",
    region: address?.region ?? "",
    postalCode: address?.postalCode ?? "",
    country: address?.country ?? "",
    description: profile.description ?? "",
    services: profile.services.join("\n"),
    hours: hoursForm(profile.hours),
    tone: profile.tone ?? "",
    policies: profile.policies.map((policy) => ({ title: policy.title, text: policy.text })),
  };
}

/** The service names a textarea holds: one per line, trimmed, blank lines dropped. */
export const parseServices = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");

function servicesValid(names: string[]): boolean {
  return names.length <= BUSINESS_SERVICES_MAX
    && names.every((name) => [...name].length <= BUSINESS_SERVICE_NAME_MAX)
    && new Set(names.map((name) => name.toLowerCase())).size === names.length;
}

/** The address a form describes: null when every field is empty, else the fields filled in. */
function addressOf(form: BusinessForm): { address: PostalAddress | null; errors: BusinessFormErrors } {
  const values = Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, form[field].trim()])) as Record<(typeof ADDRESS_FIELDS)[number], string>;
  if (ADDRESS_FIELDS.every((field) => values[field] === "")) return { address: null, errors: {} };
  const errors: BusinessFormErrors = {};
  if (values.line1 === "") errors.line1 = BUSINESS_MESSAGES.line1;
  if (values.city === "") errors.city = BUSINESS_MESSAGES.city;
  if (values.country === "") errors.country = BUSINESS_MESSAGES.country;
  for (const field of ["line1", "line2", "city", "region", "postalCode"] as const) {
    if ([...values[field]].length > LINE_MAX) errors[field] = BUSINESS_MESSAGES.tooLong;
  }
  if (Object.keys(errors).length > 0) return { address: null, errors };
  const address: PostalAddress = { line1: values.line1, city: values.city, country: values.country };
  if (values.line2 !== "") address.line2 = values.line2;
  if (values.region !== "") address.region = values.region;
  if (values.postalCode !== "") address.postalCode = values.postalCode;
  return { address, errors };
}

const sameAddress = (a: PostalAddress | null, b: PostalAddress | null) =>
  a === null || b === null ? a === b : ADDRESS_FIELDS.every((field) => (a[field] ?? "") === (b[field] ?? ""));

/**
 * The fields of `form` that differ from `profile`, ready for `PUT /v1/business`; an empty optional
 * field clears it (null). A field that cannot be sent comes back with the words to show.
 */
export function readBusinessForm(profile: BusinessProfile & { factsUnavailable?: true }, form: BusinessForm): BusinessRead {
  const errors: BusinessFormErrors = {};
  const changes: BusinessProfileChanges = {};

  const displayName = form.displayName.trim();
  if (displayName === "" || [...displayName].length > LINE_MAX) errors.displayName = BUSINESS_MESSAGES.displayName;
  else if (displayName !== profile.displayName) changes.displayName = displayName;

  const legalName = form.legalName.trim();
  if ([...legalName].length > LEGAL_NAME_MAX) errors.legalName = BUSINESS_MESSAGES.legalName;
  else if (legalName !== (profile.legalName ?? "")) changes.legalName = legalName === "" ? null : legalName;

  // Empty means clear; text that strips down to nothing ("---") is a typo, never a clear.
  const typedPhone = form.phone.trim();
  const phone = typedPhone === "" ? "" : normalizePhone(typedPhone);
  if (typedPhone !== "" && !/^\+[0-9]{8,15}$/.test(phone)) errors.phone = BUSINESS_MESSAGES.phone;
  else if (phone !== (profile.phoneE164 ?? "")) changes.phoneE164 = phone === "" ? null : phone;

  if (form.timeZone !== (profile.timeZone ?? "")) changes.timeZone = form.timeZone === "" ? null : form.timeZone;
  if (form.currency !== profile.currency) changes.currency = form.currency;

  const description = form.description.trim();
  if ([...description].length > DESCRIPTION_MAX) errors.description = BUSINESS_MESSAGES.description;
  else if (description !== (profile.description ?? "")) changes.description = description === "" ? null : description;

  const services = parseServices(form.services);
  if (!servicesValid(services)) errors.services = BUSINESS_MESSAGES.services;
  else if (services.join("\n") !== profile.services.join("\n")) changes.services = services;

  // The company facts are sent only when this client could read them, so a save never wipes facts it did not see.
  if (!profile.factsUnavailable) {
    const hours = hoursOf(form.hours);
    if (!hours.ok) errors.hours = BUSINESS_MESSAGES.hours;
    else if (!sameHours(hours.hours, profile.hours)) changes.hours = hours.hours;

    const tone = form.tone.trim();
    if ([...tone].length > BUSINESS_TONE_MAX) errors.tone = BUSINESS_MESSAGES.tone;
    else if (tone !== (profile.tone ?? "")) changes.tone = tone === "" ? null : tone;

    const policies = policiesOf(form.policies);
    if (!policies) errors.policies = BUSINESS_MESSAGES.policies;
    else if (policies.length !== profile.policies.length || policies.some((policy, i) => policy.title !== profile.policies[i]!.title || policy.text !== profile.policies[i]!.text))
      changes.policies = policies;
  }

  const { address, errors: addressErrors } = addressOf(form);
  Object.assign(errors, addressErrors);
  if (Object.keys(addressErrors).length === 0 && !sameAddress(address, profile.postalAddress)) changes.postalAddress = address;

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, changes };
}

/** The words under a field the API refused. */
export function serverFieldMessage(field: BusinessField): string {
  switch (field) {
    case "displayName": return BUSINESS_MESSAGES.displayName;
    case "legalName": return BUSINESS_MESSAGES.legalName;
    case "phone": return BUSINESS_MESSAGES.phone;
    case "timeZone": return BUSINESS_MESSAGES.timeZone;
    case "currency": return BUSINESS_MESSAGES.currency;
    case "line1": return BUSINESS_MESSAGES.line1;
    case "city": return BUSINESS_MESSAGES.city;
    case "country": return BUSINESS_MESSAGES.country;
    case "description": return BUSINESS_MESSAGES.description;
    case "services": return BUSINESS_MESSAGES.services;
    case "hours": return BUSINESS_MESSAGES.hours;
    case "tone": return BUSINESS_MESSAGES.tone;
    case "policies": return BUSINESS_MESSAGES.policies;
    default: return BUSINESS_MESSAGES.tooLong;
  }
}

/** The form field a validation issue of the API points at (`changes.timeZone`, `changes.postalAddress.city`). */
export function fieldFromIssuePath(path: string): BusinessField | null {
  const [root, key, inner] = path.split(".");
  if (root !== "changes" || !key) return null;
  if (key === "phoneE164") return "phone";
  if (key === "postalAddress") return (ADDRESS_FIELDS as readonly string[]).includes(inner ?? "") ? (inner as BusinessField) : "line1";
  return key === "displayName" || key === "legalName" || key === "timeZone" || key === "currency" || key === "description" || key === "services"
    || key === "hours" || key === "tone" || key === "policies" ? key : null;
}

/**
 * Whichever of two copies of the profile has the higher revision; a tie takes `incoming`, unless only the
 * cached copy could read the company facts (an older API answered the refetch during a rolling deploy).
 * Revisions only grow, so the lower one is stale.
 */
export function newerProfile<T extends BusinessProfile & { factsUnavailable?: true }>(cached: T | undefined, incoming: T): T {
  if (!cached) return incoming;
  if (cached.revision !== incoming.revision) return cached.revision > incoming.revision ? cached : incoming;
  return incoming.factsUnavailable && !cached.factsUnavailable ? cached : incoming;
}

/** Countries a postal address may name, by English name. */
export function countryChoices(): { code: string; name: string }[] {
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    names = null;
  }
  return COUNTRY_CODES.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name));
}
