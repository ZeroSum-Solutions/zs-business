import { describe, expect, it } from "vitest";
import { GET_ORDER_LINE_ITEMS, listLineItemsPage, listOrdersQuery, orderToRest, getOrderQuery, recentOrdersQuery } from "../../src/shopify/orders.js";
import { requestedQueryCost } from "./query-cost.js";
import { projectOrder, projectOrders } from "../../src/connections/catalog.js";

const node = {
  id: "gid://shopify/Order/1001", legacyResourceId: "1001", name: "#1001", createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T11:00:00Z",
  displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", currencyCode: "USD",
  totalPriceSet: { shopMoney: { amount: "30.00" } }, subtotalPriceSet: { shopMoney: { amount: "25.00" } }, totalTaxSet: { shopMoney: { amount: "5.00" } },
  lineItems: { nodes: [{ title: "Mug", quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "12.50" } } }] },
};

describe("native order reads (C-23)", () => {
  it("maps a GraphQL order to the shape the catalog projection keeps", () => {
    expect(projectOrder(orderToRest(node))).toEqual({ order: {
      id: "1001", name: "#1001", createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T11:00:00Z", financialStatus: "paid", fulfillmentStatus: "unfulfilled",
      currency: "USD", totalPrice: "30.00", subtotalPrice: "25.00", totalTax: "5.00", lineItems: [{ title: "Mug", quantity: 2, price: "12.50" }],
      customer: null } });
  });
  it("answers a null customer and drops an order that does not fit", () => {
    expect(projectOrders({ orders: [orderToRest(node), orderToRest({ nope: true })] })).toEqual({ orders: [expect.objectContaining({ id: "1001", customer: null })] });
  });
  it("never asks for the customer object or any protected field (Shopify answers ACCESS_DENIED without protected data access)", () => {
    const both = `${listOrdersQuery()}${getOrderQuery()}`;
    expect(both).not.toMatch(/customer|email|firstName|lastName|phone|address/i);
  });
});

describe("query cost (Shopify refuses a query over 1,000 requested points)", () => {
  it("counts like the documented example and like a nested connection", () => {
    expect(requestedQueryCost("{ products(first: 1) { edges { node { title } } } }")).toBe(3);
    expect(requestedQueryCost("query Q($n: Int!) { products(first: $n) { nodes { title variants(first: 10) { nodes { price } } } } }", { n: 5 })).toBe(2 + 5 * (1 + 2 + 10));
  });
  it("would have refused 50 orders with 50 line items each (the query before C-30's fix)", () => {
    expect(requestedQueryCost(listOrdersQuery(), { first: 50, query: "", lineItems: 50 })).toBe(7952);
  });
  it("sizes the list's line-item page so every list of 1 to 50 orders fits, and reads one order with 50", () => {
    for (let first = 1; first <= 50; first += 1) {
      const cost = requestedQueryCost(listOrdersQuery(), { first, query: "", lineItems: listLineItemsPage(first) });
      expect(cost, `first ${first}`).toBeLessThanOrEqual(1000);
      expect(requestedQueryCost(listOrdersQuery(), { first, query: "", lineItems: listLineItemsPage(first) + 1 }) > 1000 || listLineItemsPage(first) === 50, `first ${first} uses the room it has`).toBe(true);
    }
    expect([listLineItemsPage(6), listLineItemsPage(10), listLineItemsPage(50)]).toEqual([50, 30, 3]);
    expect(requestedQueryCost(getOrderQuery(), { id: "gid://shopify/Order/1", lineItems: GET_ORDER_LINE_ITEMS })).toBe(159);
  });
  it("asks the embedded page's 50 recent orders for 152 points and selects no line item, ID or customer field", () => {
    expect(requestedQueryCost(recentOrdersQuery(), { first: 50, query: "" })).toBe(152);
    expect(recentOrdersQuery()).not.toMatch(/lineItems|title|legacyResourceId|\bid\b|customer|email|phone|address/i);
  });
});
