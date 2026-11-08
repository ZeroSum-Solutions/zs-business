-- Rate-limit refund (docs/requirements/connections.md C-4). The connect limit is charged before the
-- worker is called, so a link the provider refused or that failed would still use one of the tenant's
-- 10 connects per hour. rate_limit_refund gives one unit back per named bucket, only while the bucket
-- still holds the window the charge went into: a window that has since expired or been reopened is
-- left alone, so a refund can never reduce a later window's count. Same caller rule, owner and
-- grants as rate_limit_take (20261020400000_public_rate_limits.sql).
DO $$ BEGIN
  -- ALTER ... OWNER needs SET ROLE on the new owner; the migrator reaches zs_rate_limiter as in 20261020400000.
  IF current_setting('server_version_num')::int >= 160000 THEN
    IF NOT (pg_has_role(current_user, 'zs_rate_limiter', 'SET') AND pg_has_role(current_user, 'zs_rate_limiter', 'USAGE')) THEN
      EXECUTE format('GRANT zs_rate_limiter TO %I WITH INHERIT TRUE, SET TRUE', current_user);
    END IF;
  ELSIF NOT pg_has_role(current_user, 'zs_rate_limiter', 'MEMBER') THEN
    EXECUTE format('GRANT zs_rate_limiter TO %I', current_user);
  END IF;
END $$;

CREATE FUNCTION public.rate_limit_refund(p_now timestamptz, p_charged_at timestamptz, p_keys jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = session_user
      AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid = 'authenticated'::regrole)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid <> 'authenticated'::regrole))
    OR coalesce(current_setting('request.jwt.claims', true), '') <> ''
    OR coalesce(current_setting('request.jwt.claim.sub', true), '') <> '' THEN
    RAISE EXCEPTION 'rate_limit_refund is for the API runtime login only' USING ERRCODE = '42501';
  END IF;
  IF p_now IS NULL OR p_charged_at IS NULL OR jsonb_typeof(p_keys) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_keys) NOT BETWEEN 1 AND 8 THEN
    RAISE EXCEPTION 'rate_limit_refund needs two times and 1 to 8 keys' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_keys) e WHERE NOT CASE
      WHEN jsonb_typeof(e) IS DISTINCT FROM 'string' THEN false
      ELSE (e #>> '{}') ~ '^[0-9a-f]{64}$' END)
    OR (SELECT count(DISTINCT e #>> '{}') FROM jsonb_array_elements(p_keys) e) <> jsonb_array_length(p_keys) THEN
    RAISE EXCEPTION 'rate_limit_refund keys are malformed' USING ERRCODE = '22023';
  END IF;
  -- Lock in key order (as rate_limit_take does) so overlapping refunds and takes cannot deadlock.
  PERFORM 1 FROM public.rate_limit_buckets b
    WHERE b.key IN (SELECT decode(e #>> '{}', 'hex') FROM jsonb_array_elements(p_keys) e)
    ORDER BY b.key FOR UPDATE;
  UPDATE public.rate_limit_buckets b SET count = b.count - 1
    WHERE b.key IN (SELECT decode(e #>> '{}', 'hex') FROM jsonb_array_elements(p_keys) e)
      AND b.count > 0 AND p_now < b.expires_at AND b.window_start <= p_charged_at;
END $$;
GRANT CREATE ON SCHEMA public TO zs_rate_limiter;
ALTER FUNCTION public.rate_limit_refund(timestamptz, timestamptz, jsonb) OWNER TO zs_rate_limiter;
REVOKE CREATE ON SCHEMA public FROM zs_rate_limiter;
REVOKE ALL ON FUNCTION public.rate_limit_refund(timestamptz, timestamptz, jsonb) FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.rate_limit_refund(timestamptz, timestamptz, jsonb) FROM anon;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.rate_limit_refund(timestamptz, timestamptz, jsonb) TO authenticated;
