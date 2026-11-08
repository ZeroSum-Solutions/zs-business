-- Scheduled-job (cron) failure alerts. A cron function that fails writes one row here, so an operator
-- sees the failure without reading Vercel logs. One row per job: a repeat failure raises the counter
-- on the open row (no second alert), and the next successful run closes the row. A later failure
-- opens the same row again.
--
-- A platform table, like stripe_events and shopify_locks: no tenant_id, because a job serves every
-- tenant. Only the workers' service role reads and writes it; the runtime and Data API roles get no
-- grant, and RLS is on and forced with no policy as a second wall.
--
-- Every time on the row comes from the database clock (clock_timestamp() in the statements that write
-- it), and there is deliberately no ordering CHECK between the times: overlapping runs finish in any
-- order, and a constraint between them would reject a legitimate write and lose the failure it records.
CREATE TABLE public.cron_alerts (
  job text PRIMARY KEY CONSTRAINT cron_alerts_job CHECK (job ~ '^[a-z][a-z0-9-]{0,39}$'),
  opened_at timestamptz NOT NULL,
  last_failed_at timestamptz NOT NULL,
  failure_count integer NOT NULL DEFAULT 1 CONSTRAINT cron_alerts_count CHECK (failure_count >= 1),
  -- The error's class and message, redacted and cut to 500 characters; never a stack, URL, token or address.
  last_error text NOT NULL CONSTRAINT cron_alerts_error_length CHECK (char_length(last_error) BETWEEN 1 AND 500),
  resolved_at timestamptz,
  -- Set once the operator email for this opening was accepted. An open alert with no value is mailed again
  -- by the next failing run (the send is idempotent per job + opened_at); a reopen clears it.
  notified_at timestamptz
);
-- The operator's question is "what is open now", so the open rows get their own small index.
CREATE INDEX cron_alerts_open ON public.cron_alerts (last_failed_at DESC) WHERE resolved_at IS NULL;

ALTER TABLE public.cron_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cron_alerts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.cron_alerts FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON public.cron_alerts FROM anon; END IF;
END $$;
GRANT SELECT, INSERT, UPDATE ON public.cron_alerts TO service_role;
