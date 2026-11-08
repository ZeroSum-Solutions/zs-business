// Connections C-23: reading orders over the Admin GraphQL API for the native tier. Original code. The queries ask
// only for the fields the catalog projection keeps and never for the `customer` object: on a live store Shopify
// answers ACCESS_DENIED to it without protected customer data access (found on the preview store, 2026-11-08), so
// the app asks for none. `orderToRest` shapes a GraphQL order like the REST
// record the existing projection already trims (C-6), so both tiers return the same tool output.
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

// Shopify refuses, before running it, any query whose requested cost is over 1,000 points (shopify.dev, GraphQL Admin
// API rate limits, "Single query limit"). Requested cost by the documented defaults: a scalar or enum is 0, an object
// 1, and a connection 2 plus `first` times the cost of one node. So 50 orders with 50 line items each would ask for
// about 7,950 points and never run; the list below sizes its line-item page to fit (test/shopify/query-cost.ts checks it).
export const SHOPIFY_MAX_QUERY_COST = 1000;
const MAX_LINE_ITEMS_PAGE = 50;
/** One order node of ORDER_FIELDS without line items: the order (1) and three money bags with their money (2 each). */
const ORDER_NODE_COST = 7;
/** The line-item connection (2) plus, per line item, the item (1) and its money bag with its money (2). */
const LINE_ITEMS_BASE_COST = 2;
const LINE_ITEM_COST = 3;

const ORDER_FIELDS = `id legacyResourceId name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus currencyCode
  totalPriceSet { shopMoney { amount } } subtotalPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } }
  lineItems(first: $lineItems) { nodes { title quantity originalUnitPriceSet { shopMoney { amount } } } }`;

/**
 * C-23: how many line items per order a list of `first` orders can ask for and stay within Shopify's single-query cost:
 * 50 up to 6 orders, 30 at 10, 3 at 50. `shopify_get_order` reads one order with up to 50.
 */
export function listLineItemsPage(first: number): number {
  const perOrder = Math.floor((SHOPIFY_MAX_QUERY_COST - 2) / Math.max(1, first));
  return Math.max(0, Math.min(MAX_LINE_ITEMS_PAGE, Math.floor((perOrder - ORDER_NODE_COST - LINE_ITEMS_BASE_COST) / LINE_ITEM_COST)));
}

/** Variables: `first`, `query` and `lineItems` (from `listLineItemsPage(first)`). */
export const listOrdersQuery = (): string =>
  `query ListOrders($first: Int!, $query: String, $lineItems: Int!) { orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`;
/** Variables: `id` and `lineItems` (50). */
export const getOrderQuery = (): string => `query GetOrder($id: ID!, $lineItems: Int!) { order(id: $id) { ${ORDER_FIELDS} } }`;
export const GET_ORDER_LINE_ITEMS = MAX_LINE_ITEMS_PAGE;

/**
 * C-30: the embedded page's recent orders. Only what the table and the summary show: no line items (a custom item title
 * can carry a buyer's text), no IDs, no customer. 50 orders ask for 2 + 50 x 3 = 152 points.
 */
export const recentOrdersQuery = (): string =>
  "query RecentOrders($first: Int!, $query: String) { orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { name createdAt displayFinancialStatus displayFulfillmentStatus currencyCode totalPriceSet { shopMoney { amount } } } } }";

/** Shopify's order search syntax: a created-at range and a status. Values come from parsed input only. */
export function listOrdersSearch(input: { start: Date; end: Date; status: "open" | "closed" | "cancelled" | "any" }): string {
  const parts = [`created_at:>='${input.start.toISOString()}'`, `created_at:<='${input.end.toISOString()}'`];
  if (input.status !== "any") parts.push(`status:${input.status}`);
  return parts.join(" ");
}

const amount = (set: unknown): string | null => {
  const value = record(record(set)?.["shopMoney"])?.["amount"];
  return typeof value === "string" ? value : null;
};
const lower = (value: unknown): string | null => (typeof value === "string" ? value.toLowerCase() : null);

export function orderToRest(node: unknown): Record<string, unknown> {
  const o = record(node) ?? {};
  const items = record(o["lineItems"])?.["nodes"];
  return {
    id: o["legacyResourceId"],
    name: o["name"],
    created_at: o["createdAt"],
    updated_at: o["updatedAt"],
    financial_status: lower(o["displayFinancialStatus"]),
    fulfillment_status: lower(o["displayFulfillmentStatus"]),
    currency: o["currencyCode"],
    total_price: amount(o["totalPriceSet"]),
    subtotal_price: amount(o["subtotalPriceSet"]),
    total_tax: amount(o["totalTaxSet"]),
    line_items: Array.isArray(items) ? items.map((item) => {
      const i = record(item);
      return { title: i?.["title"], quantity: i?.["quantity"], price: amount(i?.["originalUnitPriceSet"]) };
    }) : [],
    customer: null,
  };
}
