-- Hub plan subscriptions (docs/requirements/plans.md PL-3, PL-4, PL-10, PL-12). Tenant tables
-- force RLS and include tenant_id in every relationship. The runtime role reads its own rows and
-- starts a checkout; only the billing worker (service role) writes the plan record and invoices.

DO $$ BEGIN
  CREATE TYPE public.hub_plan AS ENUM ('solo', 'studio', 'pro');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE public.hub_plan_interval AS ENUM ('month', 'year');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- PL-3: one row per tenant that has had a checkout, a subscription or a founding invite. The plan
-- fields are derived from plan_subscriptions (PL-10). No row, or status 'none' with no
-- read_only_after, is a comped tenant: no plan limits and never read-only.
CREATE TABLE public.tenant_plans (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  -- PL-14: who bills this tenant's plan. Stripe now; Shopify merchants move to Shopify Billing later.
  billing_provider text NOT NULL DEFAULT 'stripe' CONSTRAINT tenant_plans_provider CHECK (billing_provider IN ('stripe', 'shopify')),
  plan public.hub_plan,
  plan_interval public.hub_plan_interval,
  founding boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'none' CONSTRAINT tenant_plans_status CHECK (status IN
    ('none', 'trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused')),
  extra_connections integer NOT NULL DEFAULT 0 CONSTRAINT tenant_plans_extra_connections CHECK (extra_connections BETWEEN 0 AND 1000),
  stripe_customer_id text CONSTRAINT tenant_plans_customer CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9_]{1,250}$'),
  stripe_subscription_id text CONSTRAINT tenant_plans_subscription CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9_]{1,250}$'),
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  trial_used boolean NOT NULL DEFAULT false,
  founding_invite boolean NOT NULL DEFAULT false,
  founding_started_at timestamptz,
  payment_failed_at timestamptz,
  -- PL-8: at or before the clock, the tenant is read-only.
  read_only_after timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT tenant_plans_named CHECK ((status = 'none') OR (plan IS NOT NULL AND plan_interval IS NOT NULL))
);
CREATE UNIQUE INDEX tenant_plans_customer_once ON public.tenant_plans (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- PL-3, PL-10: each Stripe subscription of a tenant, as Stripe last answered it.
CREATE TABLE public.plan_subscriptions (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  -- PL-14: the provider that holds the subscription; its ID format follows the provider.
  provider text NOT NULL DEFAULT 'stripe' CONSTRAINT plan_subscriptions_provider CHECK (provider IN ('stripe', 'shopify')),
  id text NOT NULL CONSTRAINT plan_subscriptions_id CHECK (char_length(id) BETWEEN 1 AND 300 AND (provider <> 'stripe' OR id ~ '^sub_[A-Za-z0-9_]{1,250}$')),
  stripe_customer_id text CONSTRAINT plan_subscriptions_customer CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9_]{1,250}$'),
  status text NOT NULL DEFAULT 'incomplete' CONSTRAINT plan_subscriptions_status CHECK (status IN
    ('trialing', 'active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused')),
  -- Null while no item's lookup key was ever recognised (PL-2).
  plan public.hub_plan,
  plan_interval public.hub_plan_interval,
  founding boolean NOT NULL DEFAULT false,
  extra_connections integer NOT NULL DEFAULT 0 CONSTRAINT plan_subscriptions_extra CHECK (extra_connections BETWEEN 0 AND 1000),
  trial_end timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  status_since timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT plan_subscriptions_named CHECK ((plan IS NULL) = (plan_interval IS NULL))
);
-- A provider's subscription IDs are global.
CREATE UNIQUE INDEX plan_subscriptions_id_once ON public.plan_subscriptions (provider, id);

-- PL-4, PL-5: one row per Checkout an owner starts; the terms are stored so a retry repeats them.
CREATE TABLE public.plan_checkouts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  plan public.hub_plan NOT NULL,
  plan_interval public.hub_plan_interval NOT NULL,
  extra_connections integer NOT NULL DEFAULT 0 CONSTRAINT plan_checkouts_extra CHECK (extra_connections BETWEEN 0 AND 20),
  founding boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CONSTRAINT plan_checkouts_status CHECK (status IN ('pending', 'completed', 'expired')),
  plan_price_id text NOT NULL DEFAULT 'price_unset' CONSTRAINT plan_checkouts_price CHECK (plan_price_id ~ '^price_[A-Za-z0-9_]{1,250}$'),
  addon_price_id text CONSTRAINT plan_checkouts_addon CHECK (addon_price_id ~ '^price_[A-Za-z0-9_]{1,250}$'),
  trial_days integer NOT NULL DEFAULT 0 CONSTRAINT plan_checkouts_trial CHECK (trial_days BETWEEN 0 AND 30),
  stripe_customer_id text CONSTRAINT plan_checkouts_customer CHECK (stripe_customer_id ~ '^cus_[A-Za-z0-9_]{1,250}$'),
  success_url text NOT NULL DEFAULT 'https://unset.invalid/' CONSTRAINT plan_checkouts_success_url CHECK (char_length(success_url) BETWEEN 1 AND 8192 AND success_url LIKE 'https://_%'),
  cancel_url text NOT NULL DEFAULT 'https://unset.invalid/' CONSTRAINT plan_checkouts_cancel_url CHECK (char_length(cancel_url) BETWEEN 1 AND 8192 AND cancel_url LIKE 'https://_%'),
  checkout_url text CONSTRAINT plan_checkouts_checkout_url CHECK (char_length(checkout_url) <= 8192 AND checkout_url LIKE 'https://_%'),
  stripe_checkout_session_id text CONSTRAINT plan_checkouts_session CHECK (stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,250}$'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT plan_checkouts_addon_state CHECK ((extra_connections = 0) = (addon_price_id IS NULL)),
  CONSTRAINT plan_checkouts_founding_plan CHECK (NOT founding OR plan <> 'solo')
);
CREATE UNIQUE INDEX plan_checkouts_session_once ON public.plan_checkouts (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;

-- PL-10: each invoice the worker saw; `paid` is terminal.
CREATE TABLE public.plan_invoices (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  provider text NOT NULL DEFAULT 'stripe' CONSTRAINT plan_invoices_provider CHECK (provider IN ('stripe', 'shopify')),
  id text NOT NULL CONSTRAINT plan_invoices_id CHECK (char_length(id) BETWEEN 1 AND 300 AND (provider <> 'stripe' OR id ~ '^in_[A-Za-z0-9_]{1,250}$')),
  stripe_subscription_id text CONSTRAINT plan_invoices_subscription CHECK (stripe_subscription_id ~ '^sub_[A-Za-z0-9_]{1,250}$'),
  status text NOT NULL DEFAULT 'failed' CONSTRAINT plan_invoices_status CHECK (status IN ('paid', 'failed', 'resolved')),
  amount_due bigint NOT NULL DEFAULT 0 CONSTRAINT plan_invoices_amount CHECK (amount_due >= 0),
  currency text NOT NULL DEFAULT 'usd' CONSTRAINT plan_invoices_currency CHECK (currency ~ '^[a-z]{3}$'),
  first_failed_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT plan_invoices_paid_state CHECK ((status = 'paid') = (paid_at IS NOT NULL))
);
-- A provider's invoice IDs are global.
CREATE UNIQUE INDEX plan_invoices_id_once ON public.plan_invoices (provider, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_plans','plan_subscriptions','plan_checkouts','plan_invoices'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO service_role', t);
  END LOOP;
END $$;
-- PL-4, PL-12: the action inserts a pending checkout with its terms; the route stores the URL once.
GRANT INSERT (tenant_id, id, plan, plan_interval, extra_connections, founding, plan_price_id, addon_price_id,
  trial_days, stripe_customer_id, success_url, cancel_url, created_by, created_at, updated_at)
  ON public.plan_checkouts TO authenticated;
GRANT UPDATE (checkout_url) ON public.plan_checkouts TO authenticated;
