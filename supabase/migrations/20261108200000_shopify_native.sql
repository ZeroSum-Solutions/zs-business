-- Native Shopify tier for the public App Store app (docs/requirements/connections.md C-18..C-26).
-- A store that installs the app is bound to one tenant. The worker (service role) holds the sealed
-- expiring offline tokens in shopify_installs, a store-level ledger with no tenant column and no
-- runtime grants; the tenant-facing row is a `connections` row with tier 'native'. Claims are tenant
-- rows only the worker reads. Nothing here changes a runtime-role grant.

-- C-26: tier also 'native'; a composio account is required exactly for composio rows.
ALTER TABLE public.connections DROP CONSTRAINT connections_tier;
ALTER TABLE public.connections ADD CONSTRAINT connections_tier CHECK (tier IN ('composio', 'native'));
ALTER TABLE public.connections ALTER COLUMN composio_account_id DROP NOT NULL;
ALTER TABLE public.connections ADD CONSTRAINT connections_account_by_tier CHECK ((tier = 'composio') = (composio_account_id IS NOT NULL));

-- C-21: a store belongs to one tenant at a time. (Native rows only; the composio tier keeps its own
-- one-live-row-per-tenant rule, and the worker refuses a store another live row of any tier holds.)
CREATE UNIQUE INDEX connections_native_shop ON public.connections (external_account_id)
  WHERE tier = 'native' AND status <> 'disconnected';

-- The take-attempt trigger belongs to composio rows (it fills their account from a verified attempt).
DROP TRIGGER connections_take_attempt ON public.connections;
CREATE TRIGGER connections_take_attempt BEFORE INSERT ON public.connections
  FOR EACH ROW WHEN (NEW.tier = 'composio') EXECUTE FUNCTION public.connections_take_attempt();

-- C-22: a worker may move a native row from reauthorize/auth_error back to active (the merchant opened
-- the app and a fresh token exchange succeeded). Nothing else about the guard changes: every role
-- still cannot move a disconnected row, a disconnecting row only finishes, and the runtime rules bind
-- everyone but the worker. CREATE OR REPLACE needs ownership; the migrator reaches zs_function_owner
-- as in 20261018090000.
DO $$ BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT (pg_has_role(current_user, 'zs_function_owner', 'SET') AND pg_has_role(current_user, 'zs_function_owner', 'USAGE')) THEN
      EXECUTE format('GRANT zs_function_owner TO %I WITH INHERIT TRUE, SET TRUE', current_user);
    END IF;
  ELSIF NOT pg_has_role(current_user, 'zs_function_owner', 'MEMBER') THEN
    EXECUTE format('GRANT zs_function_owner TO %I', current_user);
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.connections_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  worker boolean := current_user <> 'authenticated' AND (
    coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)
    OR (pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER')
        AND NOT pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER')));
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status AND (
      OLD.status = 'disconnected'
      OR (OLD.status = 'disconnecting' AND NEW.status <> 'disconnected')
      OR (OLD.status = 'reauthorize' AND OLD.reauthorize_reason = 'auth_error' AND NEW.status = 'active'
          AND NOT (worker AND OLD.tier = 'native'))) THEN
    RAISE EXCEPTION 'Connection status cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'connections';
  END IF;
  IF NOT worker AND (
      (TG_OP = 'INSERT' AND NEW.status <> 'active')
      OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
        AND NOT (NEW.status = 'disconnecting' AND OLD.status IN ('active', 'reauthorize')))) THEN
    RAISE EXCEPTION 'Connection status % is not a runtime change', NEW.status
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'connections';
  END IF;
  RETURN NEW;
END $$;

-- C-24: shop/redact may blank a disconnected native row's store identity, and nothing else may change it.
GRANT UPDATE (account_domain, external_account_id) ON public.connections TO service_role;

CREATE FUNCTION public.connections_native_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  worker boolean := current_user <> 'authenticated' AND (
    coalesce((SELECT r.rolsuper FROM pg_catalog.pg_roles r WHERE r.rolname = current_user), false)
    OR (pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER')
        AND NOT pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER')));
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.tier <> 'composio' AND NOT worker THEN
      RAISE EXCEPTION 'Only the worker binds a native connection'
        USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'connections';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tier IS DISTINCT FROM OLD.tier THEN
    RAISE EXCEPTION 'A connection tier cannot change' USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'connections';
  END IF;
  IF (NEW.account_domain IS DISTINCT FROM OLD.account_domain OR NEW.external_account_id IS DISTINCT FROM OLD.external_account_id)
     AND NOT (worker AND OLD.tier = 'native' AND OLD.status = 'disconnected' AND NEW.status = 'disconnected'
              AND NEW.account_domain = 'redacted.invalid' AND NEW.external_account_id = 'redacted') THEN
    RAISE EXCEPTION 'A connection''s store cannot change' USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'connections';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connections_native_guard BEFORE INSERT OR UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION public.connections_native_guard();
REVOKE ALL ON FUNCTION public.connections_native_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON FUNCTION public.connections_native_guard() FROM anon;
  END IF;
END $$;
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.connections_native_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

-- C-22: the install ledger. No tenant column: it is store data. Only the worker's service role reaches it.
CREATE TABLE public.shopify_installs (
  shop_id text PRIMARY KEY CONSTRAINT shopify_installs_shop_id CHECK (shop_id ~ '^gid://shopify/Shop/[0-9]{1,20}$'),
  shop_domain text NOT NULL UNIQUE CONSTRAINT shopify_installs_domain CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  shop_name text NOT NULL CONSTRAINT shopify_installs_name CHECK (char_length(shop_name) BETWEEN 1 AND 120),
  scopes text NOT NULL CONSTRAINT shopify_installs_scopes CHECK (char_length(scopes) <= 1000),
  status text NOT NULL CONSTRAINT shopify_installs_status CHECK (status IN ('live', 'needs_reauth', 'uninstalled')),
  access_sealed text CONSTRAINT shopify_installs_access_sealed CHECK (char_length(access_sealed) BETWEEN 40 AND 4200),
  access_key_id text CONSTRAINT shopify_installs_access_key CHECK (access_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  refresh_sealed text CONSTRAINT shopify_installs_refresh_sealed CHECK (char_length(refresh_sealed) BETWEEN 40 AND 4200),
  refresh_key_id text CONSTRAINT shopify_installs_refresh_key CHECK (refresh_key_id ~ '^[A-Za-z0-9_-]{1,32}$'),
  access_expires_at timestamptz,
  refresh_expires_at timestamptz,
  claim_failures integer NOT NULL DEFAULT 0 CONSTRAINT shopify_installs_failures CHECK (claim_failures >= 0),
  claim_locked_until timestamptz,
  -- C-22: bumped by every exchange and by uninstall; a token write is conditional on the value read
  -- under the worker's advisory lock, so a write in flight when an uninstall ran changes nothing.
  generation bigint NOT NULL DEFAULT 1 CONSTRAINT shopify_installs_generation CHECK (generation >= 1),
  installed_at timestamptz NOT NULL,
  uninstalled_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT shopify_installs_tokens_by_status CHECK (
    (status = 'uninstalled' AND access_sealed IS NULL AND refresh_sealed IS NULL AND access_key_id IS NULL AND refresh_key_id IS NULL
       AND access_expires_at IS NULL AND refresh_expires_at IS NULL AND uninstalled_at IS NOT NULL)
    OR (status <> 'uninstalled' AND access_sealed IS NOT NULL AND refresh_sealed IS NOT NULL AND access_key_id IS NOT NULL
       AND refresh_key_id IS NOT NULL AND access_expires_at IS NOT NULL AND refresh_expires_at IS NOT NULL))
);
-- The pass refreshes the installs whose refresh token is nearest to its end.
CREATE INDEX shopify_installs_refresh_due ON public.shopify_installs (refresh_expires_at) WHERE status = 'live';

-- C-21: a claim is one tenant's request to bind a store; only the worker reads or writes it.
CREATE TABLE public.shopify_claims (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  created_by uuid,
  -- Hex SHA-256 of an HMAC of the code; the code is shown once and never stored.
  code_hash text NOT NULL CONSTRAINT shopify_claims_code_hash CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'open' CONSTRAINT shopify_claims_status CHECK (status IN ('open', 'redeemed', 'confirmed', 'cancelled', 'expired')),
  shop_id text CONSTRAINT shopify_claims_shop_id CHECK (shop_id ~ '^gid://shopify/Shop/[0-9]{1,20}$'),
  shop_domain text CONSTRAINT shopify_claims_domain CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  shop_name text CONSTRAINT shopify_claims_name CHECK (char_length(shop_name) BETWEEN 1 AND 120),
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES public.tenant_members(tenant_id, id) ON DELETE SET NULL (created_by),
  CONSTRAINT shopify_claims_redeemed CHECK (status NOT IN ('redeemed', 'confirmed') OR (shop_id IS NOT NULL AND shop_domain IS NOT NULL AND shop_name IS NOT NULL AND redeemed_at IS NOT NULL))
);
CREATE UNIQUE INDEX shopify_claims_code ON public.shopify_claims (code_hash);
CREATE UNIQUE INDEX shopify_claims_one_open ON public.shopify_claims (tenant_id) WHERE status IN ('open', 'redeemed');

-- C-24: webhook ids already handled (Shopify delivers at least once).
CREATE TABLE public.shopify_webhook_events (
  webhook_id text PRIMARY KEY CONSTRAINT shopify_webhook_events_id CHECK (char_length(webhook_id) BETWEEN 1 AND 128),
  topic text NOT NULL CONSTRAINT shopify_webhook_events_topic CHECK (topic ~ '^[a-z_]{1,40}/[a-z_]{1,40}$'),
  shop_domain text NOT NULL CONSTRAINT shopify_webhook_events_domain CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  received_at timestamptz NOT NULL
);
-- C-22: one exchange or refresh per store at a time (S2). A short lease keyed by the verified domain, taken
-- before any install row exists. The worker holds no pool client while it waits on Shopify, so this is a
-- row, not a session lock.
CREATE TABLE public.shopify_locks (
  shop_domain text PRIMARY KEY CONSTRAINT shopify_locks_domain CHECK (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$'),
  held_until timestamptz NOT NULL,
  holder uuid NOT NULL
);
CREATE INDEX shopify_webhook_events_received ON public.shopify_webhook_events (received_at);
CREATE INDEX shopify_webhook_events_shop ON public.shopify_webhook_events (shop_domain);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shopify_installs', 'shopify_claims', 'shopify_webhook_events', 'shopify_locks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    IF t = 'shopify_claims' THEN
      EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
        USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
  END LOOP;
END $$;
-- Only the worker's service role. No runtime grants on any of the three.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shopify_installs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shopify_claims TO service_role;
GRANT SELECT, INSERT, DELETE ON public.shopify_webhook_events TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.shopify_locks TO service_role;
