-- Image port revision 2 (docs/requirements/image-port.md IM-23): an owner may reject a staged
-- variant. Adds the `rejected` state and `rejected_at`, the move staged -> rejected, and keeps
-- rejected_at set-once. Same function owner and grants as 20261023800000; RLS is unchanged (forced).

ALTER TABLE public.image_variants ADD COLUMN rejected_at timestamptz;
ALTER TABLE public.image_variants DROP CONSTRAINT image_variants_status;
ALTER TABLE public.image_variants ADD CONSTRAINT image_variants_status
  CHECK (status IN ('queued', 'running', 'staged', 'approved', 'promoted', 'failed', 'expired', 'rejected'));
ALTER TABLE public.image_variants DROP CONSTRAINT image_variants_staged_columns;
ALTER TABLE public.image_variants ADD CONSTRAINT image_variants_staged_columns
  CHECK (status NOT IN ('staged', 'approved', 'promoted', 'expired', 'rejected') OR (
    sha256 IS NOT NULL AND staged_at IS NOT NULL AND expires_at IS NOT NULL
    AND adapter IS NOT NULL AND model_id IS NOT NULL AND model_license IS NOT NULL AND workflow_hash IS NOT NULL));
ALTER TABLE public.image_variants ADD CONSTRAINT image_variants_rejected_columns
  CHECK ((status = 'rejected') = (rejected_at IS NOT NULL));
-- The sweep deletes a rejected variant's staging file, as it does an expired one's.
CREATE INDEX image_variants_rejected ON public.image_variants (rejected_at, tenant_id, id) WHERE status = 'rejected';

-- IM-2, IM-23: the guard of 20261023800000 with staged -> rejected and a set-once rejected_at.
CREATE OR REPLACE FUNCTION public.image_variants_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.source_asset_id IS DISTINCT FROM OLD.source_asset_id OR NEW.source_sha256 IS DISTINCT FROM OLD.source_sha256
     OR NEW.preset IS DISTINCT FROM OLD.preset OR NEW.params IS DISTINCT FROM OLD.params
     OR NEW.price_minor IS DISTINCT FROM OLD.price_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'An image variant keeps its source, preset, params and price'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'image_variants', CONSTRAINT = 'image_variants_immutable';
  END IF;
  IF (OLD.sha256 IS NOT NULL AND NEW.sha256 IS DISTINCT FROM OLD.sha256)
     OR (OLD.matte_sha256 IS NOT NULL AND NEW.matte_sha256 IS DISTINCT FROM OLD.matte_sha256)
     OR (OLD.background_sha256 IS NOT NULL AND NEW.background_sha256 IS DISTINCT FROM OLD.background_sha256)
     OR (OLD.adapter IS NOT NULL AND NEW.adapter IS DISTINCT FROM OLD.adapter)
     OR (OLD.model_id IS NOT NULL AND NEW.model_id IS DISTINCT FROM OLD.model_id)
     OR (OLD.model_license IS NOT NULL AND NEW.model_license IS DISTINCT FROM OLD.model_license)
     OR (OLD.workflow_hash IS NOT NULL AND NEW.workflow_hash IS DISTINCT FROM OLD.workflow_hash)
     OR (OLD.prompt_text IS NOT NULL AND NEW.prompt_text IS DISTINCT FROM OLD.prompt_text)
     OR (OLD.provider_job_id IS NOT NULL AND NEW.provider_job_id IS DISTINCT FROM OLD.provider_job_id)
     OR (OLD.vendor_cost_micros IS NOT NULL AND NEW.vendor_cost_micros IS DISTINCT FROM OLD.vendor_cost_micros)
     OR (OLD.failure_reason IS NOT NULL AND NEW.failure_reason IS DISTINCT FROM OLD.failure_reason)
     OR (OLD.staged_at IS NOT NULL AND NEW.staged_at IS DISTINCT FROM OLD.staged_at)
     OR (OLD.expires_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at)
     OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
     OR (OLD.promoted_at IS NOT NULL AND NEW.promoted_at IS DISTINCT FROM OLD.promoted_at)
     OR (OLD.rejected_at IS NOT NULL AND NEW.rejected_at IS DISTINCT FROM OLD.rejected_at) THEN
    RAISE EXCEPTION 'An image variant''s provenance is set once'
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'image_variants', CONSTRAINT = 'image_variants_provenance_once';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF (OLD.status, NEW.status) NOT IN (
      ('queued', 'running'), ('running', 'staged'), ('staged', 'approved'), ('approved', 'promoted'),
      ('queued', 'failed'), ('running', 'failed'), ('staged', 'expired'), ('staged', 'rejected')) THEN
      RAISE EXCEPTION 'An image variant cannot move from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'image_variants', CONSTRAINT = 'image_variants_transition';
    END IF;
  ELSIF OLD.status NOT IN ('queued', 'running') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'A % image variant does not change', OLD.status
      USING ERRCODE = 'check_violation', SCHEMA = 'public', TABLE = 'image_variants', CONSTRAINT = 'image_variants_transition';
  END IF;
  RETURN NEW;
END $$;

GRANT UPDATE (rejected_at) ON public.image_variants TO authenticated;
