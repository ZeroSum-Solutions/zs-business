-- M6 follow-up agent records (docs/requirements/agents.md G-8, G-10), revision 2.

-- G-10: a run is append-only apart from closing it. It moves once from running to completed or
-- stopped (finish time, stop reason and counts set then); a closed run never changes again, and
-- no update touches who started it, when, or its limit. Every role, as for inbox_replies_guard.
CREATE FUNCTION public.agent_runs_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.status <> 'running' OR NEW.status = 'running'
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.agent IS DISTINCT FROM OLD.agent OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.max_decisions IS DISTINCT FROM OLD.max_decisions THEN
    RAISE EXCEPTION 'A run only closes, once (% to % refused)', OLD.status, NEW.status
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'agent_runs',
        CONSTRAINT = 'agent_runs_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_guard
  BEFORE UPDATE ON public.agent_runs
  FOR EACH ROW EXECUTE FUNCTION public.agent_runs_guard();

REVOKE ALL ON FUNCTION public.agent_runs_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.agent_runs_guard() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.agent_runs_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

-- G-7, G-8: an inquiry the customer followed with a newer request before its draft committed
-- is skipped as superseded.
ALTER TABLE public.agent_followups DROP CONSTRAINT agent_followups_reason;
ALTER TABLE public.agent_followups ADD CONSTRAINT agent_followups_reason CHECK (reason IN
  ('no_email', 'suppressed', 'consent_denied', 'contact_cap', 'answered', 'superseded', 'model_error', 'model_invalid',
   'global_killed', 'disabled', 'tenant_killed', 'quiet_hours', 'daily_cap'));
