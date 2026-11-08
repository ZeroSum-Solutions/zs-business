// Connections C-21, C-22, C-23, C-24: the native Shopify tier. The worker holds the client secret and the token
// seal key; the API and the dashboard hold neither. Rules this file keeps:
//   - A request is authenticated by the Shopify ID token alone (C-21); the token is not a one-action credential.
//   - Every exchange and refresh for one store takes the `shopify_locks` lease (S2: never both at once). No
//     transaction or pool client is held across a Shopify call, so the worker runs on a pool of one.
//   - A token write is conditional on the install `generation` read under the lease, so a write in flight
//     when an uninstall ran changes nothing.
//   - Nothing in a log, report or error carries a token, an ID token, a code or a customer value.
import { createHmac, randomInt } from "node:crypto";
import {
  Conflict, PLAN_CATALOG, SHOPIFY_RECENT_ORDERS_DAYS, SHOPIFY_RECENT_ORDERS_FETCHED, SHOPIFY_RECENT_ORDERS_SHOWN,
  normalizeAccountLabel, type HubPlan, type ShopifyOrdersResponse, type ShopifyRecentOrder,
} from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { setShopifyBilling } from "../billing/shopify-plans.js";
import { shopifyListWindow } from "../connections/catalog.js";
import { verifyIdToken, SHOP_DOMAIN } from "./id-token.js";
import { getOrderQuery, listOrdersQuery, listOrdersSearch, orderToRest } from "./orders.js";
import { openToken, sealToken, SealError, type SealKeys } from "./seal.js";
import { redactStoreIdentity } from "./redact.js";
import { verifyWebhookHmac } from "./webhook.js";
import type { ShopifyClient, ShopifyFailure, ShopifyTokens } from "./client.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A store's lease outlives one exchange (client timeout 6 s) and its writes. */
const LOCK_MS = 30 * SECOND;
/** An access token with less time than this left is refreshed before use. */
const REFRESH_AHEAD_MS = 5 * MINUTE;
/** The cron pass refreshes an install whose refresh token has less than this left (the limit is 90 days). */
const PASS_REFRESH_BELOW_MS = 30 * DAY;
const CLAIM_LIFETIME_MS = 15 * MINUTE;
const CLAIM_MAX_WRONG = 5;
const CLAIM_LOCK_MS = HOUR;
const EVENT_KEEP_MS = 30 * DAY;
const MAX_WEBHOOK_BYTES = 256 * 1024;
/** Shopify wants a webhook answered within 5 s (verify-deliveries); the probe gets less, and a slow one answers 500 so Shopify retries. */
const WEBHOOK_PROBE_MS = 3500;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const SHOP_GID_RE = /^gid:\/\/shopify\/Shop\/([0-9]{1,20})$/;

export interface ShopifyNativeConfig {
  readonly clientId: string;
  readonly secrets: { readonly current: string; readonly previous?: string };
  readonly sealKeys: SealKeys;
  /** PL-8 grace days handed to setShopifyBilling. */
  readonly graceDays: number;
}

/** What the worker needs from the API's Supabase Auth and tenant code (apps/api), injected so core stays free of it. */
export interface HubPort {
  /** Idempotent by key and email: creates the user, the tenant and the owner member, or finds them. */
  createHub(input: { key: string; name: string; ownerEmail: string }): Promise<{ kind: "ok"; tenantId: string } | { kind: "email_has_hub" } | { kind: "failed" }>;
  /** A one-time sign-in link for a hub user, nothing emailed; null when none can be made. */
  signInLink(email: string): Promise<string | null>;
}

export type ShopifyNativeReport =
  | { readonly kind: "exchanged"; readonly shop: string; readonly generation: number }
  | { readonly kind: "refreshed"; readonly shop: string }
  | { readonly kind: "needs_reauth"; readonly shop: string }
  | { readonly kind: "non_expiring_refused"; readonly shop: string }
  | { readonly kind: "bound"; readonly tenantId: string; readonly shop: string; readonly via: "create_hub" | "claim" | "relink" }
  | { readonly kind: "uninstalled"; readonly shop: string }
  | { readonly kind: "delayed_uninstall_dropped"; readonly shop: string }
  | { readonly kind: "redacted"; readonly shop: string }
  | { readonly kind: "redact_skipped_reinstall"; readonly shop: string }
  | { readonly kind: "webhook"; readonly topic: string; readonly shop: string; readonly status: number }
  | { readonly kind: "claim_locked"; readonly shop: string }
  | { readonly kind: "hub_failed"; readonly shop: string };

export interface ShopifyNativeDeps {
  readonly service: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
  readonly client: ShopifyClient;
  readonly clock: { now(): Date };
  readonly config: ShopifyNativeConfig;
  readonly hub: HubPort;
  readonly report?: (event: ShopifyNativeReport) => void;
  /** Injected so core holds no ambient randomness; production passes crypto.randomUUID. */
  readonly newId: () => string;
  readonly randomCode?: () => string;
}

type Locked<T> = { readonly kind: "busy" } | { readonly kind: "done"; readonly value: T };

interface InstallRow {
  shop_id: string;
  shop_domain: string;
  shop_name: string;
  scopes: string;
  status: "live" | "needs_reauth" | "uninstalled";
  access_sealed: string | null;
  access_key_id: string | null;
  refresh_sealed: string | null;
  refresh_key_id: string | null;
  access_expires_at: Date | null;
  refresh_expires_at: Date | null;
  claim_failures: number;
  claim_locked_until: Date | null;
  generation: string | number;
  created_at: Date;
}
const INSTALL_COLUMNS = "shop_id, shop_domain, shop_name, scopes, status, access_sealed, access_key_id, refresh_sealed, refresh_key_id, access_expires_at, refresh_expires_at, claim_failures, claim_locked_until, generation, created_at";

export interface NativeConnectionRow {
  readonly tenant_id: string;
  readonly id: string;
  readonly external_account_id: string;
  readonly account_domain: string;
  readonly status: string;
  readonly last_error_code: string | null;
  readonly revoke_outcome: "revoked" | "failed" | null;
}

export type ShopLink =
  | { readonly state: "none" }
  | { readonly state: "linked"; readonly businessName: string; readonly connection: "active" | "reauthorize" };

export type ShopPlan = { readonly state: "none" } | { readonly state: "active" | "trial"; readonly name: string };
export type OpenResult =
  | { readonly outcome: "ok"; readonly shop: { readonly domain: string; readonly name: string }; readonly plan: ShopPlan; readonly link: ShopLink }
  | { readonly outcome: "invalid_token" | "unavailable" | "busy" | "not_supported" };
export type OrdersResult = ShopifyOrdersResponse;
export type CreateHubResult =
  | { readonly outcome: "created" | "relinked"; readonly businessName: string; readonly ownerEmail: string }
  | { readonly outcome: "already_linked" | "not_owner" | "email_has_hub" | "store_in_use" | "not_installed" | "invalid_token" | "unavailable" };
export type RedeemResult =
  | { readonly outcome: "redeemed"; readonly businessName: string }
  | { readonly outcome: "invalid_code" | "not_owner" | "already_linked" | "not_installed" | "invalid_token" | "unavailable" }
  | { readonly outcome: "locked"; readonly retryAfterSeconds: number };
export type SignInResult = { readonly outcome: "ok"; readonly url: string } | { readonly outcome: "not_available" | "not_owner" | "invalid_token" | "unavailable" };
export interface ClaimView {
  readonly id: string;
  readonly status: "open" | "redeemed";
  readonly expiresAt: string;
  readonly shop?: { readonly domain: string; readonly name: string };
}
export type ConfirmResult =
  | { readonly outcome: "confirmed"; readonly connectionId: string }
  | { readonly outcome: "not_redeemed" | "expired" | "install_gone" | "store_in_use" | "tenant_has_store" | "not_found" }
  | { readonly outcome: "billing_conflict"; readonly reason: string };
export type NativeRunResult =
  | { readonly kind: "ok"; readonly projected: unknown }
  | { readonly kind: "error"; readonly code: "connection_needs_reconnect" | "provider_permission_denied" | "provider_rate_limited" | "provider_unavailable" | "not_found"; readonly retryAfterSeconds?: number };
export interface WebhookInput {
  readonly rawBody: Uint8Array;
  readonly hmac: string | null;
  readonly topic: string | null;
  readonly shopDomain: string | null;
  readonly webhookId: string | null;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
/** `gid://shopify/Shop/<id>` from a webhook's numeric (or digit-string) shop id; null when it is not a positive integer. */
const shopGid = (value: unknown): string | null => {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : typeof value === "string" ? value : "";
  return /^[1-9][0-9]{0,19}$/.test(text) ? `gid://shopify/Shop/${text}` : null;
};
/** Decimal strings added exactly in micro-units (no floats); null when one is not a plain non-negative decimal. */
const MICRO = 1_000_000n;
function toMicro(text: string): bigint | null {
  const m = /^([0-9]{1,15})(?:\.([0-9]{1,6}))?$/.exec(text);
  return m ? BigInt(m[1]!) * MICRO + BigInt((m[2] ?? "").padEnd(6, "0")) : null;
}
function fromMicro(value: bigint): string {
  const whole = value / MICRO;
  const cents = (value % MICRO).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${cents}`;
}
const isDup = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";

export function createShopifyNativeWorker(deps: ShopifyNativeDeps) {
  const { service, client, config } = deps;
  const now = () => deps.clock.now();
  const newId = deps.newId;
  const report = (event: ShopifyNativeReport) => { try { deps.report?.(event); } catch { /* a reporter never breaks the worker */ } };
  const claimKey = createHmac("sha256", config.sealKeys.current.key).update("shopify-claim-code-v1").digest();
  const codeHash = (code: string) => createHmac("sha256", claimKey).update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
  const makeCode = deps.randomCode ?? (() => Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join(""));
  const idConfig = () => ({ clientId: config.clientId, secrets: config.secrets, now });

  // ---- the per-store lease --------------------------------------------------------------------
  async function withShopLock<T>(domain: string, work: () => Promise<T>): Promise<Locked<T>> {
    const holder = newId();
    const taken = await service((tx) => tx.query(
      `INSERT INTO shopify_locks (shop_domain, held_until, holder) VALUES ($1,$2,$3)
       ON CONFLICT (shop_domain) DO UPDATE SET held_until=$2, holder=$3 WHERE shopify_locks.held_until <= $4
       RETURNING holder`, [domain, new Date(now().getTime() + LOCK_MS), holder, now()]));
    if (taken.rowCount !== 1) return { kind: "busy" };
    try {
      return { kind: "done", value: await work() };
    } finally {
      await service((tx) => tx.query("DELETE FROM shopify_locks WHERE shop_domain=$1 AND holder=$2", [domain, holder])).catch(() => undefined);
    }
  }

  // ---- install rows and tokens ----------------------------------------------------------------
  const installByDomain = (domain: string) => service((tx) => tx.query<InstallRow>(`SELECT ${INSTALL_COLUMNS} FROM shopify_installs WHERE shop_domain=$1`, [domain])).then((r) => r.rows[0] ?? null);
  const installById = (shopId: string) => service((tx) => tx.query<InstallRow>(`SELECT ${INSTALL_COLUMNS} FROM shopify_installs WHERE shop_id=$1`, [shopId])).then((r) => r.rows[0] ?? null);
  const gen = (row: InstallRow) => Number(row.generation);

  function unseal(row: InstallRow, column: "access" | "refresh"): string | null {
    const sealed = column === "access" ? row.access_sealed : row.refresh_sealed;
    const keyId = column === "access" ? row.access_key_id : row.refresh_key_id;
    if (sealed === null || keyId === null) return null;
    try {
      return openToken(config.sealKeys, { shopId: row.shop_id, column }, { text: sealed, keyId });
    } catch (error) {
      if (error instanceof SealError) return null;
      throw error;
    }
  }
  function sealed(shopId: string, tokens: ShopifyTokens) {
    const at = now().getTime();
    return {
      access: sealToken(config.sealKeys, { shopId, column: "access" }, tokens.accessToken),
      refresh: sealToken(config.sealKeys, { shopId, column: "refresh" }, tokens.refreshToken),
      accessExpires: new Date(at + tokens.expiresInSeconds * SECOND),
      refreshExpires: new Date(at + tokens.refreshExpiresInSeconds * SECOND),
    };
  }

  /** Marks the install and its native connection as needing the merchant to reopen the app (C-22). Conditional on the generation. */
  async function markNeedsReauth(row: InstallRow): Promise<boolean> {
    const moved = await service(async (tx) => {
      const updated = await tx.query(
        "UPDATE shopify_installs SET status='needs_reauth', updated_at=$3 WHERE shop_id=$1 AND generation=$2 AND status='live'", [row.shop_id, gen(row), now()]);
      if (updated.rowCount === 1)
        await tx.query(
          `UPDATE connections SET status='reauthorize', reauthorize_reason='auth_error', last_checked_at=$2, updated_at=$2
            WHERE tier='native' AND external_account_id=$1 AND status='active'`, [row.shop_id, now()]);
      return updated.rowCount === 1;
    });
    if (moved) report({ kind: "needs_reauth", shop: row.shop_domain });
    return moved;
  }

  type Access = { kind: "ok"; row: InstallRow; token: string } | { kind: "none" } | { kind: "reauth" } | { kind: "unavailable" } | { kind: "busy" };

  /** Refreshes under the lease; `force` refreshes even when the access token still has time (the cron pass). */
  async function refreshInstall(domain: string, force: boolean, signal?: AbortSignal): Promise<Access> {
    const locked = await withShopLock(domain, async (): Promise<Access> => {
      const row = await installByDomain(domain);
      if (row === null || row.status === "uninstalled") return { kind: "none" };
      if (row.status === "needs_reauth") return { kind: "reauth" };
      const access = unseal(row, "access");
      const stillGood = access !== null && row.access_expires_at !== null && row.access_expires_at.getTime() - now().getTime() > REFRESH_AHEAD_MS;
      if (stillGood && !force) return { kind: "ok", row, token: access };
      const refresh = unseal(row, "refresh");
      if (refresh === null || row.refresh_expires_at === null || row.refresh_expires_at.getTime() <= now().getTime()) {
        await markNeedsReauth(row);
        return { kind: "reauth" };
      }
      const answer = await client.refresh(row.shop_domain, refresh, signal);
      if (answer.kind === "failed") {
        if (answer.reason === "invalid_grant") { await markNeedsReauth(row); return { kind: "reauth" }; }
        return stillGood ? { kind: "ok", row, token: access } : { kind: "unavailable" };
      }
      const s = sealed(row.shop_id, answer.tokens);
      const written = await service((tx) => tx.query(
        `UPDATE shopify_installs SET access_sealed=$3, access_key_id=$4, refresh_sealed=$5, refresh_key_id=$6, access_expires_at=$7, refresh_expires_at=$8, updated_at=$9
          WHERE shop_id=$1 AND generation=$2 AND status='live'`,
        [row.shop_id, gen(row), s.access.text, s.access.keyId, s.refresh.text, s.refresh.keyId, s.accessExpires, s.refreshExpires, now()]));
      // A generation that moved (an uninstall or a new exchange) means this pair is not ours to keep.
      if (written.rowCount !== 1) return { kind: "none" };
      report({ kind: "refreshed", shop: row.shop_domain });
      return { kind: "ok", row, token: answer.tokens.accessToken };
    });
    return locked.kind === "busy" ? { kind: "busy" } : locked.value;
  }

  /** A usable access token for a live install, refreshing first when it is near its end. */
  async function ensureAccess(domain: string, signal?: AbortSignal): Promise<Access> {
    const row = await installByDomain(domain);
    if (row === null || row.status === "uninstalled") return { kind: "none" };
    if (row.status === "needs_reauth") return { kind: "reauth" };
    const access = unseal(row, "access");
    if (access !== null && row.access_expires_at !== null && row.access_expires_at.getTime() - now().getTime() > REFRESH_AHEAD_MS) return { kind: "ok", row, token: access };
    return refreshInstall(domain, false, signal);
  }

  /** Ask Shopify whether the stored credentials still work: live, gone (uninstalled or revoked) or unknown. */
  async function probe(domain: string, signal?: AbortSignal): Promise<"live" | "gone" | "unknown"> {
    const access = await ensureAccess(domain, signal);
    if (access.kind === "none" || access.kind === "reauth") return "gone";
    if (access.kind !== "ok") return "unknown";
    const shop = await client.readShop(domain, access.token, signal);
    if (shop.kind === "ok") return "live";
    if (shop.reason === "unauthorized") return "gone";
    if (shop.reason === "forbidden") return "live";
    return "unknown";
  }

  type Exchanged = { kind: "ok"; row: InstallRow } | { kind: "invalid" } | { kind: "unavailable" } | { kind: "busy" } | { kind: "refused" };
  /** C-21: ID token to an expiring offline token, stored sealed. Re-checks under the lease, so the second of two first opens only reads. */
  async function exchange(domain: string, idToken: string): Promise<Exchanged> {
    const locked = await withShopLock(domain, async (): Promise<Exchanged> => {
      const existing = await installByDomain(domain);
      if (existing !== null && existing.status === "live") {
        const access = unseal(existing, "access");
        if (access !== null && existing.access_expires_at !== null && existing.access_expires_at.getTime() - now().getTime() > REFRESH_AHEAD_MS)
          return { kind: "ok", row: existing };
      }
      const answer = await client.exchangeOffline(domain, idToken);
      if (answer.kind === "failed") {
        if (answer.reason === "non_expiring") { report({ kind: "non_expiring_refused", shop: domain }); return { kind: "refused" }; }
        return answer.reason === "invalid_grant" ? { kind: "invalid" } : { kind: "unavailable" };
      }
      const shop = await client.readShop(domain, answer.tokens.accessToken);
      if (shop.kind === "failed") return { kind: "unavailable" };
      if (shop.shop.domain !== domain) return { kind: "invalid" };
      const s = sealed(shop.shop.id, answer.tokens);
      const name = shop.shop.name.slice(0, 120);
      // The row seen before the Shopify calls fences the write: an uninstall or redact that ran meanwhile moved the
      // generation or removed the row, and this exchange must not bring the store back to life behind it.
      const observed = existing === null ? null : gen(existing);
      const columns = `shop_id, shop_domain, shop_name, scopes, status, access_sealed, access_key_id, refresh_sealed, refresh_key_id,
              access_expires_at, refresh_expires_at, installed_at, created_at, updated_at`;
      const values = [shop.shop.id, domain, name, answer.tokens.scope.slice(0, 1000), s.access.text, s.access.keyId, s.refresh.text, s.refresh.keyId, s.accessExpires, s.refreshExpires, now()];
      let row: InstallRow | undefined;
      try {
        row = await service(async (tx) => {
          const written = observed === null
            ? await tx.query<InstallRow>(
              `INSERT INTO shopify_installs (${columns}) VALUES ($1,$2,$3,$4,'live',$5,$6,$7,$8,$9,$10,$11,$11,$11)
               ON CONFLICT (shop_id) DO NOTHING RETURNING ${INSTALL_COLUMNS}`, values)
            : await tx.query<InstallRow>(
              `INSERT INTO shopify_installs (${columns}) VALUES ($1,$2,$3,$4,'live',$5,$6,$7,$8,$9,$10,$11,$11,$11)
               ON CONFLICT (shop_id) DO UPDATE SET shop_domain=EXCLUDED.shop_domain, shop_name=EXCLUDED.shop_name, scopes=EXCLUDED.scopes, status='live',
                  access_sealed=EXCLUDED.access_sealed, access_key_id=EXCLUDED.access_key_id, refresh_sealed=EXCLUDED.refresh_sealed, refresh_key_id=EXCLUDED.refresh_key_id,
                  access_expires_at=EXCLUDED.access_expires_at, refresh_expires_at=EXCLUDED.refresh_expires_at, generation=shopify_installs.generation + 1,
                  installed_at=CASE WHEN shopify_installs.status='uninstalled' THEN EXCLUDED.installed_at ELSE shopify_installs.installed_at END,
                  uninstalled_at=NULL, updated_at=EXCLUDED.updated_at
                WHERE shopify_installs.generation = $12
               RETURNING ${INSTALL_COLUMNS}`, [...values, observed]);
          const inserted = written.rows[0];
          if (!inserted) return undefined;
          // A merchant who reopens the app after a failed refresh recovers the connection too (C-22), in the same transaction.
          await tx.query(
            `UPDATE connections SET status='active', reauthorize_reason=NULL, last_error_code=NULL, last_checked_at=$2, updated_at=$2
              WHERE tier='native' AND external_account_id=$1 AND status='reauthorize' AND reauthorize_reason='auth_error'`, [inserted.shop_id, now()]);
          return inserted;
        });
      } catch (error) {
        if (isDup(error)) return { kind: "invalid" };
        throw error;
      }
      if (!row) return { kind: "unavailable" };
      report({ kind: "exchanged", shop: domain, generation: gen(row) });
      return { kind: "ok", row };
    });
    return locked.kind === "busy" ? { kind: "busy" } : locked.value;
  }

  // ---- shop links ---------------------------------------------------------------------------------
  async function linkOf(shopId: string): Promise<ShopLink> {
    const row = (await service((tx) => tx.query<{ name: string; status: "active" | "reauthorize" }>(
      `SELECT t.name, c.status::text AS status FROM connections c JOIN tenants t ON t.tenant_id=c.tenant_id
        WHERE c.tier='native' AND c.external_account_id=$1 AND c.status IN ('active','reauthorize')`, [shopId]))).rows[0];
    return row ? { state: "linked", businessName: row.name, connection: row.status } : { state: "none" };
  }

  /** A verified token plus a usable install: the single authentication step before any UI (S1 2.3.2, 2.3.4). */
  type Auth = { kind: "ok"; row: InstallRow; domain: string } | { kind: "invalid_token" } | { kind: "unavailable" } | { kind: "busy" } | { kind: "refused" } | { kind: "not_installed" };
  async function authenticate(idToken: string, allowExchange = true): Promise<Auth> {
    const verified = verifyIdToken(idConfig(), idToken);
    if (!verified.ok) return { kind: "invalid_token" };
    const domain = verified.shopDomain;
    const access = await ensureAccess(domain);
    if (access.kind === "ok") return { kind: "ok", row: access.row, domain };
    if (access.kind === "busy") return { kind: "busy" };
    if (access.kind === "unavailable") return { kind: "unavailable" };
    if (!allowExchange) return { kind: "not_installed" };
    const exchanged = await exchange(domain, idToken);
    if (exchanged.kind === "ok") return { kind: "ok", row: exchanged.row, domain };
    return exchanged.kind === "invalid" ? { kind: "invalid_token" } : { kind: exchanged.kind };
  }

  /**
   * C-29: the shop's plan as the billing runner last stored it (plans.md PL-18), read with the link in one statement.
   * Only a store linked to a hub has a plan to show (a disconnected or uninstalled store keeps its row but shows none).
   * Trialing and active (past due keeps the plan, PL-4) count; all else is none.
   */
  async function linkAndPlanOf(shopId: string): Promise<{ link: ShopLink; plan: ShopPlan }> {
    // One statement, so one snapshot: under READ COMMITTED two queries could see a disconnect between them.
    const linked = (await service((tx) => tx.query<{ name: string; status: "active" | "reauthorize"; plan: HubPlan | null; plan_status: string | null }>(
      `SELECT t.name, c.status::text AS status, p.plan, p.status::text AS plan_status
         FROM connections c JOIN tenants t ON t.tenant_id=c.tenant_id
         LEFT JOIN tenant_plans p ON p.tenant_id=c.tenant_id AND p.billing_provider='shopify' AND p.shopify_shop_id=c.external_account_id
        WHERE c.tier='native' AND c.external_account_id=$1 AND c.status IN ('active','reauthorize')`, [shopId]))).rows[0];
    if (!linked) return { link: { state: "none" }, plan: { state: "none" } };
    const link: ShopLink = { state: "linked", businessName: linked.name, connection: linked.status };
    const entry = linked.plan ? PLAN_CATALOG[linked.plan] : undefined;
    if (!entry) return { link, plan: { state: "none" } };
    if (linked.plan_status === "trialing") return { link, plan: { state: "trial", name: entry.name } };
    return { link, plan: linked.plan_status === "active" || linked.plan_status === "past_due" ? { state: "active", name: entry.name } : { state: "none" } };
  }

  async function open(input: { idToken: string }): Promise<OpenResult> {
    const auth = await authenticate(input.idToken);
    if (auth.kind === "refused") return { outcome: "not_supported" };
    if (auth.kind !== "ok") return { outcome: auth.kind === "not_installed" ? "unavailable" : auth.kind };
    const { link, plan } = await linkAndPlanOf(auth.row.shop_id);
    return { outcome: "ok", shop: { domain: auth.row.shop_domain, name: auth.row.shop_name }, plan, link };
  }

  /**
   * C-30: the newest orders of the last 60 days for the embedded page, read-only and without customer data. It
   * authenticates like `open`, answers only for a linked store, and reuses the order reader and token path of `run`.
   */
  async function orders(input: { idToken: string }, signal?: AbortSignal): Promise<OrdersResult> {
    const auth = await authenticate(input.idToken);
    if (auth.kind === "refused") return { outcome: "not_supported" };
    if (auth.kind !== "ok") return { outcome: auth.kind === "not_installed" ? "unavailable" : auth.kind };
    if ((await linkOf(auth.row.shop_id)).state !== "linked") return { outcome: "not_linked" };
    const access = await ensureAccess(auth.domain, signal);
    if (access.kind === "busy") return { outcome: "busy" };
    if (access.kind !== "ok" || access.row.shop_id !== auth.row.shop_id) return { outcome: "unavailable" };
    const end = now();
    const start = new Date(end.getTime() - SHOPIFY_RECENT_ORDERS_DAYS * DAY);
    const answer = await client.graphql(auth.domain, access.token, listOrdersQuery(),
      { first: SHOPIFY_RECENT_ORDERS_FETCHED, query: listOrdersSearch({ start, end, status: "any" }) }, signal);
    if (answer.kind === "failed") {
      // Only the install that is current may be marked; a stale 401 just means: try again.
      if (answer.reason === "unauthorized" || answer.reason === "invalid_grant") await markNeedsReauth(access.row);
      return { outcome: "unavailable" };
    }
    const nodes = record(answer.data["orders"])?.["nodes"];
    if (!Array.isArray(nodes)) return { outcome: "unavailable" };
    const seen: Array<ShopifyRecentOrder & { micro: bigint }> = [];
    for (const node of nodes.slice(0, SHOPIFY_RECENT_ORDERS_FETCHED)) {
      const o = orderToRest(node);
      const created = typeof o["created_at"] === "string" ? new Date(o["created_at"]) : null;
      const micro = typeof o["total_price"] === "string" ? toMicro(o["total_price"]) : null;
      if (typeof o["name"] !== "string" || o["name"] === "" || created === null || Number.isNaN(created.getTime()) || micro === null
        || typeof o["currency"] !== "string" || !/^[A-Z]{3}$/.test(o["currency"])) continue;
      seen.push({
        name: o["name"].slice(0, 100),
        createdAt: created.toISOString(),
        displayFinancialStatus: typeof o["financial_status"] === "string" ? o["financial_status"].slice(0, 60) : null,
        displayFulfillmentStatus: typeof o["fulfillment_status"] === "string" ? o["fulfillment_status"].slice(0, 60) : null,
        total: { amount: fromMicro(micro), currency: o["currency"] },
        micro,
      });
    }
    seen.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    const currencies = new Set(seen.map((order) => order.total.currency));
    const sum = seen.reduce((acc, order) => acc + order.micro, 0n);
    return {
      outcome: "ok",
      orders: seen.slice(0, SHOPIFY_RECENT_ORDERS_SHOWN).map(({ micro: _micro, ...order }) => order),
      summary: { count: seen.length, total: currencies.size === 1 ? { amount: fromMicro(sum), currency: [...currencies][0]! } : null },
    };
  }

  /** The store owner behind a token: the online exchange must name an account owner with a verified email. */
  async function storeOwner(domain: string, idToken: string): Promise<{ kind: "ok"; email: string } | { kind: "not_owner" | "unavailable" | "invalid_token" }> {
    const answer = await client.exchangeOnline(domain, idToken);
    if (answer.kind === "failed") return { kind: answer.reason === "invalid_grant" ? "invalid_token" : "unavailable" };
    if (!answer.user.accountOwner || !answer.user.emailVerified || answer.user.email === null) return { kind: "not_owner" };
    return { kind: "ok", email: answer.user.email.trim().toLowerCase() };
  }

  /** True while any live connection of any tier holds this store (C-21 isolation across tiers). */
  const storeInUse = (tx: Transaction, shopId: string, domain: string) => tx.query(
    `SELECT 1 FROM connections WHERE status IN ('active','reauthorize','disconnecting') AND toolkit='shopify'
       AND ((tier='native' AND external_account_id=$1) OR account_domain=$2 OR (tier='composio' AND external_account_id=$3)) LIMIT 1`,
    [shopId, domain, SHOP_GID_RE.exec(shopId)![1]!]).then((r) => (r.rowCount ?? 0) > 0);

  async function bind(tx: Transaction, input: { tenantId: string; memberId: string; row: InstallRow }): Promise<string> {
    const connectionId = newId();
    const label = normalizeAccountLabel(input.row.shop_name) ?? input.row.shop_domain;
    await tx.query(
      `INSERT INTO connections (tenant_id,id,tier,toolkit,external_account_id,account_domain,account_label,status,connected_by,last_checked_at,created_at,updated_at)
       VALUES ($1,$2,'native','shopify',$3,$4,$5,'active',$6,$7,$7,$7)`,
      [input.tenantId, connectionId, input.row.shop_id, input.row.shop_domain, label, input.memberId, now()]);
    await setShopifyBilling(tx, { tenantId: input.tenantId, shop: { id: input.row.shop_id, domain: input.row.shop_domain }, now: now(), graceDays: config.graceDays });
    return connectionId;
  }

  const ownerMember = (tx: Transaction, tenantId: string, email: string) => tx.query<{ id: string }>(
    "SELECT id FROM tenant_members WHERE tenant_id=$1 AND lower(email)=$2 AND role='owner' LIMIT 1", [tenantId, email]).then((r) => r.rows[0]?.id ?? null);

  async function createHub(input: { idToken: string }): Promise<CreateHubResult> {
    const auth = await authenticate(input.idToken, false);
    if (auth.kind === "invalid_token") return { outcome: "invalid_token" };
    if (auth.kind === "unavailable" || auth.kind === "busy" || auth.kind === "refused") return { outcome: "unavailable" };
    if (auth.kind === "not_installed") return { outcome: "not_installed" };
    const { row, domain } = auth;
    if ((await linkOf(row.shop_id)).state === "linked") return { outcome: "already_linked" };
    const owner = await storeOwner(domain, input.idToken);
    if (owner.kind !== "ok") return { outcome: owner.kind };
    if (await service((tx) => storeInUse(tx, row.shop_id, domain))) return { outcome: "store_in_use" };

    // A returning owner: the hub that billed this store before, whose owner member has this verified email, takes it back.
    const returning = (await service((tx) => tx.query<{ tenant_id: string; name: string }>(
      `SELECT p.tenant_id, t.name FROM tenant_plans p JOIN tenants t ON t.tenant_id=p.tenant_id WHERE p.shopify_shop_id=$1`, [row.shop_id]))).rows[0];
    if (returning) {
      try {
        const bound = await service(async (tx) => {
          const memberId = await ownerMember(tx, returning.tenant_id, owner.email);
          if (memberId === null) return false;
          const live = await tx.query("SELECT 1 FROM connections WHERE tenant_id=$1 AND toolkit='shopify' AND status IN ('active','reauthorize','disconnecting')", [returning.tenant_id]);
          if ((live.rowCount ?? 0) > 0) return false;
          await bind(tx, { tenantId: returning.tenant_id, memberId, row });
          return true;
        });
        if (bound) {
          report({ kind: "bound", tenantId: returning.tenant_id, shop: domain, via: "relink" });
          return { outcome: "relinked", businessName: returning.name, ownerEmail: owner.email };
        }
      } catch (error) {
        if (!(error instanceof Conflict)) throw error;
      }
      return { outcome: "email_has_hub" };
    }

    const key = `shopify-${SHOP_GID_RE.exec(row.shop_id)![1]}`;
    const name = row.shop_name.trim().slice(0, 120) || key;
    const made = await deps.hub.createHub({ key, name, ownerEmail: owner.email });
    if (made.kind === "email_has_hub") return { outcome: "email_has_hub" };
    if (made.kind === "failed") { report({ kind: "hub_failed", shop: domain }); return { outcome: "unavailable" }; }
    try {
      const done = await service(async (tx) => {
        const memberId = await ownerMember(tx, made.tenantId, owner.email);
        if (memberId === null) throw new Error("The new hub has no owner member");
        if (await storeInUse(tx, row.shop_id, domain)) {
          // This hub's own live row means a retry already finished the bind; anyone else's row means the store is taken.
          const mine = await tx.query(
            `SELECT 1 FROM connections WHERE tenant_id=$1 AND tier='native' AND toolkit='shopify' AND external_account_id=$2
               AND status IN ('active','reauthorize','disconnecting') LIMIT 1`, [made.tenantId, row.shop_id]);
          return (mine.rowCount ?? 0) > 0 ? "retry" : "taken";
        }
        await bind(tx, { tenantId: made.tenantId, memberId, row });
        return "bound";
      });
      if (done === "taken") return { outcome: "store_in_use" };
      if (done === "bound") report({ kind: "bound", tenantId: made.tenantId, shop: domain, via: "create_hub" });
    } catch (error) {
      if (isDup(error)) return { outcome: "store_in_use" };
      if (error instanceof Conflict) { report({ kind: "hub_failed", shop: domain }); return { outcome: "unavailable" }; }
      throw error;
    }
    return { outcome: "created", businessName: name, ownerEmail: owner.email };
  }

  // ---- claims (existing hub) ----------------------------------------------------------------------
  async function claimStart(input: { tenantId: string; memberId: string }): Promise<{ outcome: "started"; claimId: string; code: string; expiresAt: string } | { outcome: "already_connected" }> {
    const code = makeCode();
    const claimId = newId();
    const expiresAt = new Date(now().getTime() + CLAIM_LIFETIME_MS);
    return service(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`shopify-claim:${input.tenantId}`]);
      const live = await tx.query("SELECT 1 FROM connections WHERE tenant_id=$1 AND toolkit='shopify' AND status IN ('active','reauthorize','disconnecting')", [input.tenantId]);
      if ((live.rowCount ?? 0) > 0) return { outcome: "already_connected" as const };
      await tx.query(
        "UPDATE shopify_claims SET status=CASE WHEN expires_at<=$2 THEN 'expired' ELSE 'cancelled' END, updated_at=$2 WHERE tenant_id=$1 AND status IN ('open','redeemed')", [input.tenantId, now()]);
      await tx.query(
        `INSERT INTO shopify_claims (tenant_id,id,created_by,code_hash,status,expires_at,created_at,updated_at) VALUES ($1,$2,$3,$4,'open',$5,$6,$6)`,
        [input.tenantId, claimId, input.memberId, codeHash(code), expiresAt, now()]);
      return { outcome: "started" as const, claimId, code, expiresAt: expiresAt.toISOString() };
    });
  }

  async function claimStatus(input: { tenantId: string }): Promise<ClaimView | null> {
    await service((tx) => tx.query("UPDATE shopify_claims SET status='expired', updated_at=$2 WHERE tenant_id=$1 AND status IN ('open','redeemed') AND expires_at<=$2", [input.tenantId, now()]));
    const row = (await service((tx) => tx.query<{ id: string; status: "open" | "redeemed"; expires_at: Date; shop_domain: string | null; shop_name: string | null }>(
      "SELECT id, status::text AS status, expires_at, shop_domain, shop_name FROM shopify_claims WHERE tenant_id=$1 AND status IN ('open','redeemed')", [input.tenantId]))).rows[0];
    if (!row) return null;
    return { id: row.id, status: row.status, expiresAt: row.expires_at.toISOString(), ...(row.shop_domain && row.shop_name ? { shop: { domain: row.shop_domain, name: row.shop_name } } : {}) };
  }

  async function claimCancel(input: { tenantId: string; claimId: string }): Promise<{ outcome: "cancelled" | "not_found" }> {
    const moved = await service((tx) => tx.query(
      "UPDATE shopify_claims SET status='cancelled', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status IN ('open','redeemed')", [input.tenantId, input.claimId, now()]));
    return { outcome: moved.rowCount === 1 ? "cancelled" : "not_found" };
  }

  async function redeemClaim(input: { idToken: string; code: string }): Promise<RedeemResult> {
    const auth = await authenticate(input.idToken, false);
    if (auth.kind === "invalid_token") return { outcome: "invalid_token" };
    if (auth.kind === "not_installed") return { outcome: "not_installed" };
    if (auth.kind !== "ok") return { outcome: "unavailable" };
    const { row, domain } = auth;
    if (row.claim_locked_until !== null && row.claim_locked_until.getTime() > now().getTime()) {
      report({ kind: "claim_locked", shop: domain });
      return { outcome: "locked", retryAfterSeconds: Math.max(1, Math.ceil((row.claim_locked_until.getTime() - now().getTime()) / SECOND)) };
    }
    if ((await linkOf(row.shop_id)).state === "linked") return { outcome: "already_linked" };
    const owner = await storeOwner(domain, input.idToken);
    if (owner.kind !== "ok") return { outcome: owner.kind };
    const hash = codeHash(input.code);
    // The lockout counter is read and written under a row lock: concurrent wrong guesses each count, and a slow
    // request cannot reset a lock another one just set.
    const found = await service(async (tx): Promise<{ kind: "redeemed"; name: string } | { kind: "wrong" } | { kind: "locked"; until: Date }> => {
      const counter = (await tx.query<{ claim_failures: number; claim_locked_until: Date | null }>(
        "SELECT claim_failures, claim_locked_until FROM shopify_installs WHERE shop_id=$1 FOR UPDATE", [row.shop_id])).rows[0];
      if (!counter) return { kind: "wrong" };
      if (counter.claim_locked_until !== null && counter.claim_locked_until.getTime() > now().getTime()) return { kind: "locked", until: counter.claim_locked_until };
      const claim = (await tx.query<{ tenant_id: string; id: string }>(
        `UPDATE shopify_claims SET status='redeemed', shop_id=$2, shop_domain=$3, shop_name=$4, redeemed_at=$5, updated_at=$5
          WHERE code_hash=$1 AND status='open' AND expires_at > $5 RETURNING tenant_id, id`, [hash, row.shop_id, domain, row.shop_name, now()])).rows[0];
      if (claim) {
        await tx.query("UPDATE shopify_installs SET claim_failures=0, claim_locked_until=NULL WHERE shop_id=$1", [row.shop_id]);
        const name = (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [claim.tenant_id])).rows[0]?.name ?? "";
        return { kind: "redeemed", name };
      }
      const failures = Number(counter.claim_failures) + 1;
      const lock = failures >= CLAIM_MAX_WRONG;
      await tx.query("UPDATE shopify_installs SET claim_failures=$2, claim_locked_until=$3, updated_at=$4 WHERE shop_id=$1",
        [row.shop_id, lock ? 0 : failures, lock ? new Date(now().getTime() + CLAIM_LOCK_MS) : null, now()]);
      return { kind: "wrong" };
    });
    if (found.kind === "locked") {
      report({ kind: "claim_locked", shop: domain });
      return { outcome: "locked", retryAfterSeconds: Math.max(1, Math.ceil((found.until.getTime() - now().getTime()) / SECOND)) };
    }
    if (found.kind === "wrong") return { outcome: "invalid_code" };
    return { outcome: "redeemed", businessName: found.name };
  }

  async function claimConfirm(input: { tenantId: string; claimId: string; memberId: string }): Promise<ConfirmResult> {
    try {
      return await service(async (tx): Promise<ConfirmResult> => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`shopify-claim:${input.tenantId}`]);
        const claim = (await tx.query<{ status: string; expires_at: Date; shop_id: string | null }>(
          "SELECT status::text AS status, expires_at, shop_id FROM shopify_claims WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [input.tenantId, input.claimId])).rows[0];
        if (!claim) return { outcome: "not_found" };
        if (claim.status !== "redeemed" || claim.shop_id === null) return { outcome: "not_redeemed" };
        if (claim.expires_at.getTime() <= now().getTime()) return { outcome: "expired" };
        const install = (await tx.query<InstallRow>(`SELECT ${INSTALL_COLUMNS} FROM shopify_installs WHERE shop_id=$1 FOR UPDATE`, [claim.shop_id])).rows[0];
        if (!install || install.status !== "live") return { outcome: "install_gone" };
        if (await storeInUse(tx, install.shop_id, install.shop_domain)) return { outcome: "store_in_use" };
        const tenantLive = await tx.query("SELECT 1 FROM connections WHERE tenant_id=$1 AND toolkit='shopify' AND status IN ('active','reauthorize','disconnecting')", [input.tenantId]);
        if ((tenantLive.rowCount ?? 0) > 0) return { outcome: "tenant_has_store" };
        // A billing guard refusal throws Conflict, which rolls the whole transaction back: no connection row, no plan change.
        const connectionId = await bind(tx, { tenantId: input.tenantId, memberId: input.memberId, row: install });
        await tx.query("UPDATE shopify_claims SET status='confirmed', confirmed_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2", [input.tenantId, input.claimId, now()]);
        report({ kind: "bound", tenantId: input.tenantId, shop: install.shop_domain, via: "claim" });
        return { outcome: "confirmed", connectionId };
      });
    } catch (error) {
      if (error instanceof Conflict) return { outcome: "billing_conflict", reason: String((error as { details?: { reason?: unknown } }).details?.reason ?? "billing_conflict") };
      if (isDup(error)) return { outcome: "store_in_use" };
      throw error;
    }
  }

  async function signIn(input: { idToken: string }): Promise<SignInResult> {
    const auth = await authenticate(input.idToken, false);
    if (auth.kind === "invalid_token") return { outcome: "invalid_token" };
    if (auth.kind !== "ok") return { outcome: "unavailable" };
    const owner = await storeOwner(auth.domain, input.idToken);
    if (owner.kind !== "ok") return { outcome: owner.kind };
    const member = (await service((tx) => tx.query<{ email: string }>(
      `SELECT m.email FROM connections c JOIN tenant_members m ON m.tenant_id=c.tenant_id AND m.role='owner' AND lower(m.email)=$2
        WHERE c.tier='native' AND c.external_account_id=$1 AND c.status IN ('active','reauthorize') LIMIT 1`, [auth.row.shop_id, owner.email]))).rows[0];
    if (!member) return { outcome: "not_available" };
    const url = await deps.hub.signInLink(owner.email);
    return url === null ? { outcome: "not_available" } : { outcome: "ok", url };
  }

  // ---- reading orders (C-23) --------------------------------------------------------------------
  async function run(input: { row: NativeConnectionRow; tool: string; arguments: Record<string, unknown> }, signal?: AbortSignal): Promise<NativeRunResult> {
    const access = await ensureAccess(input.row.account_domain);
    if (access.kind === "reauth") { await reauthConnection(input.row); return { kind: "error", code: "connection_needs_reconnect" }; }
    if (access.kind === "none") return { kind: "error", code: "connection_needs_reconnect" };
    if (access.kind !== "ok") return { kind: "error", code: "provider_unavailable" };
    if (access.row.shop_id !== input.row.external_account_id) return { kind: "error", code: "not_found" };
    let answer;
    if (input.tool === "shopify_list_orders") {
      const args = input.arguments as { createdAfter?: string; createdBefore?: string; status?: "open" | "closed" | "cancelled" | "any"; limit?: number };
      const { start, end } = shopifyListWindow(args, now());
      answer = await client.graphql(input.row.account_domain, access.token, listOrdersQuery(),
        { first: Math.min(args.limit ?? 50, 50), query: listOrdersSearch({ start, end, status: args.status ?? "any" }) }, signal);
    } else if (input.tool === "shopify_get_order") {
      answer = await client.graphql(input.row.account_domain, access.token, getOrderQuery(), { id: `gid://shopify/Order/${String(input.arguments["orderId"])}` }, signal);
    } else {
      return { kind: "error", code: "not_found" };
    }
    if (answer.kind === "failed") return failureToRun(answer.reason, input.row, access.row);
    if (input.tool === "shopify_list_orders") {
      const nodes = record(answer.data["orders"])?.["nodes"];
      return Array.isArray(nodes) ? { kind: "ok", projected: { orders: nodes.map(orderToRest) } } : { kind: "error", code: "provider_unavailable" };
    }
    const order = answer.data["order"];
    return order === null ? { kind: "error", code: "not_found" } : { kind: "ok", projected: orderToRest(order) };
  }

  async function failureToRun(reason: ShopifyFailure, row: NativeConnectionRow, install: InstallRow): Promise<NativeRunResult> {
    switch (reason) {
      case "unauthorized":
      case "invalid_grant":
        // Only the install that is current may invalidate the connection; a stale 401 (the pair was rotated or the
        // store was reinstalled meanwhile) just means: try again with the fresh token.
        return (await markNeedsReauth(install)) ? { kind: "error", code: "connection_needs_reconnect" } : { kind: "error", code: "provider_unavailable" };
      case "forbidden":
        // C-8, C-10: the credential works but a permission blocks this read; reconnecting cannot fix it.
        await service((tx) => tx.query(
          "UPDATE connections SET last_error_code='provider_permission_denied', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='active'", [row.tenant_id, row.id, now()]));
        return { kind: "error", code: "provider_permission_denied" };
      case "rate_limited":
        return { kind: "error", code: "provider_rate_limited", retryAfterSeconds: 10 };
      default:
        return { kind: "error", code: "provider_unavailable" };
    }
  }
  const reauthConnection = (row: NativeConnectionRow) => service((tx) => tx.query(
    `UPDATE connections SET status='reauthorize', reauthorize_reason='auth_error', last_checked_at=$3, updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='active'`,
    [row.tenant_id, row.id, now()])).then(() => undefined);

  // ---- disconnect (C-13) ------------------------------------------------------------------------
  async function finishDisconnect(row: NativeConnectionRow): Promise<"disconnected" | "pending"> {
    let outcome: "revoked" | "failed" = row.revoke_outcome ?? "revoked";
    if (row.revoke_outcome === null) {
      const access = await ensureAccess(row.account_domain);
      if (access.kind === "ok") {
        const gone = await client.uninstall(row.account_domain, access.token);
        if (gone.kind === "failed") {
          if (gone.reason === "unavailable" || gone.reason === "rate_limited") {
            await service((tx) => tx.query("UPDATE connections SET last_error_code='delete_failed', updated_at=$3 WHERE tenant_id=$1 AND id=$2 AND status='disconnecting'", [row.tenant_id, row.id, now()]));
            return "pending";
          }
          // A refused token means the app is already gone from the store.
          outcome = gone.reason === "unauthorized" ? "revoked" : "failed";
        }
      } else if (access.kind === "busy" || access.kind === "unavailable") {
        return "pending";
      } else if (access.kind === "reauth") {
        // The stored token no longer works, so the app cannot be removed from here: say so (the owner uninstalls it in Shopify admin).
        outcome = "failed";
      }
    }
    await service(async (tx) => {
      await tx.query(
        `UPDATE shopify_installs SET status='uninstalled', access_sealed=NULL, access_key_id=NULL, refresh_sealed=NULL, refresh_key_id=NULL, access_expires_at=NULL,
            refresh_expires_at=NULL, generation=generation+1, uninstalled_at=$2, updated_at=$2 WHERE shop_id=$1 AND status<>'uninstalled'`, [row.external_account_id, now()]);
      await tx.query(
        `UPDATE connections SET status='disconnected', account_label=NULL, revoke_outcome=$3, last_error_code=$4, last_checked_at=$5, claimed_until=NULL, updated_at=$5
          WHERE tenant_id=$1 AND id=$2 AND status='disconnecting'`, [row.tenant_id, row.id, outcome, outcome === "failed" ? "revoke_failed" : null, now()]);
    });
    return "disconnected";
  }

  // ---- webhooks (C-24) --------------------------------------------------------------------------
  const TOPICS = new Set(["app/uninstalled", "customers/data_request", "customers/redact", "shop/redact"]);

  async function webhook(input: WebhookInput): Promise<{ status: 200 | 401 | 500 }> {
    const done = (status: 200 | 401 | 500, topic = "unknown", shop = "unknown") => { report({ kind: "webhook", topic, shop, status }); return { status }; };
    if (input.rawBody.byteLength > MAX_WEBHOOK_BYTES) return done(401);
    if (!verifyWebhookHmac(config.secrets, input.rawBody, input.hmac)) return done(401);
    const { topic, shopDomain, webhookId } = input;
    if (!topic || !shopDomain || !webhookId || !SHOP_DOMAIN.test(shopDomain) || webhookId.length > 128 || !/^[a-z_]{1,40}\/[a-z_]{1,40}$/.test(topic)) return done(401);
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(Buffer.from(input.rawBody).toString("utf8"))); } catch { body = undefined; }
    if (!body) return done(401);
    // The headers are not signed; the signed body must name the same shop, and its shop is the one acted on.
    const bodyShop = String(body[topic === "app/uninstalled" ? "myshopify_domain" : "shop_domain"] ?? "").toLowerCase();
    if (!TOPICS.has(topic)) return done(200, topic, shopDomain);
    if (bodyShop !== shopDomain) return done(401, topic, shopDomain);
    // The topic header is not signed. A signed customers/* body (it names a customer) must not drive a shop-wide erase.
    if (topic === "shop/redact" && ("customer" in body || "orders_to_redact" in body || "orders_requested" in body)) return done(401, topic, shopDomain);
    const record_ = (tx: Transaction) => tx.query("INSERT INTO shopify_webhook_events (webhook_id, topic, shop_domain, received_at) VALUES ($1,$2,$3,$4) ON CONFLICT (webhook_id) DO NOTHING",
      [webhookId, topic, shopDomain, now()]).then((r) => r.rowCount === 1);

    // A signed body that names a shop id must name the stored shop's id (the headers are not signed).
    const bodyId = topic === "app/uninstalled" ? body["id"] : body["shop_id"];
    const bodyGid = shopGid(bodyId);
    if (topic !== "app/uninstalled" && bodyGid === null) return done(401, topic, shopDomain);

    // A delivery already handled is acknowledged before any call to Shopify (at-least-once delivery).
    const seen = await service((tx) => tx.query("SELECT 1 FROM shopify_webhook_events WHERE webhook_id=$1", [webhookId]));
    if ((seen.rowCount ?? 0) > 0) return done(200, topic, shopDomain);

    const install = await installByDomain(shopDomain);
    if (install !== null && bodyGid !== null && install.shop_id !== bodyGid) return done(401, topic, shopDomain);
    if (topic === "customers/data_request" || topic === "customers/redact") {
      // C-14: the hub holds no Shopify customer data, so there is nothing to export or erase.
      await service(async (tx) => { await record_(tx); });
      return done(200, topic, shopDomain);
    }
    // The whole probe shares one budget that ends before Shopify's 5 s limit; a slow store answers 500 and Shopify retries.
    const budget = () => AbortSignal.timeout(WEBHOOK_PROBE_MS);
    if (topic === "app/uninstalled") {
      if (install === null || install.status === "uninstalled") { await service(async (tx) => { await record_(tx); }); return done(200, topic, shopDomain); }
      // Shopify guarantees neither order nor delivery: ask it whether the credentials still work (C-24).
      const state = await probe(shopDomain, budget());
      if (state === "unknown") return done(500, topic, shopDomain);
      if (state === "live") {
        report({ kind: "delayed_uninstall_dropped", shop: shopDomain });
        await service(async (tx) => { await record_(tx); });
        return done(200, topic, shopDomain);
      }
      if (await applyUninstall(install, record_)) report({ kind: "uninstalled", shop: shopDomain });
      return done(200, topic, shopDomain);
    }
    // shop/redact
    if (install !== null && install.status !== "uninstalled") {
      const state = await probe(shopDomain, budget());
      if (state === "unknown") return done(500, topic, shopDomain);
      if (state === "live") { await service(async (tx) => { await record_(tx); }); return done(200, topic, shopDomain); }
    }
    const shopId = install?.shop_id ?? bodyGid!;
    const erased = await service(async (tx) => {
      if (!(await record_(tx))) return null;
      // The probe ran outside this transaction: lock the row and confirm it is still the one the probe saw. A store
      // that reinstalled meanwhile (a new generation, or a row where there was none) keeps its fresh credentials and binding.
      const now_ = (await tx.query<{ status: string; generation: string | number; created_at: Date }>("SELECT status::text AS status, generation, created_at FROM shopify_installs WHERE shop_domain=$1 FOR UPDATE", [shopDomain])).rows[0];
      // A reinstall after another redact deleted the row restarts at generation 1, so the row's creation time names the incarnation the probe saw.
      const reinstalled = install === null ? now_ !== undefined && now_.status !== "uninstalled"
        : now_ !== undefined && (Number(now_.generation) !== gen(install) || new Date(now_.created_at).getTime() !== new Date(install.created_at).getTime());
      if (reinstalled) return false;
      // The action history keeps the connection's domain and store name in `result` and `payload` (and an outbox event may echo
      // them). Scope: this shop's native connections only, matched by tenant and connection id; no search across tenants.
      const bound = (await tx.query<{ tenant_id: string; id: string; account_label: string | null }>(
        "SELECT tenant_id, id, account_label FROM connections WHERE tier='native' AND external_account_id=$1 FOR UPDATE", [shopId])).rows;
      if (bound.length > 0) {
        const identity = { domain: shopDomain, shopId, names: [install?.shop_name, ...bound.map((row) => row.account_label)].filter((name): name is string => typeof name === "string") };
        const tenantIds = bound.map((row) => row.tenant_id);
        const connectionIds = bound.map((row) => row.id);
        const history = (await tx.query<{ tenant_id: string; id: string; idempotency_key: string; payload: unknown; result: unknown }>(
          `SELECT a.tenant_id, a.id, a.idempotency_key, a.payload, a.result FROM actions a
            WHERE a.target->>'type'='connection' AND (a.tenant_id, a.target->>'id') IN (SELECT t, i::text FROM unnest($1::uuid[], $2::uuid[]) AS x(t, i)) FOR UPDATE`,
          [tenantIds, connectionIds])).rows;
        for (const row of history) {
          // A client-chosen idempotency key can carry the domain (for example `disconnect:<shop>`); the action id keeps it unique per tenant.
          const key = redactStoreIdentity(row.idempotency_key, identity) === row.idempotency_key ? row.idempotency_key : `redacted:${row.id}`;
          await tx.query("UPDATE actions SET idempotency_key=$3, payload=$4::jsonb, result=$5::jsonb WHERE tenant_id=$1 AND id=$2",
            [row.tenant_id, row.id, key, JSON.stringify(redactStoreIdentity(row.payload, identity)), JSON.stringify(redactStoreIdentity(row.result, identity))]);
        }
        const events = (await tx.query<{ tenant_id: string; id: string; payload: unknown }>(
          `SELECT tenant_id, id, payload FROM outbox WHERE (tenant_id, action_id) IN (SELECT t, i FROM unnest($1::uuid[], $2::uuid[]) AS x(t, i)) FOR UPDATE`,
          [history.map((row) => row.tenant_id), history.map((row) => row.id)])).rows;
        for (const row of events)
          await tx.query("UPDATE outbox SET payload=$3::jsonb WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, JSON.stringify(redactStoreIdentity(row.payload, identity))]);
      }
      await tx.query(
        `UPDATE connections SET status='disconnected', account_label=NULL, revoke_outcome=coalesce(revoke_outcome,'revoked'), updated_at=$2
          WHERE tier='native' AND external_account_id=$1 AND status<>'disconnected'`, [shopId, now()]);
      await tx.query("UPDATE connections SET account_domain='redacted.invalid', external_account_id='redacted' WHERE tier='native' AND external_account_id=$1 AND status='disconnected'", [shopId]);
      await tx.query("DELETE FROM shopify_claims WHERE shop_id=$1 OR shop_domain=$2", [shopId, shopDomain]);
      await tx.query("DELETE FROM shopify_installs WHERE shop_domain=$1", [shopDomain]);
      await tx.query("DELETE FROM shopify_locks WHERE shop_domain=$1", [shopDomain]);
      // No row may keep the shop's name after a redact; this delivery's own row stays, anonymised, so a repeat is still dropped.
      await tx.query("DELETE FROM shopify_webhook_events WHERE shop_domain=$1 AND webhook_id<>$2", [shopDomain, webhookId]);
      await tx.query("UPDATE shopify_webhook_events SET shop_domain='redacted.myshopify.com' WHERE webhook_id=$1", [webhookId]);
      return true;
    });
    if (erased === true) report({ kind: "redacted", shop: shopDomain });
    else if (erased === false) report({ kind: "redact_skipped_reinstall", shop: shopDomain });
    return done(200, topic, shopDomain);
  }

  /** Marks the install uninstalled and its connection disconnected, only when the install is still the generation the probe saw. */
  async function applyUninstall(install: InstallRow, record_: (tx: Transaction) => Promise<boolean>): Promise<boolean> {
    return service(async (tx) => {
      if (!(await record_(tx))) return false;
      const moved = await tx.query(
        `UPDATE shopify_installs SET status='uninstalled', access_sealed=NULL, access_key_id=NULL, refresh_sealed=NULL, refresh_key_id=NULL, access_expires_at=NULL,
            refresh_expires_at=NULL, generation=generation+1, uninstalled_at=$3, updated_at=$3 WHERE shop_id=$1 AND generation=$2 AND status<>'uninstalled'`,
        [install.shop_id, gen(install), now()]);
      if (moved.rowCount !== 1) return false;
      await tx.query(
        `UPDATE connections SET status='disconnected', account_label=NULL, revoke_outcome='revoked', last_error_code=NULL, last_checked_at=$2, claimed_until=NULL, updated_at=$2
          WHERE tier='native' AND external_account_id=$1 AND status IN ('active','reauthorize','disconnecting')`, [install.shop_id, now()]);
      return true;
    });
  }

  // ---- the cron pass -----------------------------------------------------------------------------
  async function pass(ctx: { readonly deadline: number }): Promise<{ refreshed: number }> {
    let refreshed = 0;
    const due = (await service((tx) => tx.query<{ shop_domain: string }>(
      `SELECT shop_domain FROM shopify_installs WHERE status='live' AND (refresh_expires_at <= $1 OR access_expires_at <= $2)
        ORDER BY refresh_expires_at LIMIT 25`, [new Date(now().getTime() + PASS_REFRESH_BELOW_MS), new Date(now().getTime() - DAY)]))).rows;
    for (const { shop_domain } of due) {
      if (now().getTime() >= ctx.deadline) break;
      const answer = await refreshInstall(shop_domain, true);
      if (answer.kind === "ok") refreshed += 1;
    }
    await service(async (tx) => {
      await tx.query("DELETE FROM shopify_webhook_events WHERE received_at < $1", [new Date(now().getTime() - EVENT_KEEP_MS)]);
      await tx.query("DELETE FROM shopify_locks WHERE held_until < $1", [now()]);
      await tx.query("UPDATE shopify_claims SET status='expired', updated_at=$1 WHERE status IN ('open','redeemed') AND expires_at <= $1", [now()]);
    });
    return { refreshed };
  }

  return { open, orders, createHub, claimStart, claimStatus, claimCancel, redeemClaim, claimConfirm, signIn, run, finishDisconnect, webhook, pass, probe };
}
export type ShopifyNativeWorker = ReturnType<typeof createShopifyNativeWorker>;
