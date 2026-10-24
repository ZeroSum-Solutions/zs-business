-- Transcription (docs/requirements/transcription.md X-1..X-9): a queue of audio jobs the local
-- WhisperX worker pulls, and the transcripts it returns. Both are tenant tables: tenant_id, tenant FK,
-- forced RLS with the shared tenant_scope policy. Writes come from the transcription.job.* actions
-- through the dispatcher; the claim runs in the platform transaction (db.platform), as the Stripe
-- webhook inbox does, because the worker serves every tenant and a claim cannot know the tenant first.

CREATE TYPE public.transcription_source_kind AS ENUM ('media_upload', 'voicemail');
CREATE TYPE public.transcription_job_status AS ENUM ('queued', 'running', 'completed', 'failed', 'dead_letter');

CREATE TABLE public.transcription_jobs (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  -- X-1: an owner upload, or a voicemail (the missed-call slice owns the voicemails table).
  source_kind public.transcription_source_kind NOT NULL,
  source_id uuid,
  -- X-9: what the owner said the upload weighs; the signed upload is checked against it.
  declared_bytes integer CONSTRAINT transcription_jobs_declared_bytes CHECK (declared_bytes BETWEEN 1 AND 104857600),
  status public.transcription_job_status NOT NULL DEFAULT 'queued',
  -- X-3: three attempts, then a dead letter.
  attempts integer NOT NULL DEFAULT 0 CONSTRAINT transcription_jobs_attempts CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL,
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text CONSTRAINT transcription_jobs_error_code CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  requested_by uuid,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT transcription_jobs_id_unique UNIQUE (id),
  CONSTRAINT transcription_jobs_source CHECK ((source_kind = 'voicemail') = (source_id IS NOT NULL))
);
-- X-3: one transcript per voicemail.
CREATE UNIQUE INDEX transcription_jobs_voicemail ON public.transcription_jobs (tenant_id, source_id) WHERE source_kind = 'voicemail';
-- X-3: the claim scan.
CREATE INDEX transcription_jobs_due ON public.transcription_jobs (next_attempt_at, created_at, id)
  WHERE status IN ('queued', 'failed', 'running');
CREATE INDEX transcription_jobs_recent ON public.transcription_jobs (tenant_id, created_at DESC, id);

CREATE TABLE public.transcripts (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  job_id uuid NOT NULL,
  source_kind public.transcription_source_kind NOT NULL,
  source_id uuid,
  -- X-3: the attempt that wrote it.
  attempt integer NOT NULL CONSTRAINT transcripts_attempt CHECK (attempt BETWEEN 1 AND 3),
  -- X-6: the exact models that made it; the contract checks the shape.
  model_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  language text NOT NULL,
  duration_ms integer NOT NULL CONSTRAINT transcripts_duration CHECK (duration_ms BETWEEN 0 AND 3600000),
  speaker_count integer NOT NULL DEFAULT 0 CONSTRAINT transcripts_speaker_count CHECK (speaker_count BETWEEN 0 AND 9),
  -- X-7: [{startMs,endMs,speaker,text}] in time order; the contract checks the shape and the size.
  segments jsonb NOT NULL DEFAULT '[]'::jsonb CONSTRAINT transcripts_segments_array CHECK (jsonb_typeof(segments) = 'array'),
  created_at timestamptz NOT NULL,
  -- X-8: the transcript is kept 90 days.
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  -- X-3: one transcript per job; a replayed completion writes no second row.
  CONSTRAINT transcripts_job_unique UNIQUE (tenant_id, job_id),
  CONSTRAINT transcripts_job FOREIGN KEY (tenant_id, job_id) REFERENCES public.transcription_jobs (tenant_id, id)
);
CREATE INDEX transcripts_expiry ON public.transcripts (expires_at);

ALTER TABLE public.transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcription_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.transcription_jobs TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
-- X-4: only the claim's platform transaction (db.platform) sets app.platform. It reads due jobs and
-- leases them; a runtime request through the Data API cannot set it.
CREATE POLICY platform_claim_read ON public.transcription_jobs FOR SELECT TO authenticated
  USING (current_setting('app.platform', true) = 'on');
CREATE POLICY platform_claim_lease ON public.transcription_jobs FOR UPDATE TO authenticated
  USING (current_setting('app.platform', true) = 'on')
  WITH CHECK (current_setting('app.platform', true) = 'on');

ALTER TABLE public.transcripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcripts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.transcripts TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);

REVOKE ALL ON public.transcription_jobs, public.transcripts FROM PUBLIC, authenticated, service_role;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.transcription_jobs, public.transcripts FROM anon;
  END IF;
END $$;
-- The service role (provisioning, seeds, the X-8 retention sweep) may write both tables, as for the other tenant tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.transcription_jobs, public.transcripts TO service_role;
-- Runtime: the enqueue inserts a job; the claim, heartbeat, fail and complete update the lease columns.
GRANT SELECT ON public.transcription_jobs TO authenticated;
GRANT INSERT (tenant_id, id, source_kind, source_id, declared_bytes, status, attempts, next_attempt_at, requested_by, created_at, updated_at)
  ON public.transcription_jobs TO authenticated;
GRANT UPDATE (status, attempts, next_attempt_at, lease_token, lease_expires_at, last_error_code, updated_at, completed_at)
  ON public.transcription_jobs TO authenticated;
GRANT SELECT, INSERT ON public.transcripts TO authenticated;
