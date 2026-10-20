import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SITE_OBJECT_FORMAT, siteObjectKeys, type SiteObjectReader, type SiteObjectStore } from "@zs/contracts";
import { createMemorySiteStore } from "@zs/core";
import { createManifestCache, serveSite } from "../src/handler.js";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const SITE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SITE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RELEASE_1 = "00000000-0000-4000-8000-000000000001";
const RELEASE_2 = "00000000-0000-4000-8000-000000000002";
const RELEASE_3 = "00000000-0000-4000-8000-000000000003";
const HOST_A = "a.example.com";
const HOST_B = "b.example.org";

const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

const HTML = "text/html; charset=utf-8";
const TEXT = "text/plain; charset=utf-8";
/** The etag is the quoted digest plus a hash of the media type; only its shape is fixed here. */
const etagOf = (digest: string) => new RegExp(`^"${digest}-[0-9a-f]{8}"$`);

interface ReleaseInput {
  readonly tenantId: string;
  readonly siteId: string;
  readonly releaseId: string;
  readonly entry?: string;
  readonly files: Record<string, string | { body: string; mediaType: string }>;
  /** Override manifest fields after the files are listed, to build broken manifests. */
  readonly manifest?: Record<string, unknown>;
  /** Where to store the manifest, when not under its own tenant. */
  readonly manifestTenantId?: string;
}

/** Write blobs and a manifest through the contracts key layout; returns each path's digest. */
async function publish(store: SiteObjectStore, input: ReleaseInput): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  const files = [];
  for (const path of Object.keys(input.files).sort()) {
    const value = input.files[path]!;
    const { body, mediaType } = typeof value === "string" ? { body: value, mediaType: HTML } : value;
    const bytes = encoder.encode(body);
    const digest = sha256(bytes);
    digests[path] = digest;
    await store.put(siteObjectKeys.blob(input.tenantId, digest), bytes, { contentType: mediaType });
    files.push({ path, mediaType, sha256: digest, bytes: bytes.byteLength });
  }
  const manifest = {
    format: SITE_OBJECT_FORMAT,
    tenantId: input.tenantId,
    siteId: input.siteId,
    releaseId: input.releaseId,
    entry: input.entry ?? "index.html",
    digest: "0".repeat(64),
    files,
    ...input.manifest,
  };
  const key = siteObjectKeys.manifest(input.manifestTenantId ?? input.tenantId, input.releaseId);
  await store.put(key, json(manifest), { contentType: "application/json" });
  return digests;
}

async function point(store: SiteObjectStore, host: string, tenantId: string, siteId: string, releaseId: string, version = 1) {
  const pointer = { format: SITE_OBJECT_FORMAT, host, assignment: 1, tenantId, siteId, releaseId, version };
  await store.put(siteObjectKeys.host(host), json(pointer), { contentType: "application/json" });
}

function get(path: string, host = HOST_A, init: RequestInit = {}) {
  return new Request(`https://worker.invalid${path}`, { ...init, headers: { host, ...(init.headers as Record<string, string>) } });
}

/** A store with one tenant's site live on HOST_A. */
async function siteA() {
  const store = createMemorySiteStore();
  const digests = await publish(store, {
    tenantId: TENANT_A,
    siteId: SITE_A,
    releaseId: RELEASE_1,
    files: {
      "index.html": "<h1>home v1</h1>",
      "about.html": "<h1>about</h1>",
      "docs/index.html": "<h1>docs</h1>",
      "docs/guide/index.html": "<h1>guide</h1>",
      "style.css": { body: "body{}", mediaType: "text/css; charset=utf-8" },
      "robots.txt": { body: "User-agent: *", mediaType: "text/plain; charset=utf-8" },
      "404.html": "<h1>nothing here</h1>",
    },
  });
  await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1);
  return { store, digests };
}

/** A reader that records every key it is asked for. */
function recording(store: SiteObjectReader) {
  const keys: string[] = [];
  return { keys, reader: { get: (key: string) => (keys.push(key), store.get(key)) } satisfies SiteObjectReader };
}

describe("host lookup", () => {
  it("answers 404 for a host with no pointer", async () => {
    const { store } = await siteA();
    const response = await serveSite(get("/", "unknown.example.com"), store);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  it("answers 404 for a host whose pointer was retired by a detach", async () => {
    const { store } = await siteA();
    const retired = { format: SITE_OBJECT_FORMAT, host: HOST_A, assignment: 2, retired: true };
    await store.put(siteObjectKeys.host(HOST_A), json(retired), { contentType: "application/json" });
    const response = await serveSite(get("/"), store);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 404 for an invalid host without reading the store", async () => {
    const { store } = await siteA();
    for (const host of ["localhost", "127.0.0.1", "[::1]:8080", "bad_host.example.com", "a..example.com", ""]) {
      const { keys, reader } = recording(store);
      const response = await serveSite(get("/", host), reader);
      expect(response.status, host).toBe(404);
      expect(keys, host).toEqual([]);
    }
  });

  it("normalizes case, port and trailing dot", async () => {
    const { store } = await siteA();
    for (const host of ["A.Example.COM", "a.example.com:8443", "a.example.com.", "A.EXAMPLE.com.:80"]) {
      const response = await serveSite(get("/", host), store);
      expect(response.status, host).toBe(200);
      expect(await response.text(), host).toBe("<h1>home v1</h1>");
    }
  });

  it("falls back to the URL host when there is no Host header", async () => {
    const { store } = await siteA();
    const request = new Request("https://a.example.com/about");
    request.headers.delete("host");
    const response = await serveSite(request, store);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>about</h1>");
  });

  it("answers 502 for a pointer that is not valid JSON or does not parse", async () => {
    const { store } = await siteA();
    for (const body of ["{not json", JSON.stringify({ format: 1, host: HOST_A }), "ÿ"]) {
      await store.put(siteObjectKeys.host(HOST_A), encoder.encode(body), { contentType: "application/json" });
      const response = await serveSite(get("/"), store);
      expect(response.status, body).toBe(502);
      expect(await response.text()).toBe("Bad gateway");
    }
  });

  it("answers 502 for a pointer that names another host", async () => {
    const { store } = await siteA();
    const pointer = { format: SITE_OBJECT_FORMAT, host: HOST_B, assignment: 1, tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, version: 1 };
    await store.put(siteObjectKeys.host(HOST_A), json(pointer), { contentType: "application/json" });
    expect((await serveSite(get("/"), store)).status).toBe(502);
  });
});

describe("serving files", () => {
  it("serves the entry at / with content type, etag and security headers", async () => {
    const { store, digests } = await siteA();
    const response = await serveSite(get("/"), store);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>home v1</h1>");
    expect(response.headers.get("content-type")).toBe(HTML);
    expect(response.headers.get("etag")).toMatch(etagOf(digests["index.html"]!));
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(response.headers.get("content-length")).toBe(String("<h1>home v1</h1>".length));
  });

  it("serves a non-index entry at /", async () => {
    const store = createMemorySiteStore();
    await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, entry: "home.html", files: { "home.html": "home" } });
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1);
    expect(await (await serveSite(get("/"), store)).text()).toBe("home");
  });

  it("maps clean URLs", async () => {
    const { store } = await siteA();
    const cases: Array<[string, string]> = [
      ["/about", "<h1>about</h1>"],
      ["/about.html", "<h1>about</h1>"],
      ["/docs/", "<h1>docs</h1>"],
      ["/docs/guide/", "<h1>guide</h1>"],
      ["/docs/index.html", "<h1>docs</h1>"],
      ["/style.css", "body{}"],
      ["/robots.txt", "User-agent: *"],
      ["/st%79le.css", "body{}"],
    ];
    for (const [path, body] of cases) {
      const response = await serveSite(get(path), store);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(body);
    }
    const css = await serveSite(get("/style.css"), store);
    expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
    // A trailing slash means a directory: "/about/" is not about.html.
    expect((await serveSite(get("/about/"), store)).status).toBe(404);
  });

  it("redirects a directory without its trailing slash, with 308 and no blob read", async () => {
    const { store } = await siteA();
    const cases: Array<[string, string]> = [
      ["/docs", "/docs/"],
      ["/docs/guide", "/docs/guide/"],
      ["/d%6Fcs", "/d%6Fcs/"],
    ];
    for (const [path, location] of cases) {
      for (const method of ["GET", "HEAD"]) {
        const { keys, reader } = recording(store);
        const response = await serveSite(get(path, HOST_A, { method }), reader);
        expect(response.status, `${method} ${path}`).toBe(308);
        expect(response.headers.get("location"), path).toBe(location);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("etag")).toBeNull();
        expect(response.body).toBeNull();
        expect(keys.some((key) => key.includes("/blobs/"))).toBe(false);
      }
    }
    // A file or a .html page of that name wins over the directory, with no redirect.
    const store2 = createMemorySiteStore();
    await publish(store2, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, files: { "docs.html": "docs page", "docs/index.html": "docs dir" } });
    await point(store2, HOST_A, TENANT_A, SITE_A, RELEASE_1);
    const page = await serveSite(get("/docs"), store2);
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("docs page");
  });

  it("keeps the query string on the trailing-slash redirect", async () => {
    const { store } = await siteA();
    const response = await serveSite(get("/docs/guide?tab=api&x=%20y"), store);
    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("/docs/guide/?tab=api&x=%20y");
    expect((await serveSite(get("/docs?"), store)).headers.get("location")).toBe("/docs/");
  });

  it("serves 404.html with status 404 for an unknown path", async () => {
    const { store } = await siteA();
    const response = await serveSite(get("/nope"), store);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("<h1>nothing here</h1>");
    expect(response.headers.get("content-type")).toBe(HTML);
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("answers a plain 404 when the release has no 404.html", async () => {
    const store = createMemorySiteStore();
    await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, files: { "index.html": "home" } });
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1);
    const response = await serveSite(get("/nope"), store);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers HEAD with headers and no body", async () => {
    const { store, digests } = await siteA();
    const response = await serveSite(get("/about", HOST_A, { method: "HEAD" }), store);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String("<h1>about</h1>".length));
    expect(response.headers.get("etag")).toMatch(etagOf(digests["about.html"]!));
    expect(response.headers.get("content-type")).toBe(HTML);
    expect(response.body).toBeNull();
  });

  it("answers 405 with Allow for other methods", async () => {
    const { store } = await siteA();
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const response = await serveSite(get("/", HOST_A, { method }), store);
      expect(response.status, method).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("answers 304 when If-None-Match matches, without reading the blob", async () => {
    const { store, digests } = await siteA();
    const etag = (await serveSite(get("/"), store)).headers.get("etag")!;
    expect(etag).toMatch(etagOf(digests["index.html"]!));
    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, "*"]) {
      const { keys, reader } = recording(store);
      const response = await serveSite(get("/", HOST_A, { headers: { "if-none-match": header } }), reader);
      expect(response.status, header).toBe(304);
      expect(response.headers.get("etag")).toBe(etag);
      expect(response.headers.get("content-type")).toBe(HTML);
      expect(response.body).toBeNull();
      expect(keys.some((key) => key.includes("/blobs/"))).toBe(false);
    }
    const stale = await serveSite(get("/", HOST_A, { headers: { "if-none-match": '"stale"' } }), store);
    expect(stale.status).toBe(200);
    // The bare digest, the validator before media types were part of it, no longer matches.
    const bare = await serveSite(get("/", HOST_A, { headers: { "if-none-match": `"${digests["index.html"]}"` } }), store);
    expect(bare.status).toBe(200);
  });
});

describe("paths", () => {
  it("answers 400 for malformed percent-encoding", async () => {
    const { store } = await siteA();
    const { keys, reader } = recording(store);
    const response = await serveSite(get("/%E0%A4%A"), reader);
    expect(response.status).toBe(400);
    expect(keys).toEqual([]);
  });

  it("never reads outside the release for traversal attempts", async () => {
    const { store } = await siteA();
    // Secrets another tenant holds, and an object outside any release.
    await publish(store, { tenantId: TENANT_B, siteId: SITE_B, releaseId: RELEASE_2, files: { "x": "tenant b secret", "index.html": "b" } });
    await store.put("x", encoder.encode("root secret"), { contentType: "text/plain" });
    const paths = ["/../x", "/%2e%2e/x", "//x", "/docs/../../x", "/docs/%2e%2e/%2e%2e/x", "/a%2fb", "/a%5cb", "/./about", "/docs//guide", "/%00"];
    for (const path of paths) {
      const { keys, reader } = recording(store);
      const response = await serveSite(get(path), reader);
      const body = await response.text();
      expect(body, path).not.toContain("secret");
      for (const key of keys) {
        expect(key === siteObjectKeys.host(HOST_A) || key.startsWith(`t/${TENANT_A}/`), `${path} read ${key}`).toBe(true);
      }
      // URL parsing folds dot segments; what remains maps inside the release or is refused.
      expect([200, 404], path).toContain(response.status);
    }
    expect((await serveSite(get("//x"), store)).status).toBe(404);
    expect((await serveSite(get("/docs//guide"), store)).status).toBe(404);
  });
});

describe("releases", () => {
  async function twoReleases() {
    const store = createMemorySiteStore();
    const v1 = await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, files: { "index.html": "home v1", "about.html": "about v1" } });
    const v2 = await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_2, files: { "index.html": "home v2", "about.html": "about v2" } });
    return { store, v1, v2 };
  }

  it("serves only the first release when the pointer flips mid-request", async () => {
    const { store, v1 } = await twoReleases();
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1, 1);
    let pointerReads = 0;
    const flipping: SiteObjectReader = {
      async get(key) {
        const object = await store.get(key);
        if (key === siteObjectKeys.host(HOST_A)) {
          pointerReads += 1;
          await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_2, 2);
        }
        return object;
      },
    };
    const response = await serveSite(get("/about"), flipping);
    expect(await response.text()).toBe("about v1");
    expect(response.headers.get("etag")).toMatch(etagOf(v1["about.html"]!));
    expect(pointerReads).toBe(1);
    // The next request sees the flip.
    expect(await (await serveSite(get("/about"), store)).text()).toBe("about v2");
  });

  it("does not answer 304 when a release keeps the bytes but changes the media type", async () => {
    const store = createMemorySiteStore();
    const v1 = await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, files: { "page": { body: "<b>hi</b>", mediaType: TEXT } } });
    const v2 = await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_2, files: { "page": { body: "<b>hi</b>", mediaType: HTML } } });
    expect(v2["page"]).toBe(v1["page"]);
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1, 1);
    const old = await serveSite(get("/page"), store);
    expect(old.headers.get("content-type")).toBe(TEXT);
    const oldEtag = old.headers.get("etag")!;
    expect(oldEtag).toMatch(etagOf(v1["page"]!));

    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_2, 2);
    const fresh = await serveSite(get("/page", HOST_A, { headers: { "if-none-match": oldEtag } }), store);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("content-type")).toBe(HTML);
    expect(await fresh.text()).toBe("<b>hi</b>");
    const newEtag = fresh.headers.get("etag")!;
    expect(newEtag).toMatch(etagOf(v2["page"]!));
    expect(newEtag).not.toBe(oldEtag);

    // The new validator still revalidates, and its 304 names the new type.
    const revalidated = await serveSite(get("/page", HOST_A, { headers: { "if-none-match": newEtag } }), store);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("content-type")).toBe(HTML);
  });

  it("serves the old bytes again after a rollback", async () => {
    const { store } = await twoReleases();
    const manifestCache = createManifestCache();
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1, 1);
    expect(await (await serveSite(get("/"), store, { manifestCache })).text()).toBe("home v1");
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_2, 2);
    expect(await (await serveSite(get("/"), store, { manifestCache })).text()).toBe("home v2");
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1, 3);
    expect(await (await serveSite(get("/"), store, { manifestCache })).text()).toBe("home v1");
  });

  it("caches manifests but never pointers", async () => {
    const { store } = await twoReleases();
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1, 1);
    const manifestCache = createManifestCache();
    const { keys, reader } = recording(store);
    await serveSite(get("/"), reader, { manifestCache });
    await serveSite(get("/about"), reader, { manifestCache });
    const manifestKey = siteObjectKeys.manifest(TENANT_A, RELEASE_1);
    expect(keys.filter((key) => key === manifestKey)).toHaveLength(1);
    expect(keys.filter((key) => key === siteObjectKeys.host(HOST_A))).toHaveLength(2);
  });

  it("bounds the manifest cache", async () => {
    const cache = createManifestCache(2);
    const entry = { manifest: {} as never, files: new Map() };
    cache.set("a", entry);
    cache.set("b", entry);
    cache.get("a");
    cache.set("c", entry);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(entry);
    expect(cache.get("c")).toBe(entry);
  });

  it("answers 502 when the manifest is missing, malformed or lists a path twice", async () => {
    const store = createMemorySiteStore();
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1);
    expect((await serveSite(get("/"), store)).status).toBe(502);
    await store.put(siteObjectKeys.manifest(TENANT_A, RELEASE_1), encoder.encode("{"), { contentType: "application/json" });
    expect((await serveSite(get("/"), store)).status).toBe(502);
    const file = { path: "index.html", mediaType: HTML, sha256: "a".repeat(64), bytes: 1 };
    await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, files: { "index.html": "x" }, manifest: { files: [file, file] } });
    const response = await serveSite(get("/"), store);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Bad gateway");
  });

  it("answers 502 when the manifest names another site or release", async () => {
    const store = createMemorySiteStore();
    await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, files: { "index.html": "x" }, manifest: { siteId: SITE_B } });
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1);
    expect((await serveSite(get("/"), store)).status).toBe(502);
    await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, files: { "index.html": "x" }, manifest: { releaseId: RELEASE_3 } });
    expect((await serveSite(get("/"), store)).status).toBe(502);
  });

  it("answers 502 when a blob is missing", async () => {
    const { store, digests } = await siteA();
    await store.delete(siteObjectKeys.blob(TENANT_A, digests["about.html"]!));
    const response = await serveSite(get("/about"), store);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Bad gateway");
    expect((await serveSite(get("/about", HOST_A, { method: "HEAD" }), store)).status).toBe(502);
  });

  it("answers 502 when a blob's size differs from the manifest", async () => {
    const { store, digests } = await siteA();
    await store.put(siteObjectKeys.blob(TENANT_A, digests["about.html"]!), encoder.encode("<h1>about!</h1>"), { contentType: HTML });
    expect((await serveSite(get("/about"), store)).status).toBe(502);
  });
});

describe("tenant isolation", () => {
  it("serves each host only its own tenant's bytes", async () => {
    const { store } = await siteA();
    await publish(store, { tenantId: TENANT_B, siteId: SITE_B, releaseId: RELEASE_2, files: { "index.html": "tenant b home", "only-b.html": "b only" } });
    await point(store, HOST_B, TENANT_B, SITE_B, RELEASE_2);
    expect(await (await serveSite(get("/"), store)).text()).toBe("<h1>home v1</h1>");
    expect(await (await serveSite(get("/", HOST_B), store)).text()).toBe("tenant b home");
    expect(await (await serveSite(get("/only-b", HOST_B), store)).text()).toBe("b only");
    // HOST_A's release has no such path: its own 404 page, never tenant B's file.
    const crossed = await serveSite(get("/only-b"), store);
    expect(crossed.status).toBe(404);
    expect(await crossed.text()).toBe("<h1>nothing here</h1>");
  });

  it("refuses a pointer to tenant A whose manifest is stored only under tenant B", async () => {
    const store = createMemorySiteStore();
    await publish(store, { tenantId: TENANT_B, siteId: SITE_B, releaseId: RELEASE_2, files: { "index.html": "tenant b home" } });
    await point(store, HOST_A, TENANT_A, SITE_B, RELEASE_2);
    const { keys, reader } = recording(store);
    expect((await serveSite(get("/"), reader)).status).toBe(502);
    expect(keys.every((key) => !key.startsWith(`t/${TENANT_B}/`))).toBe(true);
  });

  it("refuses a manifest whose tenant differs from the pointer", async () => {
    const store = createMemorySiteStore();
    // Stored under tenant A's prefix, but it claims tenant B.
    await publish(store, { tenantId: TENANT_B, siteId: SITE_A, releaseId: RELEASE_1, manifestTenantId: TENANT_A, files: { "index.html": "x" } });
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1);
    const response = await serveSite(get("/"), store);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Bad gateway");
  });

  it("reads blobs only under the pointer's tenant, even for a digest tenant B holds", async () => {
    const store = createMemorySiteStore();
    const digests = await publish(store, { tenantId: TENANT_B, siteId: SITE_B, releaseId: RELEASE_2, files: { "index.html": "tenant b home" } });
    // Tenant A's manifest lists tenant B's digest, but tenant A never stored that blob.
    const file = { path: "index.html", mediaType: HTML, sha256: digests["index.html"]!, bytes: "tenant b home".length };
    await publish(store, { tenantId: TENANT_A, siteId: SITE_A, releaseId: RELEASE_1, files: { "other.html": "a" }, manifest: { files: [file] } });
    await point(store, HOST_A, TENANT_A, SITE_A, RELEASE_1);
    const { keys, reader } = recording(store);
    const response = await serveSite(get("/"), reader);
    expect(response.status).toBe(502);
    expect(keys).toContain(siteObjectKeys.blob(TENANT_A, digests["index.html"]!));
    expect(keys.every((key) => !key.startsWith(`t/${TENANT_B}/`))).toBe(true);
  });
});
