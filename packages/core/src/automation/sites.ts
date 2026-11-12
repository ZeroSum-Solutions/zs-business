// hub-access.md H-13..H-15: the site methods for an automation token. The logic is the member
// session's (edge/site-methods.ts); this file is how a token is checked. A token acts on a site
// only while its row is live, holds `sites:publish` and names that site. A site it does not name
// is NotFound, never Forbidden, and the check runs before any site row is read.
import { NotFound, TenantDenied, idempotencyKeySchema, tokenPreviewSiteRequestSchema, tokenPublishSiteRequestSchema, uuidSchema } from "@zs/contracts";
import type { Transaction } from "@zs/db";
import { derivedId } from "../edge/ids.js";
import { createSiteMethods, type SiteMethodsHost } from "../edge/site-methods.js";
import { directDispatch, parseInput, type Authorize, type EdgeDependencies } from "../edge/session.js";
import { guardToken, type TokenLock } from "./guard.js";
import type { AutomationPrincipal } from "./inbound.js";

/** The only actions a site token may run. */
const SITE_TOKEN_ACTIONS: ReadonlySet<string> = new Set(["site.release.publish", "site.release.activate"]);

export function createAutomationSites(deps: EdgeDependencies) {
  return {
    forToken(principal: AutomationPrincipal) {
      const { tenantId, tokenId, actorId } = principal;
      /**
       * H-3, H-15 step 4 and 5: lock the token row, then the scope, then the allowlist. A scope
       * miss is the same TenantDenied for every site; an allowlist miss is the same NotFound for
       * a foreign site, an unnamed site of this tenant and an ID nothing holds.
       */
      const gate = async (tx: Transaction, lock: TokenLock, siteId: unknown): Promise<string> => {
        const { row } = await guardToken(tx, deps.clock, tenantId, tokenId, lock);
        if (!row.scopes.includes("sites:publish")) throw new TenantDenied();
        const id = uuidSchema.safeParse(siteId);
        if (!id.success || !row.site_ids.includes(id.data)) throw new NotFound();
        return id.data;
      };
      /** The dispatch check: inside the action's transaction, before the idempotency lookup. Exclusive lock, so a revoke stops it. */
      const authorize: Authorize = async (tx, binding) => {
        if (!SITE_TOKEN_ACTIONS.has(binding.actionType)) throw new TenantDenied();
        await gate(tx, "update", binding.target.id);
      };
      const host: SiteMethodsHost = {
        deps, tenantId,
        read: (siteId, work) => deps.db.tenant(tenantId, async (tx) => {
          await gate(tx, "share", siteId);
          return work(tx);
        }),
        dispatch: directDispatch(deps, tenantId, actorId, authorize),
        syncAuthorize: (siteId) => async (tx) => { await gate(tx, "update", siteId); },
        envelope: (rawKey, siteId) => {
          const callerKey = parseInput(idempotencyKeySchema, rawKey, "Idempotency-Key");
          // The reserved `activepieces:` prefix keeps a caller's own key out of the member namespace, and
          // the token ID keeps two tokens apart (H-15).
          const idempotencyKey = `activepieces:site:${derivedId(tenantId, tokenId, callerKey)}`;
          return {
            target: { tenantId, type: "site" as const, id: siteId },
            approvalReference: { tenantId, id: derivedId(tenantId, idempotencyKey, "approval") },
            idempotencyKey,
          };
        },
      };
      const methods = createSiteMethods(host);
      /** Every route checks the token and the site first, in its own short transaction, before it parses a body. */
      const first = (siteId: unknown) => deps.db.tenant(tenantId, async (tx) => { await gate(tx, "share", siteId); });
      return {
        async getSite(siteId: unknown) { methods.requireSites(); await first(siteId); return methods.getSite(siteId); },
        async listSiteReleases(siteId: unknown) { methods.requireSites(); await first(siteId); return methods.listSiteReleases(siteId); },
        async getSiteRelease(siteId: unknown, releaseId: unknown) { methods.requireSites(); await first(siteId); return methods.getSiteRelease(siteId, releaseId); },
        async publishSite(siteId: unknown, body: unknown, key: unknown) {
          methods.requireSites(); await first(siteId);
          return methods.publishSite(siteId, body, key, tokenPublishSiteRequestSchema);
        },
        async previewSite(siteId: unknown, body: unknown) {
          methods.requireSites(); await first(siteId);
          return methods.previewSite(siteId, body, tokenPreviewSiteRequestSchema);
        },
        async activateSiteRelease(siteId: unknown, releaseId: unknown, body: unknown, key: unknown) {
          methods.requireSites(); await first(siteId);
          return methods.activateSiteRelease(siteId, releaseId, body, key);
        },
        async syncSite(siteId: unknown) { methods.requireSites(); await first(siteId); return methods.syncSite(siteId); },
      };
    },
  };
}
export type AutomationSites = ReturnType<typeof createAutomationSites>;
export type AutomationSiteSession = ReturnType<AutomationSites["forToken"]>;
