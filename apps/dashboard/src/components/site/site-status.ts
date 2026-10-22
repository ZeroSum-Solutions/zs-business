import type { SiteRecord } from "@/lib/api";
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

type Tone = "success" | "info" | "warn" | "neutral";

export interface SiteStatus {
  badge: { tone: Tone; label: string };
  summary: string;
  /** The warning above "Update the site now", or null when the site host needs nothing. */
  note: string | null;
  /** The live version's badge in History. */
  current: { tone: Tone; label: string };
}

/** "First published …": a version keeps that date when it is made live again. */
export function releaseMeta(release: { createdAt: string }, now: number): string {
  return `First published ${relativeTime(release.createdAt, now).toLowerCase()}`;
}

/**
 * The one thing the Site card says about the site. "Live" means the site host was checked and
 * shows the live version. A publish on its way or without an answer, a host still showing the
 * previous version, and a host not checked yet each override it, so the badge, the summary, the
 * note and History never disagree.
 */
export function siteStatus({ published, live, edge, open, now }: SiteStatusInput): SiteStatus {
  // What visitors see, as far as anyone knows: only a host check proves the live version.
  const shown = live === "loading" ? "loading" : live === "error" ? "error" : edge;
  const badge: SiteStatus["badge"] = open?.inFlight ? { tone: "info", label: "Publishing" }
    : open ? { tone: "warn", label: "Not confirmed" }
      : !published ? { tone: "warn", label: "Not published" }
        : shown === "pending" ? { tone: "info", label: "Updating" }
          : shown === "error" ? { tone: "neutral", label: "Not checked" }
            : shown === "loading" ? { tone: "neutral", label: "Checking" }
              : { tone: "success", label: "Live" };
  const current: SiteStatus["current"] = published && shown === "synced" ? { tone: "success", label: "Live" } : { tone: "neutral", label: "Current" };
  const note = !published ? null
    : edge === "pending" ? "Saved, but your site still shows the previous version."
      : edge === "error" ? "Could not check whether your site shows the current version."
        : null;
  if (!published) {
    return {
      badge,
      summary: open?.inFlight ? "Your first page is on its way."
        : open ? "Your first publish got no answer. Open Edit site to finish it."
          : "Write your first page and publish it.",
      note,
      current,
    };
  }
  if (live === "loading") return { badge, summary: "Loading the current version.", note, current };
  if (live === "error") return { badge, summary: "Could not load the current version.", note, current };
  const state = edge === "synced" ? `Version ${live.number} is live.`
    : edge === "pending" ? `Your site still shows the previous version. Version ${live.number} is on its way.`
      : edge === "error" ? `Version ${live.number} is published. Your site could not be checked.`
        : `Version ${live.number} is published. Checking your site.`;
  const then = open?.inFlight ? " Your changes are on their way."
    : open ? " Your last publish got no answer. Open Edit site to finish it."
      : edge === "synced" ? ` ${releaseMeta(live, now)}.`
        : "";
  return { badge, summary: `${state}${then}`, note, current };
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

/**
 * The cached site list with `site` as a publish or rollback just left it, so an editor opened
 * straight away starts from the new live version instead of the one before (the server would
 * refuse that publish as stale). A list already holding a newer pointer keeps it.
 */
export function withSite(list: SiteRecord[] | undefined, site: SiteRecord): SiteRecord[] | undefined {
  return list?.map((item) => (item.id === site.id && item.pointerVersion < site.pointerVersion ? site : item));
}
