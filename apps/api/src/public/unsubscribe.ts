// delivery.md D-9: the List-Unsubscribe endpoint of outgoing email. Anonymous like the public
// booking routes: the tenant and delivery come only from the signed token in the path, and the
// core session builds the principal that may record the one suppression.
// GET only shows a confirmation form, since mail scanners fetch links; POST (RFC 8058 one-click,
// or that form) suppresses the address the delivery went to. Original code.
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { apiErrorBody, createUnsubscribeSession, type EdgeDependencies, type UnsubscribeSecrets } from "@zs/core";
import type { AppEnv } from "../app.js";
import { addressBucket, createClientAddress, type ClientIpConfig } from "./client-ip.js";
import { createMemoryRateLimiter, DEFAULT_RATE_LIMITS, type RateLimiter, type RateLimits } from "./limiter.js";
import { PUBLIC_BODY_LIMIT, RateLimited } from "./routes.js";

export interface UnsubscribeConfig {
  /** Verifies unsubscribe tokens; `previous` keeps links in mail already sent working through a rotation. */
  readonly tokenSecrets: UnsubscribeSecrets;
  /** Where the caller's address comes from (P-10); by default the socket address. */
  readonly clientIp?: ClientIpConfig;
  /** Uses the address read and write rules; the tenant rule does not apply. */
  readonly limits?: Partial<RateLimits>;
  /** Defaults to an in-memory limiter on the app clock. */
  readonly limiter?: RateLimiter;
}

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } };
}

const STYLE = "body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem}"
  + "button{font:inherit;padding:.5rem 1rem;cursor:pointer}";
/** No script, no third-party origin, no framing; the one inline style is pinned by its hash. */
export const UNSUBSCRIBE_PAGE_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");
const PAGE_HEADERS = {
  "Content-Security-Policy": UNSUBSCRIBE_PAGE_CSP,
  "X-Content-Type-Options": "nosniff",
  // The token is in the URL; never pass it on.
  "Referrer-Policy": "no-referrer",
};

const page = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
${body}
</body>
</html>
`;

// The form has no action, so it posts back to the URL it was served from; the page never
// repeats the token or the address.
export const CONFIRM_HTML = page("Unsubscribe", `<h1>Unsubscribe</h1>
<p>Stop emails from this business to this address?</p>
<form method="post">
<input type="hidden" name="List-Unsubscribe" value="One-Click">
<button type="submit">Unsubscribe</button>
</form>`);
export const DONE_HTML = page("Unsubscribed", `<h1>You are unsubscribed</h1>
<p>This business will send no more emails to this address.</p>`);

/**
 * `requestEdge` gives one request's dependencies, whose database work ends at that request's
 * deadline; `edge` serves what outlives a request, such as the limiter's clock.
 */
export function unsubscribeRoutes(
  edge: EdgeDependencies,
  config: UnsubscribeConfig,
  requestEdge: (c: Context<AppEnv>) => EdgeDependencies,
) {
  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, ...config.limits };
  const limiter = config.limiter ?? createMemoryRateLimiter(edge.clock);
  const clientAddress = createClientAddress(config.clientIp);

  /** Charge the address before any database work; the session answers 404 for a forged token. */
  const admit = (c: Context<AppEnv>, kind: "read" | "write") => {
    const socket = (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress;
    const bucket = addressBucket(clientAddress(socket, (name) => c.req.header(name)));
    const taken = limiter.take([kind === "write"
      ? { key: `unsubscribe-write:${bucket}`, rule: limits.addressWrites }
      : { key: `unsubscribe-read:${bucket}`, rule: limits.addressReads }]);
    if (!taken.ok) throw new RateLimited(taken.retryAfterSeconds);
    return createUnsubscribeSession(requestEdge(c), config.tokenSecrets);
  };

  return new Hono<AppEnv>()
    .use("/unsubscribe/*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .use("/unsubscribe/*", bodyLimit({
      maxSize: PUBLIC_BODY_LIMIT,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
    }))
    .get("/unsubscribe/:token", async (c) => {
      await admit(c, "read").check(c.req.param("token"));
      return c.html(CONFIRM_HTML, 200, PAGE_HEADERS);
    })
    // RFC 8058 sends `List-Unsubscribe=One-Click` (form-urlencoded or multipart); the page's form
    // sends the same. The token alone authorizes, so the body is read (for the size limit) but
    // not required. A repeat replays the stored action.
    .post("/unsubscribe/:token", async (c) => {
      const session = admit(c, "write");
      await c.req.arrayBuffer();
      await session.unsubscribe(c.req.param("token"));
      return c.html(DONE_HTML, 200, PAGE_HEADERS);
    });
}
