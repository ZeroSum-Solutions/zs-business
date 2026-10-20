import {
  siteHostPointerSchema,
  siteHostSchema,
  siteObjectKeys,
  siteReleaseManifestSchema,
  type SiteFile,
  type SiteHostPointer,
  type SiteObjectReader,
  type SiteReleaseManifest,
} from "@zs/contracts";
import type { z } from "zod";

// The dispatch Worker: one deployment serves every tenant's live release, chosen by Host.
// It reads the host pointer once, then answers every file from that pointer's manifest, so a
// request never mixes two releases. Blob keys come from the pointer's tenant and the file's
// digest only, so a pointer cannot reach another tenant's objects.

/** A release's parsed file table. Releases are immutable, so it can be kept between requests. */
export interface CachedManifest {
  readonly manifest: SiteReleaseManifest;
  readonly files: ReadonlyMap<string, SiteFile>;
}

/** A small bounded cache of parsed manifests, keyed by manifest object key. Never pointers. */
export interface ManifestCache {
  get(key: string): CachedManifest | undefined;
  set(key: string, value: CachedManifest): void;
}

export function createManifestCache(limit = 64): ManifestCache {
  const entries = new Map<string, CachedManifest>();
  return {
    get(key) {
      const value = entries.get(key);
      if (value) {
        // Move to the back, so the least recently used entry is evicted first.
        entries.delete(key);
        entries.set(key, value);
      }
      return value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value!);
    },
  };
}

export interface ServeSiteOptions {
  readonly manifestCache?: ManifestCache;
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
} as const;
const FILE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra },
  });
}
const notFound = () => plain(404, "Not found");
const badGateway = () => plain(502, "Bad gateway");

/** Serve the request from the live release of its host. Uses web-standard APIs only. */
export async function serveSite(request: Request, store: SiteObjectReader, options: ServeSiteOptions = {}): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed", { allow: "GET, HEAD" });

  const url = new URL(request.url);
  const host = normalizeHost(request.headers.get("host") ?? url.host);
  if (!host) return notFound();

  // A path that cannot be decoded is the client's fault: 400, before any store read.
  const route = parsePath(url.pathname);
  if (route === "malformed") return plain(400, "Bad request");

  // The one pointer read of this request. No object: no site here (404). An object that does
  // not parse or names another host is a broken projection, not a missing site (502).
  const pointerObject = await store.get(siteObjectKeys.host(host));
  if (!pointerObject) return notFound();
  const pointer = parseJson(pointerObject.body, siteHostPointerSchema);
  if (!pointer || pointer.host !== host) return badGateway();

  const release = await loadManifest(store, pointer, options.manifestCache);
  if (!release) return badGateway();

  const file = route === "invalid" ? undefined : resolveFile(release, route);
  if (file) return serveFile(request, store, pointer, file, 200);
  const page = release.files.get("404.html");
  return page ? serveFile(request, store, pointer, page, 404) : notFound();
}

/** Lowercased host without port or trailing dot, or null when it is not a DNS host name. */
function normalizeHost(raw: string): string | null {
  const parsed = siteHostSchema.safeParse(raw.trim().replace(/:\d*$/, ""));
  return parsed.success ? parsed.data : null;
}

type Route = { readonly segments: readonly string[]; readonly directory: boolean } | "invalid" | "malformed";

/**
 * Split the URL path into decoded segments. Empty, `.` or `..` segments, and segments that
 * decode to a slash or backslash, make the path invalid (served as not found). Malformed
 * percent-encoding is "malformed" (400).
 */
function parsePath(pathname: string): Route {
  if (pathname === "/" || pathname === "") return { segments: [], directory: true };
  const directory = pathname.endsWith("/");
  const raw = pathname.slice(1, directory ? -1 : undefined).split("/");
  const segments: string[] = [];
  for (const part of raw) {
    let segment: string;
    try {
      segment = decodeURIComponent(part);
    } catch {
      return "malformed";
    }
    if (segment === "" || segment === "." || segment === ".." || /[/\\\0]/.test(segment)) return "invalid";
    segments.push(segment);
  }
  return { segments, directory };
}

/** "/" → entry; "/a/b/" → a/b/index.html; "/a/b" → a/b, else a/b.html, else a/b/index.html. */
function resolveFile(release: CachedManifest, route: Exclude<Route, "invalid" | "malformed">): SiteFile | undefined {
  if (route.segments.length === 0) return release.files.get(release.manifest.entry);
  const path = route.segments.join("/");
  if (route.directory) return release.files.get(`${path}/index.html`);
  return release.files.get(path) ?? release.files.get(`${path}.html`) ?? release.files.get(`${path}/index.html`);
}

/** The pointer's manifest, checked against the pointer on every request; null when unusable. */
async function loadManifest(store: SiteObjectReader, pointer: SiteHostPointer, cache: ManifestCache | undefined): Promise<CachedManifest | null> {
  const key = siteObjectKeys.manifest(pointer.tenantId, pointer.releaseId);
  let release = cache?.get(key);
  if (!release) {
    const object = await store.get(key);
    const manifest = object ? parseJson(object.body, siteReleaseManifestSchema) : null;
    if (!manifest) return null;
    const files = new Map(manifest.files.map((file) => [file.path, file] as const));
    if (files.size !== manifest.files.length) return null;
    release = { manifest, files };
  }
  const { manifest } = release;
  if (manifest.tenantId !== pointer.tenantId || manifest.siteId !== pointer.siteId || manifest.releaseId !== pointer.releaseId) return null;
  cache?.set(key, release);
  return release;
}

async function serveFile(request: Request, store: SiteObjectReader, pointer: SiteHostPointer, file: SiteFile, status: 200 | 404): Promise<Response> {
  const etag = `"${file.sha256}"`;
  const headers: Record<string, string> = { "cache-control": FILE_CACHE_CONTROL, ...SECURITY_HEADERS };
  // The etag names the bytes, which the manifest already holds: a match needs no blob read.
  if (status === 200) {
    headers.etag = etag;
    if (matchesEtag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  }
  // HEAD reads the blob too, so it answers with the same status a GET would.
  const blob = await store.get(siteObjectKeys.blob(pointer.tenantId, file.sha256));
  if (!blob || blob.body.byteLength !== file.bytes) return badGateway();
  headers["content-type"] = file.mediaType;
  headers["content-length"] = String(file.bytes);
  const body = request.method === "HEAD" ? null : new Uint8Array(blob.body);
  return new Response(body, { status, headers });
}

/** If-None-Match uses weak comparison: `*`, or any listed tag equal once `W/` is dropped. */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}

function parseJson<T>(body: Uint8Array, schema: z.ZodType<T>): T | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
