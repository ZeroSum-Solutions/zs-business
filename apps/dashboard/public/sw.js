/*
 * App-shell service worker. It caches pages, scripts, styles and icons from this
 * origin so the app opens offline. It never caches API data: any request to another
 * origin, to /v1/, or that is not a GET goes straight to the network.
 */
const VERSION = "zs-shell-v1";
const SHELL = ["/", "/inbox", "/calendar", "/customers", "/site", "/agents", "/manifest.webmanifest", "/icons/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== VERSION).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

function isShellRequest(request, url) {
  if (request.method !== "GET") return false;
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith("/v1/") || url.pathname.startsWith("/api/")) return false;
  if (request.headers.get("authorization")) return false;
  return true;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (!isShellRequest(request, url)) return;

  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })),
    );
    return;
  }

  // Pages: network first, fall back to the cached page or the cached home shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match("/"))),
    );
  }
});
