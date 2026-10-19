import { describe, expect, it } from "vitest";
import { requestSignOut } from "../src/lib/session";

type Call = { url: string; init: RequestInit | undefined };

function fakeFetch(answer: () => Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  }) as typeof fetch;
  return { impl, calls };
}

describe("requestSignOut", () => {
  it("posts /api/sign-out with the same-origin cookies and is done on a 204", async () => {
    const fake = fakeFetch(async () => new Response(null, { status: 204 }));
    expect(await requestSignOut(fake.impl)).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.url).toBe("/api/sign-out");
    expect(fake.calls[0]!.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
  });

  it("is not done when Supabase could not be told (502), or on any other non-2xx answer", async () => {
    for (const status of [502, 500, 403, 405]) {
      const fake = fakeFetch(async () => Response.json({ error: "unavailable" }, { status }));
      expect(await requestSignOut(fake.impl), String(status)).toBe(false);
    }
  });

  it("is not done when the request never got an answer", async () => {
    const fake = fakeFetch(async () => { throw new TypeError("Failed to fetch"); });
    expect(await requestSignOut(fake.impl)).toBe(false);
  });
});
