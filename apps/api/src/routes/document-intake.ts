import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  INTAKE_FILENAME_HEADER,
  INTAKE_LEASE_HEADER,
  INTAKE_MAX_BYTES,
  idempotencyKeySchema,
  listIntakeJobsQuerySchema,
} from "@zs/contracts";
import { apiErrorBody, parseInput, type DocumentIntakeSession } from "@zs/core";
import { Unauthenticated } from "../auth.js";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

// document-intake.md DL-3, DL-5, DL-13: the owner's routes under /v1/document-intake (member auth,
// the `publish` permission, checked by the session) and the worker's routes under
// /v1/workers/document-intake (a bearer token of its own, checked here; the lease token on each later
// call names the job and so the tenant). The worker's routes are registered before the member auth.
export interface DocumentIntakeApiConfig {
  /** The Docling service's bearer token, from the vault. At least 32 characters. */
  readonly workerToken: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** The worker's bearer token, compared in constant time over fixed-length digests. */
export function intakeWorkerAuth(config: DocumentIntakeApiConfig): MiddlewareHandler<AppEnv> {
  if (config.workerToken.length < 32) throw new Error("DOCUMENT_INTAKE_WORKER_TOKEN must be at least 32 characters");
  const expected = digest(config.workerToken);
  return async (c, next) => {
    const match = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
    if (!match || !timingSafeEqual(digest(match[1]!), expected)) throw new Unauthenticated();
    await next();
  };
}

/** A 50-page price list can hold thousands of rows; DL-8 caps them at 5000 and each cell at 2000 characters. */
const WORKER_BODY_LIMIT = 8 * 1024 * 1024;

export function intakeWorkerRoutes(sessionFor: (c: Context<AppEnv>) => DocumentIntakeSession) {
  const worker = (c: Context<AppEnv>) => sessionFor(c).worker;
  const lease = (c: Context<AppEnv>) => c.req.header(INTAKE_LEASE_HEADER) ?? "";
  const routes = new Hono<AppEnv>();
  routes.use("*", bodyLimit({
    maxSize: WORKER_BODY_LIMIT,
    onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413),
  }));
  return routes
    .post("/claim", async (c) => c.json({ job: await worker(c).claim() }))
    .get("/jobs/:id/file", async (c) => {
      const bytes = await worker(c).file(c.req.param("id"), lease(c));
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      });
    })
    .post("/jobs/:id/result", async (c) => c.json(await worker(c).result(c.req.param("id"), lease(c), await jsonBody(c))))
    .post("/jobs/:id/fail", async (c) => c.json(await worker(c).fail(c.req.param("id"), lease(c), await jsonBody(c))));
}

/** A filename header may arrive percent-encoded; a bad escape is kept as sent and the schema judges it. */
function headerFilename(raw: string | undefined): string {
  const value = raw ?? "";
  try { return decodeURIComponent(value); } catch { return value; }
}

export function intakeMemberRoutes(sessionFor: (c: Context<AppEnv>) => DocumentIntakeSession) {
  const member = (c: Context<AppEnv>) => sessionFor(c).forMember(c.var.session.principal);
  const key = (c: Context<AppEnv>) => parseInput(idempotencyKeySchema, idempotencyKey(c), "Idempotency-Key");
  return new Hono<AppEnv>()
    // The raw PDF is the body: outside the 64 KiB JSON limit, inside its own 20 MiB one.
    .post("/uploads", bodyLimit({
      maxSize: INTAKE_MAX_BYTES + 1,
      onError: (c) => c.json(apiErrorBody("ValidationFailed", "The file is over 20 MiB", { reason: "file_too_large" }), 413),
    }), async (c) => {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      const done = await member(c).upload({
        bytes, filename: headerFilename(c.req.header(INTAKE_FILENAME_HEADER)), contentType: c.req.header("Content-Type"),
      }, key(c));
      return c.json(done, 201);
    })
    .get("/jobs", async (c) => {
      const { limit } = parseInput(listIntakeJobsQuerySchema, c.req.query());
      return c.json(await member(c).list(limit));
    })
    .get("/jobs/:id", async (c) => c.json(await member(c).get(c.req.param("id"))))
    .post("/jobs/:id/apply", async (c) => c.json(await member(c).proposeApply(c.req.param("id"), await jsonBody(c), idempotencyKey(c)), 201))
    .post("/jobs/:id/discard", async (c) => c.json(await member(c).discard(c.req.param("id"), idempotencyKey(c))));
}
