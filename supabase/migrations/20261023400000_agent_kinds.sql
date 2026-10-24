-- Agent kinds, usage and daily cost caps, stalled runs (docs/requirements/agents.md G-14..G-16).
-- Settings are keyed by (tenant, kind); runs cover five kinds; new kinds record decisions in
-- agent_decisions; every model call writes one agent_model_calls row that the daily cap counts.
-- Every tenant table has tenant_id, a tenant FK, forced RLS with the shared tenant_scope policy,
-- and tenant-qualified FKs.

-- G-14: one settings row per tenant and kind. Rows that exist keep their meaning (inquiry_followup).
ALTER TABLE public.agent_settings
  ADD COLUMN agent_kind text NOT NULL DEFAULT 'inquiry_followup'
    CONSTRAINT agent_settings_agent_kind CHECK (agent_kind IN
      ('inquiry_followup', 'appointment_reminder', 'review_request', 'document_intake', 'voice_receptionist')),
  -- Kind-specific settings, validated by agentKindConfigSchemas[kind] in packages/contracts.
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT agent_settings_config_object CHECK (jsonb_typeof(config) = 'object' AND octet_length(config::text) <= 4000),
  -- G-15: USD millionths one kind may spend on model calls in 24 hours.
  ADD COLUMN max_cost_micros_per_day integer NOT NULL DEFAULT 1000000
    CONSTRAINT agent_settings_cost_cap CHECK (max_cost_micros_per_day BETWEEN 0 AND 100000000);
ALTER TABLE public.agent_settings DROP CONSTRAINT agent_settings_pkey;
ALTER TABLE public.agent_settings ADD PRIMARY KEY (tenant_id, agent_kind);
GRANT UPDATE (config, max_cost_micros_per_day) ON public.agent_settings TO authenticated;

-- G-14, G-15, G-16: five kinds, two more stop reasons, and the usage a run's model calls add up to.
ALTER TABLE public.agent_runs DROP CONSTRAINT agent_runs_agent;
ALTER TABLE public.agent_runs ADD CONSTRAINT agent_runs_agent CHECK (agent IN
  ('inquiry_followup', 'appointment_reminder', 'review_request', 'document_intake', 'voice_receptionist'));
ALTER TABLE public.agent_runs DROP CONSTRAINT agent_runs_stop_reason;
ALTER TABLE public.agent_runs ADD CONSTRAINT agent_runs_stop_reason CHECK (stop_reason IN
  ('global_killed', 'disabled', 'tenant_killed', 'quiet_hours', 'daily_cap', 'cost_cap', 'stalled'));
ALTER TABLE public.agent_runs
  ADD COLUMN model text CONSTRAINT agent_runs_model_length CHECK (char_length(model) BETWEEN 1 AND 200),
  ADD COLUMN input_tokens integer NOT NULL DEFAULT 0 CONSTRAINT agent_runs_input_tokens CHECK (input_tokens >= 0),
  ADD COLUMN output_tokens integer NOT NULL DEFAULT 0 CONSTRAINT agent_runs_output_tokens CHECK (output_tokens >= 0),
  ADD COLUMN cost_micros bigint NOT NULL DEFAULT 0 CONSTRAINT agent_runs_cost_micros CHECK (cost_micros >= 0);
-- Decisions and model calls name their run's kind through this key, so one cannot disagree with its run.
ALTER TABLE public.agent_runs ADD CONSTRAINT agent_runs_kind_key UNIQUE (tenant_id, id, agent);
-- G-16: the scheduler looks for runs still running after a while.
CREATE INDEX agent_runs_running ON public.agent_runs (started_at) WHERE status = 'running';
GRANT UPDATE (model, input_tokens, output_tokens, cost_micros) ON public.agent_runs TO authenticated;

-- G-14: one row per decision of a kind other than inquiry_followup (which keeps agent_followups).
-- A queued decision names its message; a proposed one its approval; a skipped one names neither.
-- message_id has no foreign key: delivery messages live in more than one table.
CREATE TABLE public.agent_decisions (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  agent_kind text NOT NULL,
  subject_type text NOT NULL DEFAULT 'booking'
    CONSTRAINT agent_decisions_subject_type CHECK (subject_type IN ('booking', 'intake_item', 'document', 'call')),
  subject_id uuid NOT NULL,
  contact_id uuid,
  outcome text NOT NULL DEFAULT 'skipped' CONSTRAINT agent_decisions_outcome CHECK (outcome IN ('queued', 'proposed', 'skipped')),
  reason text CONSTRAINT agent_decisions_reason CHECK (reason IN
    ('no_address', 'suppressed', 'consent_denied', 'consent_missing', 'template_not_approved', 'too_long',
     'model_error', 'model_invalid', 'global_killed', 'disabled', 'tenant_killed', 'quiet_hours', 'daily_cap', 'cost_cap')),
  message_id uuid,
  approval_id uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id, agent_kind) REFERENCES public.agent_runs(tenant_id, id, agent),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES public.approvals(tenant_id, id),
  CONSTRAINT agent_decisions_skipped_state CHECK (outcome <> 'skipped' OR (message_id IS NULL AND approval_id IS NULL)),
  CONSTRAINT agent_decisions_kind CHECK (agent_kind IN
    ('inquiry_followup', 'appointment_reminder', 'review_request', 'document_intake', 'voice_receptionist'))
);
CREATE INDEX agent_decisions_run ON public.agent_decisions (tenant_id, run_id, created_at, id);
CREATE INDEX agent_decisions_kind_time ON public.agent_decisions (tenant_id, agent_kind, created_at);
CREATE INDEX agent_decisions_subject ON public.agent_decisions (tenant_id, agent_kind, subject_id);

-- G-15: one row per model call. A call is reserved as `started` at its worst-case cost, under the
-- kind's settings lock, so concurrent runs count it; it moves once to ok, error or invalid.
-- call_key makes a replay a no-op: agent:<kind>:model:<runId>:<subjectId> in a run,
-- agent:<kind>:suggestion:<key> for a template suggestion, voice:<CallSid>:model:<n> for a call.
CREATE TABLE public.agent_model_calls (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  call_key text NOT NULL CONSTRAINT agent_model_calls_call_key_length CHECK (char_length(call_key) BETWEEN 1 AND 300),
  run_id uuid,
  agent_kind text NOT NULL
    CONSTRAINT agent_model_calls_kind CHECK (agent_kind IN
      ('inquiry_followup', 'appointment_reminder', 'review_request', 'document_intake', 'voice_receptionist')),
  subject_id uuid,
  lane text NOT NULL DEFAULT 'personal_data'
    CONSTRAINT agent_model_calls_lane CHECK (lane IN ('personal_data', 'no_personal_data')),
  model text NOT NULL CONSTRAINT agent_model_calls_model_length CHECK (char_length(model) BETWEEN 1 AND 200),
  input_tokens integer NOT NULL DEFAULT 0 CONSTRAINT agent_model_calls_input_tokens CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CONSTRAINT agent_model_calls_output_tokens CHECK (output_tokens >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CONSTRAINT agent_model_calls_cost_micros CHECK (cost_micros >= 0),
  provider_request_id text CONSTRAINT agent_model_calls_request_id_length CHECK (char_length(provider_request_id) BETWEEN 1 AND 200),
  outcome text NOT NULL DEFAULT 'started'
    CONSTRAINT agent_model_calls_outcome CHECK (outcome IN ('started', 'ok', 'error', 'invalid')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT agent_model_calls_key UNIQUE (tenant_id, call_key),
  -- With no run (a suggestion, a call), run_id is null and this key is not checked.
  FOREIGN KEY (tenant_id, run_id, agent_kind) REFERENCES public.agent_runs(tenant_id, id, agent)
);
CREATE INDEX agent_model_calls_kind_time ON public.agent_model_calls (tenant_id, agent_kind, created_at);
CREATE INDEX agent_model_calls_run ON public.agent_model_calls (tenant_id, run_id) WHERE run_id IS NOT NULL;

-- G-15: a call row moves once, from started to ok, error or invalid, and records what the provider
-- reported then. Nothing else about it changes, for every role.
CREATE FUNCTION public.agent_model_calls_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.outcome <> 'started' OR NEW.outcome = 'started'
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.call_key IS DISTINCT FROM OLD.call_key OR NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.agent_kind IS DISTINCT FROM OLD.agent_kind OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.lane IS DISTINCT FROM OLD.lane OR NEW.model IS DISTINCT FROM OLD.model
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A model call only settles, once (% to % refused)', OLD.outcome, NEW.outcome
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'agent_model_calls',
        CONSTRAINT = 'agent_model_calls_guard';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_model_calls_guard
  BEFORE UPDATE ON public.agent_model_calls
  FOR EACH ROW EXECUTE FUNCTION public.agent_model_calls_guard();

REVOKE ALL ON FUNCTION public.agent_model_calls_guard() FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.agent_model_calls_guard() FROM anon;
  END IF;
END $$;
-- Same owner as every invoker function (20261018090000); CREATE only for the transfer.
GRANT CREATE ON SCHEMA public TO zs_function_owner;
ALTER FUNCTION public.agent_model_calls_guard() OWNER TO zs_function_owner;
REVOKE CREATE ON SCHEMA public FROM zs_function_owner;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_decisions','agent_model_calls'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT, INSERT ON public.%I TO authenticated', t);
  END LOOP;
END $$;
-- Decisions are append-only (insert and read only). Model calls also move once, by column.
GRANT UPDATE (outcome, input_tokens, output_tokens, cost_micros, provider_request_id)
  ON public.agent_model_calls TO authenticated;
