// The Site screen says one thing about the site at a time (U3 A-1, A-2, A-3), lets the owner
// type past a limit and be told why (U3-10), and acts once per press (U3-4).
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DraftFields } from "../src/components/site/site-view";
import { LIMITS, type Draft } from "../src/components/site/draft";
import { releaseMeta, singleFlight, siteStatus } from "../src/components/site/site-status";

const NOW = Date.parse("2026-10-22T15:00:00.000Z");
const live = { number: 4, createdAt: "2026-09-22T15:00:00.000Z" };

describe("site status", () => {
  it("is Live with the version and when it was first published once everything has caught up", () => {
    expect(siteStatus({ published: true, live, edge: "synced", open: null, now: NOW })).toEqual({
      badge: { tone: "success", label: "Live" },
      summary: "Version 4 is live. First published 30 days ago.",
    });
  });

  it("says Updating, not Live, while the site still shows the previous version", () => {
    const status = siteStatus({ published: true, live, edge: "pending", open: null, now: NOW });
    expect(status.badge).toEqual({ tone: "info", label: "Updating" });
    expect(status.summary).toBe("Version 4 is live. Your site will show it in a moment.");
  });

  it("does not call the site settled while a publish is on its way or got no answer", () => {
    const sending = siteStatus({ published: true, live, edge: "synced", open: { inFlight: true }, now: NOW });
    expect(sending.badge).toEqual({ tone: "info", label: "Publishing" });
    expect(sending.summary).toBe("Version 4 is live. Your changes are on their way.");
    const lost = siteStatus({ published: true, live, edge: "synced", open: { inFlight: false }, now: NOW });
    expect(lost.badge).toEqual({ tone: "warn", label: "Not confirmed" });
    expect(lost.summary).toBe("Version 4 is live. Your last publish got no answer. Open Edit site to finish it.");
    const first = siteStatus({ published: false, live: "loading", edge: "loading", open: { inFlight: false }, now: NOW });
    expect(first.summary).toBe("Your first publish got no answer. Open Edit site to finish it.");
  });

  it("keeps the not-yet-published and loading states", () => {
    expect(siteStatus({ published: false, live: "loading", edge: "loading", open: null, now: NOW })).toEqual({
      badge: { tone: "warn", label: "Not published" }, summary: "Write your first page and publish it.",
    });
    expect(siteStatus({ published: true, live: "loading", edge: "loading", open: null, now: NOW }).summary).toBe("Loading the live version.");
    expect(siteStatus({ published: true, live: "error", edge: "loading", open: null, now: NOW }).summary).toBe("Could not load the live version.");
  });

  it("labels a version by when it was first published, which stays true after a rollback", () => {
    expect(releaseMeta(live, NOW)).toBe("First published 30 days ago");
    expect(releaseMeta({ createdAt: new Date(NOW).toISOString() }, NOW)).toBe("First published just now");
  });
});

describe("site editor fields", () => {
  const draft = (change: Partial<Draft>): Draft => ({ title: "Site", tagline: "", sections: [], ...change });
  const render = (value: Draft) => renderToString(h(DraftFields, { draft: value, onEdit: () => undefined, onEditSection: () => undefined, onRemove: () => undefined }));

  it("never cuts pasted text short; an over-long field is marked and draftProblem says why", () => {
    const html = render(draft({ title: "T".repeat(LIMITS.title + 30), sections: [{ key: 1, heading: "Visit", body: "Open daily." }] }));
    expect(html).not.toMatch(/maxlength/i);
    expect(html).toMatch(/id="site-title"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="site-title"/);
    expect(render(draft({ title: "Site" }))).not.toContain("aria-invalid=");
  });
});

describe("single flight", () => {
  it("ignores a second press until the first one has an answer", () => {
    const flight = singleFlight();
    const calls: (() => void)[] = [];
    expect(flight.run((done) => calls.push(done))).toBe(true);
    expect(flight.run((done) => calls.push(done))).toBe(false);
    expect(calls).toHaveLength(1);
    calls[0]!();
    expect(flight.run((done) => calls.push(done))).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
