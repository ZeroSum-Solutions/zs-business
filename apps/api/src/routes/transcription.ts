import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { LEASE_TOKEN_HEADER, idempotencyKeySchema, listTranscriptionsQuerySchema, type TranscriptBody } from "@zs/contracts";
import { apiErrorBody, parseInput, type TranscriptionSession } from "@zs/core";
import { Unauthenticated } from "../auth.js";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// transcription.md X-1, X-4, X-7: the owner's routes under /v1/transcriptions (member auth, the
// inbox.drafts permission) and the worker's routes under /worker/v1/transcription (a bearer token
// of its own, checked here; the lease token on each later call names the job and so the tenant).
export interface TranscriptionApiConfig {
  /** The pilot Mac's bearer token, from the vault. At least 32 characters. */
  readonly workerToken: string;
}

export function transcriptionRoutes(sessionFor: (c: Context<AppEnv>) => TranscriptionSession) {
  const member = (c: Context<AppEnv>) => sessionFor(c).forMember(c.var.session.principal);
  const key = (c: Context<AppEnv>) => parseInput(idempotencyKeySchema, idempotencyKey(c), "Idempotency-Key");
  return new Hono<AppEnv>()
    .post("/uploads", async (c) => c.json(await member(c).createUpload(await jsonBody(c), key(c)), 201))
    .post("/", async (c) => c.json(await member(c).enqueue(await jsonBody(c), key(c)), 201))
    .get("/", async (c) => {
      const { limit } = parseInput(listTranscriptionsQuerySchema, c.req.query());
      return c.json({ items: await member(c).list(limit) });
    })
    .get("/:id", async (c) => c.json(await member(c).get(c.req.param("id"))));
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** The worker's bearer token, compared in constant time over fixed-length digests. */
export function workerAuth(config: TranscriptionApiConfig): MiddlewareHandler<AppEnv> {
  if (config.workerToken.length < 32) throw new Error("TRANSCRIPTION_WORKER_TOKEN must be at least 32 characters");
  const expected = digest(config.workerToken);
  return async (c, next) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
    if (!match || !timingSafeEqual(digest(match[1]!), expected)) throw new Unauthenticated();
    await next();
  };
}

/** Room for a 1500-segment transcript, with the shared JSON text limit on top. */
const WORKER_BODY_LIMIT = 2 * 1024 * 1024;

export function workerRoutes(sessionFor: (c: Context<AppEnv>) => TranscriptionSession) {
  const worker = (c: Context<AppEnv>) => sessionFor(c).worker;
  const lease = (c: Context<AppEnv>) => c.req.header(LEASE_TOKEN_HEADER) ?? "";
  const routes = new Hono<AppEnv>();
  routes.use("*", bodyLimit({
    maxSize: WORKER_BODY_LIMIT,
    onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
  }));
  return routes
    .post("/claim", async (c) => c.json({ job: await worker(c).claim() }))
    .get("/jobs/:id/audio", async (c) => {
      const audio = await worker(c).audio(c.req.param("id"), lease(c));
      return c.body(audio.body as ReadableStream<Uint8Array>, 200, {
        "Content-Type": audio.contentType,
        "Content-Length": String(audio.bytes),
        "Cache-Control": "no-store",
      });
    })
    .post("/jobs/:id/heartbeat", async (c) => c.json(await worker(c).heartbeat(c.req.param("id"), lease(c))))
    .post("/jobs/:id/complete", async (c) =>
      c.json(await worker(c).complete(c.req.param("id"), lease(c), (await jsonBody(c)) as TranscriptBody)))
    .post("/jobs/:id/fail", async (c) => c.json(await worker(c).fail(c.req.param("id"), lease(c), await jsonBody(c))));
}
