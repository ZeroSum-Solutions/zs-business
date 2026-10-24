// enrichment.md E-13: keep only eight allowlisted fields, each bounded; a failing value is dropped.
// Nothing else of an answer (the `raw` block, the body) is read, stored or logged.
import { ENRICHMENT_FIELDS, type EnrichmentField } from "@zs/contracts";
import type { EnrichmentFields } from "./port.js";

const TEXT_MAX: Readonly<Record<EnrichmentField, number>> = {
  name: 200, domain: 200, industry: 200, description: 1000, employees: 0, founded: 0, location: 200, linkedin_url: 300,
};
const LINKEDIN = /^https:\/\/([a-z0-9-]+\.)?linkedin\.com\/company\/[^\s]+$/i;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.replaceAll("\u0000", "").trim();
  return text.length >= 1 && text.length <= max ? text : null;
}

/** `value` for one field as the string that is stored, or null when it fails its bound. */
export function minimizeField(field: EnrichmentField, value: unknown, now: Date): string | null {
  switch (field) {
    case "employees": {
      const n = typeof value === "string" && /^\d{1,9}$/.test(value) ? Number(value) : value;
      return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 2_000_000_000 ? String(n) : null;
    }
    case "founded": {
      const n = typeof value === "string" && /^\d{4}$/.test(value) ? Number(value) : value;
      return typeof n === "number" && Number.isSafeInteger(n) && n >= 1000 && n <= now.getUTCFullYear() ? String(n) : null;
    }
    case "linkedin_url": {
      const text = clean(value, TEXT_MAX.linkedin_url);
      return text !== null && LINKEDIN.test(text) ? text : null;
    }
    default:
      return clean(value, TEXT_MAX[field]);
  }
}

/** Picks the allowlisted keys of an untrusted `output` object and bounds each. */
export function minimizeOutput(output: unknown, now: Date): EnrichmentFields {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return {};
  const source = output as Record<string, unknown>;
  const kept: Partial<Record<EnrichmentField, string>> = {};
  for (const field of ENRICHMENT_FIELDS) {
    if (!Object.hasOwn(source, field)) continue;
    const value = minimizeField(field, source[field], now);
    if (value !== null) kept[field] = value;
  }
  return kept;
}
