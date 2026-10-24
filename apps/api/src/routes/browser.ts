import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { BROWSER_LIMITS, TenantDenied, browserEventInputSchema, browserFinishInputSchema } from "@zs/contracts";
import {
  apiErrorBody, createBrowserSession, validationError,
  type BrowserArtifactStore, type BrowserConfig, type BrowserRunnerService, type Lease,
} from "@zs/core";
import type { AppEnv } from "../app.js";
import { idempotencyKey, jsonBody } from "./request.js";

/**
 * Website tasks (browser-tasks.md): the owner's side. `config` is the dispatcher config and
 * `artifacts` the store the runner's files live in. Absent from the app, these routes are off (404).
 */
export interface BrowserApiConfig {
  readonly config: BrowserConfig;
  readonly artifacts: BrowserArtifactStore;
  /** The runner's side (BT-7): its token and the service-role service. Absent means `/browser-runner/v1` is off. */
  readonly runner?: { readonly token: string; readonly service: BrowserRunnerService };
}

// BT-3, BT-9, BT-12: status, settings, switches, targets, runs and the files of a run. Reads, the
// kill and run requests follow the dispatcher's permissions (agents; the kill needs inbox.drafts).
export function browserRoutes(browser: BrowserApiConfig, sessionFor: (c: Context<AppEnv>) => ReturnType<typeof createBrowserSession>) {
  void browser;
  return new Hono<AppEnv>()
    .get("/", async (c) => c.json(await sessionFor(c).getStatus()))
    .put("/settings", async (c) => c.json(await sessionFor(c).updateSettings(await jsonBody(c), idempotencyKey(c))))
    .post("/kill", async (c) => c.json(await sessionFor(c).kill(await jsonBody(c), idempotencyKey(c))))
    .post("/resume", async (c) => c.json(await sessionFor(c).resume(await jsonBody(c), idempotencyKey(c))))
    .post("/targets", async (c) => c.json(await sessionFor(c).saveTarget(await jsonBody(c), idempotencyKey(c)), 201))
    .post("/runs", async (c) => c.json(await sessionFor(c).requestRun(await jsonBody(c), idempotencyKey(c)), 201))
    .get("/runs", async (c) => c.json(await sessionFor(c).listRuns()))
    .get("/runs/:id", async (c) => c.json(await sessionFor(c).getRun(c.req.param("id"))))
    .get("/runs/:id/artifacts/:artifactId", async (c) => {
      const file = await sessionFor(c).getArtifact(c.req.param("id"), c.req.param("artifactId"));
      // Never rendered by the browser: a download with a fixed type, never a name taken from the supplier.
      return new Response(new Blob([new Uint8Array(file.bytes).buffer as ArrayBuffer], { type: file.contentType }), {
        headers: {
          "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${file.name}"`,
          "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store",
        },
      });
    });
}

const digest = (value: string) => createHash("sha256").update(value).digest();

// BT-7: the runner's job interface. Five calls, one bearer token for the runner and one lease
// token per run; the tenant, target and profile come from the run's row, never from a payload.
export function browserRunnerRoutes(runner: NonNullable<BrowserApiConfig["runner"]>) {
  const expected = digest(runner.token);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const match = /^Bearer ([A-Za-z0-9_\-.]+)$/.exec(c.req.header("Authorization") ?? "");
    if (!match || !timingSafeEqual(digest(match[1]!), expected)) {
      return c.json(apiErrorBody("Unauthorized", "Invalid or missing access token"), 401, { "WWW-Authenticate": "Bearer" });
    }
    await next();
  });
  const leaseOf = (c: Context): Lease => {
    const token = c.req.header("Lease-Token");
    if (!token) throw new TenantDenied();
    return { runId: c.req.param("id") ?? "", token };
  };
  return app
    .post("/claim", async (c) => c.json({ claim: await runner.service.claim() }))
    .post("/runs/:id/control", async (c) => c.json(await runner.service.control(leaseOf(c))))
    .post("/runs/:id/events", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json(apiErrorBody("ValidationFailed", "Request body is too large"), 413) }),
      async (c) => {
        const parsed = browserEventInputSchema.safeParse(await jsonBody(c));
        if (!parsed.success) throw validationError("Invalid request", parsed.error.issues);
        return c.json(await runner.service.appendEvent(leaseOf(c), parsed.data), 201);
      })
    .post("/runs/:id/artifacts", bodyLimit({ maxSize: BROWSER_LIMITS.maxPdfBytes + 1024, onError: (c) => c.json(apiErrorBody("ValidationFailed", "File is too large"), 413) }),
      async (c) => {
        const kind = c.req.query("kind");
        if (kind !== "invoice_pdf" && kind !== "screenshot") throw validationError("Invalid request", [{ path: ["kind"], message: "Unknown kind" }]);
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        return c.json(await runner.service.putArtifact(leaseOf(c), { kind, name: c.req.query("name") ?? "", bytes }), 201);
      })
    .post("/runs/:id/finish", async (c) => {
      const parsed = browserFinishInputSchema.safeParse(await jsonBody(c));
      if (!parsed.success) throw validationError("Invalid request", parsed.error.issues);
      return c.json(await runner.service.finish(leaseOf(c), parsed.data));
    });
}
