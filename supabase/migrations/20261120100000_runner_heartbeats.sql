-- Runner heartbeats (plans.md PL-26). The agent runners (the follow-up and templated agents, the
-- delivery worker) live in the workers project; the API cannot read their deploy flags (FOLLOWUP_AGENT,
-- AGENT_TEMPLATED, DELIVERY_WORKER, SMS_PROVIDER), and must not name them (the worker-split rule). So a
-- runner that finished a run writes one row here, and the plan page treats a feature as "running"
-- only while the row for the runner it needs is fresh. A deploy whose flag is off writes nothing, and its
-- row goes stale, so the page names the feature as not running instead of included.
--
-- A platform table, like cron_alerts: no tenant_id, because a runner serves every tenant. Only the
-- workers' service role writes it. The member's session (`authenticated`) reads it, as it reads
-- agent_global_switch, so the plan read sees the runners and the agent switches in one snapshot.
-- It holds no tenant data and no secret: a runner name, a time and how long the beat counts.
--
-- `beat_at` comes from the database clock (clock_timestamp() in the statement that writes it). The
-- runner states in `fresh_for_seconds` how long its beat counts (twice its slot, or a flat window for the
-- delivery worker), so a reader that knows nothing of the worker's environment can judge it.
CREATE TABLE public.runner_heartbeats (
  runner text PRIMARY KEY CONSTRAINT runner_heartbeats_runner CHECK (runner ~ '^[a-z][a-z_]{0,39}$'),
  beat_at timestamptz NOT NULL,
  fresh_for_seconds integer NOT NULL CONSTRAINT runner_heartbeats_fresh CHECK (fresh_for_seconds BETWEEN 60 AND 604800)
);

ALTER TABLE public.runner_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.runner_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY heartbeat_read ON public.runner_heartbeats FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.runner_heartbeats FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON public.runner_heartbeats FROM anon; END IF;
END $$;
GRANT SELECT ON public.runner_heartbeats TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.runner_heartbeats TO service_role;
