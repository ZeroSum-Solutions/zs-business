// public-intake.md P-2..P-11: anonymous booking routes. They never see an owner token; the
// tenant and page come only from the signed key in the path, and the session builds the
// principal itself. Everything here stays independent of the owner auth middleware.
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { NotFound, ValidationFailed } from "@zs/contracts";
import { apiErrorBody, createPublicSession, verifyBookingKey, type BookingKeySecrets, type EdgeDependencies } from "@zs/core";
import { jsonBody } from "../routes/request.js";
import { createMemoryRateLimiter, DEFAULT_RATE_LIMITS, type RateLimiter, type RateLimits } from "./limiter.js";
import { bookerAssets } from "./assets.js";

/** P-10: an injected bot check; the default accepts every request. */
export type BotCheck = (input: { token: string | null; address: string }) => Promise<boolean>;
export const allowAllBots: BotCheck = async () => true;

export interface PublicIntakeConfig {
  readonly keySecrets: BookingKeySecrets;
  /** Origin the booking page and embed snippets point at, for example https://book.example.com. */
  readonly publicBaseUrl: string;
  /** Trust the right-most X-Forwarded-For entry; only behind a proxy that sets it. */
  readonly trustProxy?: boolean;
  readonly limits?: Partial<RateLimits>;
  /** Defaults to an in-memory limiter on the app clock. */
  readonly limiter?: RateLimiter;
  readonly botCheck?: BotCheck;
}

export const PUBLIC_BODY_LIMIT = 8 * 1024;

interface NodeBindings {
  incoming?: { socket?: { remoteAddress?: string } };
}

/** P-10: the socket address, or the right-most forwarded entry when a trusted proxy sets it. */
export function clientAddress(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = (c.req.header("X-Forwarded-For") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
    const last = forwarded.at(-1);
    if (last) return last;
  }
  return (c.env as NodeBindings | undefined)?.incoming?.socket?.remoteAddress ?? "unknown";
}

export class RateLimited extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super("Too many requests");
  }
}

export function publicRoutes(edge: EdgeDependencies, config: PublicIntakeConfig) {
  const limits: RateLimits = { ...DEFAULT_RATE_LIMITS, ...config.limits };
  const limiter = config.limiter ?? createMemoryRateLimiter(edge.clock);
  const botCheck = config.botCheck ?? allowAllBots;
  const trustProxy = config.trustProxy ?? false;

  /** Charge the address (and, for a valid key, the tenant) before any database work. */
  const admit = (c: Context, kind: "read" | "write") => {
    const address = clientAddress(c, trustProxy);
    const ref = verifyBookingKey(config.keySecrets, c.req.param("key") ?? "");
    const charges = [kind === "write"
      ? { key: `address-write:${address}`, rule: limits.addressWrites }
      : { key: `address-read:${address}`, rule: limits.addressReads }];
    if (ref && kind === "write") charges.push({ key: `tenant-write:${ref.tenantId}`, rule: limits.tenantWrites });
    const taken = limiter.take(charges);
    if (!taken.ok) throw new RateLimited(taken.retryAfterSeconds);
    // P-4: a forged key looks exactly like an unpublished page.
    if (!ref) throw new NotFound();
    return { address, session: createPublicSession(edge, ref) };
  };

  const api = new Hono()
    .use("*", async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    })
    .use("*", bodyLimit({
      maxSize: PUBLIC_BODY_LIMIT,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
    }))
    .get("/pages/:key", async (c) => c.json(await admit(c, "read").session.getPage()))
    .get("/pages/:key/slots", async (c) => c.json(await admit(c, "read").session.findSlots(c.req.query())))
    .post("/pages/:key/requests", async (c) => {
      const { address, session } = admit(c, "write");
      const body = await jsonBody(c);
      const token = typeof body === "object" && body !== null && "botToken" in body && typeof body.botToken === "string"
        ? body.botToken : null;
      if (!(await botCheck({ token, address }))) throw new ValidationFailed("Bot check failed");
      return c.json(await session.request(body, c.req.header("Idempotency-Key")), 201);
    });

  const assets = bookerAssets();
  const site = new Hono()
    .get("/book/:key", (c) => {
      // The page is the same for every key: the script reads the key from its own URL.
      if (!verifyBookingKey(config.keySecrets, c.req.param("key"))) return c.html(assets.missingHtml, 404, assets.pageHeaders);
      return c.html(assets.pageHtml, 200, assets.pageHeaders);
    })
    .get("/booker.js", (c) => c.body(assets.bookerJs, 200, assets.scriptHeaders))
    .get("/booker.css", (c) => c.body(assets.bookerCss, 200, assets.styleHeaders))
    .get("/embed.js", (c) => c.body(assets.embedJs, 200, assets.scriptHeaders));

  return { api, site };
}
