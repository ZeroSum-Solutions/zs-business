// Connections C-21, C-22: the hub side of the native Shopify tier, for the worker. `createHub` makes (or finds) the
// tenant `shopify-<numeric shop id>`, its Supabase user and its owner member, all idempotent for the same key and
// email, so a retry after any crash resumes. `signInLink` asks Supabase Auth for a one-time token and builds the dashboard's /auth/confirm link from it; nothing is
// emailed. It uses the service pool the worker already holds and the Supabase Auth admin API.
import { randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { HubPort } from "@zs/core";
import { asService } from "@zs/db";
import { checkTenantCreateInput, createTenant, tenantIdForKey } from "../tenant-create.js";
import type { SupabaseAuthAdmin } from "../supabase-auth-admin.js";

export function createShopifyHub(deps: {
  readonly pool: Pool;
  readonly auth: SupabaseAuthAdmin;
  readonly clock: { now(): Date };
  /** The dashboard's `/auth/confirm` page (HUB_SIGN_IN_URL): it trades the link's one-time token for session cookies. */
  readonly signInUrl: string;
  readonly generateId?: () => string;
  readonly report?: (event: { readonly kind: "hub_error"; readonly step: string }) => void;
}): HubPort {
  const generateId = deps.generateId ?? randomUUID;
  return {
    async createHub(input) {
      const tenantId = tenantIdForKey(input.key);
      let step = "check_input";
      try {
        // Before any Auth call: an address or name the tenant create would refuse must not leave an Auth user behind.
        // The raw address goes in: the member rules check ASCII before folding case, so a non-ASCII address (the Kelvin
        // sign folds to "k") cannot alias an ASCII one.
        const email = checkTenantCreateInput({ key: input.key, name: input.name, ownerEmail: input.ownerEmail, dryRun: false }).email;
        step = "find_user";
        const found = await deps.auth.findUser(email);
        if (found?.tenantId && found.tenantId !== tenantId) return { kind: "email_has_hub" };
        step = "read_state";
        const state = await asService(deps.pool, async (tx) => ({
          elsewhere: (await tx.query("SELECT 1 FROM tenant_members WHERE lower(email)=$1 AND tenant_id<>$2 LIMIT 1", [email, tenantId])).rowCount ?? 0,
          name: (await tx.query<{ name: string }>("SELECT name FROM tenants WHERE tenant_id=$1", [tenantId])).rows[0]?.name ?? null,
        }));
        if (state.elsewhere > 0) return { kind: "email_has_hub" };
        step = "create_tenant";
        // A retry keeps the name the tenant already has, so a renamed store cannot trip the rerun check.
        const name = state.name ?? input.name;
        await createTenant({ service: deps.pool, clock: deps.clock, generateId, auth: deps.auth }, { key: input.key, name, ownerEmail: email, dryRun: false }, {
          // Under the provisioning locks, after the stored-owner, name and membership checks: a refused retry leaves no Auth user.
          // No mailbox is involved: the user is confirmed and holds a random password nobody learns; sign-in is by link.
          createOwnerUser: async () => {
            step = "create_user";
            await deps.auth.createUser({ email, password: randomBytes(32).toString("base64url") });
            step = "create_tenant";
          },
        });
        return { kind: "ok", tenantId, name };
      } catch {
        // A create that raced another for the same email lost: the next retry finds the user. No error text is kept.
        deps.report?.({ kind: "hub_error", step });
        return { kind: "failed" };
      }
    },

    async signInLink(email) {
      try {
        return await deps.auth.generateLink({ email: email.trim().toLowerCase(), confirmUrl: deps.signInUrl });
      } catch {
        return null;
      }
    },
  };
}
