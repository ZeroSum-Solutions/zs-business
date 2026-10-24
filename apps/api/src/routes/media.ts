import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MEDIA_LIMITS } from "@zs/contracts";
import { apiErrorBody, type StoredImage } from "@zs/core";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// image-port.md IM-22: owners only (the "publish" permission). Every write goes through the core
// session and the dispatcher with the Idempotency-Key header; object keys come from the session's
// tenant, never from the path. Generating only queues: the worker reserves and calls (IM-7).

/** The one /v1 path whose body is raw image bytes, not JSON; app.ts keeps the 64 KiB limit off it. */
export const MEDIA_UPLOAD_PATH = "/v1/media/assets";

/** The media type without parameters; the session checks it against IM-3's list and the bytes. */
const mediaType = (c: Context) => (c.req.header("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();

/** IM-22: the bytes are private to the owner and never sniffed into another type. */
const content = (c: Context, image: StoredImage) => c.body(image.bytes as Uint8Array<ArrayBuffer>, 200, {
  "Content-Type": image.contentType,
  "Content-Length": String(image.bytes.byteLength),
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
});

export const mediaRoutes = new Hono<AppEnv>()
  .post("/assets", bodyLimit({
    maxSize: MEDIA_LIMITS.fileBytes,
    onError: (c) => c.json(apiErrorBody("ValidationFailed", "Image is too large"), 413),
  }), async (c) => {
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return c.json(await c.var.session.uploadMediaAsset(bytes, mediaType(c), idempotencyKey(c)), 201);
  })
  .get("/assets", async (c) => c.json(await c.var.session.listMediaAssets()))
  .get("/assets/:id/content", async (c) => content(c, await c.var.session.readMediaAssetContent(c.req.param("id"))))
  .post("/variants", async (c) => c.json(await c.var.session.generateImageVariant(await jsonBody(c), idempotencyKey(c)), 201))
  .get("/variants", async (c) => c.json(await c.var.session.listImageVariants()))
  .get("/variants/:id", async (c) => c.json(await c.var.session.getImageVariant(c.req.param("id"))))
  .get("/variants/:id/content", async (c) => content(c, await c.var.session.readImageVariantContent(c.req.param("id"))))
  .post("/variants/:id/approval", async (c) =>
    c.json(await c.var.session.requestImageVariantApproval(c.req.param("id"), await jsonBody(c), idempotencyKey(c)), 201))
  .post("/variants/:id/reject", async (c) =>
    c.json(await c.var.session.rejectImageVariant(c.req.param("id"), await jsonBody(c), idempotencyKey(c))));
