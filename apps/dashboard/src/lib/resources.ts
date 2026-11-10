import type { ResourceSummary } from "./api";

/** Short label for tabs and badges: "Showroom appointments" reads as "Showroom". */
export function resourceLabel(resource: Pick<ResourceSummary, "name">): string {
  const name = resource.name?.trim();
  if (!name) return "Calendar";
  return name.replace(/\s+appointments?$/i, "");
}

/** Full name for headings and sentences. A calendar saved without one (B-24) still reads as one. */
export function calendarName(resource: Pick<ResourceSummary, "name">): string {
  return resource.name?.trim() || "Unnamed calendar";
}

/**
 * What an appointment is called in lists: its own title, else the service it was booked for
 * (the calendar's name, "Showroom appointments" as "Showroom appointment"), else the generic
 * word. `fromService` is true when the calendar's name was used, so a row can drop a badge
 * that would repeat it.
 */
export function bookingTitle(
  booking: { title?: string | null; source?: string | null },
  resource: Pick<ResourceSummary, "name"> | null | undefined,
): { text: string; fromService: boolean } {
  const own = booking.title?.trim();
  if (own) return { text: own, fromService: false };
  const service = resource?.name?.trim();
  if (service) return { text: service.replace(/\bappointments$/i, (word) => word.slice(0, -1)), fromService: true };
  return { text: booking.source === "website" ? "Website booking" : "Appointment", fromService: false };
}
