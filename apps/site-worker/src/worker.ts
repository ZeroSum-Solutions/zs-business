import { createManifestCache, serveSite } from "./handler.js";
import { r2Reader, type R2BucketLike } from "./r2.js";

export interface Env {
  readonly SITES: R2BucketLike;
}

// Parsed manifests are immutable, so one isolate keeps a few between requests.
const manifestCache = createManifestCache();

/** The dispatch Worker's entry point. Unexpected errors answer a fixed 500 with no details. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await serveSite(request, r2Reader(env.SITES), { manifestCache });
    } catch (error) {
      console.error("site-worker: unexpected error", error);
      return new Response("Internal error", {
        status: 500,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
      });
    }
  },
};
