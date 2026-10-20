/**
 * In-memory sites for the demo, with the server's rules: owners publish immutable releases
 * numbered 1, 2, 3 per site, one is live, publish and rollback name the release the caller saw
 * as live (`stale_release` if another went live since), and a write retried with its key replays. Specs are `{ kind: "plain" }`,
 * checked with the same @zs/contracts schema the API's built-in compiler uses.
 */
import {
  createSiteRequestSchema,
  plainSiteSpecSchema,
  publishSiteRequestSchema,
  type SiteFile,
  type SitePreview,
  type SiteRecord,
  type SiteReleaseDetail,
  type SiteReleaseResponse,
  type SiteSpec,
} from "@zs/contracts";
import { newId as defaultNewId } from "../../id";
import { ApiError, defaultMessage, demoError, demoValidationError } from "../errors";
import { fingerprint } from "../../intent-key";
import type { SitesApi } from "../types";
import type { DemoClock } from "./adapter";

/** Hooks that act as another owner, or as an outage at the edge. */
export interface DemoSiteControls {
  /** Another owner makes the newest release that is not live the live one, so this page's view goes stale. */
  rollBackElsewhere(): void;
  /** While down, publishes and rollbacks commit but the site keeps the previous version. */
  setSiteEdgeDown(down: boolean): void;
  /** The next publish or rollback answers this much later. */
  delayNextSiteWrite(ms: number): void;
  /** The next publish or rollback commits, then its answer is lost as a network failure. */
  loseNextSiteAnswer(): void;
}

export const DEMO_SITE_ID = "5b0c7d2e-41a6-4f3b-9c55-8e2f6a1d3b70";
export const DEMO_SITE_HOST = "haldenrowe.example";
const OWNER_ID = "0f7d5a3c-2b1e-4c9d-8a6f-3e5b7c9d1a20";

const encoder = new TextEncoder();
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (text: string) => hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));

/** The page the API's plain compiler builds, close enough for a demo preview. */
function plainPage(spec: ReturnType<typeof plainSiteSpecSchema.parse>): string {
  const header = `<header><h1>${escapeHtml(spec.title)}</h1>${spec.tagline ? `<p>${escapeHtml(spec.tagline)}</p>` : ""}</header>`;
  const main = spec.sections.map((section) =>
    `<section><h2>${escapeHtml(section.heading)}</h2>${section.body.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para)}</p>`).join("")}</section>`).join("");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(spec.title)}</title>` +
    `<style>body{font-family:system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:2rem 1rem;line-height:1.5;color:#1f2933}h1{margin-bottom:.25rem}header p{margin-top:0;color:#52606d}section{margin-top:2rem}</style>` +
    `</head><body>${header}<main>${main}</main></body></html>\n`;
}

async function compile(spec: SiteSpec): Promise<{ preview: SitePreview; html: string }> {
  const parsed = plainSiteSpecSchema.safeParse(spec);
  if (!parsed.success) throw demoValidationError(parsed.error.issues);
  const html = plainPage(parsed.data);
  const notFound = plainPage({ ...parsed.data, title: `Not found · ${parsed.data.title}`, sections: [] });
  const files: SiteFile[] = [
    { path: "404.html", mediaType: "text/html; charset=utf-8", sha256: await sha256(notFound), bytes: encoder.encode(notFound).byteLength },
    { path: "index.html", mediaType: "text/html; charset=utf-8", sha256: await sha256(html), bytes: encoder.encode(html).byteLength },
  ];
  const digest = await sha256(files.map((file) => `${file.path}\u0000${file.sha256}\n`).join(""));
  return { preview: { entry: "index.html", digest, files, entryHtml: html }, html };
}

const SEED_SPECS: SiteSpec[] = [
  {
    kind: "plain", title: "Halden & Rowe", tagline: "Fine jewelry from our Hudson Street workshop",
    sections: [{ heading: "Engagement", body: "Rings drawn for one person." }],
  },
  {
    kind: "plain", title: "Halden & Rowe", tagline: "Fine jewelry, made in our Hudson Street workshop",
    sections: [
      { heading: "Engagement", body: "Start with a stone or a sketch. We guide you through design, casting and setting." },
      { heading: "Bespoke", body: "Signets, pendants and pieces that carry a family story." },
      { heading: "Repairs", body: "Book a ten-minute drop-off. Most repairs are ready within a week." },
    ],
  },
];

export function createDemoSites(options: { clock?: DemoClock; newId?: () => string; latencyMs?: number } = {}): {
  api: SitesApi;
  controls: DemoSiteControls;
} {
  const clock = options.clock ?? { now: () => new Date() };
  const newId = options.newId ?? defaultNewId;
  const latency = options.latencyMs ?? 0;
  const wait = () => (latency > 0 ? new Promise((resolve) => setTimeout(resolve, latency)) : Promise.resolve());
  const ago = (days: number) => new Date(clock.now().getTime() - days * 86400000).toISOString();

  interface DemoSite { record: SiteRecord; releases: SiteReleaseDetail[] }
  const sites = new Map<string, DemoSite>();
  const replies = new Map<string, { print: string; response: Promise<unknown> }>();
  let edgeDown = false;
  let delayNext = 0;
  let loseNext = false;
  let seeded: Promise<void> | null = null;

  async function release(siteId: string, number: number, spec: SiteSpec, createdAt: string): Promise<SiteReleaseDetail> {
    const { preview } = await compile(spec);
    return {
      id: newId(), siteId, number, entry: preview.entry, digest: preview.digest, fileCount: preview.files.length,
      totalBytes: preview.files.reduce((sum, file) => sum + file.bytes, 0), createdBy: OWNER_ID, createdAt, spec, files: preview.files,
    };
  }
  const seed = () => (seeded ??= (async () => {
    const releases = [await release(DEMO_SITE_ID, 2, SEED_SPECS[1]!, ago(4)), await release(DEMO_SITE_ID, 1, SEED_SPECS[0]!, ago(30))];
    sites.set(DEMO_SITE_ID, {
      record: {
        id: DEMO_SITE_ID, name: "Halden & Rowe", currentReleaseId: releases[0]!.id, pointerVersion: 2,
        hosts: [DEMO_SITE_HOST], createdAt: ago(31), updatedAt: ago(4),
      },
      releases,
    });
  })());

  const findSite = (siteId: string) => {
    const site = sites.get(siteId);
    if (!site) throw demoError("NotFound");
    return site;
  };
  const summary = ({ spec: _spec, files: _files, ...record }: SiteReleaseDetail) => record;
  /**
   * A key names one write: the same body replays its answer (a second call while the first
   * runs waits for it), another body is a conflict. A write that fails leaves nothing behind.
   */
  async function once<T>(key: string, body: unknown, work: () => Promise<T>): Promise<T> {
    const print = fingerprint(body);
    if (delayNext > 0) {
      const ms = delayNext;
      delayNext = 0;
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    const stored = replies.get(key);
    let response: Promise<unknown>;
    if (stored) {
      if (stored.print !== print) throw demoError("Conflict", { reason: "idempotency_key_reused" });
      response = stored.response;
    } else {
      response = work().then((value) => structuredClone(value));
      replies.set(key, { print, response });
      response.catch(() => replies.delete(key));
    }
    const answer = structuredClone(await response) as T;
    if (loseNext) {
      loseNext = false;
      throw new ApiError("network", defaultMessage("network"));
    }
    return answer;
  }
  const goLive = (site: DemoSite, releaseId: string) => {
    site.record = { ...site.record, currentReleaseId: releaseId, pointerVersion: site.record.pointerVersion + 1, updatedAt: clock.now().toISOString() };
  };

  const api: SitesApi = {
    async listSites() {
      await seed(); await wait();
      return [...sites.values()].map((site) => structuredClone(site.record));
    },
    async createSite(name, options) {
      await seed(); await wait();
      const parsed = createSiteRequestSchema.safeParse({ name });
      if (!parsed.success) throw demoValidationError(parsed.error.issues);
      return once(options.idempotencyKey, ["create", parsed.data], async () => {
        const now = clock.now().toISOString();
        const record: SiteRecord = { id: newId(), name: parsed.data.name, currentReleaseId: null, pointerVersion: 0, hosts: [], createdAt: now, updatedAt: now };
        sites.set(record.id, { record, releases: [] });
        return structuredClone(record);
      });
    },
    async listSiteReleases(siteId) {
      await seed(); await wait();
      return findSite(siteId).releases.map(summary);
    },
    async getSiteRelease(siteId, releaseId) {
      await seed(); await wait();
      const found = findSite(siteId).releases.find((item) => item.id === releaseId);
      if (!found) throw demoError("NotFound");
      return structuredClone(found);
    },
    async previewSite(siteId, spec) {
      await seed(); await wait();
      findSite(siteId);
      const parsed = publishSiteRequestSchema.safeParse({ spec });
      if (!parsed.success) throw demoValidationError(parsed.error.issues);
      return (await compile(parsed.data.spec)).preview;
    },
    async publishSite(input, options) {
      await seed(); await wait();
      const site = findSite(input.siteId);
      const parsed = publishSiteRequestSchema.safeParse({ spec: input.spec, expectedCurrentReleaseId: input.expectedCurrentReleaseId });
      if (!parsed.success) throw demoValidationError(parsed.error.issues);
      return once(options.idempotencyKey, ["publish", input.siteId, parsed.data], async (): Promise<SiteReleaseResponse> => {
        const built = await release(input.siteId, 1, parsed.data.spec, clock.now().toISOString());
        // Checked and numbered after the build, with no await in between, as the server does under its lock.
        if (site.record.currentReleaseId !== input.expectedCurrentReleaseId) throw demoError("Conflict", { reason: "stale_release" });
        const made = { ...built, number: (site.releases[0]?.number ?? 0) + 1 };
        site.releases.unshift(made);
        goLive(site, made.id);
        return { actionId: newId(), result: { site: structuredClone(site.record), release: summary(made) }, edge: edgeDown ? "pending" : "synced" };
      });
    },
    async activateSiteRelease(input, options) {
      await seed(); await wait();
      const site = findSite(input.siteId);
      return once(options.idempotencyKey, ["activate", input], async (): Promise<SiteReleaseResponse> => {
        if (site.record.currentReleaseId !== input.expectedCurrentReleaseId) throw demoError("Conflict", { reason: "stale_release" });
        const target = site.releases.find((item) => item.id === input.releaseId);
        if (!target) throw demoError("NotFound");
        if (site.record.currentReleaseId !== target.id) goLive(site, target.id);
        return { actionId: newId(), result: { site: structuredClone(site.record), release: summary(target) }, edge: edgeDown ? "pending" : "synced" };
      });
    },
    async syncSite(siteId) {
      await seed(); await wait();
      return { site: structuredClone(findSite(siteId).record), edge: edgeDown ? "pending" : "synced" };
    },
  };

  return {
    api,
    controls: {
      rollBackElsewhere() {
        const site = sites.get(DEMO_SITE_ID);
        const older = site?.releases.find((item) => item.id !== site.record.currentReleaseId);
        if (site && older) goLive(site, older.id);
      },
      setSiteEdgeDown(down) { edgeDown = down; },
      delayNextSiteWrite(ms) { delayNext = ms; },
      loseNextSiteAnswer() { loseNext = true; },
    },
  };
}
