// BT-5: the request policy of a read-only browser task. Pure: no I/O, no clock. The runner asks it
// about every request the browser would send (the DevTools interception hook in the Python
// service, the request queue in the fake runner) and sends nothing it refuses. The model picks
// steps; this decides whether a step may run.
import { canonicalOrigin, type BrowserStopReason } from "@zs/contracts";

/** What started the request. Asset prefixes serve only the four asset types (BT-5). */
export type BrowserResourceType = "document" | "script" | "style" | "image" | "font" | "xhr" | "fetch" | "form" | "other";
const ASSET_TYPES: readonly BrowserResourceType[] = ["script", "style", "image", "font"];

export interface BrowserPolicyTarget {
  readonly allowedOrigins: readonly string[];
  readonly allowedPaths: readonly string[];
  readonly assetPaths: readonly string[];
  readonly signInPath: string;
}
export interface BrowserRequest {
  readonly method: string;
  readonly url: string;
  readonly resourceType: BrowserResourceType;
}
export type PolicyVerdict =
  | { readonly allow: true; readonly kind: "page" | "asset" | "sign_in" }
  | { readonly allow: false; readonly reason: Extract<BrowserStopReason, "origin_denied" | "write_refused"> };

/** True when `path` equals the prefix or sits below it, on a segment boundary (`/inv` does not cover `/invoices`). */
export function underPrefix(path: string, prefix: string): boolean {
  const base = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return path === base || path === `${base}/` || path.startsWith(`${base}/`);
}

/** The origin and path of a URL, with the query string and fragment dropped (BT-9). Null for a URL that is not http(s). */
export function eventLocation(raw: string): { origin: string; path: string } | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return { origin: url.origin, path: url.pathname };
}

/**
 * One policy per run attempt: the sign-in `POST` is allowed once (BT-5), so the policy remembers it.
 * `check` is the whole decision; it never throws for hostile input.
 */
export function createRequestPolicy(target: BrowserPolicyTarget) {
  let signInUsed = false;
  // BT-3: compare canonical origins (`https://x:443` is `https://x`); a value that is not an exact origin allows nothing.
  const origins = new Set(target.allowedOrigins.map(canonicalOrigin).filter((origin): origin is string => origin !== null));
  return {
    check(request: BrowserRequest): PolicyVerdict {
      let url: URL;
      try { url = new URL(request.url); } catch { return { allow: false, reason: "origin_denied" }; }
      if ((url.protocol !== "https:" && url.protocol !== "http:") || !origins.has(url.origin))
        return { allow: false, reason: "origin_denied" };
      // An encoded separator hides a path from a prefix check; refuse it outright.
      if (/%2f|%5c|\\/i.test(url.pathname) || url.username !== "" || url.password !== "")
        return { allow: false, reason: "write_refused" };
      const path = url.pathname;
      const method = request.method.toUpperCase();
      if (method === "POST" && !signInUsed && path === target.signInPath
        && (request.resourceType === "form" || request.resourceType === "document")) {
        signInUsed = true;
        return { allow: true, kind: "sign_in" };
      }
      if (method !== "GET" && method !== "HEAD") return { allow: false, reason: "write_refused" };
      if (target.allowedPaths.some((prefix) => underPrefix(path, prefix)) || path === target.signInPath)
        return { allow: true, kind: "page" };
      if (ASSET_TYPES.includes(request.resourceType) && target.assetPaths.some((prefix) => underPrefix(path, prefix)))
        return { allow: true, kind: "asset" };
      return { allow: false, reason: "write_refused" };
    },
  };
}
export type RequestPolicy = ReturnType<typeof createRequestPolicy>;
