import { randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { apiErrorBodySchema } from "@zs/contracts";
import { createApp, createHs256Verifier } from "../src/app.js";
import { clock, SECRET } from "./helpers.js";

// No database: these routes never open a session.
const app = createApp({
  verifier: createHs256Verifier(SECRET, { clock }),
  clock,
  db: { tenant: () => Promise.reject(new Error("unused")) },
  generateId: randomUUID,
  config: { allowedOrigins: [] },
});
app.get("/test/http-exception/:status", (c) => {
  throw new HTTPException(Number(c.req.param("status")) as 400, { message: "From middleware" });
});

describe("HTTPException mapping", () => {
  it.each([
    [400, "ValidationFailed"], [401, "Unauthorized"], [403, "Forbidden"], [404, "NotFound"], [409, "Conflict"],
    [413, "ValidationFailed"], [429, "ValidationFailed"],
  ])("keeps status %i with code %s", async (status, code) => {
    const response = await app.request(`/test/http-exception/${status}`);
    expect(response.status).toBe(status);
    expect(apiErrorBodySchema.parse(await response.json()).error).toEqual({ code, message: "From middleware", details: {} });
    expect(response.headers.get("WWW-Authenticate")).toBe(status === 401 ? "Bearer" : null);
  });

  it("maps a 5xx HTTPException to a generic 500", async () => {
    const response = await app.request("/test/http-exception/503");
    expect(response.status).toBe(500);
    expect(apiErrorBodySchema.parse(await response.json()).error.code).toBe("Internal");
  });
});
