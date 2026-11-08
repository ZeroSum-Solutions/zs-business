/**
 * C-24: shop/redact also anonymises the append-only action history that names a store. A connection's connect and
 * disconnect actions keep the connection (domain and store name) in `payload` and `result`, and outbox events can echo it.
 * The rows stay, so the history is kept; only the store's identity is replaced, with the placeholders the `connections` row gets.
 */
export const REDACTED_DOMAIN = "redacted.invalid";
export const REDACTED = "redacted";

/** Keys that hold a store's display name wherever they appear. */
const NAME_KEYS = new Set(["accountLabel", "account_label", "shopName", "shop_name"]);

export interface StoreIdentity {
  readonly domain: string;
  readonly shopId: string;
  /** Every spelling of the store name known to the database (the install's name and the connections' labels). */
  readonly names: readonly string[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Returns a copy of `value` with the store's domain, shop id and name replaced. Pure; never mutates its input. */
export function redactStoreIdentity(value: unknown, identity: StoreIdentity): unknown {
  const names = new Set(identity.names.map((name) => name.trim().toLowerCase()).filter((name) => name !== ""));
  const domain = new RegExp(escapeRegExp(identity.domain), "gi");
  const gid = new RegExp(escapeRegExp(identity.shopId), "g");
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (names.has(node.trim().toLowerCase())) return REDACTED;
      return node.replace(domain, REDACTED_DOMAIN).replace(gid, REDACTED);
    }
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) out[key] = NAME_KEYS.has(key) && typeof child === "string" ? null : walk(child);
      return out;
    }
    return node;
  };
  return walk(value);
}
