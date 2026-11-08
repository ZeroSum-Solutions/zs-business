import { describe, expect, it } from "vitest";
import { createSupabaseAuthAdmin } from "../src/supabase-auth-admin.js";

// Connections C-21: the reviewer / owner sign-in link is built from generate_link's `hashed_token` and lands on the
// dashboard's server-side /auth/confirm (Supabase's own action_link returns the session in a URL fragment).
const REF = "abcdefghijklmnopqrst";
const KEY = "sb_secret_" + "k".repeat(24);

function admin(reply: { status: number; body: unknown }, seen: { url?: string; body?: unknown } = {}) {
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return createSupabaseAuthAdmin({ projectRef: REF, serviceKey: KEY, fetch: fetchStub });
}

describe("SupabaseAuthAdmin.generateLink", () => {
  it("builds the dashboard confirm URL from hashed_token and never uses action_link", async () => {
    const seen: { url?: string; body?: unknown } = {};
    const link = await admin({ status: 200, body: { hashed_token: "abc123_-", action_link: "https://x.supabase.co/auth/v1/verify?token=raw", email_otp: "123456" } }, seen)
      .generateLink({ email: "owner@example.com", confirmUrl: "https://app.example.com/auth/confirm?old=1#frag" });
    expect(seen.url).toBe(`https://${REF}.supabase.co/auth/v1/admin/generate_link`);
    expect(seen.body).toEqual({ type: "magiclink", email: "owner@example.com" });
    expect(link).toBe("https://app.example.com/auth/confirm?token_hash=abc123_-&type=magiclink&next=%2F");
    expect(link).not.toContain("supabase.co");
    expect(link).not.toContain("123456");
  });

  it("returns null for a failed call, a missing token, an oversized token or a non-https confirm URL", async () => {
    const ok = "https://app.example.com/auth/confirm";
    expect(await admin({ status: 500, body: {} }).generateLink({ email: "a@b.co", confirmUrl: ok })).toBeNull();
    expect(await admin({ status: 200, body: { action_link: "https://x/y" } }).generateLink({ email: "a@b.co", confirmUrl: ok })).toBeNull();
    expect(await admin({ status: 200, body: { hashed_token: "x".repeat(513) } }).generateLink({ email: "a@b.co", confirmUrl: ok })).toBeNull();
    expect(await admin({ status: 200, body: { hashed_token: "t" } }).generateLink({ email: "a@b.co", confirmUrl: "http://app.example.com/auth/confirm" })).toBeNull();
    expect(await admin({ status: 200, body: { hashed_token: "t" } }).generateLink({ email: "a@b.co", confirmUrl: "not a url" })).toBeNull();
  });
});
