// The Supabase Auth admin API (GoTrue /auth/v1/admin) for owner-run hosted scripts: hosted
// owner provisioning, the hosted seed and check:hosted. Authenticates with the project's
// service_role (secret) key, which never appears in an error, a log or a receipt. Users are
// found and changed only through this API, never by reading auth.users.
import { z } from "zod";
import type { AuthAdmin } from "./provision-owner.js";

const PROJECT_REF = /^[a-z]{20}$/;
/** GoTrue error codes are short snake_case words; anything else in a reply is not echoed. */
const ERROR_CODE = /^[a-z0-9_]{1,64}$/;

function refuse(reason: string): never {
  throw new Error(`Refusing to run: ${reason}`);
}

/**
 * The service key must belong to the project the scripts target. A legacy service_role JWT
 * names its project in the `ref` claim, checked here (the signature is the server's to check).
 * A new opaque secret key (`sb_secret_...`) carries no project, so the URL binds it: the Auth
 * API of another project refuses it. Never echoes the value.
 */
export function assertServiceKey(value: string | undefined, projectRef: string): string {
  if (!PROJECT_REF.test(projectRef)) refuse("ZS_TARGET_REF must be a Supabase project ref");
  const key = value?.trim() ?? "";
  if (!key) refuse("SUPABASE_SERVICE_ROLE_KEY is required");
  if (/^sb_secret_[A-Za-z0-9_-]{16,}$/.test(key)) return key;
  const parts = key.split(".");
  if (parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part))) {
    let claims: { role?: unknown; ref?: unknown } = {};
    try {
      claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as typeof claims;
    } catch {
      // Falls through to the refusal below.
    }
    if (claims.role === "service_role" && claims.ref === projectRef) return key;
    refuse(`SUPABASE_SERVICE_ROLE_KEY is not the service_role key of project ${projectRef}`);
  }
  refuse("SUPABASE_SERVICE_ROLE_KEY is not a Supabase service_role JWT or sb_secret_ key");
}

export class AuthAdminError extends Error {
  constructor(operation: string, problem: string) {
    super(`Supabase Auth admin ${operation} failed: ${problem}`);
    this.name = "AuthAdminError";
  }
}

const userSchema = z.object({
  id: z.uuid(),
  email: z.string().nullish(),
  app_metadata: z.record(z.string(), z.unknown()).nullish(),
  deleted_at: z.string().nullish(),
});
type AdminUser = z.infer<typeof userSchema>;
const userListSchema = z.object({ users: z.array(userSchema) });

export interface SupabaseAuthAdminOptions {
  readonly projectRef: string;
  /** The service_role key; pass it through assertServiceKey first. */
  readonly serviceKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  /** Users per list page while searching by email; GoTrue's default is 50. */
  readonly perPage?: number;
  /** Stop searching after this many pages rather than walk an unbounded list. */
  readonly maxPages?: number;
}

export interface SupabaseAuthAdmin extends AuthAdmin {
  /** The user's app_metadata.tenant_id, or null when unset or the user is gone. */
  readTenantClaim(userId: string): Promise<string | null>;
  /** A confirmed user with a password (no email is sent); returns its id. */
  createUser(input: { email: string; password: string; appMetadata?: Record<string, unknown> }): Promise<string>;
  deleteUser(userId: string): Promise<void>;
}

function tenantClaimOf(user: AdminUser, operation: string): string | null {
  const claim = user.app_metadata?.tenant_id;
  if (claim === undefined || claim === null) return null;
  if (typeof claim !== "string") throw new AuthAdminError(operation, "the user's app_metadata.tenant_id is not a string");
  return claim;
}

export function createSupabaseAuthAdmin(options: SupabaseAuthAdminOptions): SupabaseAuthAdmin {
  if (!PROJECT_REF.test(options.projectRef)) refuse("ZS_TARGET_REF must be a Supabase project ref");
  const base = `https://${options.projectRef}.supabase.co/auth/v1/admin/users`;
  const doFetch = options.fetch ?? fetch;
  const perPage = options.perPage ?? 200;
  const maxPages = options.maxPages ?? 100;

  async function request(operation: string, url: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: init.method ?? "GET",
        headers: {
          apikey: options.serviceKey,
          Authorization: `Bearer ${options.serviceKey}`,
          Accept: "application/json",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
    } catch {
      throw new AuthAdminError(operation, "no answer from Supabase Auth");
    }
    const body: unknown = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  function failure(operation: string, reply: { status: number; body: unknown }): AuthAdminError {
    const record = (reply.body ?? {}) as { error_code?: unknown; code?: unknown };
    const code = [record.error_code, record.code].find((value): value is string => typeof value === "string" && ERROR_CODE.test(value));
    return new AuthAdminError(operation, `HTTP ${reply.status}${code ? ` (${code})` : ""}`);
  }

  function parseUser(operation: string, body: unknown): AdminUser {
    const parsed = userSchema.safeParse(body);
    if (!parsed.success) throw new AuthAdminError(operation, "the reply is not a user");
    return parsed.data;
  }

  const userUrl = (userId: string) => `${base}/${encodeURIComponent(z.uuid().parse(userId))}`;

  return {
    async findUser(email) {
      const wanted = email.trim().toLowerCase();
      const matches: AdminUser[] = [];
      // `filter` narrows the list on GoTrue (a LIKE over email); the exact comparison below
      // decides, so a server that ignores the filter only costs more pages.
      for (let page = 1; ; page += 1) {
        if (page > maxPages) throw new AuthAdminError("find user", `more than ${maxPages} pages of users; refusing to guess`);
        const url = `${base}?page=${page}&per_page=${perPage}&filter=${encodeURIComponent(wanted)}`;
        const reply = await request("find user", url);
        if (reply.status !== 200) throw failure("find user", reply);
        const list = userListSchema.safeParse(reply.body);
        if (!list.success) throw new AuthAdminError("find user", "the reply is not a user list");
        matches.push(...list.data.users.filter((user) => !user.deleted_at && user.email?.trim().toLowerCase() === wanted));
        if (list.data.users.length < perPage) break;
      }
      if (matches.length > 1) throw new AuthAdminError("find user", "more than one user has this email");
      const user = matches[0];
      return user ? { id: user.id, tenantId: tenantClaimOf(user, "find user") } : null;
    },

    async setTenantClaim(userId, tenantId) {
      // GoTrue merges app_metadata key by key, so the other keys (provider, providers) stay.
      const reply = await request("set tenant claim", userUrl(userId), { method: "PUT", body: { app_metadata: { tenant_id: tenantId } } });
      if (reply.status !== 200) throw failure("set tenant claim", reply);
      if (tenantClaimOf(parseUser("set tenant claim", reply.body), "set tenant claim") !== tenantId)
        throw new AuthAdminError("set tenant claim", "the user returned does not carry the new claim");
    },

    async readTenantClaim(userId) {
      const reply = await request("read user", userUrl(userId));
      if (reply.status === 404) return null;
      if (reply.status !== 200) throw failure("read user", reply);
      const user = parseUser("read user", reply.body);
      return user.deleted_at ? null : tenantClaimOf(user, "read user");
    },

    async createUser(input) {
      const reply = await request("create user", base, {
        method: "POST",
        body: { email: input.email, password: input.password, email_confirm: true, app_metadata: input.appMetadata ?? {} },
      });
      if (reply.status !== 200 && reply.status !== 201) throw failure("create user", reply);
      return parseUser("create user", reply.body).id;
    },

    async deleteUser(userId) {
      const reply = await request("delete user", userUrl(userId), { method: "DELETE" });
      if (reply.status !== 200 && reply.status !== 204) throw failure("delete user", reply);
    },
  };
}

/** Password sign-in with the anon key, as a browser would; returns the access token. */
export async function signInWithPassword(
  options: { projectRef: string; anonKey: string; fetch?: typeof fetch; timeoutMs?: number },
  email: string,
  password: string,
): Promise<string> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(`https://${options.projectRef}.supabase.co/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: options.anonKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ email, password }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw new Error("Supabase Auth sign-in failed: no answer");
  }
  const body = await response.json().catch(() => null) as { access_token?: unknown } | null;
  if (response.status !== 200 || typeof body?.access_token !== "string") throw new Error(`Supabase Auth sign-in failed: HTTP ${response.status}`);
  return body.access_token;
}
