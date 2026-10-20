import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiErrorBodySchema, walletSummarySchema } from "@zs/contracts";
import { creditWallet } from "@zs/core";
import { call, createApiHarness, NOW, signedInMember, type ApiHarness } from "./helpers.js";

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => h.close());

const wallet = (token: string) => call(h.app, "GET", "/v1/wallet", { token });
const EMPTY = { currency: "usd", balance: 0, reserved: 0, available: 0 };

describe("GET /v1/wallet (delivery.md D-4)", () => {
  it("shows an empty wallet to the owner of a tenant that was never credited", async () => {
    const response = await wallet(h.a.token);
    expect(response.status).toBe(200);
    expect(walletSummarySchema.parse(response.body)).toEqual(EMPTY);
  });

  it("shows the caller's own tenant after a credit and a hold", async () => {
    await h.fixture.service((tx) => creditWallet(tx, {
      tenantId: h.a.tenantId, ledgerId: randomUUID(), amount: 1500, idempotencyKey: `credit:${randomUUID()}`, now: new Date(NOW),
    }));
    expect(walletSummarySchema.parse((await wallet(h.a.token)).body)).toEqual({ currency: "usd", balance: 1500, reserved: 0, available: 1500 });
    // A held reservation as the delivery worker leaves it (D-5).
    await h.fixture.service((tx) => tx.query("UPDATE wallets SET reserved = 400 WHERE tenant_id=$1", [h.a.tenantId]));
    expect(walletSummarySchema.parse((await wallet(h.a.token)).body)).toEqual({ currency: "usd", balance: 1500, reserved: 400, available: 1100 });
    // Tenant B's owner still sees B's own empty wallet.
    expect(walletSummarySchema.parse((await wallet(h.b.token)).body)).toEqual(EMPTY);
  });

  it("refuses staff, who lack the billing permission, and anonymous callers", async () => {
    const staff = await signedInMember(h.database, h.fixture, h.a.tenantId, "staff");
    const refused = await wallet(staff.token);
    expect(refused.status).toBe(403);
    expect(apiErrorBodySchema.parse(refused.body).error.code).toBe("Forbidden");
    expect((await call(h.app, "GET", "/v1/wallet")).status).toBe(401);
  });
});
