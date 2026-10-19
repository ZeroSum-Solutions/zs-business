// An in-memory stand-in for one project's Supabase Auth admin API (/auth/v1/admin/users), served
// through an injected fetch. Only the calls src/supabase-auth-admin.ts makes; fake data only.
import { randomUUID } from "node:crypto";

export const FAKE_REF = "abcdefghijklmnopqrst";
export const FAKE_SERVICE_KEY = `sb_secret_${"f".repeat(32)}`;

export interface FakeUser {
  id: string;
  email: string;
  app_metadata: Record<string, unknown>;
  deleted_at?: string | null;
}

export interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

export function fakeGoTrue(options: { ref?: string; serviceKey?: string } = {}) {
  const ref = options.ref ?? FAKE_REF;
  const key = options.serviceKey ?? FAKE_SERVICE_KEY;
  const users = new Map<string, FakeUser>();
  const requests: FakeRequest[] = [];
  /** Set to answer every request with this status (and a body that echoes the key). */
  let failWith: number | null = null;

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ method, url: url.href, headers, body });
    if (url.origin !== `https://${ref}.supabase.co` || !url.pathname.startsWith("/auth/v1/admin/users"))
      return json(404, { code: "not_found" });
    if (failWith !== null) return json(failWith, { code: "unexpected_failure", msg: `echo ${headers.apikey}` });
    if (headers.apikey !== key || headers.authorization !== `Bearer ${key}`) return json(401, { error_code: "no_authorization" });
    const id = url.pathname.split("/")[5];
    if (id === undefined || id === "") {
      if (method === "POST") {
        const user: FakeUser = { id: randomUUID(), email: String(body.email).toLowerCase(), app_metadata: { provider: "email", ...body.app_metadata } };
        users.set(user.id, user);
        return json(200, user);
      }
      const page = Number(url.searchParams.get("page") ?? "1");
      const perPage = Number(url.searchParams.get("per_page") ?? "50");
      const filter = url.searchParams.get("filter") ?? "";
      const all = [...users.values()].filter((user) => user.email.includes(filter));
      return json(200, { aud: "authenticated", users: all.slice((page - 1) * perPage, page * perPage) });
    }
    const user = users.get(id);
    if (!user) return json(404, { error_code: "user_not_found" });
    if (method === "GET") return json(200, user);
    if (method === "PUT") {
      user.app_metadata = { ...user.app_metadata, ...body.app_metadata };
      return json(200, user);
    }
    if (method === "DELETE") {
      users.delete(id);
      return json(200, {});
    }
    return json(405, { code: "method_not_allowed" });
  }) as typeof globalThis.fetch;

  return {
    fetch,
    users,
    requests,
    failAll(status: number | null) {
      failWith = status;
    },
    addUser(email: string, appMetadata: Record<string, unknown> = {}): string {
      const user: FakeUser = { id: randomUUID(), email, app_metadata: { provider: "email", providers: ["email"], ...appMetadata } };
      users.set(user.id, user);
      return user.id;
    },
    claimOf(userId: string): unknown {
      return users.get(userId)?.app_metadata.tenant_id;
    },
  };
}
