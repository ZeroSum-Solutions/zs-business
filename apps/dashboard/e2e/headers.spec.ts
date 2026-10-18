import { expect, test } from "@playwright/test";

test("refuses to be framed on pages and on the API proxy", async ({ request }, info) => {
  test.skip(info.project.name !== "desktop", "HTTP-only check; one project is enough");
  for (const path of ["/", "/customers", "/account/plan", "/api/v1/booking/resources", "/sw.js"]) {
    const response = await request.get(path);
    const headers = response.headers();
    expect(headers["content-security-policy"], path).toContain("frame-ancestors 'none'");
    expect(headers["x-frame-options"], path).toBe("DENY");
  }
});
