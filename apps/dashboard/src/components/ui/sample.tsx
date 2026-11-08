"use client";

import type { ReactNode } from "react";
import { useApiRuntime } from "@/lib/api/react";
import { Badge } from "./badge";

/**
 * Live mode serves bookings and customers from the API; the other areas still read the
 * built-in sample workspace. Those areas say so, and their writes stay off: a change that
 * never reaches a server must not look saved.
 */
export function useSampleOnly(): boolean {
  return useApiRuntime().mode === "live";
}

/** "Sample data" marker for a panel or page that is not backed by the API yet (live only). */
export function SampleBadge() {
  if (!useSampleOnly()) return null;
  return <Badge tone="warn" data-testid="sample-badge">Sample data</Badge>;
}

/** Visible reason a control is off. Point the control at it with aria-describedby. */
export function DisabledReason({ id, children }: { id: string; children: ReactNode }) {
  return <p id={id} className="text-xs text-muted" data-testid="disabled-reason">{children}</p>;
}

export const NOT_AVAILABLE = "Not available yet. This area shows sample data until its API ships.";
