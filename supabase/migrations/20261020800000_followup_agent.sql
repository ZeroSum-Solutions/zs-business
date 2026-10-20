-- M6 inquiry follow-up agent (docs/requirements/agents.md G-2..G-10). The agent drafts Inbox
-- replies with a pending send proposal; it never approves or sends. Its settings, caps, kill
-- switches, runs and decisions live here. Every tenant table has tenant_id, a tenant FK, forced
-- RLS with the shared tenant_scope policy, and tenant-qualified FKs.

-- G-2, G-4, G-5: one row per tenant. A tenant without a row reads as these defaults, agent off.
-- Every column has a default, so the catalog isolation fixture can build a row.
CREATE TABLE public.agent_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  enabled boolean NOT NULL DEFAULT false,
  max_drafts_per_day integer NOT NULL DEFAULT 10
    CONSTRAINT agent_settings_daily_cap CHECK (max_drafts_per_day BETWEEN 1 AND 200),
  max_drafts_per_contact integer NOT NULL DEFAULT 1
    CONSTRAINT agent_settings_contact_cap CHECK (max_drafts_per_contact BETWEEN 1 AND 10),
  contact_window_hours integer NOT NULL DEFAULT 168
    CONSTRAINT agent_settings_contact_window CHECK (contact_window_hours BETWEEN 1 AND 2160),
  wait_hours integer NOT NULL DEFAULT 24
    CONSTRAINT agent_settings_wait CHECK (wait_hours BETWEEN 1 AND 720),
  lookback_days integer NOT NULL DEFAULT 14
    CONSTRAINT agent_settings_lookback CHECK (lookback_days BETWEEN 1 AND 90),
  quiet_start_minute integer NOT NULL DEFAULT 1260
    CONSTRAINT agent_settings_quiet_start CHECK (quiet_start_minute BETWEEN 0 AND 1439),
  quiet_end_minute integer NOT NULL DEFAULT 480
    CONSTRAINT agent_settings_quiet_end CHECK (quiet_end_minute BETWEEN 0 AND 1439),
  time_zone text NOT NULL DEFAULT 'UTC'
    CONSTRAINT agent_settings_time_zone_shape CHECK (time_zone = 'UTC' OR (char_length(time_zone) BETWEEN 3 AND 100 AND position('/' IN time_zone) > 0)),
  -- G-3: the tenant's kill switch. Engaged while killed_at is set.
  killed_at timestamptz,
  killed_by uuid,
  kill_note text CONSTRAINT agent_settings_kill_note_length CHECK (char_length(kill_note) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CONSTRAINT agent_settings_revision CHECK (revision >= 1),
  updated_by uuid,
  updated_at timestamptz NOT NULL,
  CONSTRAINT agent_settings_kill_state CHECK (
    (killed_at IS NULL) = (killed_by IS NULL) AND (killed_at IS NOT NULL OR kill_note IS NULL))
);

-- G-3: the global switch, one row, written only by the service role. Not a tenant table: every
-- tenant reads the same row. Drafts take a shared advisory lock and a flip takes it exclusively
-- (core agents/controls.ts), so the runtime role needs no lock privilege on this row.
CREATE TABLE public.agent_global_switch (
  id boolean PRIMARY KEY DEFAULT true CONSTRAINT agent_global_switch_single CHECK (id),
  killed boolean NOT NULL DEFAULT false,
  note text CONSTRAINT agent_global_switch_note_length CHECK (char_length(note) BETWEEN 1 AND 500),
  updated_at timestamptz NOT NULL
);
INSERT INTO public.agent_global_switch (id, killed, updated_at) VALUES (true, false, '2026-10-20T00:00:00Z')
  ON CONFLICT (id) DO NOTHING;

-- G-10: one row per run.
CREATE TABLE public.agent_runs (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  agent text NOT NULL DEFAULT 'inquiry_followup' CONSTRAINT agent_runs_agent CHECK (agent IN ('inquiry_followup')),
  requested_by uuid,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CONSTRAINT agent_runs_status CHECK (status IN ('running', 'completed', 'stopped')),
  stop_reason text CONSTRAINT agent_runs_stop_reason CHECK (stop_reason IN
    ('global_killed', 'disabled', 'tenant_killed', 'quiet_hours', 'daily_cap')),
  considered integer NOT NULL DEFAULT 0 CONSTRAINT agent_runs_considered CHECK (considered >= 0),
  drafted integer NOT NULL DEFAULT 0 CONSTRAINT agent_runs_drafted CHECK (drafted >= 0),
  skipped integer NOT NULL DEFAULT 0 CONSTRAINT agent_runs_skipped CHECK (skipped >= 0),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT agent_runs_finish_state CHECK (
    (status = 'running') = (finished_at IS NULL)
    AND (status = 'stopped') = (stop_reason IS NOT NULL)
    AND (finished_at IS NULL OR finished_at >= started_at))
);
CREATE INDEX agent_runs_tenant_started ON public.agent_runs (tenant_id, started_at DESC, id);

-- G-10: one row per decision. A drafted decision names its reply and proposal; a skipped one
-- names no reply. Handlers always record the reason of a skip.
CREATE TABLE public.agent_followups (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  intake_item_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'skipped' CONSTRAINT agent_followups_outcome CHECK (outcome IN ('drafted', 'skipped')),
  reason text CONSTRAINT agent_followups_reason CHECK (reason IN
    ('no_email', 'suppressed', 'consent_denied', 'contact_cap', 'answered', 'model_error', 'model_invalid',
     'global_killed', 'disabled', 'tenant_killed', 'quiet_hours', 'daily_cap')),
  reply_id uuid,
  approval_id uuid,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.agent_runs(tenant_id, id),
  FOREIGN KEY (tenant_id, intake_item_id) REFERENCES public.intake_items(tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES public.crm_contacts(tenant_id, id),
  FOREIGN KEY (tenant_id, reply_id) REFERENCES public.inbox_replies(tenant_id, id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES public.approvals(tenant_id, id),
  CONSTRAINT agent_followups_drafted_state CHECK (
    outcome <> 'drafted' OR (reply_id IS NOT NULL AND approval_id IS NOT NULL AND reason IS NULL)),
  CONSTRAINT agent_followups_skipped_state CHECK (
    outcome <> 'skipped' OR (reply_id IS NULL AND approval_id IS NULL))
);
-- G-4: one agent draft per inquiry, ever; the caps count drafts by time, per tenant and customer.
CREATE UNIQUE INDEX agent_followups_one_draft ON public.agent_followups (tenant_id, intake_item_id)
  WHERE outcome = 'drafted';
CREATE INDEX agent_followups_tenant_drafted ON public.agent_followups (tenant_id, created_at)
  WHERE outcome = 'drafted';
CREATE INDEX agent_followups_contact_drafted ON public.agent_followups (tenant_id, contact_id, created_at)
  WHERE outcome = 'drafted';
CREATE INDEX agent_followups_run ON public.agent_followups (tenant_id, run_id, created_at, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['agent_settings','agent_runs','agent_followups'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO service_role', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

ALTER TABLE public.agent_global_switch ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_global_switch FORCE ROW LEVEL SECURITY;
CREATE POLICY global_read ON public.agent_global_switch FOR SELECT TO authenticated USING (true);
REVOKE ALL ON public.agent_global_switch FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.agent_global_switch FROM anon;
  END IF;
END $$;
GRANT SELECT ON public.agent_global_switch TO authenticated;
GRANT SELECT, UPDATE (killed, note, updated_at) ON public.agent_global_switch TO service_role;

-- Runtime writes come only from the agent and settings actions, through the dispatcher (G-6).
-- Settings: the whole row except its tenant. Runs: insert, then close. Decisions: append-only.
GRANT INSERT ON public.agent_settings TO authenticated;
GRANT UPDATE (enabled, max_drafts_per_day, max_drafts_per_contact, contact_window_hours, wait_hours,
  lookback_days, quiet_start_minute, quiet_end_minute, time_zone, killed_at, killed_by, kill_note,
  revision, updated_by, updated_at) ON public.agent_settings TO authenticated;
GRANT INSERT ON public.agent_runs TO authenticated;
GRANT UPDATE (finished_at, status, stop_reason, considered, drafted, skipped) ON public.agent_runs TO authenticated;
GRANT INSERT ON public.agent_followups TO authenticated;
