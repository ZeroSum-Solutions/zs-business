-- M3b source record (docs/requirements/approvals.md F-1..F-8): where a fact about a subject
-- came from, when its source last said so, and until when it counts as fresh.

DO $$ BEGIN
  CREATE TYPE public.source_subject_type AS ENUM ('contact', 'deal', 'booking', 'booking_resource', 'intake_item');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE public.source_records (
  tenant_id uuid NOT NULL REFERENCES public.tenants(tenant_id),
  id uuid NOT NULL,
  subject_type public.source_subject_type NOT NULL,
  subject_id uuid NOT NULL,
  source text NOT NULL CONSTRAINT source_records_source_name CHECK (source ~ '^[a-z][a-z0-9_.-]{0,62}$'),
  source_ref text CONSTRAINT source_records_source_ref_length CHECK (char_length(source_ref) BETWEEN 1 AND 500),
  observed_at timestamptz NOT NULL,
  fresh_until timestamptz,
  revision integer NOT NULL DEFAULT 1 CONSTRAINT source_records_revision CHECK (revision >= 1),
  recorded_by uuid NOT NULL,
  recorded_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT source_records_subject_source UNIQUE (tenant_id, subject_type, subject_id, source),
  CONSTRAINT source_records_fresh_after_observed CHECK (fresh_until > observed_at),
  -- F-4: an observation is never later than the clock that stored it.
  CONSTRAINT source_records_observed_before_update CHECK (observed_at <= updated_at),
  CONSTRAINT source_records_updated_after_recorded CHECK (updated_at >= recorded_at)
);

ALTER TABLE public.source_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON public.source_records TO authenticated
  USING (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id',true),'')::uuid);
REVOKE ALL ON public.source_records FROM PUBLIC, authenticated, service_role;
REVOKE ALL ON TYPE public.source_subject_type FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.source_records FROM anon;
    REVOKE ALL ON TYPE public.source_subject_type FROM anon;
  END IF;
END $$;
GRANT USAGE ON TYPE public.source_subject_type TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.source_records TO service_role;
-- F-8: runtime writes come only from source.observe; no DELETE, and the subject, source and
-- first-recorded columns never change.
GRANT SELECT ON public.source_records TO authenticated;
GRANT INSERT (tenant_id, id, subject_type, subject_id, source, source_ref, observed_at, fresh_until, revision,
  recorded_by, recorded_at, updated_at) ON public.source_records TO authenticated;
GRANT UPDATE (source_ref, observed_at, fresh_until, revision, updated_at) ON public.source_records TO authenticated;
