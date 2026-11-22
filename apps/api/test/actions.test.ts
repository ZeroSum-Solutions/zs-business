// Backlog B05: GET /v1/actions and GET /v1/actions/:id over HTTP. Owners only, one tenant's rows,
// no address or body in the response.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actionLogEntrySchema, actionLogPageSchema, apiErrorBodySchema } from "@zs/contracts";
import { call, signedInMember, createApiHarness, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

const EMAIL = "linnea.halden@haldenrowe.example";

describe("GET /v1/actions", () => {
  it("lists the owner's own tenant's actions, redacted, and opens one receipt", async () => {
    const created = await call(h.app, "POST", "/v1/crm/contacts", { token: h.a.token, key: randomUUID(), body: { displayName: "Linnea Halden", email: EMAIL } });
    expect(created.status).toBe(201);
    const list = await call(h.app, "GET", "/v1/actions?limit=10", { token: h.a.token });
    expect(list.status).toBe(200);
    const page = actionLogPageSchema.parse(list.body);
    expect(page.items[0]).toMatchObject({ actor: { kind: "person", memberId: h.a.memberId, role: "owner" }, target: { type: "contact" } });
    expect(JSON.stringify(list.body)).not.toContain(EMAIL);
    expect(JSON.stringify(list.body)).not.toContain("Linnea");

    const receipt = await call(h.app, "GET", `/v1/actions/${page.items[0]!.id}`, { token: h.a.token });
    expect(receipt.status).toBe(200);
    expect(actionLogEntrySchema.parse(receipt.body)).toEqual(page.items[0]);

    // Tenant B's owner sees none of it, and cannot open A's receipt.
    const other = actionLogPageSchema.parse((await call(h.app, "GET", "/v1/actions", { token: h.b.token })).body);
    expect(other.items.some((item) => item.id === page.items[0]!.id)).toBe(false);
    expect((await call(h.app, "GET", `/v1/actions/${page.items[0]!.id}`, { token: h.b.token })).status).toBe(404);
  });

  it("refuses staff with 403", async () => {
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    for (const path of ["/v1/actions", "/v1/actions?limit=9999", `/v1/actions/${randomUUID()}`]) {
      const response = await call(h.app, "GET", path, { token: staff.token });
      expect(response.status).toBe(403);
      expect(apiErrorBodySchema.parse(response.body).error.code).toBe("Forbidden");
    }
  });
});
