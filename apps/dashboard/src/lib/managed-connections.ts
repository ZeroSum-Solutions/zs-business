import { shopDomainSchema, type Permission } from "@zs/contracts";
import { isApiError, type CancelManagedConnectResult, type ManagedConnectionsApi, type ManagedConnectOutcome, type ManagedConnection } from "./api";
import { isDefinitive } from "./intent-key";
import type { ReturnNotice } from "./calendar-sync";

/**
 * Connecting, confirming and disconnecting a store gives agents a read of its orders, so the API asks for
 * the owner-only `integrations` permission on every one of these calls (connections.md C-4, C-13).
 */
export const MANAGE_MANAGED_CONNECTIONS: Permission = "integrations";

/** The store address the owner typed, as the API wants it, or null when it is not a `.myshopify.com` address. */
export function parseShopDomain(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (text === "") return null;
  text = text.replace(/^https?:\/\//, "");
  text = text.split(/[/?#]/, 1)[0] ?? "";
  // Just the store's name: "halden-rowe" is "halden-rowe.myshopify.com".
  if (!text.includes(".")) text = `${text}.myshopify.com`;
  const parsed = shopDomainSchema.safeParse(text);
  return parsed.success ? parsed.data : null;
}

export const SHOP_DOMAIN_HELP = "Enter your store's address, such as halden-rowe.myshopify.com.";
export const CONNECTED_MESSAGE = "Shopify connected. Agents with a connections token can now read this store's orders.";
export const CANCELLED_MESSAGE = "Nothing was connected.";
export const CONFIRM_EXPIRED_MESSAGE = "That connection request expired. Connect again.";
export const GRANT_CHANGED_MESSAGE = "Another store is now waiting here. Nothing was connected. Check the store below before you connect.";
export const PENDING_TIMEOUT_MESSAGE = "Shopify has not finished yet. Check again in a moment.";
export const STILL_WAITING_MESSAGE = "Waiting for Shopify to finish connecting.";
const UNKNOWN_RETURN = "Shopify could not be connected. Try again from this page.";
// Staff cannot connect, so "try again" is no use to them.
export const STAFF_ERROR = "Shopify was not connected. Ask an owner to connect it.";

/** Why the callback sent the owner back without a connection (C-5), in plain words. */
export const RETURN_REASONS: Readonly<Record<string, string>> = {
  invalid_attempt: "That connect link expired or is not valid. Try again from this page.",
  browser_mismatch: "Finish connecting in the same browser you started in. Try again from this page.",
  attempt_changed: "Another connect started in this browser while you were on Shopify. Nothing changed. Try again from this page.",
  forbidden: "Only an owner can connect Shopify. Nothing changed.",
  rate_limited: "Too many tries. Wait a few minutes, then connect again.",
  conflict: "This store changed while you were on Shopify. Check its status below, then connect again if you need to.",
  not_connected: "Shopify did not finish connecting. Nothing changed. Try again from this page.",
  expired: "That connect link expired. Try again from this page.",
  provider_unavailable: "We could not reach Shopify to finish connecting. Try again in a minute.",
  unavailable: "We could not reach the server to finish connecting. Try again in a minute.",
};

/**
 * What `?connection=connected` or `?connection=error&reason=...` on the return URL means; null for
 * `confirm` and `pending`, which say nothing by themselves: the waiting grant, read from the server, is
 * what the page asks the owner to confirm, and a pending connect is asked about again.
 */
export function returnNotice(outcome: string | null, reason: string | null): ReturnNotice | null {
  if (outcome === "connected") return { tone: "success", message: CONNECTED_MESSAGE };
  // Own keys only: the reason comes from the address bar.
  if (outcome === "error") return { tone: "error", message: reason !== null && Object.hasOwn(RETURN_REASONS, reason) ? RETURN_REASONS[reason]! : UNKNOWN_RETURN };
  return null;
}

/** How many times the page asks about a pending connect, and how long it waits between asks (C-5). */
export const STATUS_POLLS = 5;
export const STATUS_POLL_MS = 2_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PollOptions {
  /** True once the page no longer wants the answer (it left, or settled otherwise). */
  stopped?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  polls?: number;
  delayMs?: number;
}

/**
 * Asks how a pending connect ended: STATUS_POLLS times, each after a STATUS_POLL_MS wait (C-5). The callback
 * was the ask at 0 s, so asking again at once would only repeat it; the asks land at 2, 4, 6, 8 and 10 s.
 * One call is one budget, so the page's rerenders cannot give it more. Resolves with the first answer that is
 * not "pending", "timeout" when every ask said pending, or "stopped". A failed ask rejects.
 */
export async function pollConnectStatus(
  check: () => Promise<ManagedConnectOutcome>,
  { stopped = () => false, sleep = defaultSleep, polls = STATUS_POLLS, delayMs = STATUS_POLL_MS }: PollOptions = {},
): Promise<ManagedConnectOutcome | "timeout" | "stopped"> {
  for (let asked = 0; asked < polls; asked += 1) {
    await sleep(delayMs);
    if (stopped()) return "stopped";
    const outcome = await check();
    if (stopped()) return "stopped";
    if (outcome.connection !== "pending") return outcome;
  }
  return "timeout";
}

/** The page's own memory of "Shopify has not finished", so a reload keeps asking (C-5). It lasts as long as an attempt. */
const PENDING_KEY = "zs-managed-pending";
const PENDING_REMEMBER_MS = 10 * 60_000;
type PendingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** This tab's storage, or undefined where the browser blocks it. */
export function pendingStorage(): PendingStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function rememberPending(storage: PendingStorage | undefined, now: number): void {
  try {
    storage?.setItem(PENDING_KEY, String(now + PENDING_REMEMBER_MS));
  } catch {
    // Without storage a reload simply does not resume the wait.
  }
}

export function pendingRemembered(storage: PendingStorage | undefined, now: number): boolean {
  try {
    const until = Number(storage?.getItem(PENDING_KEY));
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
}

export function forgetPending(storage: PendingStorage | undefined): void {
  try {
    storage?.removeItem(PENDING_KEY);
  } catch {
    // See rememberPending.
  }
}

/** How long Reconnect waits for the old link to go before it stops and says so. */
export const RECONNECT_POLLS = 15;
export const RECONNECT_POLL_MS = 2_000;
export const RECONNECT_STILL_DISCONNECTING = "This store is still disconnecting. Wait until it shows Disconnected, then connect it again.";

/** The old link did not finish going away in time; nothing was connected. */
export class DisconnectPendingError extends Error {
  constructor() {
    super(RECONNECT_STILL_DISCONNECTING);
    this.name = "DisconnectPendingError";
  }
}

/**
 * Reads the list until the connection is `disconnected` (or no longer listed). The API refuses a connect with
 * `already_connected` while the old row is still `disconnecting` (C-4), so Reconnect cannot start before this ends.
 */
export async function waitUntilDisconnected(
  connectionId: string,
  read: () => Promise<readonly ManagedConnection[]>,
  { sleep = defaultSleep, polls = RECONNECT_POLLS, delayMs = RECONNECT_POLL_MS }: Pick<PollOptions, "sleep" | "polls" | "delayMs"> = {},
): Promise<void> {
  for (let asked = 0; asked < polls; asked += 1) {
    if (asked > 0) await sleep(delayMs);
    const row = (await read()).find((item) => item.id === connectionId);
    if (row === undefined || row.status === "disconnected") return;
  }
  throw new DisconnectPendingError();
}

/** Reconnect is a disconnect, then a connect to the same store, once the disconnect has finished (C-13). */
export async function reconnectStore(
  api: Pick<ManagedConnectionsApi, "disconnectManagedConnection" | "listManagedConnections" | "startManagedConnect">,
  connection: Pick<ManagedConnection, "id" | "toolkit" | "accountDomain">,
  idempotencyKey: string,
  wait: Pick<PollOptions, "sleep" | "polls" | "delayMs"> = {},
): Promise<{ authorizeUrl: string }> {
  const result = await api.disconnectManagedConnection(connection.id, { idempotencyKey });
  if (result.status !== "disconnected") await waitUntilDisconnected(connection.id, () => api.listManagedConnections(), wait);
  return api.startManagedConnect(connection.toolkit, connection.accountDomain);
}

/** A grant is gone for good (404), replaced (409 grant_changed), refused (409, 403): what each says. Null for a lost answer. */
export const isGrantChanged = (error: unknown) => isApiError(error, "conflict") && error.reason === "grant_changed";

export function confirmErrorNotice(error: unknown): ReturnNotice | null {
  if (!isDefinitive(error)) return null;
  const message = isGrantChanged(error) ? GRANT_CHANGED_MESSAGE
    : isApiError(error, "not_found") ? CONFIRM_EXPIRED_MESSAGE
    : isApiError(error, "conflict") ? (error.reason === "already_connected" ? "This store is already connected." : RETURN_REASONS.conflict!)
    : isApiError(error, "forbidden") ? RETURN_REASONS.forbidden!
    : isApiError(error) ? error.message : UNKNOWN_RETURN;
  return { tone: "error", message };
}

/** A connect the server refused before Shopify. */
export function connectErrorMessage(error: unknown): string {
  if (error instanceof DisconnectPendingError) return error.message;
  if (isApiError(error, "not_found")) return "Shopify connections are not set up on this server yet.";
  if (isApiError(error, "forbidden")) return "Only an owner can connect Shopify.";
  if (isApiError(error, "rate_limited")) return RETURN_REASONS.rate_limited!;
  if (isApiError(error, "conflict")) return error.reason === "already_connected" ? "This store is already connected." : RETURN_REASONS.conflict!;
  if (isApiError(error, "validation")) return SHOP_DOMAIN_HELP;
  return isApiError(error) ? error.message : "Something went wrong. Try again.";
}

/**
 * The connections the card shows: connected, needing the owner, or being removed. Retired ones are history,
 * except one whose revoke Shopify did not confirm: the app may still be installed there, so the owner keeps
 * seeing it, with the warning to remove it in Shopify admin (C-13). A newer connection of the same store
 * replaces that warning: connecting again installed the app under the new grant, and that row says what is
 * true now (a later disconnect that Shopify confirmed removed the app).
 */
export const currentConnections = (items: readonly ManagedConnection[]): ManagedConnection[] =>
  items.filter((item) => item.status !== "disconnected" || (item.revokeFailed && !hasNewerConnection(items, item)));

// A live row stamped in the same millisecond counts as newer too (a reconnect under a fixed clock):
// two rows cannot both be the later grant, and the live one says what is true now.
const hasNewerConnection = (items: readonly ManagedConnection[], item: ManagedConnection): boolean =>
  items.some((other) => {
    if (other.id === item.id || other.toolkit !== item.toolkit || other.accountDomain !== item.accountDomain) return false;
    const [mine, theirs] = [Date.parse(item.createdAt), Date.parse(other.createdAt)];
    return theirs > mine || (theirs === mine && other.status !== "disconnected");
  });

/** Whether any connection waits for the owner to connect it again (C-8). */
export const needsReauthorize = (items: readonly ManagedConnection[] | undefined): boolean =>
  items?.some((item) => item.status === "reauthorize") ?? false;

/** The line on Home while a connection needs the owner (C-13). */
export const REAUTHORIZE_HOME_LINE = "A connected store needs you to reconnect it. Agents cannot read its orders until you do.";

export const DISCONNECT_TITLE = "Disconnect Shopify?";
/** C-13: what a disconnect does, no more and no less. */
export const DISCONNECT_WHAT = "Disconnecting stops our access and asks Shopify to remove the app's access.";
export const DISCONNECT_AGENTS = "Agents can no longer read this store's orders.";
/** C-13: a revoke Shopify did not confirm leaves the app installed there. */
export const REVOKE_FAILED_MESSAGE = "Shopify did not confirm it removed the app's access. In your Shopify admin, open Settings, then Apps, and remove the app to end its access.";

/**
 * C-8, C-10: the store's app permissions block the reads (Shopify's protected customer data approval is the
 * known cause). The connection itself is fine: reconnecting does not fix it, so the row keeps no Reconnect for it.
 */
export const READ_BLOCKED_MESSAGE = "Shopify is blocking agents from reading this store's orders because the app's permissions in the store do not allow it. Reconnecting will not fix this: the store's app permissions need to change.";

/** What a cancel the server answered says: nothing connected, and the same warning as a disconnect when the revoke failed (C-5). */
export function cancelNotice(result: CancelManagedConnectResult): ReturnNotice {
  return result.revokeFailed
    ? { tone: "error", message: `${CANCELLED_MESSAGE} ${REVOKE_FAILED_MESSAGE}` }
    : { tone: "info", message: CANCELLED_MESSAGE };
}

export const REAUTHORIZE_MESSAGES = {
  provider_status: "Shopify says the connection needs approval again.",
  auth_error: "Shopify no longer accepts the saved access.",
} as const;

export function reauthorizeMessage(reason: ManagedConnection["reauthorizeReason"]): string {
  const detail = reason !== null ? REAUTHORIZE_MESSAGES[reason] : "Shopify access ended.";
  return `${detail} Agents cannot read this store's orders until you reconnect or disconnect it.`;
}

export const RECONNECT_TITLE = "Reconnect Shopify?";
export const RECONNECT_WHAT = "Reconnect disconnects the current link first, then sends you to Shopify to approve the app again.";
