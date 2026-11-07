// The words and rules the Shopify card uses (connections.md C-5, C-11, C-13): which store address is
// accepted, what each return from Shopify says, what a refused confirm says, and the disconnect copy.
import { ApiError } from "../src/lib/api/errors";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_EXPIRED_MESSAGE,
  CONNECTED_MESSAGE,
  DISCONNECT_AGENTS,
  DISCONNECT_WHAT,
  GRANT_CHANGED_MESSAGE,
  RETURN_REASONS,
  REVOKE_FAILED_MESSAGE,
  SHOP_DOMAIN_HELP,
  confirmErrorNotice,
  connectErrorMessage,
  currentConnections,
  needsReauthorize,
  parseShopDomain,
  reauthorizeMessage,
  returnNotice,
} from "../src/lib/managed-connections";
import { connectErrorReasonSchema } from "@zs/contracts";
import type { ManagedConnection } from "../src/lib/api";

const connection = (status: ManagedConnection["status"]): ManagedConnection => ({
  id: "b7d9f1a3-5c7e-4a9b-8d1f-000000000001", toolkit: "shopify", accountLabel: "Halden Rowe", accountDomain: "halden-rowe.myshopify.com", status,
  reauthorizeReason: status === "reauthorize" ? "auth_error" : null, revokeFailed: false, lastCheckedAt: "2026-11-06T12:00:00.000Z", createdAt: "2026-11-05T12:00:00.000Z",
});

const KINDS: Record<number, ConstructorParameters<typeof ApiError>[0]> = { 400: "validation", 403: "forbidden", 404: "not_found", 409: "conflict", 429: "rate_limited" };
const apiError = (status: number, code: string, details: Record<string, unknown> = {}) =>
  new ApiError(KINDS[status]!, `server said ${code}`, status, code, details);

describe("shop address", () => {
  it("accepts a .myshopify.com address however the owner typed it", () => {
    for (const typed of ["halden-rowe.myshopify.com", "  Halden-Rowe.MyShopify.com ", "https://halden-rowe.myshopify.com/admin?x=1", "halden-rowe", "http://halden-rowe.myshopify.com#top"]) {
      expect(parseShopDomain(typed), typed).toBe("halden-rowe.myshopify.com");
    }
  });

  it("refuses any other address, so a look-alike never reaches the server", () => {
    for (const typed of ["", "   ", "example.com", "halden-rowe.myshopify.com.evil.test", "evil.test/halden-rowe.myshopify.com", "-bad.myshopify.com", "a b.myshopify.com", "https://"]) {
      expect(parseShopDomain(typed), typed).toBeNull();
    }
  });
});

describe("return from Shopify", () => {
  it("says nothing for confirm and pending: the server's waiting grant and the status check speak instead", () => {
    expect(returnNotice("confirm", null)).toBeNull();
    expect(returnNotice("pending", null)).toBeNull();
    expect(returnNotice(null, null)).toBeNull();
    expect(returnNotice("surprise", null)).toBeNull();
  });

  it("confirms a connection", () => {
    expect(returnNotice("connected", null)).toEqual({ tone: "success", message: CONNECTED_MESSAGE });
  });

  it("has a plain sentence for every reason the callback can give, and for a lost server", () => {
    for (const reason of connectErrorReasonSchema.options) {
      const notice = returnNotice("error", reason);
      expect(notice?.tone, reason).toBe("error");
      expect(notice?.message, reason).toBe(RETURN_REASONS[reason]);
    }
    expect(returnNotice("error", "unavailable")?.message).toBe(RETURN_REASONS.unavailable);
  });

  it("does not echo a reason the address bar made up, nor read one from the prototype chain", () => {
    for (const reason of ["<script>", "constructor", "__proto__", "toString", null]) {
      const notice = returnNotice("error", reason);
      expect(notice?.message, String(reason)).toBe("Shopify could not be connected. Try again from this page.");
    }
  });
});

describe("a confirm the server refused", () => {
  it("says nothing for a lost answer, so the panel stays for a retry", () => {
    expect(confirmErrorNotice(new TypeError("network"))).toBeNull();
  });

  it("names a replaced grant, an expired one, a refusal and a connected store", () => {
    expect(confirmErrorNotice(apiError(409, "Conflict", { reason: "grant_changed" }))?.message).toBe(GRANT_CHANGED_MESSAGE);
    expect(confirmErrorNotice(apiError(404, "NotFound"))?.message).toBe(CONFIRM_EXPIRED_MESSAGE);
    expect(confirmErrorNotice(apiError(403, "Forbidden"))?.message).toBe(RETURN_REASONS.forbidden);
    expect(confirmErrorNotice(apiError(409, "Conflict", { reason: "already_connected" }))?.message).toBe("This store is already connected.");
    expect(confirmErrorNotice(apiError(409, "Conflict"))?.message).toBe(RETURN_REASONS.conflict);
  });

  it("explains a refused connect", () => {
    expect(connectErrorMessage(apiError(404, "NotFound"))).toBe("Shopify connections are not set up on this server yet.");
    expect(connectErrorMessage(apiError(403, "Forbidden"))).toBe("Only an owner can connect Shopify.");
    expect(connectErrorMessage(apiError(429, "RateLimited"))).toBe(RETURN_REASONS.rate_limited);
    expect(connectErrorMessage(apiError(409, "Conflict", { reason: "already_connected" }))).toBe("This store is already connected.");
    expect(connectErrorMessage(apiError(400, "ValidationError"))).toBe(SHOP_DOMAIN_HELP);
    expect(connectErrorMessage(new Error("x"))).toBe("Something went wrong. Try again.");
  });
});

describe("the list", () => {
  it("hides retired stores and flags the ones that need the owner", () => {
    const items = [connection("active"), connection("disconnected"), connection("disconnecting"), connection("reauthorize")];
    expect(currentConnections(items).map((item) => item.status)).toEqual(["active", "disconnecting", "reauthorize"]);
    expect(needsReauthorize(items)).toBe(true);
    expect(needsReauthorize([connection("active"), connection("disconnecting")])).toBe(false);
    expect(needsReauthorize([])).toBe(false);
    expect(needsReauthorize(undefined)).toBe(false);
  });

  it("tells the owner why a store needs them, and that agents are cut off until then", () => {
    expect(reauthorizeMessage("provider_status")).toContain("needs approval again");
    expect(reauthorizeMessage("auth_error")).toContain("no longer accepts");
    expect(reauthorizeMessage(null)).toContain("Shopify access ended");
    for (const reason of ["provider_status", "auth_error", null] as const) expect(reauthorizeMessage(reason)).toContain("Agents cannot read this store's orders");
  });
});

describe("disconnect wording (C-13)", () => {
  it("says it stops our access and asks Shopify to remove the app's access, and does not say Shopify is certain to have", () => {
    expect(DISCONNECT_WHAT).toBe("Disconnecting stops our access and asks Shopify to remove the app's access.");
    expect(DISCONNECT_AGENTS).toContain("Agents can no longer read");
    expect(DISCONNECT_WHAT).not.toMatch(/revoked|removed Shopify|guarantee/i);
  });

  it("sends the owner to the Shopify admin when Shopify did not confirm", () => {
    expect(REVOKE_FAILED_MESSAGE).toMatch(/did not confirm/);
    expect(REVOKE_FAILED_MESSAGE).toMatch(/Shopify admin/);
    expect(REVOKE_FAILED_MESSAGE).toMatch(/Settings, then Apps/);
  });
});
