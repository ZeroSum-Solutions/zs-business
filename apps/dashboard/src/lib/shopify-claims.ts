/**
 * The owner's side of linking an installed Shopify store to this hub (docs/requirements/connections.md C-22): start a
 * claim and read the code once, wait for the store to enter it, then confirm. The calls go through the dashboard's
 * proxy with the owner's own session. Plain functions here; the card is components/account/shopify-claim.tsx.
 */
import { shopifyClaimStartResponseSchema, shopifyClaimStatusResponseSchema, type ShopifyClaimView } from "@zs/contracts";
import { z } from "zod";

const BASE = "/api/v1/shopify/claims";

/** The server has no native Shopify tier (404), or this person may not link a store (401, 403): the card stays away. */
export class ClaimsUnavailable extends Error {
  constructor(readonly status: number) {
    super("claims unavailable");
  }
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

async function send(method: "GET" | "POST" | "DELETE", path: string, signal?: AbortSignal): Promise<Answer> {
  const response = await fetch(path, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : {},
    ...(method === "POST" ? { body: "{}" } : {}),
    credentials: "same-origin",
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

const reasonOf = (body: unknown): string | null => {
  const parsed = z.object({ error: z.object({ details: z.object({ reason: z.string().max(64) }).partial().optional() }) }).safeParse(body);
  return parsed.success ? (parsed.data.error.details?.reason ?? null) : null;
};
const gone = (status: number) => status === 401 || status === 403 || status === 404;

export async function getClaim(signal?: AbortSignal): Promise<ShopifyClaimView | null> {
  const answer = await send("GET", `${BASE}/current`, signal);
  if (gone(answer.status)) throw new ClaimsUnavailable(answer.status);
  if (answer.status !== 200) throw new Error("claim status failed");
  return shopifyClaimStatusResponseSchema.parse(answer.body).claim;
}

export type StartResult = { kind: "started"; claimId: string; code: string; expiresAt: string } | { kind: "already_connected" };

export async function startClaim(): Promise<StartResult> {
  const answer = await send("POST", BASE);
  if (answer.status === 409) return { kind: "already_connected" };
  if (gone(answer.status)) throw new ClaimsUnavailable(answer.status);
  if (answer.status !== 201) throw new Error("claim start failed");
  const parsed = shopifyClaimStartResponseSchema.parse(answer.body);
  if (parsed.outcome !== "started") return { kind: "already_connected" };
  return { kind: "started", claimId: parsed.claimId, code: parsed.code, expiresAt: parsed.expiresAt };
}

export type ConfirmResult = { kind: "confirmed" } | { kind: "refused"; reason: string };

export async function confirmClaim(id: string): Promise<ConfirmResult> {
  const answer = await send("POST", `${BASE}/${id}/confirm`);
  if (answer.status === 200) return { kind: "confirmed" };
  if (answer.status === 404) return { kind: "refused", reason: "not_found" };
  if (answer.status === 409) return { kind: "refused", reason: reasonOf(answer.body) ?? "not_found" };
  throw new Error("claim confirm failed");
}

/** True when the claim is cancelled or already gone. */
export async function cancelClaim(id: string): Promise<void> {
  const answer = await send("DELETE", `${BASE}/${id}`);
  if (answer.status !== 200 && answer.status !== 404) throw new Error("claim cancel failed");
}

/** "ABCDEFGHJK" as "ABCDE FGHJK": easier to read aloud and to type. */
export function groupCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)} ${code.slice(5)}` : code;
}

/** What to tell the owner for each way a confirm can end without linking the store. */
export const CONFIRM_MESSAGES: Readonly<Record<string, string>> = {
  not_redeemed: "The store has not entered the code yet.",
  expired: "That code expired. Cancel it and start a new link.",
  install_gone: "The app is no longer installed on that store. Install it again, then start a new link.",
  store_in_use: "That store is already linked to another hub.",
  tenant_has_store: "This hub already has a Shopify store linked.",
  not_found: "That link is gone. Start a new one.",
  billing_conflict: "This hub bills through another plan, so the store could not be linked. Contact support.",
};

export const CLAIM_STARTED_MESSAGE =
  "Open ZS Business Connections in your Shopify admin, choose I already have a hub, and enter this code. It works once and expires in 15 minutes. We show it only now.";
export const CLAIM_LINKED_MESSAGE = "Shopify linked. Agents with a connections token can now read this store's orders.";
