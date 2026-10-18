-- M1 hardening (docs/bakeoff-2026-10-17.md, Follow-ups): known time-zone names in SQL,
-- pinned search_path and explicit ownership for every function in public.

-- Known zone names (B-4 at the SQL level). A trigger, not a CHECK: a CHECK cannot hold a
-- subquery, and an IMMUTABLE wrapper over pg_timezone_names would be false. The zone list
-- changes with tzdata, CHECKs are re-run when pg_dump output loads data, so a restore could
-- fail on a row whose zone a newer tzdata dropped. The trigger checks each write against
-- the live list and is created after the data on restore.
CREATE FUNCTION public.booking_resources_time_zone_known() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.time_zone) THEN
    RAISE EXCEPTION 'Unknown time zone: %', NEW.time_zone USING ERRCODE = 'check_violation',
      SCHEMA = 'public', TABLE = 'booking_resources', COLUMN = 'time_zone',
      CONSTRAINT = 'booking_resources_time_zone_known';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER booking_resources_time_zone_known
  BEFORE INSERT OR UPDATE OF time_zone ON public.booking_resources
  FOR EACH ROW EXECUTE FUNCTION public.booking_resources_time_zone_known();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM public.booking_resources r
    WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name = r.time_zone)) THEN
    RAISE EXCEPTION 'booking_resources holds unknown time zones; fix them before this migration';
  END IF;
END $$;

-- pg_temp listed last: unlisted, it is searched first for tables and types, so a session
-- could shadow a type such as uuid inside a function (PostgreSQL "Writing SECURITY DEFINER
-- Functions Safely"). Every function keeps its earlier path and gains pg_temp at the end.
ALTER FUNCTION public.record_action_and_event(uuid,uuid,uuid,text,jsonb,jsonb,jsonb,text,jsonb,timestamptz,uuid,text,jsonb)
  SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.booking_windows_valid(jsonb) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.booking_weekly_valid(jsonb) SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.booking_overrides_valid(jsonb) SET search_path = pg_catalog, public, pg_temp;

-- Invoker functions get one explicit owner that exists in every environment, instead of
-- whichever role ran the migration (a superuser locally, postgres on Supabase). It is
-- NOLOGIN and standalone, so no runtime login can assume it. The SECURITY DEFINER
-- function stays with zs_dispatcher (20261017160000).
DO $$ BEGIN
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_function_owner') THEN
      CREATE ROLE zs_function_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
  EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='zs_function_owner' AND
    (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
    OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member='zs_function_owner'::regrole) THEN
    RAISE EXCEPTION 'zs_function_owner must be an unprivileged standalone NOLOGIN role';
  END IF;
  -- ALTER ... OWNER needs SET ROLE on the new owner; a non-superuser migrator (Supabase
  -- postgres) can be a member without it (see 20261017160000).
  IF NOT (pg_has_role(current_user, 'zs_function_owner', 'SET') AND pg_has_role(current_user, 'zs_function_owner', 'USAGE')) THEN
    EXECUTE format('GRANT zs_function_owner TO %I WITH INHERIT TRUE, SET TRUE', current_user);
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.booking_resources_time_zone_known() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.booking_resources_time_zone_known() FROM anon;
  END IF;
END $$;
-- Ownership transfer requires CREATE briefly; the role cannot create replacements afterward.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.booking_windows_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.booking_weekly_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.booking_overrides_valid(jsonb) OWNER TO zs_function_owner;
ALTER FUNCTION public.booking_resources_time_zone_known() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;
