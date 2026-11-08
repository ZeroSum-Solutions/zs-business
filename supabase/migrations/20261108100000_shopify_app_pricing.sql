-- Shopify App Pricing for Shopify-billed tenants (docs/requirements/plans.md PL-17, PL-18). The
-- operator links a tenant to its shop; the billing runner stores the shop's contract as the
-- tenant's one Shopify row in plan_subscriptions, whose ID is the shop GID. RLS, policies and
-- grants of both tables are unchanged: the runtime role reads its own rows, only the service role
-- writes them.

ALTER TABLE public.tenant_plans
  ADD COLUMN shopify_shop_id text CONSTRAINT tenant_plans_shopify_shop CHECK (shopify_shop_id ~ '^gid://shopify/Shop/[0-9]{1,20}$'),
  ADD COLUMN shopify_shop_domain text CONSTRAINT tenant_plans_shopify_domain CHECK (
    char_length(shopify_shop_domain) <= 255 AND shopify_shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  ADD COLUMN shopify_synced_at timestamptz,
  ADD COLUMN shopify_sync_failures integer NOT NULL DEFAULT 0 CONSTRAINT tenant_plans_shopify_failures CHECK (shopify_sync_failures BETWEEN 0 AND 1000000),
  ADD COLUMN shopify_next_sync_at timestamptz,
  ADD CONSTRAINT tenant_plans_shopify_pair CHECK ((shopify_shop_id IS NULL) = (shopify_shop_domain IS NULL)),
  -- PL-17: only a Shopify-billed tenant names a shop.
  ADD CONSTRAINT tenant_plans_shopify_provider CHECK (shopify_shop_id IS NULL OR billing_provider = 'shopify');

-- PL-17: one shop bills one tenant.
CREATE UNIQUE INDEX tenant_plans_shopify_shop_once ON public.tenant_plans (shopify_shop_id) WHERE shopify_shop_id IS NOT NULL;
-- PL-18: the runner picks the least recently synced linked tenants.
CREATE INDEX tenant_plans_shopify_sync ON public.tenant_plans (shopify_synced_at NULLS FIRST, tenant_id)
  WHERE billing_provider = 'shopify' AND shopify_shop_id IS NOT NULL;

-- PL-18: a Shopify row's ID is its shop's GID.
ALTER TABLE public.plan_subscriptions
  ADD CONSTRAINT plan_subscriptions_shopify_id CHECK (provider <> 'shopify' OR id ~ '^gid://shopify/Shop/[0-9]{1,20}$');
