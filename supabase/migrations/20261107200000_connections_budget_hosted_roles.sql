-- Fix-forward for 20261106200000 (connections.md C-12). The guard of connections_org_budget
-- refused every login that is a member of `authenticated`. On hosted Supabase the only login
-- that can SET ROLE service_role is `postgres`, and it is a member of BOTH service_role and
-- authenticated, so every hosted worker call failed 42501. The intent is unchanged: only the
-- connections worker's service login, outside PostgREST, may spend the org budget. The API
-- runtime login (zs_runtime) is not a member of service_role, so the first test refuses it.
-- PostgREST's login `authenticator` is a member of service_role and authenticated on hosted
-- Supabase; it is refused by name, and its requests also carry request.jwt.claims. Other
-- dual-role logins there (supabase_admin and the like) are Supabase-internal superusers that
-- can already do anything. Only the guard changes: owner, SECURITY DEFINER, search_path and
-- grants are as in 20261106200000 and are asserted again below.
DO $$ BEGIN
  -- CREATE OR REPLACE needs ownership; the migrator reaches zs_rate_limiter as in 20261020400000.
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT (pg_has_role(current_user, 'zs_rate_limiter', 'SET') AND pg_has_role(current_user, 'zs_rate_limiter', 'USAGE')) THEN
      EXECUTE format('GRANT zs_rate_limiter TO %I WITH INHERIT TRUE, SET TRUE', current_user);
    END IF;
  ELSIF NOT pg_has_role(current_user, 'zs_rate_limiter', 'MEMBER') THEN
    EXECUTE format('GRANT zs_rate_limiter TO %I', current_user);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.connections_org_budget(p_now timestamptz, p_env text, p_op text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  budget_key bytea;
  cool_key bytea;
  lock_key bytea;
  lim integer;
  budget record;
  cool record;
BEGIN
  -- Only a worker login (a member of service_role, not PostgREST's `authenticator`) outside PostgREST may spend it.
  -- Hosted `postgres` is a member of authenticated too, so that membership no longer counts against it.
  IF NOT pg_catalog.pg_has_role(session_user, 'service_role', 'MEMBER')
    OR session_user::text = 'authenticator'
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
