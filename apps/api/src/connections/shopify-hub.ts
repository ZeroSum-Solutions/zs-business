// Connections C-21, C-22: the hub side of the native Shopify tier, for the worker. `createHub` makes (or finds) the
// tenant `shopify-<numeric shop id>`, its Supabase user and its owner member, all idempotent for the same key and
// email, so a retry after any crash resumes. `signInLink` asks Supabase Auth for a one-time magic link; nothing is
// emailed. It uses the service pool the worker already holds and the Supabase Auth admin API.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { HubPort } from "@zs/core";
import { asService } from "@zs/db";
import { createTenant, tenantIdForKey } from "../tenant-create.js";
import type { SupabaseAuthAdmin } from "../supabase-auth-admin.js";

export function createShopifyHub(deps: {
  readonly pool: Pool;
  readonly auth: SupabaseAuthAdmin;
  readonly clock: { now(): Date };
  /** The hub page a magic link lands on (HUB_SIGN_IN_URL). */
  readonly signInUrl: string;
  readonly generateId?: () => string;
  readonly report?: (event: { readonly kind: "hub_error"; readonly step: string }) => void;
}): HubPort {
  const generateId = deps.generateId ?? randomUUID;
  return {
    async createHub(input) {
      const tenantId = tenantIdForKey(input.key);
      const email = input.ownerEmail.trim().toLowerCase();
      let step = "find_user";
      try {
        const found = await deps.auth.findUser(email);
        if (found?.tenantId && found.tenantId !== tenantId) return { kind: "email_has_hub" };
        step = "read_state";
        const state = await asService(deps.pool, async (tx) => ({
          elsewhere: (await tx.query("SELECT 1 FROM tenant_members WHERE lower(email)=$1 AND tenant_id<>$2 LIMIT 1", [email, tenantId])).rowCount ?? 0,
          name: (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows[0]?.name ?? null,
        }));
        if (state.elsewhere > 0) return { kind: "email_has_hub" };
        if (!found) {
          step = "create_user";
          // No mailbox is involved: the user is confirmed and holds a random password nobody learns; sign-in is by link.
          await deps.auth.createUser({ email, password: randomBytes(32).toString("base64url") });
        }
        step = "create_tenant";
        // A retry keeps the name the tenant already has, so a renamed store cannot trip the rerun check.
        const name = state.name ?? input.name;
        await createTenant({ service: deps.pool, clock: deps.clock, generateId, auth: deps.auth }, { key: input.key, name, ownerEmail: email, dryRun: false });
        return { kind: "ok", tenantId };
      } catch {
        // A create that raced another for the same email lost: the next retry finds the user. No error text is kept.
        deps.report?.({ kind: "hub_error", step });
        return { kind: "failed" };
      }
    },

    async signInLink(email) {
      try {
        return await deps.auth.generateLink({ email: email.trim().toLowerCase(), redirectTo: deps.signInUrl });
      } catch {
        return null;
      }
    },
  };
}
