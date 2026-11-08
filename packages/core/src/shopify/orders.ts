// Connections C-23: reading orders over the Admin GraphQL API for the native tier. Original code. The queries ask
// only for the fields the catalog projection keeps and never for the `customer` object: on a live store Shopify
// answers ACCESS_DENIED to it without protected customer data access (found on the preview store, 2026-11-08), so
// the app asks for none. `orderToRest` shapes a GraphQL order like the REST
// record the existing projection already trims (C-6), so both tiers return the same tool output.
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const ORDER_FIELDS = `id legacyResourceId name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus currencyCode
  totalPriceSet { shopMoney { amount } } subtotalPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } }
  lineItems(first: 50) { nodes { title quantity originalUnitPriceSet { shopMoney { amount } } } }`;

export const listOrdersQuery = (): string =>
  `query ListOrders($first: Int!, $query: String) { orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } } }`;
export const getOrderQuery = (): string => `query GetOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;

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
