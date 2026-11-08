-- Connections C-4: a connect charge that bought nothing can be given back. The charge returns a
-- receipt naming exactly what it charged (bucket key and window start); the refund consumes the
-- receipt, so a charge is refunded at most once, in the window it was taken in, and never below zero.
-- rate_limit_take is not touched: sign-in admit and the public routes behave as before.
-- Idempotent and short: it creates one new table and two new functions, so no statement waits on a
-- lock the running API holds (the hosted runner applies all pending files in one transaction with
-- lock_timeout 5s and statement_timeout 15s). A re-run changes nothing.
-- Same ownership and access rule as rate_limit_take (20261020400000): the functions run as
-- zs_rate_limiter, and only the API's runtime login may call them.

-- One row per issued, unconsumed receipt. charges is [{ key: 64 hex, windowStart: ISO instant }].
-- expires_at is the end of the latest window the receipt touches: past it a refund can change
-- nothing, so later takes sweep the row.
CREATE TABLE IF NOT EXISTS public.rate_limit_receipts (
  id uuid PRIMARY KEY,
  charges jsonb NOT NULL CONSTRAINT rate_limit_receipts_charges CHECK (jsonb_typeof(charges) = 'array'),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_limit_receipts_expires ON public.rate_limit_receipts (expires_at);

ALTER TABLE public.rate_limit_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limit_receipts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS rate_limiter ON public.rate_limit_receipts;
CREATE POLICY rate_limiter ON public.rate_limit_receipts TO zs_rate_limiter USING (true) WITH CHECK (true);
REVOKE ALL ON public.rate_limit_receipts FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.rate_limit_receipts FROM anon;
  END IF;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit_receipts TO zs_rate_limiter;
GRANT SELECT, DELETE ON public.rate_limit_receipts TO service_role;

-- Charges like rate_limit_take (same arguments, same checks, same answer for a refusal) and, when
-- every bucket was charged, records and returns a receipt:
--   { "retryMs": 0, "receipt": { "id": uuid, "charges": [{ "key": hex, "windowStart": instant }] } }
-- A refusal is { "retryMs": n, "receipt": null } and charged nothing.
-- It calls rate_limit_take in the same transaction. That call leaves every bucket it charged
-- row-locked, so the windows read afterwards are the ones this charge joined or opened.
CREATE OR REPLACE FUNCTION public.rate_limit_receipt_take(p_now timestamptz, p_charges jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  retry_ms bigint;
  receipt_id uuid;
  windows jsonb;
  ends timestamptz;
BEGIN
  -- The caller check, the argument checks and the charge are rate_limit_take's: session_user and
  -- the request's JWT settings reach it unchanged through this definer.
  retry_ms := public.rate_limit_take(p_now, p_charges);
  IF retry_ms > 0 THEN
    RETURN jsonb_build_object('retryMs', retry_ms, 'receipt', NULL);
  END IF;
  SELECT jsonb_agg(jsonb_build_object('key', encode(b.key, 'hex'), 'windowStart', b.window_start) ORDER BY b.key),
         max(b.expires_at)
    INTO windows, ends
    FROM public.rate_limit_buckets b
   WHERE b.key IN (SELECT decode(e->>'key', 'hex') FROM jsonb_array_elements(p_charges) e);
  receipt_id := gen_random_uuid();
  INSERT INTO public.rate_limit_receipts (id, charges, expires_at) VALUES (receipt_id, windows, ends);
  -- Bounded cleanup, as in rate_limit_take: receipts past their windows.
  DELETE FROM public.rate_limit_receipts r WHERE r.id IN (
    SELECT s.id FROM public.rate_limit_receipts s WHERE s.expires_at <= p_now
     ORDER BY s.expires_at LIMIT 32 FOR UPDATE SKIP LOCKED);
  RETURN jsonb_build_object('retryMs', 0, 'receipt', jsonb_build_object('id', receipt_id, 'charges', windows));
END $$;

-- Consumes a receipt and gives back one unit in each bucket whose window is still the one the
-- receipt names. Returns how many buckets it gave a unit back to.
--   - At most once: the receipt row is deleted first, under its row lock, so a second or a
--     concurrent refund of the same receipt finds nothing and returns 0.
--   - Only that window: a bucket whose window ended (p_now at or past expires_at) or was reopened
--     (another window_start) is left alone, as is a receipt the table does not hold (unknown,
--     already refunded, or swept after its windows ended).
--   - Never below zero: only a count above 0 is decremented.
-- Buckets are locked in key order, as in rate_limit_take, so the two cannot deadlock.
CREATE OR REPLACE FUNCTION public.rate_limit_refund(p_now timestamptz, p_receipt uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  windows jsonb;
  w record;
  given integer := 0;
  hit integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = session_user
      AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication)
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid = 'authenticated'::regrole)
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid <> 'authenticated'::regrole))
    OR coalesce(current_setting('request.jwt.claims', true), '') <> ''
    OR coalesce(current_setting('request.jwt.claim.sub', true), '') <> '' THEN
    RAISE EXCEPTION 'rate_limit_refund is for the API runtime login only' USING ERRCODE = '42501';
  END IF;
  IF p_now IS NULL OR p_receipt IS NULL THEN
    RAISE EXCEPTION 'rate_limit_refund needs a time and a receipt' USING ERRCODE = '22023';
  END IF;
  DELETE FROM public.rate_limit_receipts r WHERE r.id = p_receipt RETURNING r.charges INTO windows;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  FOR w IN
    SELECT decode(e->>'key', 'hex') AS key, (e->>'windowStart')::timestamptz AS window_start
      FROM jsonb_array_elements(windows) e ORDER BY 1
  LOOP
    UPDATE public.rate_limit_buckets b SET count = b.count - 1
     WHERE b.key = w.key AND b.window_start = w.window_start AND p_now < b.expires_at AND b.count > 0;
    GET DIAGNOSTICS hit = ROW_COUNT;
    given := given + hit;
  END LOOP;
  RETURN given;
END $$;

-- Ownership transfer requires CREATE briefly; the role cannot create replacements afterward.
GRANT CREATE ON SCHEMA public TO zs_rate_limiter;
ALTER FUNCTION public.rate_limit_receipt_take(timestamptz, jsonb) OWNER TO zs_rate_limiter;
ALTER FUNCTION public.rate_limit_refund(timestamptz, uuid) OWNER TO zs_rate_limiter;
REVOKE CREATE ON SCHEMA public FROM zs_rate_limiter;
REVOKE ALL ON FUNCTION public.rate_limit_receipt_take(timestamptz, jsonb) FROM PUBLIC, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rate_limit_refund(timestamptz, uuid) FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.rate_limit_receipt_take(timestamptz, jsonb) FROM anon;
    REVOKE ALL ON FUNCTION public.rate_limit_refund(timestamptz, uuid) FROM anon;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.rate_limit_receipt_take(timestamptz, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_refund(timestamptz, uuid) TO authenticated;
