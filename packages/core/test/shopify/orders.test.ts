import { describe, expect, it } from "vitest";
import { listOrdersQuery, orderToRest, getOrderQuery } from "../../src/shopify/orders.js";
import { projectOrder, projectOrders } from "../../src/connections/catalog.js";

const node = {
  id: "gid://shopify/Order/1001", legacyResourceId: "1001", name: "#1001", createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T11:00:00Z",
  displayFinancialStatus: "PAID", displayFulfillmentStatus: "UNFULFILLED", currencyCode: "USD",
  totalPriceSet: { shopMoney: { amount: "30.00" } }, subtotalPriceSet: { shopMoney: { amount: "25.00" } }, totalTaxSet: { shopMoney: { amount: "5.00" } },
  lineItems: { nodes: [{ title: "Mug", quantity: 2, originalUnitPriceSet: { shopMoney: { amount: "12.50" } } }] },
  customer: { id: "gid://shopify/Customer/55" },
};

describe("native order reads (C-23)", () => {
  it("maps a GraphQL order to the shape the catalog projection keeps", () => {
    expect(projectOrder(orderToRest(node))).toEqual({ order: {
      id: "1001", name: "#1001", createdAt: "2026-11-01T10:00:00Z", updatedAt: "2026-11-01T11:00:00Z", financialStatus: "paid", fulfillmentStatus: "unfulfilled",
      currency: "USD", totalPrice: "30.00", subtotalPrice: "25.00", totalTax: "5.00", lineItems: [{ title: "Mug", quantity: 2, price: "12.50" }],
      customer: { id: "55", name: null, email: null } } });
  });
  it("keeps a missing customer null and drops an order that does not fit", () => {
    expect(projectOrders({ orders: [orderToRest({ ...node, customer: null }), orderToRest({ nope: true })] })).toEqual({ orders: [expect.objectContaining({ id: "1001", customer: null })] });
  });
  it("asks only for the customer id, never a protected field", () => {
    const query = listOrdersQuery();
    expect(query).toContain("customer { id }");
    expect(`${query}${getOrderQuery()}`).not.toMatch(/email|firstName|lastName|phone|address/i);
  });
});
