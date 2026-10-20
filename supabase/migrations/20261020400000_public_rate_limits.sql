-- Shared public rate limits (docs/requirements/public-intake.md P-10, revision 6). Every API
-- instance counts in one table, so a limit holds however many instances serve. Not a tenant
-- table: a client address bucket spans every tenant. No runtime role reads or writes it; the
-- API reaches it only through rate_limit_take, which runs as zs_rate_limiter.

-- The owner of rate_limit_take, as zs_dispatcher owns the action write (20261017155900): a
-- standalone NOLOGIN role that can do nothing but keep the buckets. CREATE ROLE names
-- NOLOGIN only (supautils); the check asserts every other attribute.
DO $$ BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_rate_limiter') THEN
      CREATE ROLE zs_rate_limiter NOLOGIN;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_rate_limiter' AND
    (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='zs_rate_limiter'::regrole) THEN
    RAISE EXCEPTION 'zs_rate_limiter must be an unprivileged standalone NOLOGIN role';
  END IF;
  -- ALTER ... OWNER needs SET ROLE on the new owner (see 20261017155900).
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT (pg_has_role(current_user, 'zs_rate_limiter', 'SET') AND pg_has_role(current_user, 'zs_rate_limiter', 'USAGE')) THEN
      EXECUTE format('GRANT zs_rate_limiter TO %I WITH INHERIT TRUE, SET TRUE', current_user);
    END IF;
  ELSIF NOT pg_has_role(current_user, 'zs_rate_limiter', 'MEMBER') THEN
    EXECUTE format('GRANT zs_rate_limiter TO %I', current_user);
  END IF;
END $$;

-- One row per bucket. The key is the SHA-256 of the API's bucket name, so no client address
-- is stored. A row with count 0 holds no window: a refused request created it and charged
-- nothing. Rows past expires_at are swept by later takes.
CREATE TABLE public.rate_limit_buckets (
  key bytea PRIMARY KEY CONSTRAINT rate_limit_buckets_key_length CHECK (octet_length(key) = 32),
  window_start timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  count integer NOT NULL CONSTRAINT rate_limit_buckets_count CHECK (count >= 0),
  CONSTRAINT rate_limit_buckets_window CHECK (expires_at >= window_start)
);
CREATE INDEX rate_limit_buckets_expires ON public.rate_limit_buckets (expires_at);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_buckets FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_limiter ON public.rate_limit_buckets TO zs_rate_limiter USING (true) WITH CHECK (true);
REVOKE ALL ON public.rate_limit_buckets FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.rate_limit_buckets FROM anon;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO zs_rate_limiter;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit_buckets TO zs_rate_limiter;
-- Operators may look at buckets and clear one; the service role bypasses RLS.
GRANT SELECT, DELETE ON public.rate_limit_buckets TO service_role;

-- P-10: charge every bucket a request names, or none. p_charges is a JSON array of 1 to 8
-- distinct { key: 64 hex characters, limit, windowMs }. Returns 0 when every bucket was
-- charged, else the milliseconds until the latest full bucket reopens, and charges nothing.
-- p_now is the caller's clock: core logic never reads the database clock either.
-- Buckets are locked in key order, so takes over overlapping buckets cannot deadlock. The
-- sweep runs last and skips locked rows, so it never waits while holding a bucket.
CREATE FUNCTION public.rate_limit_take(p_now timestamptz, p_charges jsonb) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  charge record;
  bucket record;
  retry_ms bigint := 0;
BEGIN
  -- Only the API's runtime login may charge or sweep buckets: an unprivileged LOGIN whose one
  -- role membership is authenticated, the rule assertRuntimeLogin and every scoped
  -- transaction enforce. EXECUTE has to go to authenticated, which Supabase-issued JWTs also
  -- carry, so pg_graphql and PostgREST could reach this function. Their requests run under
  -- the authenticator login, which belongs to anon, authenticated and service_role, and carry
  -- JWT claims; both are refused, so a signed-in member cannot pick p_now and sweep or fill
  -- buckets.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = session_user
      AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid = 'authenticated'::regrole)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid <> 'authenticated'::regrole))
    OR coalesce(current_setting('request.jwt.claims', true), '') <> ''
    OR coalesce(current_setting('request.jwt.claim.sub', true), '') <> '' THEN
    RAISE EXCEPTION 'rate_limit_take is for the API runtime login only' USING ERRCODE = '42501';
  END IF;
  IF p_now IS NULL OR jsonb_typeof(p_charges) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_charges) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'rate_limit_take needs a time and 1 to 8 charges' USING ERRCODE = '22023';
  END IF;
  -- CASE keeps each cast behind its pattern: OR does not fix the order of evaluation.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_charges) e WHERE NOT CASE
      WHEN jsonb_typeof(e) IS DISTINCT FROM 'object' THEN false
      WHEN jsonb_typeof(e->'key') IS DISTINCT FROM 'string' OR (e->>'key') !~ '^[0-9a-f]{64}$' THEN false
      WHEN jsonb_typeof(e->'limit') IS DISTINCT FROM 'number' OR (e->>'limit') !~ '^[0-9]{1,7}$' THEN false
      WHEN jsonb_typeof(e->'windowMs') IS DISTINCT FROM 'number' OR (e->>'windowMs') !~ '^[0-9]{1,8}$' THEN false
      ELSE (e->>'limit')::int BETWEEN 1 AND 1000000 AND (e->>'windowMs')::int BETWEEN 1 AND 86400000 END)
    OR (SELECT count(DISTINCT e->>'key') FROM jsonb_array_elements(p_charges) e) <> jsonb_array_length(p_charges) THEN
    RAISE EXCEPTION 'rate_limit_take charges are malformed' USING ERRCODE = '22023';
  END IF;

  FOR charge IN
    SELECT decode(e->>'key', 'hex') AS key, (e->>'limit')::int AS lim
      FROM jsonb_array_elements(p_charges) e ORDER BY 1
  LOOP
    -- Lock the bucket, creating it empty if it is missing. A sweep may delete a row between
    -- the insert's conflict and the lock, so try again until the lock holds a row.
    LOOP
      SELECT b.expires_at, b.count INTO bucket FROM public.rate_limit_buckets b WHERE b.key = charge.key FOR UPDATE;
      EXIT WHEN FOUND;
      INSERT INTO public.rate_limit_buckets (key, window_start, expires_at, count)
        VALUES (charge.key, p_now, p_now, 0) ON CONFLICT (key) DO NOTHING;
    END LOOP;
    IF bucket.count >= charge.lim AND p_now < bucket.expires_at THEN
      retry_ms := greatest(retry_ms, ceil(extract(epoch FROM bucket.expires_at - p_now) * 1000)::bigint);
    END IF;
  END LOOP;

  IF retry_ms = 0 THEN
    -- A live window gains one; an empty or expired bucket opens a new window at p_now.
    UPDATE public.rate_limit_buckets b SET
        count = CASE WHEN b.count > 0 AND p_now < b.expires_at THEN b.count + 1 ELSE 1 END,
        window_start = CASE WHEN b.count > 0 AND p_now < b.expires_at THEN b.window_start ELSE p_now END,
        expires_at = CASE WHEN b.count > 0 AND p_now < b.expires_at THEN b.expires_at
          ELSE p_now + (e->>'windowMs')::int * interval '1 millisecond' END
      FROM jsonb_array_elements(p_charges) e
     WHERE b.key = decode(e->>'key', 'hex');
  END IF;

  -- Bounded cleanup: each take removes up to 32 expired buckets and adds at most 8, so
  -- expired rows drain while traffic lasts.
  DELETE FROM public.rate_limit_buckets b WHERE b.key IN (
    SELECT s.key FROM public.rate_limit_buckets s WHERE s.expires_at <= p_now
     ORDER BY s.expires_at LIMIT 32 FOR UPDATE SKIP LOCKED);
  RETURN retry_ms;
END $$;
-- Ownership transfer requires CREATE briefly; the role cannot create replacements afterward.
GRANT CREATE ON SCHEMA public TO zs_rate_limiter;
ALTER FUNCTION public.rate_limit_take(timestamptz, jsonb) OWNER TO zs_rate_limiter;
REVOKE CREATE ON SCHEMA public FROM zs_rate_limiter;
REVOKE ALL ON FUNCTION public.rate_limit_take(timestamptz, jsonb) FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.rate_limit_take(timestamptz, jsonb) FROM anon;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.rate_limit_take(timestamptz, jsonb) TO authenticated;
