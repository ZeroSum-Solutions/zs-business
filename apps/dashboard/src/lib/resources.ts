import type { ResourceSummary } from "./api";

/** Short label for tabs and badges: "Showroom appointments" reads as "Showroom". */
export function resourceLabel(resource: Pick<ResourceSummary, "name">): string {
  const name = resource.name?.trim();
  if (!name) return "Calendar";
  return name.replace(/\s+appointments?$/i, "");
}
