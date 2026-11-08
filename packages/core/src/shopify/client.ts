// Connections C-22, C-23: the worker's own Shopify client. Original code. Token exchange (offline, with
// `expiring=1`, and online for the signed-in user), refresh, and the Admin GraphQL endpoint. `fetch`,
// the client secret and the API version come in as arguments; nothing here reads process.env.
// A token or secret never appears in a URL, a thrown message or a result's `reason`.
import { SHOP_DOMAIN } from "./id-token.js";

export interface ShopifyTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly refreshExpiresInSeconds: number;
  readonly scope: string;
}
export interface ShopifyUser {
  readonly id: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly accountOwner: boolean;
}
export interface ShopifyShop {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
}
export type ShopifyFailure = "invalid_grant" | "non_expiring" | "unauthorized" | "forbidden" | "rate_limited" | "unavailable";
export type ShopifyResult<T> = ({ readonly kind: "ok" } & T) | { readonly kind: "failed"; readonly reason: ShopifyFailure };

export interface ShopifyClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Pinned, e.g. `2026-10`. */
  readonly apiVersion: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const MAX_BYTES = 512 * 1024;
const TOKEN_EXCHANGE = "urn:ietf:params:oauth:grant-type:token-exchange";
const ID_TOKEN = "urn:ietf:params:oauth:token-type:id_token";
const OFFLINE = "urn:shopify:params:oauth:token-type:offline-access-token";
const ONLINE = "urn:shopify:params:oauth:token-type:online-access-token";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const str = (value: unknown, max = 4096): string | undefined => (typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined);
const seconds = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value > 0 && value < 2 ** 31 ? value : undefined);

export function createShopifyClient(config: ShopifyClientConfig) {
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 6000;

  async function send(shop: string, path: string, init: { headers: Record<string, string>; body: string }, signal?: AbortSignal): Promise<{ status: number; json: unknown } | "network"> {
    if (!SHOP_DOMAIN.test(shop)) throw new Error("Not a myshopify.com domain");
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const response = await doFetch(`https://${shop}${path}`, {
        method: "POST", redirect: "error", headers: { accept: "application/json", "content-type": "application/json", ...init.headers }, body: init.body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      const text = await readBounded(response);
      let json: unknown = null;
      try { json = text === "" ? null : JSON.parse(text); } catch { json = null; }
      return { status: response.status, json };
    } catch {
      return "network";
    }
  }
  async function readBounded(response: Response): Promise<string> {
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) { await reader.cancel().catch(() => undefined); throw new Error("too large"); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  /** 400/401 from the token endpoint means the grant is dead, unless Shopify names our own client credentials as the fault. */
  const grantDead = (answer: { status: number; json: unknown }): boolean =>
    (answer.status === 400 || answer.status === 401) && record(answer.json)?.["error"] !== "invalid_client";
  const failure = (status: number): ShopifyFailure => status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 429 ? "rate_limited" : "unavailable";

  async function token(shop: string, body: Record<string, unknown>, signal?: AbortSignal) {
    return send(shop, "/admin/oauth/access_token", { headers: {}, body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, ...body }) }, signal);
  }
  function offlineTokens(json: unknown): ShopifyTokens | undefined {
    const o = record(json);
    const accessToken = str(o?.["access_token"]);
    const refreshToken = str(o?.["refresh_token"]);
    const expiresInSeconds = seconds(o?.["expires_in"]);
    const refreshExpiresInSeconds = seconds(o?.["refresh_token_expires_in"]);
    if (!accessToken || !refreshToken || !expiresInSeconds || !refreshExpiresInSeconds) return undefined;
    return { accessToken, refreshToken, expiresInSeconds, refreshExpiresInSeconds, scope: str(o?.["scope"], 1000) ?? "" };
  }

  return {
    /** S3: ID token to an expiring offline token. A token without a refresh token is refused (3.1.2). */
    async exchangeOffline(shop: string, idToken: string, signal?: AbortSignal): Promise<ShopifyResult<{ tokens: ShopifyTokens }>> {
      const answer = await token(shop, { grant_type: TOKEN_EXCHANGE, subject_token: idToken, subject_token_type: ID_TOKEN, requested_token_type: OFFLINE, expiring: 1 }, signal);
      if (answer === "network") return { kind: "failed", reason: "unavailable" };
      if (grantDead(answer)) return { kind: "failed", reason: "invalid_grant" };
      if (answer.status !== 200) return { kind: "failed", reason: failure(answer.status) };
      const tokens = offlineTokens(answer.json);
      return tokens ? { kind: "ok", tokens } : { kind: "failed", reason: "non_expiring" };
    },
    /** S3: the signed-in user, for the owner check. The online token itself is dropped. */
    async exchangeOnline(shop: string, idToken: string, signal?: AbortSignal): Promise<ShopifyResult<{ user: ShopifyUser }>> {
      const answer = await token(shop, { grant_type: TOKEN_EXCHANGE, subject_token: idToken, subject_token_type: ID_TOKEN, requested_token_type: ONLINE }, signal);
      if (answer === "network") return { kind: "failed", reason: "unavailable" };
      if (grantDead(answer)) return { kind: "failed", reason: "invalid_grant" };
      if (answer.status !== 200) return { kind: "failed", reason: failure(answer.status) };
      const user = record(record(answer.json)?.["associated_user"]);
      const id = user?.["id"];
      if (user === undefined || (typeof id !== "number" && typeof id !== "string")) return { kind: "failed", reason: "unavailable" };
      const email = str(user["email"], 320);
      return { kind: "ok", user: { id: String(id), email: email ?? null, emailVerified: user["email_verified"] === true, accountOwner: user["account_owner"] === true } };
    },
    /** S2: the stored refresh token for a new pair. 401/400 means the merchant must reopen the app. */
    async refresh(shop: string, refreshToken: string, signal?: AbortSignal): Promise<ShopifyResult<{ tokens: ShopifyTokens }>> {
      const answer = await token(shop, { grant_type: "refresh_token", refresh_token: refreshToken }, signal);
      if (answer === "network") return { kind: "failed", reason: "unavailable" };
      if (grantDead(answer)) return { kind: "failed", reason: "invalid_grant" };
      if (answer.status !== 200) return { kind: "failed", reason: failure(answer.status) };
      const tokens = offlineTokens(answer.json);
      return tokens ? { kind: "ok", tokens } : { kind: "failed", reason: "unavailable" };
    },
    /** One GraphQL call with an offline token. Top-level errors map to our failure reasons; data is the `data` object. */
    async graphql(shop: string, accessToken: string, query: string, variables: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ShopifyResult<{ data: Record<string, unknown> }>> {
      const answer = await send(shop, `/admin/api/${config.apiVersion}/graphql.json`, { headers: { "x-shopify-access-token": accessToken }, body: JSON.stringify({ query, variables }) }, signal);
      if (answer === "network") return { kind: "failed", reason: "unavailable" };
      if (answer.status !== 200) return { kind: "failed", reason: failure(answer.status) };
      const root = record(answer.json);
      const errors = root?.["errors"];
      if (Array.isArray(errors) && errors.length > 0) {
        const codes = errors.map((error) => str(record(record(error)?.["extensions"])?.["code"], 60));
        if (codes.includes("THROTTLED")) return { kind: "failed", reason: "rate_limited" };
        if (codes.includes("ACCESS_DENIED")) return { kind: "failed", reason: "forbidden" };
        return { kind: "failed", reason: "unavailable" };
      }
      const data = record(root?.["data"]);
      return data ? { kind: "ok", data } : { kind: "failed", reason: "unavailable" };
    },
    async readShop(shop: string, accessToken: string, signal?: AbortSignal): Promise<ShopifyResult<{ shop: ShopifyShop }>> {
      const out = await this.graphql(shop, accessToken, "query { shop { id name myshopifyDomain } }", {}, signal);
      if (out.kind !== "ok") return out;
      const s = record(out.data["shop"]);
      const id = str(s?.["id"], 100);
      const name = str(s?.["name"], 500);
      const domain = str(s?.["myshopifyDomain"], 253)?.toLowerCase();
      if (!id || !/^gid:\/\/shopify\/Shop\/[0-9]{1,20}$/.test(id) || !name || !domain || !SHOP_DOMAIN.test(domain)) return { kind: "failed", reason: "unavailable" };
      return { kind: "ok", shop: { id, name, domain } };
    },
    /** C-13: the app removes itself. Only a clean answer with the app id and no userErrors counts. */
    async uninstall(shop: string, accessToken: string, signal?: AbortSignal): Promise<ShopifyResult<Record<never, never>>> {
      const out = await this.graphql(shop, accessToken, "mutation { appUninstall { app { id } userErrors { field message } } }", {}, signal);
      if (out.kind !== "ok") return out;
      const payload = record(out.data["appUninstall"]);
      const clean = payload !== undefined && Array.isArray(payload["userErrors"]) && payload["userErrors"].length === 0 && typeof record(payload["app"])?.["id"] === "string";
      return clean ? { kind: "ok" } : { kind: "failed", reason: "unavailable" };
    },
  };
}
export type ShopifyClient = ReturnType<typeof createShopifyClient>;
