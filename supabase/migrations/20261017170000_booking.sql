-- F1 booking authority (docs/requirements/booking.md B-20, B-21, B-24, B-25, B-28).
-- btree_gist supplies the uuid equality operator class for the exclusion constraint.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- Schema-equivalent validation of the frozen bookingResourceSchema JSON fields.
-- Each test is a separate statement so a scalar never reaches jsonb_object_keys.
CREATE FUNCTION public.booking_windows_valid(p_windows jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE w jsonb; s numeric; e numeric;
BEGIN
  IF jsonb_typeof(p_windows) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOR w IN SELECT value FROM jsonb_array_elements(p_windows) LOOP
    IF jsonb_typeof(w) <> 'object' THEN RETURN false; END IF;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(w) k) IS DISTINCT FROM ARRAY['endMinute','startMinute'] THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(w->'startMinute') <> 'number' OR jsonb_typeof(w->'endMinute') <> 'number' THEN RETURN false; END IF;
    s := (w->>'startMinute')::numeric;
    e := (w->>'endMinute')::numeric;
    IF s <> trunc(s) OR e <> trunc(e) OR s < 0 OR s > 1439 OR e < 1 OR e > 1440 OR s >= e THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION public.booking_weekly_valid(p_weekly jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; seen numeric[] := '{}'; d numeric;
BEGIN
  IF jsonb_typeof(p_weekly) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_weekly) LOOP
    IF jsonb_typeof(r) <> 'object' THEN RETURN false; END IF;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) IS DISTINCT FROM ARRAY['weekday','windows'] THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(r->'weekday') <> 'number' THEN RETURN false; END IF;
    d := (r->>'weekday')::numeric;
    IF d <> trunc(d) OR d < 1 OR d > 7 OR d = ANY(seen) THEN RETURN false; END IF;
    IF NOT public.booking_windows_valid(r->'windows') THEN RETURN false; END IF;
    seen := seen || d;
  END LOOP;
  RETURN true;
END $$;

CREATE FUNCTION public.booking_overrides_valid(p_overrides jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $$
DECLARE r jsonb; seen text[] := '{}'; d text;
BEGIN
  IF jsonb_typeof(p_overrides) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_overrides) LOOP
    IF jsonb_typeof(r) <> 'object' THEN RETURN false; END IF;
    IF (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(r) k) IS DISTINCT FROM ARRAY['date','windows'] THEN
      RETURN false;
    END IF;
    IF jsonb_typeof(r->'date') <> 'string' THEN RETURN false; END IF;
    d := r->>'date';
    IF d !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR d = ANY(seen) THEN RETURN false; END IF;
    BEGIN
      IF to_char(make_date(substr(d,1,4)::int, substr(d,6,2)::int, substr(d,9,2)::int), 'YYYY-MM-DD') <> d THEN
        RETURN false;
      END IF;
    EXCEPTION WHEN OTHERS THEN RETURN false;
    END;
    IF NOT public.booking_windows_valid(r->'windows') THEN RETURN false; END IF;
    seen := seen || d;
  END LOOP;
  RETURN true;
END $$;

CREATE TABLE public.booking_resources (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  -- Defaults keep catalog-generated fixtures constructible; B-28 seeds supply every column.
  time_zone text NOT NULL DEFAULT 'UTC',
  weekly jsonb NOT NULL DEFAULT '[]'::jsonb,
  overrides jsonb NOT NULL DEFAULT '[]'::jsonb,
  slot_length_minutes integer NOT NULL,
  slot_step_minutes integer NOT NULL,
  buffer_before_minutes integer NOT NULL,
  buffer_after_minutes integer NOT NULL,
  minimum_notice_minutes integer NOT NULL,
  booking_horizon_minutes integer NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT booking_resources_one_per_tenant UNIQUE (tenant_id),
  -- Intl decides whether a zone name is known (B-4); SQL checks only the accepted shape.
  CONSTRAINT booking_resources_time_zone_shape CHECK (time_zone = 'UTC' OR (length(time_zone) BETWEEN 3 AND 100 AND position('/' IN time_zone) > 0)),
  CONSTRAINT booking_resources_weekly_valid CHECK (public.booking_weekly_valid(weekly)),
  CONSTRAINT booking_resources_overrides_valid CHECK (public.booking_overrides_valid(overrides)),
  CONSTRAINT booking_resources_slot_length CHECK (slot_length_minutes BETWEEN 1 AND 1440),
  CONSTRAINT booking_resources_slot_step CHECK (slot_step_minutes BETWEEN 1 AND 1440),
  CONSTRAINT booking_resources_buffers CHECK (buffer_before_minutes BETWEEN 0 AND 1440 AND buffer_after_minutes BETWEEN 0 AND 1440),
  CONSTRAINT booking_resources_notice CHECK (minimum_notice_minutes BETWEEN 0 AND 525600),
  CONSTRAINT booking_resources_horizon CHECK (booking_horizon_minutes BETWEEN 0 AND 525600)
);

CREATE TABLE public.bookings (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  resource_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  occupied_starts_at timestamptz NOT NULL,
  occupied_ends_at timestamptz NOT NULL,
  buffer_before_minutes integer NOT NULL DEFAULT 0,
  buffer_after_minutes integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'confirmed',
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES public.booking_resources(tenant_id, id),
  CONSTRAINT bookings_positive_range CHECK (starts_at < ends_at),
  CONSTRAINT bookings_buffers CHECK (buffer_before_minutes BETWEEN 0 AND 1440 AND buffer_after_minutes BETWEEN 0 AND 1440),
  CONSTRAINT bookings_occupied_bounds CHECK (
    occupied_starts_at = starts_at - make_interval(mins => buffer_before_minutes)
    AND occupied_ends_at = ends_at + make_interval(mins => buffer_after_minutes)),
  -- Only confirmed exists in F1. Adding cancellation must add WHERE (status = 'confirmed') below.
  CONSTRAINT bookings_status_confirmed CHECK (status = 'confirmed'),
  CONSTRAINT bookings_resource_occupied_excl EXCLUDE USING gist (
    tenant_id WITH =,
    resource_id WITH =,
    tstzrange(occupied_starts_at, occupied_ends_at, '[)') WITH &&
  )
);

CREATE TABLE public.booking_external_blocks (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  resource_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, resource_id) REFERENCES public.booking_resources(tenant_id, id),
  CONSTRAINT booking_external_blocks_positive_range CHECK (starts_at < ends_at),
  CONSTRAINT booking_external_blocks_source_nonempty CHECK (length(source) > 0)
);
CREATE INDEX booking_external_blocks_resource_range ON public.booking_external_blocks
  USING gist (tenant_id, resource_id, tstzrange(starts_at, ends_at, '[)'));

ALTER TABLE public.booking_resources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_resources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.booking_resources TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.bookings TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE public.booking_external_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_external_blocks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.booking_external_blocks TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);

-- Runtime reads configuration and busy data and inserts bookings (the create handler
-- and B-28 direct-insert proofs). No runtime UPDATE/DELETE: B-21 uses an advisory lock.
REVOKE ALL ON public.booking_resources, public.bookings, public.booking_external_blocks
  FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.booking_resources, public.bookings, public.booking_external_blocks FROM anon;
  END IF;
END $$;
GRANT SELECT ON public.booking_resources, public.booking_external_blocks TO authenticated;
GRANT SELECT, INSERT ON public.bookings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.booking_resources, public.bookings, public.booking_external_blocks TO service_role;

REVOKE ALL ON FUNCTION public.booking_windows_valid(jsonb), public.booking_weekly_valid(jsonb),
  public.booking_overrides_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.booking_windows_valid(jsonb), public.booking_weekly_valid(jsonb),
  public.booking_overrides_valid(jsonb) TO authenticated, service_role;
