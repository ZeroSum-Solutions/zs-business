// The words and rules the Shopify card uses (connections.md C-5, C-11, C-13): which store address is
// accepted, what each return from Shopify says, what a refused confirm says, and the disconnect copy.
import { ApiError } from "../src/lib/api/errors";
import { describe, expect, it, vi } from "vitest";
import {
  CANCELLED_MESSAGE,
  CONFIRM_EXPIRED_MESSAGE,
  DisconnectPendingError,
  CONNECTED_MESSAGE,
  DISCONNECT_AGENTS,
  DISCONNECT_WHAT,
  GRANT_CHANGED_MESSAGE,
  RETURN_REASONS,
  REVOKE_FAILED_MESSAGE,
  SHOP_DOMAIN_HELP,
  STATUS_POLLS,
  STATUS_POLL_MS,
  forgetPending,
  pendingRemembered,
  pollConnectStatus,
  reconnectStore,
  reconnectPath,
  disconnectForNativeInstall,
  rememberPending,
  waitUntilDisconnected,
  cancelNotice,
  confirmErrorNotice,
  connectErrorMessage,
  currentConnections,
  needsReauthorize,
  parseShopDomain,
  reauthorizeMessage,
  returnNotice,
} from "../src/lib/managed-connections";
import { connectErrorReasonSchema } from "@zs/contracts";
import type { ManagedConnection, ManagedConnectOutcome } from "../src/lib/api";

const connection = (status: ManagedConnection["status"]): ManagedConnection => ({
  id: "b7d9f1a3-5c7e-4a9b-8d1f-000000000001", toolkit: "shopify", accountLabel: "Halden Rowe", accountDomain: "halden-rowe.myshopify.com", status,
  reauthorizeReason: status === "reauthorize" ? "auth_error" : null, revokeFailed: false, readBlocked: false, lastCheckedAt: "2026-11-06T12:00:00.000Z", createdAt: "2026-11-05T12:00:00.000Z",
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

describe("a cancel the server answered", () => {
  it("says nothing was connected, and adds the Shopify admin warning when the revoke failed", () => {
    expect(cancelNotice({ cancelled: true, revokeFailed: false })).toEqual({ tone: "info", message: CANCELLED_MESSAGE });
    const failed = cancelNotice({ cancelled: true, revokeFailed: true });
    expect(failed.tone).toBe("error");
    expect(failed.message).toContain(CANCELLED_MESSAGE);
    expect(failed.message).toContain(REVOKE_FAILED_MESSAGE);
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

  it("keeps a retired store in view while Shopify has not confirmed it removed the app (C-13)", () => {
    const failed = { ...connection("disconnected"), revokeFailed: true };
    expect(currentConnections([failed, connection("disconnected")])).toEqual([failed]);
  });

  it("drops that warning once the same store was connected again, since the newer row says what is true now", () => {
    const failed = { ...connection("disconnected"), revokeFailed: true };
    const later = (status: ManagedConnection["status"], id: string) =>
      ({ ...connection(status), id, createdAt: "2026-11-07T12:00:00.000Z" });
    const revoked = later("disconnected", "b7d9f1a3-5c7e-4a9b-8d1f-000000000002");
    expect(currentConnections([revoked, failed])).toEqual([]);
    const active = later("active", "b7d9f1a3-5c7e-4a9b-8d1f-000000000003");
    expect(currentConnections([active, failed])).toEqual([active]);
    const failedAgain = { ...revoked, revokeFailed: true };
    expect(currentConnections([failedAgain, failed])).toEqual([failedAgain]);
    const otherStore = { ...active, accountDomain: "other-shop.myshopify.com" };
    expect(currentConnections([otherStore, failed])).toEqual([otherStore, failed]);
    const older = { ...active, createdAt: "2026-11-04T12:00:00.000Z" };
    expect(currentConnections([failed, older])).toEqual([failed, older]);
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

describe("asking again while Shopify has not finished (C-5)", () => {
  const sleepLog = () => {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => { waits.push(ms); } };
  };

  it("asks at most five times, two seconds apart, spread over 2 to 10 s after the callback's own ask, then gives up", async () => {
    let clock = 0;
    const askedAt: number[] = [];
    const sleep = async (ms: number) => { clock += ms; };
    const check = vi.fn(async (): Promise<ManagedConnectOutcome> => { askedAt.push(clock); return { connection: "pending" }; });
    const result = await pollConnectStatus(check, { sleep });
    expect(result).toBe("timeout");
    expect(check).toHaveBeenCalledTimes(5);
    expect(STATUS_POLLS).toBe(5);
    expect(STATUS_POLL_MS).toBe(2_000);
    // The callback was the ask at 0 s; asking again at once would only repeat its answer.
    expect(askedAt).toEqual([2_000, 4_000, 6_000, 8_000, 10_000]);
  });

  it("stops at the first answer that is not pending", async () => {
    const { waits, sleep } = sleepLog();
    const answers: ManagedConnectOutcome[] = [{ connection: "pending" }, { connection: "pending" }, { connection: "confirm" }];
    const check = vi.fn(async () => answers.shift()!);
    expect(await pollConnectStatus(check, { sleep })).toEqual({ connection: "confirm" });
    expect(check).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([STATUS_POLL_MS, STATUS_POLL_MS, STATUS_POLL_MS]);
  });

  it("stops asking once the page says it is done with the answer", async () => {
    let stop = false;
    const check = vi.fn(async (): Promise<ManagedConnectOutcome> => ({ connection: "pending" }));
    let waited = 0;
    const result = await pollConnectStatus(check, { sleep: async () => { waited += 1; if (waited === 2) stop = true; }, stopped: () => stop });
    expect(result).toBe("stopped");
    expect(check).toHaveBeenCalledTimes(1);
    // Stopped during the very first wait: nothing is asked.
    stop = false;
    const early = vi.fn(async (): Promise<ManagedConnectOutcome> => ({ connection: "pending" }));
    expect(await pollConnectStatus(early, { sleep: async () => { stop = true; }, stopped: () => stop })).toBe("stopped");
    expect(early).not.toHaveBeenCalled();
  });

  it("lets a failed ask reach the caller", async () => {
    await expect(pollConnectStatus(async () => { throw new Error("down"); }, { sleep: async () => undefined })).rejects.toThrow("down");
  });
});

describe("a pending connect survives a reload", () => {
  const store = () => {
    const data = new Map<string, string>();
    return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
  };

  it("is remembered for the ten minutes the attempt lives, and forgotten when the connect settles", () => {
    const storage = store();
    expect(pendingRemembered(storage, 1_000)).toBe(false);
    rememberPending(storage, 1_000);
    expect(pendingRemembered(storage, 1_000 + 9 * 60_000)).toBe(true);
    expect(pendingRemembered(storage, 1_000 + 10 * 60_000)).toBe(false);
    forgetPending(storage);
    expect(pendingRemembered(storage, 1_000)).toBe(false);
  });

  it("ignores a value it did not write, and works without storage", () => {
    const storage = store();
    storage.setItem("zs-managed-pending", "soon");
    expect(pendingRemembered(storage, 1_000)).toBe(false);
    expect(() => { rememberPending(undefined, 1); forgetPending(undefined); }).not.toThrow();
    expect(pendingRemembered(undefined, 1)).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => { rememberPending(broken, 1); forgetPending(broken); }).not.toThrow();
    expect(pendingRemembered(broken, 1)).toBe(false);
  });
});

describe("reconnect waits for the old link to go (C-4, C-13)", () => {
  const row = (status: ManagedConnection["status"]) => connection(status);
  const instant = { sleep: async () => undefined, polls: 4, delayMs: 1 };

  it("reads the list until the store is disconnected, and starts the connect only then", async () => {
    const log: string[] = [];
    const reads = [[row("disconnecting")], [row("disconnecting")], [row("disconnected")]];
    const api = {
      disconnectManagedConnection: vi.fn(async () => { log.push("disconnect"); return row("disconnecting"); }),
      listManagedConnections: vi.fn(async () => { log.push(`list:${reads[0]![0]!.status}`); return reads.shift()!; }),
      startManagedConnect: vi.fn(async () => { log.push("start"); return { authorizeUrl: "https://connect.example/x" }; }),
    };
    const result = await reconnectStore(api, row("reauthorize"), "key-1", instant);
    expect(result).toEqual({ authorizeUrl: "https://connect.example/x" });
    expect(log).toEqual(["disconnect", "list:disconnecting", "list:disconnecting", "list:disconnected", "start"]);
    expect(api.disconnectManagedConnection).toHaveBeenCalledWith(row("reauthorize").id, { idempotencyKey: "key-1" });
    expect(api.startManagedConnect).toHaveBeenCalledWith("shopify", "halden-rowe.myshopify.com");
  });

  it("does not wait when the disconnect already answers disconnected", async () => {
    const api = {
      disconnectManagedConnection: vi.fn(async () => row("disconnected")),
      listManagedConnections: vi.fn(async () => []),
      startManagedConnect: vi.fn(async () => ({ authorizeUrl: "https://connect.example/x" })),
    };
    await reconnectStore(api, row("reauthorize"), "key-1", instant);
    expect(api.listManagedConnections).not.toHaveBeenCalled();
    expect(api.startManagedConnect).toHaveBeenCalledTimes(1);
  });

  it("never starts the connect when the old link is still going after the wait, and says so", async () => {
    const api = {
      disconnectManagedConnection: vi.fn(async () => row("disconnecting")),
      listManagedConnections: vi.fn(async () => [row("disconnecting")]),
      startManagedConnect: vi.fn(async () => ({ authorizeUrl: "https://connect.example/x" })),
    };
    await expect(reconnectStore(api, row("reauthorize"), "key-1", instant)).rejects.toBeInstanceOf(DisconnectPendingError);
    expect(api.listManagedConnections).toHaveBeenCalledTimes(4);
    expect(api.startManagedConnect).not.toHaveBeenCalled();
    expect(connectErrorMessage(new DisconnectPendingError())).toMatch(/still disconnecting/i);
  });

  it("does not start the connect when the disconnect itself fails, and counts a store gone from the list as disconnected", async () => {
    const failing = {
      disconnectManagedConnection: vi.fn(async () => { throw apiError(403, "Forbidden"); }),
      listManagedConnections: vi.fn(async () => []),
      startManagedConnect: vi.fn(async () => ({ authorizeUrl: "https://connect.example/x" })),
    };
    await expect(reconnectStore(failing, row("reauthorize"), "key-1", instant)).rejects.toMatchObject({ kind: "forbidden" });
    expect(failing.startManagedConnect).not.toHaveBeenCalled();
    await expect(waitUntilDisconnected(row("active").id, async () => [], instant)).resolves.toBeUndefined();
  });
});

describe("reconnect path (C-18)", () => {
  it("sends a legacy row to the native install under the native tier, and every other case to the path the worker allows", () => {
    expect(reconnectPath({ tier: "composio" }, true)).toBe("native_install");
    expect(reconnectPath({ tier: "native" }, true)).toBe("reopen");
    expect(reconnectPath({}, true)).toBe("reopen");
    expect(reconnectPath({ tier: "composio" }, false)).toBe("composio");
    expect(reconnectPath({}, false)).toBe("composio");
  });

  it("disconnects the legacy row and waits until it is gone before the link code is made", async () => {
    const calls: string[] = [];
    const api = {
      disconnectManagedConnection: async () => { calls.push("disconnect"); return connection("disconnecting"); },
      listManagedConnections: async () => { calls.push("list"); return [connection("disconnected")]; },
    };
    await disconnectForNativeInstall(api, { id: connection("active").id }, "key", { sleep: async () => undefined });
    expect(calls).toEqual(["disconnect", "list"]);
  });
});
