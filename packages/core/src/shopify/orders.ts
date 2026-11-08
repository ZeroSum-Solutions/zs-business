// Connections C-23: reading orders over the Admin GraphQL API for the native tier. Original code. The queries ask
// only for the fields the catalog projection keeps, and for the customer's id alone, so a store at protected
// customer data Level 1 never answers an access error. `orderToRest` shapes a GraphQL order like the REST
// record the existing projection already trims (C-6), so both tiers return the same tool output.
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const ORDER_FIELDS = `id legacyResourceId name createdAt updatedAt displayFinancialStatus displayFulfillmentStatus currencyCode
  totalPriceSet { shopMoney { amount } } subtotalPriceSet { shopMoney { amount } } totalTaxSet { shopMoney { amount } }
  lineItems(first: 50) { nodes { title quantity originalUnitPriceSet { shopMoney { amount } } } }
  customer { id }`;

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
const customerId = (value: unknown): string | null => {
  const id = record(value)?.["id"];
  const match = typeof id === "string" ? /^gid:\/\/shopify\/Customer\/([0-9]{1,20})$/.exec(id) : null;
  return match ? match[1]! : null;
};

export function orderToRest(node: unknown): Record<string, unknown> {
  const o = record(node) ?? {};
  const items = record(o["lineItems"])?.["nodes"];
  const customer = customerId(o["customer"]);
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
    customer: customer === null ? null : { id: customer, first_name: null, last_name: null, email: null },
  };
}
