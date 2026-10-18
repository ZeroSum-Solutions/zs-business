/*
 * App-shell service worker. It caches pages and the hashed scripts and styles they load,
 * so the app opens offline, styled and working. It never caches data: any request to
 * another origin, to /api/ or /v1/, that is not a GET or that carries an Authorization
 * header goes to the network only. A response is stored only when it is same-origin
 * ("basic"), OK, HTML, JavaScript or CSS, and not marked no-store or private.
 *
 * The page registers /sw.js?v=<build id>. Each build gets a new worker and a new cache,
 * and the old caches are deleted on activate.
 */
const BUILD = new URL(self.location.href).searchParams.get("v") || "dev";
const VERSION = `zs-shell-${BUILD}`;
const PAGES = [
  "/", "/inbox", "/calendar", "/customers", "/site", "/agents",
  "/account/settings", "/account/connections", "/account/plan",
];
/** Build scripts and styles a page refers to, written with or without the /_next/ prefix. */
const ASSET = /(?:\/_next\/)?static\/[A-Za-z0-9_\-./~%@]+?\.(?:js|css)(?![A-Za-z0-9])/g;
/** The only content types worth keeping offline. Fonts fall back; data is never kept. */
const SHELL_TYPE = /^(?:text\/html|text\/css|(?:text|application)\/javascript)(?:;|$)/;

function isPrivateRequest(request, url) {
  if (request.method !== "GET") return true;
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) return true;
  if (request.headers.get("authorization")) return true;
  return false;
}

function isStorable(response) {
  if (!response.ok || response.type !== "basic") return false;
  if (!SHELL_TYPE.test((response.headers.get("content-type") || "").toLowerCase().trim())) return false;
  const control = (response.headers.get("cache-control") || "").toLowerCase();
  return !control.includes("no-store") && !control.includes("private");
}

function assetsIn(text) {
  const found = new Set();
  for (const match of text.matchAll(ASSET)) {
    found.add(match[0].startsWith("/_next/") ? match[0] : `/_next/${match[0]}`);
  }
  return [...found];
}

async function put(cache, url) {
  const response = await fetch(url, { cache: "reload", credentials: "same-origin" });
  if (!isStorable(response)) return null;
  await cache.put(url, response.clone());
  return response;
}

/** Cache the pages, then every script and style they reference, then what the styles import. */
async function precache() {
  const cache = await caches.open(VERSION);
  const pages = await Promise.all(PAGES.map((url) => put(cache, url).catch(() => null)));
  if (!pages[0]) throw new Error("The home page could not be cached");
  const html = await Promise.all(pages.filter(Boolean).map((response) => response.text()));
  const assets = new Set(html.flatMap(assetsIn));
  const fetched = await Promise.all([...assets].map((url) => put(cache, url).catch(() => null)));
  const styles = await Promise.all(
    fetched.filter((response) => response && response.url.endsWith(".css")).map((response) => response.text()),
  );
  const nested = styles.flatMap(assetsIn).filter((url) => !assets.has(url));
  await Promise.all(nested.map((url) => put(cache, url).catch(() => null)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name.startsWith("zs-shell-") && name !== VERSION).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

function storeCopy(request, response) {
  if (!isStorable(response)) return;
  const copy = response.clone();
  caches.open(VERSION).then((cache) => cache.put(request, copy));
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (isPrivateRequest(request, url)) return;

  // Hashed build assets never change within a build: cache first.
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(VERSION)
        .then((cache) => cache.match(request))
        .then((hit) => hit || fetch(request).then((response) => {
          storeCopy(request, response);
          return response;
        })),
    );
    return;
  }

  // Pages: network first, then the cached page, then the cached home shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          storeCopy(request, response);
          return response;
        })
        .catch(() => caches.open(VERSION).then((cache) => cache.match(request, { ignoreVary: true }).then((hit) => hit || cache.match("/", { ignoreVary: true })))),
    );
  }
});
