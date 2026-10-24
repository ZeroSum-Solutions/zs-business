-- Business profile (docs/requirements/business-profile.md BP-1..BP-12): one row per tenant that says
-- who the business is. Tenant table: tenant_id, tenant FK, forced RLS with the shared tenant_scope
-- policy. Writes come only from the business.profile.update action, through the dispatcher.

CREATE TABLE public.business_profiles (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  -- BP-2, BP-9: the name the dashboard shows. Updating it also updates tenants.name (trigger below).
  display_name text NOT NULL
    CONSTRAINT business_profiles_display_name CHECK (char_length(display_name) BETWEEN 1 AND 120 AND btrim(display_name) <> ''),
  legal_name text CONSTRAINT business_profiles_legal_name CHECK (char_length(legal_name) BETWEEN 1 AND 200),
  phone_e164 text CONSTRAINT business_profiles_phone CHECK (phone_e164 ~ '^\+[0-9]{8,15}$'),
  -- BP-3: null means not set. The trigger below checks the name against pg_timezone_names.
  time_zone text CONSTRAINT business_profiles_time_zone_shape CHECK (char_length(time_zone) BETWEEN 1 AND 100),
  -- BP-4: the same codes as CURRENCY_CODES in packages/contracts/src/currency.ts (a test keeps them in step).
  currency text NOT NULL DEFAULT 'USD' CONSTRAINT business_profiles_currency CHECK (currency IN (
  'AED', 'AFN', 'ALL', 'AMD', 'ANG', 'AOA', 'ARS', 'AUD', 'AWG', 'AZN', 'BAM', 'BBD', 'BDT', 'BGN', 'BHD', 'BIF',
  'BMD', 'BND', 'BOB', 'BRL', 'BSD', 'BTN', 'BWP', 'BYN', 'BZD', 'CAD', 'CDF', 'CHF', 'CLP', 'CNY', 'COP', 'CRC',
  'CUC', 'CUP', 'CVE', 'CZK', 'DJF', 'DKK', 'DOP', 'DZD', 'EGP', 'ERN', 'ETB', 'EUR', 'FJD', 'FKP', 'GBP', 'GEL',
  'GHS', 'GIP', 'GMD', 'GNF', 'GTQ', 'GYD', 'HKD', 'HNL', 'HRK', 'HTG', 'HUF', 'IDR', 'ILS', 'INR', 'IQD', 'IRR',
  'ISK', 'JMD', 'JOD', 'JPY', 'KES', 'KGS', 'KHR', 'KMF', 'KPW', 'KRW', 'KWD', 'KYD', 'KZT', 'LAK', 'LBP', 'LKR',
  'LRD', 'LSL', 'LYD', 'MAD', 'MDL', 'MGA', 'MKD', 'MMK', 'MNT', 'MOP', 'MRU', 'MUR', 'MVR', 'MWK', 'MXN', 'MYR',
  'MZN', 'NAD', 'NGN', 'NIO', 'NOK', 'NPR', 'NZD', 'OMR', 'PAB', 'PEN', 'PGK', 'PHP', 'PKR', 'PLN', 'PYG', 'QAR',
  'RON', 'RSD', 'RUB', 'RWF', 'SAR', 'SBD', 'SCR', 'SDG', 'SEK', 'SGD', 'SHP', 'SLE', 'SLL', 'SOS', 'SRD', 'SSP',
  'STN', 'SVC', 'SYP', 'SZL', 'THB', 'TJS', 'TMT', 'TND', 'TOP', 'TRY', 'TTD', 'TWD', 'TZS', 'UAH', 'UGX', 'USD',
  'UYU', 'UZS', 'VED', 'VES', 'VND', 'VUV', 'WST', 'XAF', 'XCD', 'XCG', 'XDR', 'XOF', 'XPF', 'XSU', 'YER', 'ZAR',
  'ZMW', 'ZWG', 'ZWL'
  )),
  -- BP-2: { line1, line2?, city, region?, postalCode?, country }; optional keys are absent, never JSON null.
  -- A CHECK passes on NULL, so every clause is coalesced to false.
  postal_address jsonb CONSTRAINT business_profiles_address_shape CHECK (postal_address IS NULL OR coalesce(
    jsonb_typeof(postal_address) = 'object'
    AND (postal_address - ARRAY['line1', 'line2', 'city', 'region', 'postalCode', 'country']) = '{}'::jsonb
    AND coalesce(jsonb_typeof(postal_address->'line1') = 'string' AND char_length(postal_address->>'line1') BETWEEN 1 AND 120, false)
    AND coalesce(jsonb_typeof(postal_address->'city') = 'string' AND char_length(postal_address->>'city') BETWEEN 1 AND 120, false)
    AND coalesce(jsonb_typeof(postal_address->'country') = 'string' AND postal_address->>'country' ~ '^[A-Z]{2}$', false)
    AND (postal_address->'line2' IS NULL
      OR coalesce(jsonb_typeof(postal_address->'line2') = 'string' AND char_length(postal_address->>'line2') BETWEEN 1 AND 120, false))
    AND (postal_address->'region' IS NULL
      OR coalesce(jsonb_typeof(postal_address->'region') = 'string' AND char_length(postal_address->>'region') BETWEEN 1 AND 120, false))
    AND (postal_address->'postalCode' IS NULL
      OR coalesce(jsonb_typeof(postal_address->'postalCode') = 'string' AND char_length(postal_address->>'postalCode') BETWEEN 1 AND 120, false)),
    false)),
  -- BP-7: compare-and-set; every write adds one.
  revision integer NOT NULL DEFAULT 1 CONSTRAINT business_profiles_revision CHECK (revision >= 1),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- BP-3: known zone names, as booking resources check them (20261018090000): a trigger, not a CHECK,
-- because the zone list changes with tzdata and a CHECK is re-run when a dump loads. Names compare
-- case-insensitively, as PostgreSQL and Intl resolve them, and the row keeps its spelling.
CREATE FUNCTION public.business_profiles_time_zone_known() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE lower(name) = lower(NEW.time_zone)) THEN
    RAISE EXCEPTION 'Unknown time zone: %', NEW.time_zone USING ERRCODE = 'check_violation',
      SCHEMA = 'public', TABLE = 'business_profiles', COLUMN = 'time_zone',
      CONSTRAINT = 'business_profiles_time_zone_known';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER business_profiles_time_zone_known
  BEFORE INSERT OR UPDATE OF time_zone ON public.business_profiles
  FOR EACH ROW WHEN (NEW.time_zone IS NOT NULL)
  EXECUTE FUNCTION public.business_profiles_time_zone_known();

-- BP-1: the row is created with the tenant. Tenants are inserted by the service role (provisioning,
-- seeds), which may write this table. display_name copies the name, trimmed and cut to the column's limit.
CREATE FUNCTION public.business_profiles_create() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  INSERT INTO public.business_profiles (tenant_id, display_name, currency, revision, updated_at)
  VALUES (NEW.tenant_id, coalesce(nullif(btrim(left(btrim(NEW.name), 120)), ''), 'Business'), 'USD', 1, now());
  RETURN NULL;
END $$;

-- BP-9: display_name and tenants.name move together, in the writer's transaction. The runtime role has
-- no UPDATE on tenants (20261017160000), so this trigger runs as zs_dispatcher, the narrow definer
-- owner, limited by tenants' own tenant_scope policy to the tenant in context. A row it cannot reach
-- is an error, never a silent split of the two names.
CREATE FUNCTION public.business_profiles_sync_name() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  UPDATE public.tenants SET name = NEW.display_name WHERE tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tenant % is not in context; its name was not updated', NEW.tenant_id USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER business_profiles_sync_name
  AFTER UPDATE OF display_name ON public.business_profiles
  FOR EACH ROW WHEN (NEW.display_name IS DISTINCT FROM OLD.display_name)
  EXECUTE FUNCTION public.business_profiles_sync_name();

ALTER TABLE public.business_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.business_profiles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.business_profiles TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.business_profiles FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.business_profiles FROM anon;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.business_profiles TO service_role;
-- Runtime: read, and update the editable columns only. The row is never inserted or deleted by it.
GRANT SELECT ON public.business_profiles TO authenticated;
GRANT UPDATE (display_name, legal_name, phone_e164, time_zone, currency, postal_address, revision, updated_by, updated_at)
  ON public.business_profiles TO authenticated;

-- The sync trigger's reach: one column of tenants, only the tenant in context.
GRANT SELECT (tenant_id), UPDATE (name) ON public.tenants TO zs_dispatcher;
ALTER POLICY tenant_scope ON public.tenants TO authenticated, zs_dispatcher;

-- Same owners as every function: invoker functions with zs_function_owner (20261018090000), the
-- definer with zs_dispatcher (20261017160000). CREATE only for the transfer.
REVOKE ALL ON FUNCTION public.business_profiles_time_zone_known() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_profiles_create() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.business_profiles_sync_name() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.business_profiles_time_zone_known() FROM anon;
    REVOKE ALL ON FUNCTION public.business_profiles_create() FROM anon;
    REVOKE ALL ON FUNCTION public.business_profiles_sync_name() FROM anon;
  END IF;
END $$;
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.business_profiles_time_zone_known() OWNER TO zs_function_owner;
ALTER FUNCTION public.business_profiles_create() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
GRANT CREATE ON SCHEMA public TO zs_dispatcher;
ALTER FUNCTION public.business_profiles_sync_name() OWNER TO zs_dispatcher;
REVOKE CREATE ON SCHEMA public FROM zs_dispatcher;

-- BP-1: a row for every existing tenant. Under FORCE ROW LEVEL SECURITY a migrator that is not a
-- superuser (postgres on hosted Supabase) sees no tenants and would backfill nothing; the table owner
-- lifts FORCE for the copy only (ALTER TABLE holds an ACCESS EXCLUSIVE lock until commit).
ALTER TABLE public.tenants NO FORCE ROW LEVEL SECURITY;
ALTER TABLE public.business_profiles NO FORCE ROW LEVEL SECURITY;
INSERT INTO public.business_profiles (tenant_id, display_name, currency, revision, updated_at)
  SELECT t.tenant_id, coalesce(nullif(btrim(left(btrim(t.name), 120)), ''), 'Business'), 'USD', 1, now()
  FROM public.tenants t
  ON CONFLICT (tenant_id) DO NOTHING;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.business_profiles FORCE ROW LEVEL SECURITY;

-- Created after the backfill, so a tenant inserted from here on gets its row.
CREATE TRIGGER business_profiles_create
  AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.business_profiles_create();
