-- Managed-tier connections (docs/requirements/connections.md C-7, C-12, C-16). A connection is
-- one tenant's grant to one external app, held at Composio; we store only account IDs. The
-- runtime role (the API) reads rows, inserts an active row through the connect action and may
-- only move a row to disconnecting. Every other change is the worker's (service role).

-- C-10, C-16: the scope that lets an agent read connected apps through /mcp.
ALTER TYPE public.automation_token_scope ADD VALUE IF NOT EXISTS 'connections:read';

-- A token may hold all ten scopes.
ALTER TABLE public.automation_tokens DROP CONSTRAINT automation_tokens_scopes_size;
ALTER TABLE public.automation_tokens
  ADD CONSTRAINT automation_tokens_scopes_size CHECK (cardinality(scopes) <= 10);

-- H-1 with the new scope. Compared as text: a value added in this transaction cannot be used as
-- an enum literal until the transaction commits. No existing row holds the new scope.
ALTER TABLE public.automation_tokens DROP CONSTRAINT automation_tokens_read_expiry;
ALTER TABLE public.automation_tokens
  ADD CONSTRAINT automation_tokens_read_expiry CHECK (
    NOT (scopes::text[] && ARRAY['contacts:read', 'deals:read', 'bookings:read', 'inbox:read', 'results:read', 'business:read', 'connections:read'])
    OR (expires_at IS NOT NULL
        AND expires_at >= created_at + interval '24 hours'
        AND expires_at <= created_at + interval '8760 hours'));

DO $$ BEGIN
  CREATE TYPE public.connection_status AS ENUM ('active', 'reauthorize', 'disconnecting', 'disconnected');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE public.connection_reauthorize_reason AS ENUM ('provider_status', 'auth_error');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  CREATE TYPE public.connection_attempt_status AS ENUM ('started', 'verified', 'confirmed', 'cancelled', 'swept');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- C-7. account_domain is the store's own address (C-14): the shop the member named, which the
-- identity read had to confirm.
CREATE TABLE public.connections (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  tier text NOT NULL DEFAULT 'composio' CONSTRAINT connections_tier CHECK (tier = 'composio'),
  toolkit text NOT NULL CONSTRAINT connections_toolkit CHECK (toolkit ~ '^[a-z0-9_-]{1,40}$'),
  composio_account_id text NOT NULL CONSTRAINT connections_composio_account_length CHECK (char_length(composio_account_id) BETWEEN 1 AND 128),
  external_account_id text NOT NULL CONSTRAINT connections_external_account_length CHECK (char_length(external_account_id) BETWEEN 1 AND 64),
  account_domain text NOT NULL CONSTRAINT connections_domain_length CHECK (char_length(account_domain) BETWEEN 1 AND 253),
  -- Normalized by the contracts schema (C-14); null exactly once the connection is disconnected.
  account_label text CONSTRAINT connections_label_length CHECK (char_length(account_label) BETWEEN 1 AND 120),
  status public.connection_status NOT NULL,
  reauthorize_reason public.connection_reauthorize_reason,
  connected_by uuid NOT NULL,
  last_checked_at timestamptz NOT NULL,
  last_error_code text CONSTRAINT connections_error_code CHECK (last_error_code ~ '^[a-z_]{1,40}$'),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, connected_by) REFERENCES public.tenant_members(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT connections_label_state CHECK ((status = 'disconnected') = (account_label IS NULL)),
  -- A reason belongs to a row that needs reconnecting; it survives the move to disconnecting.
  CONSTRAINT connections_reason_state CHECK (
    (status <> 'active' OR reauthorize_reason IS NULL) AND (status <> 'reauthorize' OR reauthorize_reason IS NOT NULL))
);
-- At most one live row per tenant and toolkit, and one live row per Composio account.
CREATE UNIQUE INDEX connections_one_live_per_toolkit ON public.connections (tenant_id, toolkit)
  WHERE status IN ('active', 'reauthorize', 'disconnecting');
CREATE UNIQUE INDEX connections_one_live_per_account ON public.connections (composio_account_id)
  WHERE status <> 'disconnected';
-- The worker's pass claims the oldest unchecked live rows and the rows to finish.
CREATE INDEX connections_due ON public.connections (last_checked_at) WHERE status <> 'disconnected';

-- C-4, C-7: the worker's record of one connect attempt. Only the worker reads and writes it.
CREATE TABLE public.connection_attempts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  connection_id uuid NOT NULL,
  toolkit text NOT NULL CONSTRAINT connection_attempts_toolkit CHECK (toolkit ~ '^[a-z0-9_-]{1,40}$'),
  composio_account_id text NOT NULL CONSTRAINT connection_attempts_account_length CHECK (char_length(composio_account_id) BETWEEN 1 AND 128),
  auth_config_id text NOT NULL CONSTRAINT connection_attempts_auth_config_length CHECK (char_length(auth_config_id) BETWEEN 1 AND 128),
  account_domain text NOT NULL CONSTRAINT connection_attempts_domain_length CHECK (char_length(account_domain) BETWEEN 1 AND 253),
  created_by uuid NOT NULL,
  -- base64url SHA-256 of the browser key (G-1).
  browser_hash text NOT NULL CONSTRAINT connection_attempts_browser_hash CHECK (browser_hash ~ '^[A-Za-z0-9_-]{43}$'),
  status public.connection_attempt_status NOT NULL DEFAULT 'started',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX connection_attempts_sweep ON public.connection_attempts (expires_at) WHERE status IN ('started', 'verified');
CREATE UNIQUE INDEX connection_attempts_account ON public.connection_attempts (composio_account_id);

-- C-3: request IDs the worker has seen, kept 5 minutes. No tenant data.
CREATE TABLE public.connector_request_nonces (
  jti text PRIMARY KEY CONSTRAINT connector_request_nonces_jti CHECK (jti ~ '^[A-Za-z0-9_-]{16,64}$'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX connector_request_nonces_expires ON public.connector_request_nonces (expires_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['connections','connection_attempts','connector_request_nonces'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    IF t <> 'connector_request_nonces' THEN
      EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
        USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    END IF;
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
  END LOOP;
END $$;
-- C-7: the runtime role reads, inserts an active row through the connect action and may only
-- change status and updated_at (the trigger below allows one move). No DELETE.
GRANT SELECT ON public.connections TO authenticated;
GRANT INSERT (tenant_id, id, tier, toolkit, composio_account_id, external_account_id, account_domain, account_label,
  status, connected_by, last_checked_at, created_at, updated_at) ON public.connections TO authenticated;
GRANT UPDATE (status, updated_at) ON public.connections TO authenticated;
-- The worker moves rows, records checks and finishes disconnects. It never edits identity columns.
GRANT SELECT, INSERT ON public.connections TO service_role;
GRANT UPDATE (status, reauthorize_reason, last_checked_at, last_error_code, account_label, updated_at) ON public.connections TO service_role;
-- connection_attempts: no runtime grants.
GRANT SELECT, INSERT, UPDATE ON public.connection_attempts TO service_role;
GRANT SELECT, INSERT, DELETE ON public.connector_request_nonces TO service_role;

-- C-7: a connection the runtime role creates starts active, its one status change is to
-- disconnecting, and disconnected is final for every role.
CREATE FUNCTION public.connections_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'disconnected' AND NEW.status <> 'disconnected' THEN
    RAISE EXCEPTION 'A disconnected connection stays disconnected'
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'connections';
  END IF;
  IF current_user = 'authenticated' AND (
      (TG_OP = 'INSERT' AND NEW.status <> 'active')
      OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
        AND NOT (NEW.status = 'disconnecting' AND OLD.status IN ('active', 'reauthorize')))) THEN
    RAISE EXCEPTION 'Connection status % is not a runtime change', NEW.status
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'connections';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER connections_guard BEFORE INSERT OR UPDATE ON public.connections
  FOR EACH ROW EXECUTE FUNCTION public.connections_guard();
REVOKE ALL ON FUNCTION public.connections_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.connections_guard() FROM anon;
  END IF;
END $$;
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.connections_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

-- C-12: the worker's budget for every Composio call of one environment (3000 a minute in
-- production, 500 in preview) and the 60 second cooldown a provider 429 opens. The worker's
-- service login cannot reach rate_limit_take (it serves the API login only), so this is its own
-- definer over the same bucket table, owned by the narrow rate-limiter role. p_op 'take' charges
-- one call and returns 0, or the milliseconds until a call may go; 'cool' opens the cooldown.
CREATE FUNCTION public.connections_org_budget(p_now timestamptz, p_env text, p_op text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  budget_key bytea;
  cool_key bytea;
  lock_key bytea;
  lim integer;
  budget record;
  cool record;
BEGIN
  -- Only a worker login (a member of service_role, not of authenticated) outside PostgREST may spend it.
  IF NOT pg_catalog.pg_has_role(session_user, 'service_role', 'MEMBER')
    OR pg_catalog.pg_has_role(session_user, 'authenticated', 'MEMBER')
    OR coalesce(current_setting('request.jwt.claims', true), '') <> ''
    OR coalesce(current_setting('request.jwt.claim.sub', true), '') <> '' THEN
    RAISE EXCEPTION 'connections_org_budget is for the connections worker login only' USING ERRCODE = '42501';
  END IF;
  IF p_now IS NULL OR p_env IS NULL OR p_op IS NULL OR p_env NOT IN ('production', 'preview') OR p_op NOT IN ('take', 'cool') THEN
    RAISE EXCEPTION 'connections_org_budget needs a time, an environment and an operation' USING ERRCODE = '22023';
  END IF;
  lim := CASE p_env WHEN 'production' THEN 3000 ELSE 500 END;
  budget_key := sha256(convert_to('composio-org:' || p_env, 'UTF8'));
  cool_key := sha256(convert_to('composio-cooldown:' || p_env, 'UTF8'));
  -- Locked in key order so two takes cannot deadlock; a missing bucket is created empty.
  FOR lock_key IN SELECT k FROM unnest(ARRAY[budget_key, cool_key]) k ORDER BY k LOOP
    LOOP
      PERFORM 1 FROM public.rate_limit_buckets b WHERE b.key = lock_key FOR UPDATE;
      EXIT WHEN FOUND;
      INSERT INTO public.rate_limit_buckets (key, window_start, expires_at, count)
        VALUES (lock_key, p_now, p_now, 0) ON CONFLICT (key) DO NOTHING;
    END LOOP;
  END LOOP;
  IF p_op = 'cool' THEN
    UPDATE public.rate_limit_buckets b SET count = 1, window_start = p_now, expires_at = p_now + interval '60 seconds'
     WHERE b.key = cool_key;
    RETURN 60000;
  END IF;
  SELECT b.expires_at, b.count INTO cool FROM public.rate_limit_buckets b WHERE b.key = cool_key;
  IF cool.count > 0 AND p_now < cool.expires_at THEN
    RETURN ceil(extract(epoch FROM cool.expires_at - p_now) * 1000)::bigint;
  END IF;
  SELECT b.expires_at, b.count INTO budget FROM public.rate_limit_buckets b WHERE b.key = budget_key;
  IF budget.count >= lim AND p_now < budget.expires_at THEN
    RETURN ceil(extract(epoch FROM budget.expires_at - p_now) * 1000)::bigint;
  END IF;
  UPDATE public.rate_limit_buckets b SET
      count = CASE WHEN b.count > 0 AND p_now < b.expires_at THEN b.count + 1 ELSE 1 END,
      window_start = CASE WHEN b.count > 0 AND p_now < b.expires_at THEN b.window_start ELSE p_now END,
      expires_at = CASE WHEN b.count > 0 AND p_now < b.expires_at THEN b.expires_at ELSE p_now + interval '60 seconds' END
   WHERE b.key = budget_key;
  RETURN 0;
END $$;
GRANT CREATE ON SCHEMA public TO zs_rate_limiter;
ALTER FUNCTION public.connections_org_budget(timestamptz, text, text) OWNER TO zs_rate_limiter;
REVOKE CREATE ON SCHEMA public FROM zs_rate_limiter;
REVOKE ALL ON FUNCTION public.connections_org_budget(timestamptz, text, text) FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.connections_org_budget(timestamptz, text, text) FROM anon;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.connections_org_budget(timestamptz, text, text) TO service_role;
