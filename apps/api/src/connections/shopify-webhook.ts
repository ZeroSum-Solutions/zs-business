// POST /webhooks/shopify (docs/requirements/connections.md C-24): Shopify's mandatory compliance topics and
// `app/uninstalled`, on the workers project (it holds the client secret). Shopify signs the raw body with the app's
// client secret (X-Shopify-Hmac-SHA256); the worker checks that tag, that the signed body names the shop in the
// header, and applies the event once. The route reads at most 64 KiB, as bytes, before anything else. Answers: 200
// (handled or a duplicate), 401 (a bad tag), 500 (try again later; Shopify retries), 404 (the native tier is off).
// A body, a tag or a customer value never reaches a log.
import { Hono } from "hono";
import { apiErrorBody, type ShopifyNativeWorker } from "@zs/core";
import { readCapped } from "./internal.js";

const MAX_WEBHOOK_BYTES = 64 * 1024;
const READ_BUDGET_MS = 5_000;

export function shopifyWebhookRoutes(config: {
  readonly native: Pick<ShopifyNativeWorker, "webhook"> | null;
  readonly onError?: (error: unknown) => void;
  readonly readTimeoutMs?: number;
}) {
  const app = new Hono();
  app.post("/webhooks/shopify", async (c) => {
    const native = config.native;
    if (!native) return c.json(apiErrorBody("NotFound", "Route not found"), 404);
    c.header("Cache-Control", "no-store");
    const declared = Number(c.req.header("content-length"));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) return c.json(apiErrorBody("ValidationFailed", "Request too large"), 413);
    let rawBody: Uint8Array | null;
    try {
      rawBody = await readCapped(c.req.raw.body, MAX_WEBHOOK_BYTES, AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(config.readTimeoutMs ?? READ_BUDGET_MS)]));
    } catch {
      return c.json(apiErrorBody("ValidationFailed", "Invalid request body"), 400);
    }
    if (rawBody === null) return c.json(apiErrorBody("ValidationFailed", "Request too large"), 413);
    try {
      const out = await native.webhook({
        rawBody,
        hmac: c.req.header("x-shopify-hmac-sha256") ?? null,
        topic: c.req.header("x-shopify-topic") ?? null,
        shopDomain: c.req.header("x-shopify-shop-domain") ?? null,
        webhookId: c.req.header("x-shopify-webhook-id") ?? null,
      });
      return c.body(null, out.status);
    } catch (error) {
      config.onError?.(error);
      return c.body(null, 500);
    }
  });
  return app;
}
