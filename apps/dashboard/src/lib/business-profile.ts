// The Settings form for the business profile (business-profile.md BP-2, BP-3, BP-6): what a person
// types becomes the `changes` a save sends. Pure, so the rules are tested without a screen.
import { COUNTRY_CODES, type BusinessProfile, type BusinessProfileChanges, type PostalAddress } from "@zs/contracts";
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
}
export type BusinessField = keyof BusinessForm;
export type BusinessFormErrors = Partial<Record<BusinessField, string>>;
export type BusinessRead = { ok: true; changes: BusinessProfileChanges } | { ok: false; errors: BusinessFormErrors };

const ADDRESS_FIELDS = ["line1", "line2", "city", "region", "postalCode", "country"] as const;
const LINE_MAX = 120;
const LEGAL_NAME_MAX = 200;

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
} as const;

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
  };
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
    if (values[field].length > LINE_MAX) errors[field] = BUSINESS_MESSAGES.tooLong;
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
export function readBusinessForm(profile: BusinessProfile, form: BusinessForm): BusinessRead {
  const errors: BusinessFormErrors = {};
  const changes: BusinessProfileChanges = {};

  const displayName = form.displayName.trim();
  if (displayName === "" || displayName.length > LINE_MAX) errors.displayName = BUSINESS_MESSAGES.displayName;
  else if (displayName !== profile.displayName) changes.displayName = displayName;

  const legalName = form.legalName.trim();
  if (legalName.length > LEGAL_NAME_MAX) errors.legalName = BUSINESS_MESSAGES.legalName;
  else if (legalName !== (profile.legalName ?? "")) changes.legalName = legalName === "" ? null : legalName;

  const phone = normalizePhone(form.phone.trim());
  if (phone !== "" && !/^\+[0-9]{8,15}$/.test(phone)) errors.phone = BUSINESS_MESSAGES.phone;
  else if (phone !== (profile.phoneE164 ?? "")) changes.phoneE164 = phone === "" ? null : phone;

  if (form.timeZone !== (profile.timeZone ?? "")) changes.timeZone = form.timeZone === "" ? null : form.timeZone;
  if (form.currency !== profile.currency) changes.currency = form.currency;

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
    default: return BUSINESS_MESSAGES.tooLong;
  }
}

/** The form field a validation issue of the API points at (`changes.timeZone`, `changes.postalAddress.city`). */
export function fieldFromIssuePath(path: string): BusinessField | null {
  const [root, key, inner] = path.split(".");
  if (root !== "changes" || !key) return null;
  if (key === "phoneE164") return "phone";
  if (key === "postalAddress") return (ADDRESS_FIELDS as readonly string[]).includes(inner ?? "") ? (inner as BusinessField) : "line1";
  return key === "displayName" || key === "legalName" || key === "timeZone" || key === "currency" ? key : null;
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
