import type { SiteSpec } from "@/lib/api";

/** The plain site spec as the editor holds it; sections carry a local key for React. */
export interface Draft {
  title: string;
  tagline: string;
  sections: { key: number; heading: string; body: string }[];
}
export const MAX_SECTIONS = 20;
/** The lengths `plainSiteSpecSchema` allows, counted after trimming. */
export const LIMITS = { title: 120, tagline: 200, heading: 120, body: 2000 } as const;
/** The dashboard proxy and the API refuse a body over 64 KiB (`MAX_BODY_BYTES` in api-proxy.ts). */
export const MAX_REQUEST_BYTES = 64 * 1024;
const encoder = new TextEncoder();
let nextKey = 1;
/** A key React can tell sections apart by; never shown or sent. */
export const newSectionKey = () => nextKey++;

/** At most `max` UTF-16 units, as zod counts them, never splitting an emoji in two. */
export function cut(text: string, max: number): string {
  const short = text.trim().slice(0, max);
  return (/[\ud800-\udbff]$/.test(short) ? short.slice(0, -1) : short).trim();
}

export function draftFrom(spec: SiteSpec | undefined, fallbackTitle: string): Draft {
  const plain = spec?.kind === "plain" ? spec : undefined;
  const sections = Array.isArray(plain?.sections) ? plain.sections : [];
  return {
    // A site name may be longer than a page title; the editor starts from one the API takes.
    title: typeof plain?.title === "string" ? plain.title : cut(fallbackTitle, LIMITS.title),
    tagline: typeof plain?.tagline === "string" ? plain.tagline : "",
    sections: sections.flatMap((section) => {
      if (section === null || typeof section !== "object" || Array.isArray(section)) return [];
      const { heading, body } = section as Record<string, unknown>;
      return typeof heading === "string" && typeof body === "string" ? [{ key: nextKey++, heading, body }] : [];
    }),
  };
}

export function specFrom(draft: Draft): SiteSpec {
  const tagline = draft.tagline.trim();
  return {
    kind: "plain",
    title: draft.title.trim(),
    ...(tagline ? { tagline } : {}),
    sections: draft.sections.map((section) => ({ heading: section.heading.trim(), body: section.body.trim() })),
  };
}

/** Why the draft cannot go out yet, or null. The API checks the same limits. */
export function draftProblem(draft: Draft, baseline: string | null): string | null {
  const title = draft.title.trim();
  if (!title) return "Add a site title first.";
  if (title.length > LIMITS.title) return `Shorten the site title to ${LIMITS.title} characters.`;
  if (draft.tagline.trim().length > LIMITS.tagline) return `Shorten the tagline to ${LIMITS.tagline} characters.`;
  if (draft.sections.some((section) => !section.heading.trim() || !section.body.trim())) return "Each section needs a heading and some text.";
  if (draft.sections.some((section) => section.heading.trim().length > LIMITS.heading)) return `Shorten each section heading to ${LIMITS.heading} characters.`;
  if (draft.sections.some((section) => section.body.trim().length > LIMITS.body)) return `Shorten each section's text to ${LIMITS.body.toLocaleString("en-US")} characters.`;
  // The publish body is the larger of the two requests; characters outside plain English
  // letters take two to four bytes each, so a page under every length limit can still be too big.
  const bytes = encoder.encode(JSON.stringify({ spec: specFrom(draft), expectedCurrentReleaseId: baseline })).byteLength;
  if (bytes > MAX_REQUEST_BYTES) return "This page holds more text than one publish can carry. Shorten or remove a section. Accented letters and other scripts take more room than plain letters.";
  return null;
}
