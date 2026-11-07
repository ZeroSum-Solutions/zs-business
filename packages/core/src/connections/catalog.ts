// Connections C-6: the managed-tier catalog, in code. For each toolkit: the identity tool, the
// allowlisted read tools with their Composio slug, the toolkit version every call pins, the strict
// input schema (in contracts, the one callers see), and an output projection that keeps only named
// fields. Callers outside the adapter never see a slug or a version (C-1).
//
// C-6, C-17: the slugs and the version below were read from Composio's tool registry on 2026-11-07
// (`GET /tools/<slug>`): every tool is live, not deprecated and tagged read-only, and the response
// shapes follow each tool's published output schema, recorded with fake responses in the tests. The
// owner-run `pnpm connections:check-catalog` (vault key) re-checks each slug and version. A version
// change is a code change with a new recorded response.
import { z } from "zod";
import {
  SHOPIFY_GET_ORDER_TOOL,
  SHOPIFY_LIST_ORDERS_TOOL,
  SHOPIFY_MAX_RANGE_MS,
  SHOPIFY_TOOLKIT,
  shopifyGetOrderInputSchema,
  shopifyListOrdersInputSchema,
} from "@zs/contracts";

export interface CatalogTool {
  /** Our name (`<toolkit>_<verb>`, at most 40 characters). */
  readonly name: string;
  /** Composio's tool slug. Never leaves the adapter. */
  readonly slug: string;
  /** The toolkit version every call sends; a missing version is an error. */
  readonly version: string;
  /** Strict: unknown fields are refused, at the API and again at the worker. */
  readonly input: z.ZodType<Record<string, unknown>>;
  /** The arguments Composio's tool takes, built only from the parsed input. */
  readonly toArguments: (input: Record<string, unknown>, now: Date) => Record<string, unknown>;
  /** Keeps only the named output fields; undefined when the data does not fit the schema. */
  readonly project: (data: unknown) => unknown;
  /** Where in the projected output a list may be cut from its tail to fit the size cap. */
  readonly listPath: readonly string[];
}
export interface CatalogIdentity {
  readonly slug: string;
  readonly version: string;
  /** Fixed arguments for the identity call; never built from caller input. */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly project: (data: unknown) => { readonly externalAccountId: string; readonly name: string; readonly domain: string } | undefined;
}
export interface CatalogToolkit {
  readonly toolkit: string;
  readonly identity: CatalogIdentity;
  /** What the link call sends beside the auth config: the shop the member named. */
  readonly linkData: (shopDomain: string) => Record<string, string>;
  readonly tools: readonly CatalogTool[];
}

const MAX_ORDERS = 50;
const MAX_LINE_ITEMS = 250;
const idLike = z.union([z.string().min(1).max(64), z.number().int()]).transform((value) => String(value));
const text = z.string().max(2000).nullish().transform((value) => value ?? null);
const money = z.union([z.string().max(64), z.number()]).nullish().transform((value) => (value === null || value === undefined ? null : String(value)));
const lineItem = z.object({
  title: text,
  quantity: z.number().int().nullish().transform((value) => value ?? null),
  price: money,
});
const customer = z.object({
  id: idLike,
  first_name: text,
  last_name: text,
  email: text,
}).nullish().transform((value) => {
  if (!value) return null;
  const name = [value.first_name, value.last_name].filter((part): part is string => part !== null && part !== "").join(" ");
  return { id: value.id, name: name === "" ? null : name, email: value.email };
});
const order = z.object({
  id: idLike,
  name: text,
  created_at: text,
  updated_at: text,
  financial_status: text,
  fulfillment_status: text,
  currency: text,
  total_price: money,
  subtotal_price: money,
  total_tax: money,
  // C-9: one line item that does not fit is dropped, not the order; at most 250 are kept and the size
  // trim cuts further.
  line_items: z.array(z.unknown()).nullish().transform((value) => (value ?? []).slice(0, MAX_LINE_ITEMS).flatMap((item) => {
    const parsed = lineItem.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  })),
  customer,
}).transform((value) => ({
  id: value.id,
  name: value.name,
  createdAt: value.created_at,
  updatedAt: value.updated_at,
  financialStatus: value.financial_status,
  fulfillmentStatus: value.fulfillment_status,
  currency: value.currency,
  totalPrice: value.total_price,
  subtotalPrice: value.subtotal_price,
  totalTax: value.total_tax,
  lineItems: value.line_items,
  customer: value.customer,
}));

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * C-6, C-9: at most 50 orders, each projected on its own, so one order that does not fit is left out
 * instead of failing the answer.
 */
const projectOrders = (data: unknown): unknown => {
  const list = Array.isArray(data) ? data : record(data)?.["orders"];
  if (!Array.isArray(list)) return undefined;
  const orders: unknown[] = [];
  for (const item of list) {
    if (orders.length >= MAX_ORDERS) break;
    const parsed = order.safeParse(item);
    if (parsed.success) orders.push(parsed.data);
  }
  return { orders };
};
const projectOrder = (data: unknown): unknown => {
  const parsed = order.safeParse(data);
  return parsed.success ? { order: parsed.data } : undefined;
};

// The shop query answers over GraphQL: the id is a global id (`gid://shopify/Shop/<number>`), and we keep
// only its number, the same account id the REST API gives.
const SHOP_GID = /^gid:\/\/shopify\/Shop\/([0-9]{1,20})$/;
const shopDetails = z.object({ id: z.string().min(1).max(100), name: z.string().min(1).max(500), myshopifyDomain: z.string().min(1).max(253) });

const SHOPIFY_VERSION = "20261104_00";

const shopify: CatalogToolkit = {
  toolkit: SHOPIFY_TOOLKIT,
  identity: {
    slug: "SHOPIFY_QUERY_SHOP",
    version: SHOPIFY_VERSION,
    arguments: Object.freeze({ fields: "id name myshopifyDomain" }),
    project(data) {
      const parsed = shopDetails.safeParse(record(data)?.["shop"]);
      const id = parsed.success ? SHOP_GID.exec(parsed.data.id)?.[1] : undefined;
      if (!parsed.success || id === undefined) return undefined;
      return { externalAccountId: id, name: parsed.data.name, domain: parsed.data.myshopifyDomain.toLowerCase() };
    },
  },
  linkData: (shopDomain) => ({ shop: shopDomain.replace(/\.myshopify\.com$/, "") }),
  tools: [
    {
      name: SHOPIFY_LIST_ORDERS_TOOL,
      slug: "SHOPIFY_GET_ORDERS_WITH_FILTERS",
      version: SHOPIFY_VERSION,
      input: shopifyListOrdersInputSchema as unknown as z.ZodType<Record<string, unknown>>,
      toArguments(input, now) {
        const parsed = shopifyListOrdersInputSchema.parse(input);
        // C-6: a range of at most 92 days, whichever bounds the caller gave.
        const end = parsed.createdBefore ? Date.parse(parsed.createdBefore) : parsed.createdAfter ? Math.min(Date.parse(parsed.createdAfter) + SHOPIFY_MAX_RANGE_MS, Math.max(now.getTime(), Date.parse(parsed.createdAfter) + 1)) : now.getTime();
        const start = parsed.createdAfter ? Date.parse(parsed.createdAfter) : end - SHOPIFY_MAX_RANGE_MS;
        return {
          created_at_min: new Date(start).toISOString(),
          created_at_max: new Date(end).toISOString(),
          status: parsed.status ?? "any",
          limit: parsed.limit ?? 50,
        };
      },
      project: projectOrders,
      listPath: ["orders"],
    },
    {
      name: SHOPIFY_GET_ORDER_TOOL,
      slug: "SHOPIFY_GET_ORDER",
      version: SHOPIFY_VERSION,
      input: shopifyGetOrderInputSchema as unknown as z.ZodType<Record<string, unknown>>,
      toArguments: (input) => ({ order_id: shopifyGetOrderInputSchema.parse(input).orderId }),
      project: projectOrder,
      listPath: ["order", "lineItems"],
    },
  ],
};

export const COMPOSIO_CATALOG: readonly CatalogToolkit[] = Object.freeze([shopify]);
export const catalogToolkit = (toolkit: string): CatalogToolkit | undefined => COMPOSIO_CATALOG.find((entry) => entry.toolkit === toolkit);
export const catalogTool = (toolkit: string, name: string): CatalogTool | undefined =>
  catalogToolkit(toolkit)?.tools.find((entry) => entry.name === name);

/** Keys a caller must never reach Composio's execute call through (C-3): refused before any schema. */
export const OVERRIDE_KEYS: ReadonlySet<string> = new Set([
  "custom_auth_params", "custom_connection_data", "text", "instant_account", "connected_account_id", "user_id", "version", "arguments",
]);
