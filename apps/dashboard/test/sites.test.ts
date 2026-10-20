import { siteReleaseDigest, siteReleaseResponseSchema } from "@zs/contracts";
import { describe, expect, it } from "vitest";
import { createDemoSites, DEMO_SITE_ID } from "../src/lib/api/demo/sites";
import { ApiError, isStaleRelease } from "../src/lib/api/errors";
import { createHttpClient } from "../src/lib/api/http-client";

const SPEC = { kind: "plain", title: "Halden & Rowe", tagline: "Rings <and> repairs", sections: [{ heading: "Visit", body: "Tuesday to Saturday." }] };
let keys = 0;
const key = () => ({ idempotencyKey: `00000000-0000-4000-8000-${String(++keys).padStart(12, "0")}` });
const clock = { now: () => new Date("2026-10-20T12:00:00.000Z") };

function client(responses: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createHttpClient({
    baseUrl: "https://api.example.test/",
    getToken: () => "dev-token",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      const next = responses.shift();
      if (!next) throw new Error("no response queued");
      return next;
    },
  });
  return { api, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const headers = (init: RequestInit) => (init.headers ?? {}) as Record<string, string>;

describe("demo sites", () => {
  it("publishes a release that goes live, and rolls back to the release the caller saw replaced", async () => {
    const { api } = createDemoSites({ clock });
    const [site] = await api.listSites();
    expect(site!.id).toBe(DEMO_SITE_ID);
    const before = await api.listSiteReleases(site!.id);
    expect(before).toHaveLength(2);
    expect(site!.currentReleaseId).toBe(before[0]!.id);

    const published = await api.publishSite(site!.id, SPEC, key());
    expect(siteReleaseResponseSchema.parse(published)).toEqual(published);
    expect(published.edge).toBe("synced");
    expect(published.result.site.currentReleaseId).toBe(published.result.release.id);
    expect(published.result.site.pointerVersion).toBe(site!.pointerVersion + 1);
    const detail = await api.getSiteRelease(site!.id, published.result.release.id);
    expect(detail.spec).toEqual(SPEC);
    // The demo computes the digest the way the server checks it.
    expect(detail.digest).toBe(await siteReleaseDigest(detail.files));

    const back = await api.activateSiteRelease(
      { siteId: site!.id, releaseId: before[1]!.id, expectedCurrentReleaseId: published.result.release.id }, key());
    expect(back.result.site.currentReleaseId).toBe(before[1]!.id);
    expect(await api.listSiteReleases(site!.id)).toHaveLength(3);
  });

  it("answers stale_release when another release went live, and replays a retried write", async () => {
    const { api, controls } = createDemoSites({ clock });
    const [site] = await api.listSites();
    const releases = await api.listSiteReleases(site!.id);
    controls.rollBackElsewhere();
    const error = await api.activateSiteRelease(
      { siteId: site!.id, releaseId: releases[1]!.id, expectedCurrentReleaseId: site!.currentReleaseId }, key()).catch((caught: unknown) => caught);
    expect(isStaleRelease(error)).toBe(true);

    const once = key();
    const first = await api.publishSite(site!.id, SPEC, once);
    const again = await api.publishSite(site!.id, SPEC, once);
    expect(again).toEqual(first);
    expect(await api.listSiteReleases(site!.id)).toHaveLength(3);
    const reused = await api.publishSite(site!.id, { ...SPEC, title: "Other" }, once).catch((caught: unknown) => caught);
    expect(reused).toBeInstanceOf(ApiError);
    expect((reused as ApiError).reason).toBe("idempotency_key_reused");
  });

  it("previews escaped HTML without publishing, and reports pending while the edge is down", async () => {
    const { api, controls } = createDemoSites({ clock });
    const preview = await api.previewSite(DEMO_SITE_ID, SPEC);
    expect(preview.entryHtml).toContain("Rings &lt;and&gt; repairs");
    expect(await api.listSiteReleases(DEMO_SITE_ID)).toHaveLength(2);
    controls.setSiteEdgeDown(true);
    expect((await api.publishSite(DEMO_SITE_ID, SPEC, key())).edge).toBe("pending");
    expect((await api.syncSite(DEMO_SITE_ID)).edge).toBe("pending");
    controls.setSiteEdgeDown(false);
    expect((await api.syncSite(DEMO_SITE_ID)).edge).toBe("synced");
  });

  it("rejects a spec the plain compiler cannot build", async () => {
    const { api } = createDemoSites({ clock });
    const error = await api.previewSite(DEMO_SITE_ID, { kind: "plain", title: "" }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("ValidationFailed");
  });
});

describe("http client sites", () => {
  it("sends publish and rollback with the caller's key, and preview and sync without one", async () => {
    const demo = createDemoSites({ clock }).api;
    const [site] = await demo.listSites();
    const published = await demo.publishSite(site!.id, SPEC, key());
    const preview = await demo.previewSite(site!.id, SPEC);
    const { api, calls } = client([
      json(200, preview),
      json(201, published),
      json(200, published),
      json(200, { site: published.result.site, edge: "synced" }),
    ]);

    expect((await api.previewSite(site!.id, SPEC)).entryHtml).toBe(preview.entryHtml);
    expect(calls[0]!.url).toBe(`https://api.example.test/v1/sites/${site!.id}/preview`);
    expect(headers(calls[0]!.init)["Idempotency-Key"]).toBeUndefined();
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ spec: SPEC });

    const publishKey = key();
    expect((await api.publishSite(site!.id, SPEC, publishKey)).edge).toBe("synced");
    expect(calls[1]!.url).toBe(`https://api.example.test/v1/sites/${site!.id}/releases`);
    expect(headers(calls[1]!.init)["Idempotency-Key"]).toBe(publishKey.idempotencyKey);

    const input = { siteId: site!.id, releaseId: published.result.release.id, expectedCurrentReleaseId: site!.currentReleaseId };
    await api.activateSiteRelease(input, key());
    expect(calls[2]!.url).toBe(`https://api.example.test/v1/sites/${site!.id}/releases/${input.releaseId}/activate`);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ expectedCurrentReleaseId: site!.currentReleaseId });
    expect(headers(calls[2]!.init)["Idempotency-Key"]).toBeTruthy();

    expect((await api.syncSite(site!.id)).edge).toBe("synced");
    expect(calls[3]!.url).toBe(`https://api.example.test/v1/sites/${site!.id}/sync`);
    expect(calls[3]!.init.method).toBe("POST");
    expect(headers(calls[3]!.init)["Idempotency-Key"]).toBeUndefined();
  });

  it("refuses a publish without a caller-owned key, and maps a stale_release 409", async () => {
    const { api, calls } = client([json(409, { error: { code: "Conflict", message: "stale", details: { reason: "stale_release" } } })]);
    await expect(api.publishSite(DEMO_SITE_ID, SPEC, {} as never)).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
    const error = await api.activateSiteRelease(
      { siteId: DEMO_SITE_ID, releaseId: DEMO_SITE_ID, expectedCurrentReleaseId: null }, key()).catch((caught: unknown) => caught);
    expect(isStaleRelease(error)).toBe(true);
  });
});
