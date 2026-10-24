-- Browser tasks, first slice (docs/requirements/browser-tasks.md BT-3, BT-7..BT-9, BT-12, BT-13).
-- Read-only website tasks run by a runner on the pilot Mac that pulls jobs from the API.
-- Every tenant table has tenant_id, a tenant FK, forced RLS with the shared tenant_scope policy,
-- tenant-qualified FKs, and explicit grants. Every column a catalog fixture must fill has a default
-- that satisfies its CHECK. No SQL functions: rules live in CHECKs, grants and core code.

-- BT-12: one settings row per tenant. A tenant without a row reads as these defaults, tasks off.
CREATE TABLE public.browser_task_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenants(tenant_id),
  enabled boolean NOT NULL DEFAULT false,
  -- BT-9: per tenant per day.
  max_runs_per_day integer NOT NULL DEFAULT 5
    CONSTRAINT browser_task_settings_runs CHECK (max_runs_per_day BETWEEN 1 AND 100),
  max_cost_micros_per_day bigint NOT NULL DEFAULT 5000000
    CONSTRAINT browser_task_settings_cost CHECK (max_cost_micros_per_day BETWEEN 0 AND 100000000),
  killed_at timestamptz,
  killed_by uuid,
  kill_note text CONSTRAINT browser_task_settings_kill_note CHECK (char_length(kill_note) BETWEEN 1 AND 500),
  revision integer NOT NULL DEFAULT 1 CONSTRAINT browser_task_settings_revision CHECK (revision >= 1),
  updated_at timestamptz NOT NULL,
  CONSTRAINT browser_task_settings_kill_state CHECK (
    (killed_at IS NULL) = (killed_by IS NULL) AND (killed_at IS NOT NULL OR kill_note IS NULL))
);

-- BT-3, BT-5: what a task may visit. Off by default; enabling needs the owner's attestation and the
-- reviewed origins, paths and sign-in path. Lists have defaults so a fixture row is constructible;
-- the CHECKs bound them and an enabled target must have them filled.
CREATE TABLE public.browser_targets (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  name text NOT NULL CONSTRAINT browser_targets_name CHECK (char_length(name) BETWEEN 1 AND 120),
  task_kind text NOT NULL DEFAULT 'supplier_invoice_download'
    CONSTRAINT browser_targets_task_kind CHECK (task_kind IN ('supplier_invoice_download')),
  allowed_origins text[] NOT NULL DEFAULT '{}'
    CONSTRAINT browser_targets_origins CHECK (cardinality(allowed_origins) <= 5),
  allowed_paths text[] NOT NULL DEFAULT '{}'
    CONSTRAINT browser_targets_paths CHECK (cardinality(allowed_paths) <= 10),
  asset_paths text[] NOT NULL DEFAULT '{}'
    CONSTRAINT browser_targets_asset_paths CHECK (cardinality(asset_paths) <= 10),
  sign_in_path text CONSTRAINT browser_targets_sign_in CHECK (char_length(sign_in_path) BETWEEN 1 AND 200),
  enabled boolean NOT NULL DEFAULT false,
  attested_by uuid,
  attested_at timestamptz,
  revision integer NOT NULL DEFAULT 1 CONSTRAINT browser_targets_revision CHECK (revision >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT browser_targets_attestation CHECK ((attested_by IS NULL) = (attested_at IS NULL)),
  CONSTRAINT browser_targets_enabled CHECK (
    NOT enabled OR (attested_by IS NOT NULL AND sign_in_path IS NOT NULL
      AND cardinality(allowed_origins) BETWEEN 1 AND 5 AND cardinality(allowed_paths) BETWEEN 1 AND 10))
);

-- BT-8: points at a Supabase Vault secret. The value is never stored in a table.
CREATE TABLE public.browser_credentials (
  tenant_id uuid NOT NULL,
  target_id uuid NOT NULL,
  secret_ref text NOT NULL CONSTRAINT browser_credentials_ref CHECK (char_length(secret_ref) BETWEEN 1 AND 300),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, target_id),
  FOREIGN KEY (tenant_id, target_id) REFERENCES public.browser_targets(tenant_id, id)
);

-- BT-9: one row per run. A run is a queued job until the runner claims it; the claim is a lease.
CREATE TABLE public.browser_runs (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  target_id uuid NOT NULL,
  task_kind text NOT NULL DEFAULT 'supplier_invoice_download'
    CONSTRAINT browser_runs_task_kind CHECK (task_kind IN ('supplier_invoice_download')),
  status text NOT NULL DEFAULT 'queued'
    CONSTRAINT browser_runs_status CHECK (status IN ('queued', 'running', 'completed', 'stopped')),
  stop_reason text CONSTRAINT browser_runs_stop_reason CHECK (stop_reason IN
    ('origin_denied', 'write_refused', 'needs_vision', 'needs_owner', 'killed', 'disabled', 'step_cap', 'deadline',
     'cost_cap', 'stalled', 'insufficient_funds', 'model_error', 'runner_error')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  -- The task's parameters ({"month":"2026-09"}); a tenant ID here is never read.
  params jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT browser_runs_params CHECK (jsonb_typeof(params) = 'object' AND octet_length(params::text) <= 1000),
  max_steps integer NOT NULL DEFAULT 25 CONSTRAINT browser_runs_max_steps CHECK (max_steps BETWEEN 1 AND 100),
  deadline_ms integer NOT NULL DEFAULT 600000 CONSTRAINT browser_runs_deadline CHECK (deadline_ms BETWEEN 1000 AND 3600000),
  max_cost_micros bigint NOT NULL DEFAULT 500000 CONSTRAINT browser_runs_max_cost CHECK (max_cost_micros BETWEEN 0 AND 100000000),
  steps integer NOT NULL DEFAULT 0 CONSTRAINT browser_runs_steps CHECK (steps >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CONSTRAINT browser_runs_cost CHECK (cost_micros >= 0),
  attempt integer NOT NULL DEFAULT 0 CONSTRAINT browser_runs_attempt CHECK (attempt >= 0),
  -- BT-7: the lease. Only a hash of the token is stored.
  lease_hash text CONSTRAINT browser_runs_lease_hash CHECK (char_length(lease_hash) = 64),
  lease_until timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, target_id) REFERENCES public.browser_targets(tenant_id, id),
  CONSTRAINT browser_runs_stop_state CHECK ((status = 'stopped') = (stop_reason IS NOT NULL)),
  CONSTRAINT browser_runs_finished_state CHECK ((status IN ('completed', 'stopped')) = (finished_at IS NOT NULL)),
  CONSTRAINT browser_runs_lease_state CHECK ((lease_hash IS NULL) = (lease_until IS NULL)),
  CONSTRAINT browser_runs_id_unique UNIQUE (id)
);
CREATE INDEX browser_runs_queue ON public.browser_runs (requested_at) WHERE status IN ('queued', 'running');
CREATE INDEX browser_runs_recent ON public.browser_runs (tenant_id, requested_at DESC);

-- BT-13: files a run downloaded, and the audit screenshots (BT-10). The bytes live in object storage
-- under tenants/<tenantId>/browser-runs/<runId>/; this row names them.
CREATE TABLE public.browser_run_artifacts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  run_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'invoice_pdf' CONSTRAINT browser_run_artifacts_kind CHECK (kind IN ('invoice_pdf', 'screenshot')),
  name text NOT NULL CONSTRAINT browser_run_artifacts_name CHECK (char_length(name) BETWEEN 1 AND 200),
  storage_key text NOT NULL CONSTRAINT browser_run_artifacts_key CHECK (char_length(storage_key) BETWEEN 1 AND 500),
  bytes integer NOT NULL DEFAULT 0 CONSTRAINT browser_run_artifacts_bytes CHECK (bytes >= 0),
  sha256 text NOT NULL CONSTRAINT browser_run_artifacts_sha CHECK (char_length(sha256) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.browser_runs(tenant_id, id),
  CONSTRAINT browser_run_artifacts_once UNIQUE (tenant_id, run_id, sha256)
);
CREATE INDEX browser_run_artifacts_run ON public.browser_run_artifacts (tenant_id, run_id, created_at);

-- BT-9: the numbered event log. seq counts from 1 with no gaps (the primary key refuses a repeat and
-- the service appends under the run's row lock). Events hold origin and path, never a query string.
-- Model usage is recorded here per step (docs/requirements/browser-tasks.md deviation: agent_model_calls
-- is keyed by the five agent kinds of agents.md G-14).
CREATE TABLE public.browser_run_events (
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  seq integer NOT NULL CONSTRAINT browser_run_events_seq CHECK (seq >= 1),
  origin text CONSTRAINT browser_run_events_origin CHECK (char_length(origin) BETWEEN 1 AND 200),
  path text CONSTRAINT browser_run_events_path CHECK (char_length(path) BETWEEN 1 AND 500 AND path !~ '[?#]'),
  action text NOT NULL DEFAULT 'open'
    CONSTRAINT browser_run_events_action CHECK (action IN ('sign_in', 'open', 'click_link', 'set_date_filter', 'download', 'stop')),
  screenshot_ref uuid,
  lane text CONSTRAINT browser_run_events_lane CHECK (lane IN ('personal_data', 'no_personal_data')),
  model text CONSTRAINT browser_run_events_model CHECK (char_length(model) BETWEEN 1 AND 200),
  input_tokens integer NOT NULL DEFAULT 0 CONSTRAINT browser_run_events_input CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CONSTRAINT browser_run_events_output CHECK (output_tokens >= 0),
  cost_micros bigint NOT NULL DEFAULT 0 CONSTRAINT browser_run_events_cost CHECK (cost_micros >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, run_id, seq),
  FOREIGN KEY (tenant_id, run_id) REFERENCES public.browser_runs(tenant_id, id),
  FOREIGN KEY (tenant_id, screenshot_ref) REFERENCES public.browser_run_artifacts(tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['browser_task_settings', 'browser_targets', 'browser_credentials', 'browser_runs',
                           'browser_run_artifacts', 'browser_run_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_scope ON public.%I TO authenticated
      USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)$p$, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, authenticated, service_role', t);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
      EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    END IF;
  END LOOP;
END $$;

-- Members (the runtime role) change settings, targets and credential references and request runs
-- through the dispatcher; everything else about a run they only read.
GRANT SELECT, INSERT, UPDATE ON public.browser_task_settings, public.browser_targets, public.browser_credentials TO authenticated;
GRANT SELECT, INSERT ON public.browser_runs TO authenticated;
GRANT SELECT ON public.browser_run_artifacts, public.browser_run_events TO authenticated;

-- BT-7: the runner's service (service role) reads the target and credential reference, moves the run
-- through its states, and appends events and artifacts. It never changes settings or targets.
GRANT SELECT ON public.browser_task_settings, public.browser_targets, public.browser_credentials TO service_role;
GRANT SELECT, UPDATE ON public.browser_runs TO service_role;
GRANT SELECT, INSERT ON public.browser_run_artifacts, public.browser_run_events TO service_role;
