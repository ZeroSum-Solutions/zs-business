-- G-4 (google-calendar.md): the runtime limits on calendar_connections.status held only while
-- current_user was exactly `authenticated`. The API's login (zs_runtime) inherits
-- `authenticated`, so a session that left its SET LOCAL ROLE (RESET ROLE) ran as zs_runtime and
-- skipped the guard. The limits now hold for every role that is not the service role (the
-- worker), whatever role name the session runs under. Same function owner and grants as
-- 20261020630000; only the body changes.
CREATE OR REPLACE FUNCTION public.calendar_connections_runtime_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT pg_has_role(current_user, 'service_role', 'MEMBER') AND (
      (TG_OP = 'INSERT' AND NEW.status <> 'active')
      OR (TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
        AND NOT (NEW.status = 'disconnecting' AND OLD.status IN ('active', 'reauthorize')))) THEN
    RAISE EXCEPTION 'Calendar connection status % is not a runtime change', NEW.status
      USING ERRCODE = 'insufficient_privilege', SCHEMA = 'public', TABLE = 'calendar_connections';
  END IF;
  RETURN NEW;
END $$;
