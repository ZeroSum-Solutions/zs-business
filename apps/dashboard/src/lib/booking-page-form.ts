// The booking page edit form (public-intake.md P-24): what an owner types becomes the `changes` a
// save sends. Pure, so the rules are tested without a screen.
import type { BookingPageChanges, BookingPageSummary } from "@zs/contracts";

export const PAGE_TITLE_MAX = 200;
export const PAGE_DESCRIPTION_MAX = 2000;

export interface BookingPageForm {
  title: string;
  /** "" is no description. */
  description: string;
}
export type BookingPageFormErrors = Partial<Record<keyof BookingPageForm, string>>;
export type BookingPageRead = { ok: true; changes: BookingPageChanges } | { ok: false; errors: BookingPageFormErrors };

export const BOOKING_PAGE_MESSAGES = {
  title: `Enter a title, up to ${PAGE_TITLE_MAX} characters.`,
  description: `A description can be up to ${PAGE_DESCRIPTION_MAX} characters.`,
} as const;

export const toBookingPageForm = (page: Pick<BookingPageSummary, "title" | "description">): BookingPageForm => ({
  title: page.title,
  description: page.description ?? "",
});

/** The fields of `form` that differ from `page`; an empty description clears it (null). */
export function readBookingPageForm(page: Pick<BookingPageSummary, "title" | "description">, form: BookingPageForm): BookingPageRead {
  const errors: BookingPageFormErrors = {};
  const changes: BookingPageChanges = {};

  const title = form.title.trim();
  if (title === "" || [...title].length > PAGE_TITLE_MAX) errors.title = BOOKING_PAGE_MESSAGES.title;
  else if (title !== page.title) changes.title = title;

  const description = form.description.trim();
  if ([...description].length > PAGE_DESCRIPTION_MAX) errors.description = BOOKING_PAGE_MESSAGES.description;
  else if (description !== (page.description ?? "")) changes.description = description === "" ? null : description;

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, changes };
}

/** The form field a validation issue of the API points at (`changes.title`). */
export function pageFieldFromIssuePath(path: string): keyof BookingPageForm | null {
  const [root, key] = path.split(".");
  return root === "changes" && (key === "title" || key === "description") ? key : null;
}
