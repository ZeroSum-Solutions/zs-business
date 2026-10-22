import { relativeTime } from "@/lib/utils";

export interface SiteStatusInput {
  /** The site has a live release. */
  published: boolean;
  live: { number: number; createdAt: string } | "loading" | "error";
  /** Whether the site host serves the live release yet; "error" when that could not be checked. */
  edge: "synced" | "pending" | "error" | "loading";
  /** A publish not yet answered for good: still on its way, or its answer was lost. */
  open: { inFlight: boolean } | null;
  now: number;
}

export interface SiteStatus {
  badge: { tone: "success" | "info" | "warn"; label: string };
  summary: string;
}

/** "First published …": a version keeps that date when it is made live again. */
export function releaseMeta(release: { createdAt: string }, now: number): string {
  return `First published ${relativeTime(release.createdAt, now).toLowerCase()}`;
}

/**
 * The one thing the Site card says about the site. A publish on its way or without an answer,
 * and a site host still showing the previous version, each override "Live", so the badge, the
 * summary and the notes below never disagree.
 */
export function siteStatus({ published, live, edge, open, now }: SiteStatusInput): SiteStatus {
  const badge: SiteStatus["badge"] = open?.inFlight ? { tone: "info", label: "Publishing" }
    : open ? { tone: "warn", label: "Not confirmed" }
      : !published ? { tone: "warn", label: "Not published" }
        : edge === "pending" ? { tone: "info", label: "Updating" }
          : { tone: "success", label: "Live" };
  if (!published) {
    return {
      badge,
      summary: open?.inFlight ? "Your first page is on its way."
        : open ? "Your first publish got no answer. Open Edit site to finish it."
          : "Write your first page and publish it.",
    };
  }
  if (live === "loading") return { badge, summary: "Loading the live version." };
  if (live === "error") return { badge, summary: "Could not load the live version." };
  const then = open?.inFlight ? "Your changes are on their way."
    : open ? "Your last publish got no answer. Open Edit site to finish it."
      : edge === "pending" ? "Your site will show it in a moment."
        : `${releaseMeta(live, now)}.`;
  return { badge, summary: `Version ${live.number} is live. ${then}` };
}

/**
 * Lets one press through until it has an answer. A double tap calls the handler twice before
 * React re-renders the button as disabled; this answers the second call synchronously.
 */
export function singleFlight() {
  let busy = false;
  return {
    run(start: (done: () => void) => void): boolean {
      if (busy) return false;
      busy = true;
      start(() => { busy = false; });
      return true;
    },
  };
}
