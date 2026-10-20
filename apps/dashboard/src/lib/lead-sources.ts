import { leadSourceSchema, type LeadSource, type RevenueSource } from "@zs/contracts";

/** Lead sources as people read them (inbox-home.md H-1), in the contract's order. */
export const LEAD_SOURCE_LABELS: Readonly<Record<LeadSource, string>> = {
  website: "Website",
  referral: "Referral",
  phone: "Phone",
  email: "Email",
  walk_in: "Walk-in",
  social: "Social",
  ads: "Ads",
  other: "Other",
};

export const LEAD_SOURCES: readonly LeadSource[] = leadSourceSchema.options;

export function revenueSourceLabel(source: RevenueSource): string {
  return source === "unset" ? "No source set" : LEAD_SOURCE_LABELS[source];
}

/** Where Home's leads and bookings came from (H-4). */
export const ORIGIN_LABELS: Readonly<Record<"website" | "manual" | "owner", string>> = {
  website: "Website",
  manual: "Added by your team",
  owner: "Booked by your team",
};
